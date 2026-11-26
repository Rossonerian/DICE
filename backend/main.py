from __future__ import annotations

import asyncio
import json
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

import gatekeeper
import schemas
import swarm
import synthesis

_MUTATING_KEYWORD_RE = re.compile(
    r"\b(?:buy|purchase|checkout|place\s+(?:an\s+)?order|order\s+(?:it|this|that|one|now)|submit\s+(?:the\s+|a\s+)?(?:form|application|order)|post\s+(?:a\s+|the\s+)?(?:comment|reply|review)|publish|reply\s+to|comment\s+on)\b",
    re.IGNORECASE,
)

ALLOWED_ORIGINS: tuple[str, ...] = (
    "http://localhost:1420",
    "http://127.0.0.1:1420",
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
)
ALLOWED_ORIGIN_SET: frozenset[str] = frozenset(ALLOWED_ORIGINS)
MAX_WS_FRAME_BYTES = 65_536


def _env_bool(name: str, default: bool = False) -> bool:
    val = os.getenv(name)
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes")


@dataclass
class JobState:
    job_id: str
    intent: str
    constraints: list[str]
    context_url: str | None
    pinned_notes: list[schemas.PinnedNote]
    generation_id: int = 0
    start_time: float = field(default_factory=time.monotonic)
    scouts: dict[asyncio.Task[Any], str] = field(default_factory=dict)
    chunks: dict[str, gatekeeper.TaintedPayload] = field(default_factory=dict)
    cancelled_domains: set[str] = field(default_factory=set)
    synth_task: asyncio.Task[Any] | None = None
    gate_tasks: dict[asyncio.Task[Any], str] = field(default_factory=dict)
    synthesizing: bool = False


@dataclass
class SessionState:
    jobs: dict[str, JobState] = field(default_factory=dict)
    registry: gatekeeper.GateRegistry = field(default_factory=gatekeeper.GateRegistry)
    epoch: int = 0
    active_connections: int = 0


@dataclass
class AppRuntime:
    http_client: httpx.AsyncClient
    pool: swarm.BrowserPool
    mock_bedrock: bool
    mock_fetch: bool
    active_jobs: dict[tuple[str, str], JobState] = field(default_factory=dict)
    sessions: dict[str, SessionState] = field(default_factory=dict)

    def get_or_create_session(self, session_id: str) -> SessionState:
        sess = self.sessions.get(session_id)
        if sess is None:
            sess = SessionState()
            self.sessions[session_id] = sess
        return sess


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_dotenv()
    mock_bedrock = _env_bool("MOCK_BEDROCK", False)
    mock_fetch = _env_bool("MOCK_FETCH", False)
    enable_playwright = _env_bool("ENABLE_PLAYWRIGHT", True)
    pool_size = int(os.getenv("PLAYWRIGHT_POOL_SIZE", "2"))

    http_client = httpx.AsyncClient(follow_redirects=False)
    pool = swarm.BrowserPool()
    await pool.start(size=pool_size, enabled=enable_playwright)

    rt = AppRuntime(
        http_client=http_client,
        pool=pool,
        mock_bedrock=mock_bedrock,
        mock_fetch=mock_fetch,
    )
    app.state.runtime = rt
    try:
        yield
    finally:
        for sid in list(rt.sessions.keys()):
            await _reset_session_state(rt, sid)
        await pool.stop()
        await http_client.aclose()


