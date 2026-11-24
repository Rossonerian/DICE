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


@dataclass
class AppRuntime:
    http_client: httpx.AsyncClient
    pool: swarm.BrowserPool
    mock_bedrock: bool
    mock_fetch: bool
    active_jobs: dict[tuple[str, str], JobState] = field(default_factory=dict)


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

    app.state.runtime = AppRuntime(
        http_client=http_client,
        pool=pool,
        mock_bedrock=mock_bedrock,
        mock_fetch=mock_fetch,
    )
    try:
        yield
    finally:
        await pool.stop()
        await http_client.aclose()


app = FastAPI(title="DICE Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, Any]:
    rt: AppRuntime = app.state.runtime
    return {
        "status": "ok",
        "warm_pool": {
            "available": rt.pool.available,
            "size": rt.pool.size if rt.pool.available else 0,
            "idle": rt.pool.idle,
        },
        "active_jobs": len(rt.active_jobs),
        "mock_bedrock": rt.mock_bedrock,
    }


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
    await websocket.accept()
    rt: AppRuntime = app.state.runtime
    send_lock = asyncio.Lock()
    registry = gatekeeper.GateRegistry()
    session_jobs: dict[str, JobState] = {}

    async def send_msg(msg: schemas.CloudMessage) -> None:
        async with send_lock:
            try:
                await websocket.send_json(msg.model_dump(by_alias=True))
            except (RuntimeError, WebSocketDisconnect):
                pass

    async def await_gate_task(
        job: JobState,
        gen_id: int,
        gate_id: str,
        action_type: str,
        target_url: str,
    ) -> None:
        try:
            approved = await registry.await_approval(gate_id, timeout=300.0)
            if job.generation_id != gen_id:
                return
            if approved:
                await send_msg(
                    _make_telemetry(
                        "gatekeeper",
                        "COMPLETED",
                        f"{action_type} action released (simulated; not executed)",
                        job=job,
                    )
                )
            else:
                await send_msg(
                    _make_telemetry(
                        "gatekeeper",
                        "BLOCKED",
                        f"{action_type} action denied or timed out",
                        job=job,
                    )
                )
        finally:
            current = asyncio.current_task()
            if current is not None:
                job.gate_tasks.pop(current, None)

    async def run_generation(job: JobState, gen_id: int) -> None:
        if job.generation_id != gen_id:
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

        if job.generation_id != gen_id:
            return

        if not targets:
            await send_msg(
                _make_telemetry(
                    "scout_swarm",
                    "COMPLETED",
                    "no reachable sources",
                    job=job,
                )
            )
            await send_msg(
                schemas.SynthesisUpdate(
                    job_id=job.job_id,
                    voice_brief="No reachable sources were available for this request.",
                    items=[],
                    evidence_cards=[],
                    contradictions=[],
                    mind_map=schemas.MindMapData(nodes=[], edges=[]),
                )
            )
            return

        await send_msg(
            _make_telemetry(
                "scout_swarm",
                "RUNNING",
                f"Dispatching {len(targets)} scout(s)",
                job=job,
            )
        )

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

            results = await asyncio.gather(*scout_tasks.keys(), return_exceptions=True)
        finally:
            for task in scout_tasks:
                job.scouts.pop(task, None)

        if job.generation_id != gen_id:
            return

        for res in results:
            if isinstance(res, tuple):
                url, payload = res
                if payload is not None:
                    job.chunks[url] = payload

        if job.generation_id != gen_id:
            return

        chunk_list = list(job.chunks.values())
        await send_msg(
            _make_telemetry(
                "synthesis",
                "RUNNING",
                f"Synthesizing {len(chunk_list)} source(s)",
                job=job,
            )
        )

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

        if job.generation_id != gen_id:
            return

        await send_msg(update)
        await send_msg(
            _make_telemetry(
                "synthesis",
                "COMPLETED",
                "Synthesis complete",
                job=job,
            )
        )

        should_intercept, action_type, target_url, offending_taint = _detect_mutating_action(
            job.intent, job.constraints, chunk_list, context_url=effective_context
        )
        if should_intercept:
            decision = gatekeeper.evaluate(action_type, target_url, offending_taint)
            if not decision.allowed:
                gate_id = str(uuid.uuid4())
                registry.create(gate_id)
                outbound_action = _normalize_action_type(action_type)
                await send_msg(
                    schemas.GatekeeperIntercept(
                        gate_id=gate_id,
                        decision="FORBID_UNTIL_SIGNED",
                        cedar_rule=decision.rule_id,
                        action_type=outbound_action,  # type: ignore[arg-type]
                        target_url=target_url,
                        reason=decision.reason,
                        action_diff=_build_action_diff(offending_taint, target_url),
                    )
                )
                await send_msg(
                    _make_telemetry(
                        "gatekeeper",
                        "BLOCKED",
                        "awaiting approval",
                        job=job,
                    )
                )
                gtask = asyncio.create_task(
                    await_gate_task(job, gen_id, gate_id, outbound_action, target_url)
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
            try:
                msg = schemas.parse_client_message(raw)
            except (json.JSONDecodeError, ValidationError, ValueError):
                await send_msg(_make_telemetry("gatekeeper", "BLOCKED", "invalid message"))
                continue

            if isinstance(msg, schemas.DispatchSwarm):
                prior = session_jobs.get(msg.job_id)
                if prior is not None:
                    prior.generation_id += 1
                    await _cancel_job_tasks(prior, registry=registry)

                job = JobState(
                    job_id=msg.job_id,
                    intent=msg.intent,
                    constraints=list(msg.constraints),
                    context_url=msg.context_url,
                    pinned_notes=list(msg.pinned_notes),
                    generation_id=(prior.generation_id + 1) if prior else 1,
                )
                session_jobs[msg.job_id] = job
                rt.active_jobs[(session_id, msg.job_id)] = job

                job.synth_task = asyncio.create_task(run_generation(job, job.generation_id))

            elif isinstance(msg, schemas.SteerSwarm):
                job = session_jobs.get(msg.job_id)
                # Emit CANCELLED telemetry IMMEDIATELY before awaiting anything else.
                await send_msg(
                    _make_telemetry(
                        "scout_swarm",
                        "CANCELLED",
                        "Steer received; cancelling superseded scouts",
                        job=job,
                    )
                )
                if job is None:
                    continue

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

                for gtask, gate_id in list(job.gate_tasks.items()):
                    if not gtask.done():
                        gtask.cancel()
                        registry.discard(gate_id)
                        await send_msg(
                            _make_telemetry(
                                "gatekeeper",
                                "BLOCKED",
                                f"gate {gate_id} withdrawn: superseded by steer",
                                job=job,
                            )
                        )
                job.gate_tasks.clear()

                if job.synth_task is not None and not job.synth_task.done():
                    job.synth_task.cancel()

                job.generation_id += 1
                if msg.delta_instruction:
                    job.intent = f"{job.intent} {msg.delta_instruction}".strip()

                job.synth_task = asyncio.create_task(run_generation(job, job.generation_id))

            elif isinstance(msg, schemas.ApprovalDecision):
                registry.resolve(msg.gate_id, msg.approved)

    except WebSocketDisconnect:
        pass
    finally:
        for job in list(session_jobs.values()):
            for gtask, gate_id in list(job.gate_tasks.items()):
                if not gtask.done():
                    gtask.cancel()
                registry.discard(gate_id)
            job.gate_tasks.clear()
        registry.cancel_all()
        for job_id, job in list(session_jobs.items()):
            await _cancel_job_tasks(job, registry=registry)
            rt.active_jobs.pop((session_id, job_id), None)
        session_jobs.clear()