app = FastAPI(title="DICE Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(ALLOWED_ORIGINS),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, Any]:
    rt: AppRuntime = app.state.runtime
    pool = rt.pool
    is_healthy = bool(
        pool is not None
        and getattr(pool, "available", False)
        and getattr(pool, "is_healthy", lambda: pool is not None)()
    )
    return {
        "status": "ok",
        "warm_pool": {
            "available": is_healthy,
            "size": pool.size if is_healthy else 0,
            "idle": pool.idle if is_healthy else 0,
        },
        "active_jobs": len(rt.active_jobs),
        "mock_bedrock": rt.mock_bedrock,
    }


async def _reset_session_state(rt: AppRuntime, session_id: str) -> None:
    sess = rt.sessions.get(session_id)
    if sess is None:
        for key in [k for k in list(rt.active_jobs.keys()) if k[0] == session_id]:
            rt.active_jobs.pop(key, None)
        return
    sess.epoch += 1
    jobs = list(sess.jobs.items())
    sess.jobs.clear()
    tasks_to_drain: list[asyncio.Task[Any]] = []
    for job_id, job in jobs:
        job.generation_id += 1
        if job.synth_task is not None and not job.synth_task.done():
            tasks_to_drain.append(job.synth_task)
        await _cancel_job_tasks(job, registry=sess.registry)
        if rt.active_jobs.get((session_id, job_id)) is job:
            rt.active_jobs.pop((session_id, job_id), None)
    for key in [k for k in list(rt.active_jobs.keys()) if k[0] == session_id]:
        rt.active_jobs.pop(key, None)
    sess.registry.cancel_all()
    if tasks_to_drain:
        try:
            await asyncio.wait_for(
                asyncio.gather(*tasks_to_drain, return_exceptions=True),
                timeout=0.5,
            )
        except asyncio.TimeoutError:
            pass
    if sess.active_connections <= 0:
        rt.sessions.pop(session_id, None)


@app.post("/sessions/{session_id}/reset")
async def reset_session(session_id: str) -> dict[str, str]:
    rt: AppRuntime = app.state.runtime
    await _reset_session_state(rt, session_id)
    return {"status": "reset", "session_id": session_id}


@app.post("/reset")
async def reset_all_sessions() -> dict[str, str]:
    rt: AppRuntime = app.state.runtime
    for sid in list(rt.sessions.keys()):
        await _reset_session_state(rt, sid)
    return {"status": "reset"}


def _host_matches_domain(host: str, domain: str) -> bool:
    h = host.lower().strip(".")
    d = domain.lower().strip(".")
    if not d:
        return False
    return h == d or h.endswith("." + d)


def _detect_mutating_action(
    intent: str,
    constraints: list[str],
    chunks: list[gatekeeper.TaintedPayload],
    context_url: str | None = None,
) -> tuple[bool, str, str, gatekeeper.TaintedPayload | None]:
    """Return (should_intercept, action_type, target_url, offending_taint)."""
    for chunk in chunks:
        if chunk.injected_actions:
            return True, "FORM_SUBMIT", chunk.source_url or "https://fixtures.mock/dom-injection", chunk

    combined = " ".join([intent, *constraints])
    match = _MUTATING_KEYWORD_RE.search(combined)
    if match:
        kw = match.group(0).lower()
        if kw.startswith(("buy", "purchase", "checkout", "place", "order")):
            action_type = "CHECKOUT_CLICK"
            suffix = "/checkout"
        elif kw.startswith(("post", "publish", "reply", "comment")):
            action_type = "EXTERNAL_POST"
            suffix = "/post"
        else:
            action_type = "FORM_SUBMIT"
            suffix = "/submit"
        first_host = (urlparse(chunks[0].source_url).hostname if chunks else None) or "fixtures.mock"
        target_url = context_url or f"https://{first_host}{suffix}"
        return True, action_type, target_url, None

    return False, "", "", None


async def _cancel_job_tasks(
    job: JobState,
    registry: gatekeeper.GateRegistry | None = None,
) -> None:
    for task in list(job.scouts.keys()):
        if not task.done():
            task.cancel()
    job.scouts.clear()
    if job.synth_task is not None and not job.synth_task.done():
        job.synth_task.cancel()
    job.synth_task = None
    for gtask, gate_id in list(job.gate_tasks.items()):
        if not gtask.done():
            gtask.cancel()
        if registry is not None:
            registry.discard(gate_id)
    job.gate_tasks.clear()


def _make_telemetry(
    agent_id: str,
    status: str,
    message: str,
    job: JobState | None = None,
) -> schemas.Telemetry:
    latency_ms = int((time.monotonic() - job.start_time) * 1000) if job is not None else 0
    return schemas.Telemetry(
        trace_id=f"tr_{uuid.uuid4().hex[:8]}",
        agent_id=agent_id,  # type: ignore[arg-type]
        status=status,  # type: ignore[arg-type]
        message=message,
        latency_ms=latency_ms,
        workers_active=len(job.scouts) if job is not None else 0,
        tabs_offloaded=len(job.chunks) if job is not None else 0,
    )


def _normalize_action_type(action_type: str) -> str:
    if action_type in ("FORM_SUBMIT", "CHECKOUT_CLICK", "EXTERNAL_POST"):
        return action_type
    return "FORM_SUBMIT"


def _build_action_diff(taint: gatekeeper.TaintedPayload | None, target_url: str) -> str:
    if taint is not None and taint.forms:
        return f"{taint.forms[0]} with user session"
    path = urlparse(target_url).path or "/"
    return f"POST {path} with user session"


@app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str) -> None:
    origin = websocket.headers.get("origin")
    if origin is not None and origin not in ALLOWED_ORIGIN_SET:
        await websocket.close(code=1008)
        return

    await websocket.accept()
    rt: AppRuntime = app.state.runtime
    send_lock = asyncio.Lock()
    session_state = rt.get_or_create_session(session_id)
    session_state.active_connections += 1
    owned_jobs: dict[str, JobState] = {}

    async def send_msg(
        msg: schemas.CloudMessage,
        *,
        job: JobState | None = None,
        expected_gen: int | None = None,
        expected_epoch: int | None = None,
    ) -> bool:
        async with send_lock:
            if job is not None and expected_gen is not None and job.generation_id != expected_gen:
                return False
            if expected_epoch is not None and session_state.epoch != expected_epoch:
                return False
            try:
                await websocket.send_json(msg.model_dump(by_alias=True))
                return True
            except (RuntimeError, WebSocketDisconnect, OSError):
                return False

    async def await_gate_task(
        job: JobState,
        gen_id: int,
        epoch: int,
        gate_id: str,
        action_type: str,
        target_url: str,
    ) -> None:
        try:
            approved = await session_state.registry.await_approval(gate_id, timeout=300.0)
            if job.generation_id != gen_id or session_state.epoch != epoch:
                return
            if approved:
                await send_msg(
                    _make_telemetry(
                        "gatekeeper",
                        "COMPLETED",
                        f"{action_type} action released (simulated; not executed)",
                        job=job,
                    ),
                    job=job,
                    expected_gen=gen_id,
                    expected_epoch=epoch,
                )
            else:
                await send_msg(
                    _make_telemetry(
                        "gatekeeper",
                        "BLOCKED",
                        f"{action_type} action denied or timed out",
                        job=job,
                    ),
                    job=job,
                    expected_gen=gen_id,
                    expected_epoch=epoch,
                )
        finally:
            current = asyncio.current_task()
            if current is not None:
                job.gate_tasks.pop(current, None)

    async def run_generation(job: JobState, gen_id: int, epoch: int) -> None:
        if job.generation_id != gen_id or session_state.epoch != epoch:
            return

        effective_context = job.context_url
        if rt.mock_fetch and effective_context and effective_context not in swarm.MOCK_FIXTURES:
            effective_context = None
        if not rt.mock_fetch and effective_context:
            try:
                await swarm.validate_public_https_async(effective_context, mock_fetch=False)
            except ValueError:
                effective_context = None
        if effective_context and job.cancelled_domains:
            ctx_host = urlparse(effective_context).hostname or ""
            if any(_host_matches_domain(ctx_host, d) for d in job.cancelled_domains):
                effective_context = None

        targets = await swarm.discover_targets(
            job.intent,
            job.constraints,
            effective_context,
            rt.http_client,
            mock_fetch=rt.mock_fetch,
        )
        if job.cancelled_domains:
            targets = [
                u
                for u in targets
                if not any(_host_matches_domain(urlparse(u).hostname or "", d) for d in job.cancelled_domains)
            ]

        if job.generation_id != gen_id or session_state.epoch != epoch:
            return

        if not targets:
            await send_msg(
                _make_telemetry(
                    "scout_swarm",
                    "COMPLETED",
                    "no reachable sources",
                    job=job,
                ),
                job=job,
                expected_gen=gen_id,
                expected_epoch=epoch,
            )
            await send_msg(
                schemas.SynthesisUpdate(
                    job_id=job.job_id,
                    voice_brief="No reachable sources were available for this request.",
                    items=[],
                    evidence_cards=[],
                    contradictions=[],
                    mind_map=schemas.MindMapData(nodes=[], edges=[]),
                ),
                job=job,
                expected_gen=gen_id,
                expected_epoch=epoch,
            )
            return

        async def fetch_one(url: str) -> tuple[str, gatekeeper.TaintedPayload | None]:
            try:
                payload = await swarm.fetch_url(
                    url,
                    rt.http_client,
                    pool=rt.pool,
                    mock_fetch=rt.mock_fetch,
                )
                return url, payload
            except asyncio.CancelledError:
                raise
            except Exception:
                return url, None

        scout_tasks: dict[asyncio.Task[tuple[str, gatekeeper.TaintedPayload | None]], str] = {}
        try:
            for url in targets:
                host = urlparse(url).hostname or ""
                task = asyncio.create_task(fetch_one(url))
                scout_tasks[task] = host
                job.scouts[task] = host

            await send_msg(
                _make_telemetry(
                    "scout_swarm",
                    "RUNNING",
                    f"Dispatching {len(targets)} scout(s)",
                    job=job,
                ),
                job=job,
                expected_gen=gen_id,
                expected_epoch=epoch,
            )

            results = await asyncio.gather(*scout_tasks.keys(), return_exceptions=True)
        finally:
            for task in scout_tasks:
                if not task.done():
                    task.cancel()
                job.scouts.pop(task, None)

        if job.generation_id != gen_id or session_state.epoch != epoch:
            return

        for res in results:
            if isinstance(res, tuple):
                url, payload = res
                if payload is not None:
                    job.chunks[url] = payload

        if job.generation_id != gen_id or session_state.epoch != epoch:
            return

        await send_msg(
            _make_telemetry(
                "scout_swarm",
                "COMPLETED",
                f"Collected {len(job.chunks)} source(s)",
                job=job,
            ),
            job=job,
            expected_gen=gen_id,
            expected_epoch=epoch,
        )

        chunk_list = list(job.chunks.values())
        await send_msg(
            _make_telemetry(
                "synthesis",
                "RUNNING",
                f"Synthesizing {len(chunk_list)} source(s)",
                job=job,
            ),
            job=job,
            expected_gen=gen_id,
            expected_epoch=epoch,
        )

        job.synthesizing = True
        try:
            update = await synthesis.synthesize(
                job_id=job.job_id,
                intent=job.intent,
                constraints=job.constraints,
                chunks=chunk_list,
                pinned_notes=job.pinned_notes,
                mock_bedrock=rt.mock_bedrock,
                generation_id=gen_id,
                context_url=effective_context,
            )
        finally:
            if job.generation_id == gen_id:
                job.synthesizing = False

        if job.generation_id != gen_id or session_state.epoch != epoch:
            return

        await send_msg(update, job=job, expected_gen=gen_id, expected_epoch=epoch)
        await send_msg(
            _make_telemetry(
                "synthesis",
                "COMPLETED",
                "Synthesis complete",
                job=job,
            ),
            job=job,
            expected_gen=gen_id,
            expected_epoch=epoch,
        )

        should_intercept, action_type, target_url, offending_taint = _detect_mutating_action(
            job.intent, job.constraints, chunk_list, context_url=effective_context
        )
        if should_intercept:
            decision = gatekeeper.evaluate(action_type, target_url, offending_taint)
            if not decision.allowed:
                if job.generation_id != gen_id or session_state.epoch != epoch:
                    return
                gate_id = str(uuid.uuid4())
                session_state.registry.create(gate_id)
                outbound_action = _normalize_action_type(action_type)
                sent_intercept = await send_msg(
                    schemas.GatekeeperIntercept(
                        gate_id=gate_id,
                        decision="FORBID_UNTIL_SIGNED",
                        cedar_rule=decision.rule_id,
                        action_type=outbound_action,  # type: ignore[arg-type]
                        target_url=target_url,
                        reason=decision.reason,
                        action_diff=_build_action_diff(offending_taint, target_url),
                    ),
                    job=job,
                    expected_gen=gen_id,
                    expected_epoch=epoch,
                )
                if not sent_intercept or job.generation_id != gen_id or session_state.epoch != epoch:
                    session_state.registry.discard(gate_id)
                    return
                await send_msg(
                    _make_telemetry(
                        "gatekeeper",
                        "BLOCKED",
                        "awaiting approval",
                        job=job,
                    ),
                    job=job,
                    expected_gen=gen_id,
                    expected_epoch=epoch,
                )
                if job.generation_id != gen_id or session_state.epoch != epoch:
                    session_state.registry.discard(gate_id)
                    return
                gtask = asyncio.create_task(
                    await_gate_task(job, gen_id, epoch, gate_id, outbound_action, target_url)
                )
                job.gate_tasks[gtask] = gate_id

    try:
        while True:
            ws_msg = await websocket.receive()
            if ws_msg.get("type") == "websocket.disconnect":
                break
            if ws_msg.get("bytes") is not None:
                await send_msg(_make_telemetry("gatekeeper", "BLOCKED", "invalid message"))
                continue
            raw = ws_msg.get("text")
            if raw is None:
                continue
            if len(raw) > MAX_WS_FRAME_BYTES or len(raw.encode("utf-8")) > MAX_WS_FRAME_BYTES:
                await send_msg(_make_telemetry("gatekeeper", "BLOCKED", "invalid message: frame too large"))
                continue
            try:
                msg = schemas.parse_client_message(raw)
            except (json.JSONDecodeError, ValidationError, ValueError):
                await send_msg(_make_telemetry("gatekeeper", "BLOCKED", "invalid message"))
                continue

            if isinstance(msg, schemas.DispatchSwarm):
                dispatch_epoch = session_state.epoch
                prior_same = session_state.jobs.get(msg.job_id)
                next_gen = (prior_same.generation_id + 1) if prior_same is not None else 1

                superseded = list(session_state.jobs.items())
                session_state.jobs.clear()
                tasks_to_drain: list[asyncio.Task[Any]] = []
                cancelled_notices: list[JobState] = []
                for old_id, old_job in superseded:
                    old_job.generation_id += 1
                    had_active = (
                        any(not t.done() for t in old_job.scouts)
                        or (old_job.synth_task is not None and not old_job.synth_task.done())
                    )
                    if old_job.synth_task is not None and not old_job.synth_task.done():
                        tasks_to_drain.append(old_job.synth_task)
                    await _cancel_job_tasks(old_job, registry=session_state.registry)
                    if rt.active_jobs.get((session_id, old_id)) is old_job:
                        rt.active_jobs.pop((session_id, old_id), None)
                    if owned_jobs.get(old_id) is old_job:
                        owned_jobs.pop(old_id, None)
                    if had_active:
                        cancelled_notices.append(old_job)

                for old_job in cancelled_notices:
                    await send_msg(
                        _make_telemetry(
                            "scout_swarm",
                            "CANCELLED",
                            f"Superseded by new dispatch {msg.job_id}",
                            job=old_job,
                        ),
                        expected_epoch=dispatch_epoch,
                    )

                if tasks_to_drain:
                    try:
                        await asyncio.wait_for(
                            asyncio.gather(*tasks_to_drain, return_exceptions=True),
                            timeout=0.5,
                        )
                    except asyncio.TimeoutError:
                        pass

                if session_state.epoch != dispatch_epoch:
                    continue

                job = JobState(
                    job_id=msg.job_id,
                    intent=msg.intent,
                    constraints=list(msg.constraints),
                    context_url=msg.context_url,
                    pinned_notes=list(msg.pinned_notes),
                    generation_id=next_gen,
                )
                session_state.jobs[msg.job_id] = job
                owned_jobs[msg.job_id] = job
                rt.active_jobs[(session_id, msg.job_id)] = job

                job.synth_task = asyncio.create_task(
                    run_generation(job, job.generation_id, dispatch_epoch)
                )

            elif isinstance(msg, schemas.SteerSwarm):
                steer_epoch = session_state.epoch
                job = session_state.jobs.get(msg.job_id)
                if job is None:
                    await send_msg(
                        _make_telemetry(
                            "gatekeeper",
                            "BLOCKED",
                            f"unknown job_id: {msg.job_id}",
                        )
                    )
                    continue

                # Synchronously advance generation_id, cancel active tasks/gates,
                # and filter/clear chunks BEFORE any await.
                job.generation_id += 1
                was_synthesizing = job.synthesizing
                old_synth_task = job.synth_task
                job.synth_task = None

                if not msg.cancel_domains:
                    for task in list(job.scouts.keys()):
                        if not task.done():
                            task.cancel()
                    job.scouts.clear()
                    job.chunks.clear()
                else:
                    job.cancelled_domains.update(d.lower().strip(".") for d in msg.cancel_domains if d)
                    for task, host in list(job.scouts.items()):
                        if any(_host_matches_domain(host, d) for d in msg.cancel_domains):
                            if not task.done():
                                task.cancel()
                            job.scouts.pop(task, None)
                    for url in list(job.chunks.keys()):
                        host = urlparse(url).hostname or ""
                        if any(_host_matches_domain(host, d) for d in msg.cancel_domains):
                            job.chunks.pop(url, None)

                withdrawn_gates: list[str] = []
                for gtask, gate_id in list(job.gate_tasks.items()):
                    if not gtask.done():
                        gtask.cancel()
                        session_state.registry.discard(gate_id)
                        withdrawn_gates.append(gate_id)
                job.gate_tasks.clear()

                if old_synth_task is not None and not old_synth_task.done():
                    old_synth_task.cancel()

                if msg.delta_instruction:
                    job.intent = f"{job.intent} {msg.delta_instruction}".strip()

                await send_msg(
                    _make_telemetry(
                        "scout_swarm",
                        "CANCELLED",
                        "Steer received; cancelling superseded scouts",
                        job=job,
                    ),
                    expected_epoch=steer_epoch,
                )
                if was_synthesizing:
                    await send_msg(
                        _make_telemetry(
                            "synthesis",
                            "CANCELLED",
                            "Steer received; cancelling active synthesis",
                            job=job,
                        ),
                        expected_epoch=steer_epoch,
                    )
                for gate_id in withdrawn_gates:
                    await send_msg(
                        _make_telemetry(
                            "gatekeeper",
                            "BLOCKED",
                            f"gate {gate_id} withdrawn: superseded by steer",
                            job=job,
                        ),
                        expected_epoch=steer_epoch,
                    )

                if old_synth_task is not None and not old_synth_task.done():
                    try:
                        await asyncio.wait_for(
                            asyncio.gather(old_synth_task, return_exceptions=True),
                            timeout=0.5,
                        )
                    except asyncio.TimeoutError:
                        pass

                if session_state.epoch != steer_epoch or session_state.jobs.get(msg.job_id) is not job:
                    continue

                job.synth_task = asyncio.create_task(
                    run_generation(job, job.generation_id, steer_epoch)
                )

            elif isinstance(msg, schemas.ApprovalDecision):
                if not session_state.registry.resolve(msg.gate_id, msg.approved):
                    await send_msg(
                        _make_telemetry(
                            "gatekeeper",
                            "BLOCKED",
                            f"unknown or expired gate_id: {msg.gate_id}",
                        )
                    )

    except (WebSocketDisconnect, RuntimeError, OSError):
        pass
    finally:
        for job_id, job in list(owned_jobs.items()):
            job.generation_id += 1
            await _cancel_job_tasks(job, registry=session_state.registry)
            if session_state.jobs.get(job_id) is job:
                session_state.jobs.pop(job_id, None)
            if rt.active_jobs.get((session_id, job_id)) is job:
                rt.active_jobs.pop((session_id, job_id), None)
        owned_jobs.clear()
        session_state.active_connections = max(0, session_state.active_connections - 1)
        if not session_state.jobs:
            session_state.registry.cancel_all()
            if session_state.active_connections == 0:
                rt.sessions.pop(session_id, None)
