from __future__ import annotations

import asyncio
import os
import queue
import sys
import threading
import time
from typing import Any, Callable
from urllib.parse import quote_plus

import httpx

os.environ["MOCK_BEDROCK"] = "true"
os.environ["MOCK_FETCH"] = "true"
os.environ["ENABLE_PLAYWRIGHT"] = "false"

from fastapi.testclient import TestClient  # noqa: E402
from pydantic import TypeAdapter, ValidationError  # noqa: E402

import gatekeeper  # noqa: E402
import main  # noqa: E402
import schemas  # noqa: E402
import swarm  # noqa: E402
import synthesis  # noqa: E402

CLOUD_ADAPTER: TypeAdapter[schemas.CloudMessage] = TypeAdapter(schemas.CloudMessage)


class WsReader:
    def __init__(self, ws: Any) -> None:
        self._ws = ws
        self._q: queue.Queue[Any] = queue.Queue()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                data = self._ws.receive_json()
                self._q.put(data)
            except Exception as exc:
                self._q.put(exc)
                break

    def recv_until(
        self,
        pred: Callable[[schemas.CloudMessage], bool],
        timeout: float = 5.0,
    ) -> schemas.CloudMessage:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Timed out waiting for matching WebSocket frame")
            try:
                item = self._q.get(timeout=remaining)
            except queue.Empty as exc:
                raise TimeoutError("Timed out waiting for matching WebSocket frame") from exc
            if isinstance(item, Exception):
                raise item
            msg = CLOUD_ADAPTER.validate_python(item)
            if pred(msg):
                return msg

    def close(self) -> None:
        self._stop.set()


def run_case(name: str, fn: Callable[[], None]) -> bool:
    try:
        fn()
        print(f"PASS: {name}")
        return True
    except Exception as exc:
        print(f"FAIL: {name} -> {exc!r}")
        return False


def main_tests() -> int:
    results: list[bool] = []

    with TestClient(main.app) as client:
        # 1. GET /health
        def case_1() -> None:
            resp = client.get("/health")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["status"] == "ok", body
            assert body["mock_bedrock"] is True, body
            assert body["warm_pool"]["available"] is False, body
            assert body["active_jobs"] == 0, body

        results.append(run_case("1. GET /health", case_1))

        # 2. schemas.parse_client_message
        def case_2() -> None:
            d = schemas.parse_client_message(
                {"type": "DISPATCH_SWARM", "job_id": "j1", "intent": "compare", "constraints": None, "pinned_notes": None}
            )
            assert isinstance(d, schemas.DispatchSwarm)
            assert d.constraints == []
            assert d.pinned_notes == []

            s = schemas.parse_client_message({"type": "STEER_SWARM", "job_id": "j1", "delta_instruction": "cheaper", "cancel_domains": None})
            assert isinstance(s, schemas.SteerSwarm)
            assert s.cancel_domains == []

            a = schemas.parse_client_message({"type": "APPROVAL_DECISION", "gate_id": "g1", "approved": True})
            assert isinstance(a, schemas.ApprovalDecision)

            try:
                schemas.parse_client_message({"type": "STEER_SWARM", "job_id": "j1", "extra_key": 123})
                raise AssertionError("Expected ValidationError for extra_key")
            except ValidationError:
                pass

        results.append(run_case("2. schemas.parse_client_message", case_2))

        # 3. gatekeeper.sanitize_html
        def case_3() -> None:
            html = (
                "<html><head><style>.a{color:red}</style></head><body>"
                "<!-- secret comment -->"
                "<script>alert(1)</script>"
                "<div hidden>hidden attr</div>"
                "<span aria-hidden='true'>aria hidden</span>"
                "<p style='display: none'>disp none</p>"
                "<p style='visibility:hidden'>vis hidden</p>"
                "<p style='opacity: 0'>op zero</p>"
                "<p style='font-size: 0px'>fs zero</p>"
                "<p>Visible   content   here.</p>"
                "</body></html>"
            )
            cleaned = gatekeeper.sanitize_html(html, max_chars=50)
            assert "Visible content here." in cleaned, cleaned
            for forbidden in ("secret", "alert", "hidden attr", "aria hidden", "disp none", "vis hidden", "op zero", "fs zero"):
                assert forbidden not in cleaned, f"Found {forbidden!r} in {cleaned!r}"
            assert len(cleaned) <= 50

        results.append(run_case("3. gatekeeper.sanitize_html", case_3))

        # 4. gatekeeper.evaluate
        def case_4() -> None:
            taint = gatekeeper.TaintedPayload(source_url="https://example.com", title="t", text="x")
            for act in ("FORM_SUBMIT", "CHECKOUT_CLICK", "EXTERNAL_POST"):
                dec = gatekeeper.evaluate(act, "https://example.com", taint)
                assert dec.allowed is False
                assert dec.decision == "FORBID_UNTIL_SIGNED"
            unk = gatekeeper.evaluate("UNKNOWN_MUTATING", "https://example.com", taint)
            assert unk.allowed is False
            read_dec = gatekeeper.evaluate("READ_FETCH", "https://example.com", taint)
            assert read_dec.allowed is True

        results.append(run_case("4. gatekeeper.evaluate", case_4))

        # 5. swarm.validate_public_https
        def case_5() -> None:
            bad_urls = [
                "http://example.com",
                "https://localhost",
                "https://10.0.0.1",
                "https://169.254.169.254",
                "https://[::1]",
            ]
            for u in bad_urls:
                try:
                    swarm.validate_public_https(u)
                    raise AssertionError(f"Expected ValueError for {u}")
                except ValueError:
                    pass

        results.append(run_case("5. swarm.validate_public_https", case_5))

        # 6. WS full flow
        def case_6() -> None:
            expected_telemetry_keys = {
                "type",
                "trace_id",
                "agent_id",
                "status",
                "message",
                "latency_ms",
                "workers_active",
                "tabs_offloaded",
            }
            with client.websocket_connect("/ws/sess-6") as ws:
                reader = WsReader(ws)
                try:
                    ws.send_json({"type": "DISPATCH_SWARM", "job_id": "job-6", "intent": "checkout best option"})
                    t1 = reader.recv_until(
                        lambda m: isinstance(m, schemas.Telemetry)
                        and m.agent_id == "scout_swarm"
                        and m.status == "RUNNING"
                    )
                    assert set(t1.model_dump(by_alias=True).keys()) == expected_telemetry_keys
                    t0 = time.monotonic()
                    ws.send_json({"type": "STEER_SWARM", "job_id": "job-6", "delta_instruction": "under 1200", "cancel_domains": []})
                    t2 = reader.recv_until(
                        lambda m: isinstance(m, schemas.Telemetry)
                        and m.agent_id == "scout_swarm"
                        and m.status == "CANCELLED",
                        timeout=0.2,
                    )
                    assert set(t2.model_dump(by_alias=True).keys()) == expected_telemetry_keys
                    elapsed = time.monotonic() - t0
                    assert elapsed <= 0.2, f"CANCELLED took {elapsed:.3f}s"

                    synth = reader.recv_until(lambda m: isinstance(m, schemas.SynthesisUpdate), timeout=5.0)
                    assert isinstance(synth, schemas.SynthesisUpdate)
                    assert len(synth.items) > 0
                    assert len(synth.evidence_cards) > 0

                    intercept = reader.recv_until(lambda m: isinstance(m, schemas.GatekeeperIntercept), timeout=5.0)
                    assert isinstance(intercept, schemas.GatekeeperIntercept)
                    gate_id = intercept.gate_id

                    t3 = reader.recv_until(
                        lambda m: isinstance(m, schemas.Telemetry)
                        and m.agent_id == "gatekeeper"
                        and m.status == "BLOCKED",
                        timeout=5.0,
                    )
                    assert set(t3.model_dump(by_alias=True).keys()) == expected_telemetry_keys

                    ws.send_json({"type": "APPROVAL_DECISION", "gate_id": gate_id, "approved": True})
                    done = reader.recv_until(
                        lambda m: isinstance(m, schemas.Telemetry)
                        and m.agent_id == "gatekeeper"
                        and m.status == "COMPLETED",
                        timeout=5.0,
                    )
                    assert isinstance(done, schemas.Telemetry)
                    assert set(done.model_dump(by_alias=True).keys()) == expected_telemetry_keys
                    assert "simulated" in done.message.lower(), done.message
                finally:
                    reader.close()

        results.append(run_case("6. WS full flow", case_6))

        # 7. Rejection
        def case_7() -> None:
            with client.websocket_connect("/ws/sess-7") as ws:
                reader = WsReader(ws)
                try:
                    ws.send_json({"type": "DISPATCH_SWARM", "job_id": "job-7", "intent": "buy laptop now"})
                    intercept = reader.recv_until(lambda m: isinstance(m, schemas.GatekeeperIntercept), timeout=5.0)
                    assert isinstance(intercept, schemas.GatekeeperIntercept)
                    reader.recv_until(
                        lambda m: isinstance(m, schemas.Telemetry)
                        and m.agent_id == "gatekeeper"
                        and m.status == "BLOCKED",
                        timeout=5.0,
                    )
                    ws.send_json({"type": "APPROVAL_DECISION", "gate_id": intercept.gate_id, "approved": False})
                    reader.recv_until(
                        lambda m: isinstance(m, schemas.Telemetry)
                        and m.agent_id == "gatekeeper"
                        and m.status == "BLOCKED",
                        timeout=5.0,
                    )
                finally:
                    reader.close()

        results.append(run_case("7. Gatekeeper rejection", case_7))

        # 8. DISPATCH omitting context_url and pinned_notes
        def case_8() -> None:
            with client.websocket_connect("/ws/sess-8") as ws:
                reader = WsReader(ws)
                try:
                    ws.send_json({"type": "DISPATCH_SWARM", "job_id": "job-8", "intent": "compare laptops"})
                    synth = reader.recv_until(lambda m: isinstance(m, schemas.SynthesisUpdate), timeout=5.0)
                    assert isinstance(synth, schemas.SynthesisUpdate)
                finally:
                    reader.close()

        results.append(run_case("8. DISPATCH minimal payload", case_8))

        # 9. Invalid JSON and binary frame keep socket open
        def case_9() -> None:
            with client.websocket_connect("/ws/sess-9") as ws:
                reader = WsReader(ws)
                try:
                    ws.send_text("{bad json")
                    err = reader.recv_until(
                        lambda m: isinstance(m, schemas.Telemetry)
                        and m.agent_id == "gatekeeper"
                        and m.status == "BLOCKED"
                        and "invalid message" in m.message.lower(),
                        timeout=5.0,
                    )
                    assert isinstance(err, schemas.Telemetry)

                    ws.send_bytes(b"\x00\x01\x02")
                    bin_err = reader.recv_until(
                        lambda m: isinstance(m, schemas.Telemetry)
                        and m.agent_id == "gatekeeper"
                        and m.status == "BLOCKED"
                        and "invalid message" in m.message.lower(),
                        timeout=5.0,
                    )
                    assert isinstance(bin_err, schemas.Telemetry)

                    ws.send_json({"type": "DISPATCH_SWARM", "job_id": "job-9", "intent": "compare laptops"})
                    reader.recv_until(
                        lambda m: isinstance(m, schemas.Telemetry)
                        and m.agent_id == "scout_swarm"
                        and m.status == "RUNNING",
                        timeout=5.0,
                    )
                finally:
                    reader.close()

        results.append(run_case("9. Invalid JSON recovery", case_9))

        # 10. Benign form vs DOM injection
        def case_10() -> None:
            with client.websocket_connect("/ws/sess-10a") as ws:
                reader = WsReader(ws)
                try:
                    ws.send_json(
                        {
                            "type": "DISPATCH_SWARM",
                            "job_id": "job-10a",
                            "intent": "compare specs",
                            "context_url": swarm.FIXTURE_BENIGN_FORM_URL,
                        }
                    )
                    reader.recv_until(lambda m: isinstance(m, schemas.SynthesisUpdate), timeout=5.0)
                    try:
                        reader.recv_until(lambda m: isinstance(m, schemas.GatekeeperIntercept), timeout=0.5)
                        raise AssertionError("Unexpected GatekeeperIntercept for benign form")
                    except TimeoutError:
                        pass
                finally:
                    reader.close()

            with client.websocket_connect("/ws/sess-10b") as ws:
                reader = WsReader(ws)
                try:
                    ws.send_json(
                        {
                            "type": "DISPATCH_SWARM",
                            "job_id": "job-10b",
                            "intent": "compare specs",
                            "context_url": swarm.FIXTURE_DOM_INJECTION_URL,
                        }
                    )
                    reader.recv_until(lambda m: isinstance(m, schemas.SynthesisUpdate), timeout=5.0)
                    intercept = reader.recv_until(lambda m: isinstance(m, schemas.GatekeeperIntercept), timeout=5.0)
                    assert isinstance(intercept, schemas.GatekeeperIntercept)
                finally:
                    reader.close()

        results.append(run_case("10. Benign form vs DOM injection", case_10))

        # 11. build_targets mock vs real mode
        def case_11() -> None:
            mock_targets = swarm.build_targets("compare laptops", ["under 1500"], mock_fetch=True)
            assert swarm.FIXTURE_HIDDEN_INJECTION_URL not in mock_targets, mock_targets
            assert swarm.FIXTURE_BENIGN_FORM_URL not in mock_targets, mock_targets
            assert swarm.FIXTURE_SPEC_ALPHA_URL in mock_targets, mock_targets

            real_targets = swarm.build_targets("compare laptops", ["under 1500"], mock_fetch=False)
            assert len(real_targets) == 2, real_targets
            assert real_targets[0].startswith("https://html.duckduckgo.com"), real_targets
            assert real_targets[1].startswith("https://old.reddit.com"), real_targets

        results.append(run_case("11. build_targets mock vs real", case_11))

        # 12. discover_targets offline with MockTransport
        def case_12() -> None:
            https_target = "https://example.com/review"
            http_target = "http://insecure.example"
            fake_html = (
                "<html><body>"
                f'<a class="result__a" href="//duckduckgo.com/l/?uddg={quote_plus(https_target)}">Good</a>'
                f'<a class="result__a" href="//duckduckgo.com/l/?uddg={quote_plus(http_target)}">Bad</a>'
                "</body></html>"
            )

            def handler(request: httpx.Request) -> httpx.Response:
                return httpx.Response(200, text=fake_html)

            orig_validate = swarm.validate_public_https
            orig_validate_async = swarm.validate_public_https_async

            def scheme_only_validate(url: str, mock_fetch: bool | None = None) -> str:
                if not url.startswith("https://"):
                    raise ValueError(f"Only https permitted: {url}")
                return url

            async def scheme_only_validate_async(url: str, mock_fetch: bool | None = None) -> str:
                if not url.startswith("https://"):
                    raise ValueError(f"Only https permitted: {url}")
                return url

            swarm.validate_public_https = scheme_only_validate
            swarm.validate_public_https_async = scheme_only_validate_async
            try:
                async def run_discover() -> list[str]:
                    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as mock_client:
                        return await swarm.discover_targets(
                            "compare laptops",
                            [],
                            None,
                            mock_client,
                            mock_fetch=False,
                        )

                discovered = asyncio.run(run_discover())
                assert https_target in discovered, discovered
                assert http_target not in discovered, discovered
            finally:
                swarm.validate_public_https = orig_validate
                swarm.validate_public_https_async = orig_validate_async

        results.append(run_case("12. discover_targets offline", case_12))

        # 13. contract examples
        def case_13() -> None:
            dispatch_ex = {
                "type": "DISPATCH_SWARM",
                "job_id": "job_01",
                "intent": "Compare top 3 ANC headphones under 25k INR and check Reddit hinge issues",
                "constraints": ["under_25k_inr", "check_reddit_hinge"],
                "context_url": "https://example.com/product",
                "pinned_notes": [
                    {
                        "note_id": "nt_01",
                        "source_url": "https://example.com/review",
                        "text": "The hinge developed a hairline crack after 4 months.",
                    }
                ],
            }
            steer_ex = {
                "type": "STEER_SWARM",
                "job_id": "job_01",
                "delta_instruction": "Drop Sony XM5 and prioritize multipoint Bluetooth",
                "cancel_domains": ["sony.co.in"],
            }
            approval_ex = {
                "type": "APPROVAL_DECISION",
                "gate_id": "gate_99",
                "approved": True,
            }

            assert isinstance(schemas.parse_client_message(dispatch_ex), schemas.DispatchSwarm)
            assert isinstance(schemas.parse_client_message(steer_ex), schemas.SteerSwarm)
            assert isinstance(schemas.parse_client_message(approval_ex), schemas.ApprovalDecision)

            telemetry_ex = {
                "type": "TELEMETRY",
                "trace_id": "tr_9918a4c2",
                "agent_id": "scout_swarm",
                "status": "RUNNING",
                "message": "Tier-1 fetched 4 Reddit threads; escalating 1 JS page to warm Playwright",
                "latency_ms": 420,
                "workers_active": 3,
                "tabs_offloaded": 5,
            }
            synthesis_ex = {
                "type": "SYNTHESIS_UPDATE",
                "job_id": "job_01",
                "voice_brief": "Two models look solid, but Model A has recent Reddit hinge complaints. Want me to drop it?",
                "items": [
                    {
                        "name": "Model A",
                        "price": "₹22,990",
                        "pros": ["Strong ANC", "Lightweight"],
                        "cons": ["Hinge cracks reported"],
                        "url": "https://example.com/model-a",
                    }
                ],
                "evidence_cards": [
                    {
                        "source_url": "https://example.com/model-a",
                        "title": "Model A Official Specs",
                        "sanitized_excerpt": "Engineered for long flights with 30 hours of playback and adaptive noise cancellation...",
                        "quote_to_highlight": "30 hours of playback",
                    }
                ],
                "contradictions": [
                    {
                        "claim": "30-hour battery life",
                        "conflict": "User benchmarks average 18-20 hours with ANC on",
                        "source_url": "https://example.com/model-a",
                        "quote_to_highlight": "30 hours of playback",
                    }
                ],
                "mind_map": {
                    "nodes": [
                        {"id": "n1", "label": "ANC Headphones", "source_url": ""},
                        {"id": "n2", "label": "Model A Battery Conflict", "source_url": "https://example.com/model-a"},
                    ],
                    "edges": [
                        {"from": "n1", "to": "n2", "label": "contradicts"},
                    ],
                },
            }
            gatekeeper_ex = {
                "type": "GATEKEEPER_INTERCEPT",
                "gate_id": "gate_99",
                "decision": "FORBID_UNTIL_SIGNED",
                "cedar_rule": "forbid_untrusted_mutating_action",
                "action_type": "FORM_SUBMIT",
                "target_url": "https://example.com/checkout",
                "reason": "Untrusted web content attempted to trigger a state-changing form submission.",
                "action_diff": "POST /checkout with user session",
            }

            for ex in (telemetry_ex, synthesis_ex, gatekeeper_ex):
                parsed = CLOUD_ADAPTER.validate_python(ex)
                dumped = parsed.model_dump(by_alias=True)
                assert set(dumped.keys()) == set(ex.keys()), f"Key mismatch: {set(dumped.keys())} vs {set(ex.keys())}"

        results.append(run_case("13. contract examples", case_13))

        # 14. STEER with non-empty cancel_domains
        def case_14() -> None:
            with client.websocket_connect("/ws/test-s14") as ws:
                reader = WsReader(ws)
                try:
                    ws.send_json(
                        {
                            "type": "DISPATCH_SWARM",
                            "job_id": "job-s14",
                            "intent": "compare laptops",
                            "constraints": [],
                        }
                    )
                    ws.send_json(
                        {
                            "type": "STEER_SWARM",
                            "job_id": "job-s14",
                            "delta_instruction": "only reachable",
                            "cancel_domains": ["fixtures.mock"],
                        }
                    )
                    # Order-independent: the "no reachable sources" path sends COMPLETED before SYNTHESIS_UPDATE.
                    upd = comp = None
                    deadline = time.monotonic() + 5.0
                    while (upd is None or comp is None) and time.monotonic() < deadline:
                        m = reader.recv_until(
                            lambda m: isinstance(m, schemas.SynthesisUpdate)
                            or (isinstance(m, schemas.Telemetry)
                                and m.agent_id in ("scout_swarm", "synthesis")
                                and m.status == "COMPLETED"),
                            timeout=max(0.1, deadline - time.monotonic()),
                        )
                        if isinstance(m, schemas.SynthesisUpdate):
                            upd = m
                        else:
                            comp = m
                    assert isinstance(upd, schemas.SynthesisUpdate)
                    for card in upd.evidence_cards:
                        assert "fixtures.mock" not in card.source_url, card.source_url
                    assert isinstance(comp, schemas.Telemetry)
                    assert comp.workers_active == 0, comp.workers_active
                finally:
                    reader.close()

        results.append(run_case("14. STEER cancel_domains", case_14))

        # 15. Freeze: no gatekeeper COMPLETED before APPROVAL_DECISION
        def case_15() -> None:
            with client.websocket_connect("/ws/test-s15") as ws:
                reader = WsReader(ws)
                try:
                    ws.send_json(
                        {
                            "type": "DISPATCH_SWARM",
                            "job_id": "job-s15",
                            "intent": "buy the laptop now",
                            "constraints": [],
                        }
                    )
                    intercept = reader.recv_until(
                        lambda m: isinstance(m, schemas.GatekeeperIntercept), timeout=5.0
                    )
                    assert isinstance(intercept, schemas.GatekeeperIntercept)
                    try:
                        reader.recv_until(
                            lambda m: isinstance(m, schemas.Telemetry)
                            and m.agent_id == "gatekeeper"
                            and m.status == "COMPLETED",
                            timeout=0.5,
                        )
                        raise AssertionError("Received gatekeeper COMPLETED before APPROVAL_DECISION")
                    except TimeoutError:
                        pass
                    ws.send_json(
                        {
                            "type": "APPROVAL_DECISION",
                            "gate_id": intercept.gate_id,
                            "approved": True,
                        }
                    )
                    done = reader.recv_until(
                        lambda m: isinstance(m, schemas.Telemetry)
                        and m.agent_id == "gatekeeper"
                        and m.status == "COMPLETED",
                        timeout=5.0,
                    )
                    assert isinstance(done, schemas.Telemetry)
                finally:
                    reader.close()

        results.append(run_case("15. gatekeeper freeze before approval", case_15))

        # 16. FORM_SUBMIT via DOM-injection fixture & EXTERNAL_POST keyword
        def case_16() -> None:
            with client.websocket_connect("/ws/test-s16a") as ws:
                reader = WsReader(ws)
                try:
                    ws.send_json(
                        {
                            "type": "DISPATCH_SWARM",
                            "job_id": "job-s16a",
                            "intent": "inspect deal",
                            "constraints": [],
                            "context_url": swarm.FIXTURE_DOM_INJECTION_URL,
                        }
                    )
                    intercept = reader.recv_until(
                        lambda m: isinstance(m, schemas.GatekeeperIntercept), timeout=5.0
                    )
                    assert isinstance(intercept, schemas.GatekeeperIntercept)
                    assert intercept.action_type == "FORM_SUBMIT", intercept.action_type
                    ws.send_json(
                        {
                            "type": "APPROVAL_DECISION",
                            "gate_id": intercept.gate_id,
                            "approved": True,
                        }
                    )
                    done = reader.recv_until(
                        lambda m: isinstance(m, schemas.Telemetry)
                        and m.agent_id == "gatekeeper"
                        and m.status == "COMPLETED",
                        timeout=5.0,
                    )
                    assert isinstance(done, schemas.Telemetry)
                finally:
                    reader.close()

            with client.websocket_connect("/ws/test-s16b") as ws:
                reader = WsReader(ws)
                try:
                    ws.send_json(
                        {
                            "type": "DISPATCH_SWARM",
                            "job_id": "job-s16b",
                            "intent": "post a comment on the review",
                            "constraints": [],
                        }
                    )
                    intercept = reader.recv_until(
                        lambda m: isinstance(m, schemas.GatekeeperIntercept), timeout=5.0
                    )
                    assert isinstance(intercept, schemas.GatekeeperIntercept)
                    assert intercept.action_type == "EXTERNAL_POST", intercept.action_type
                finally:
                    reader.close()

        results.append(run_case("16. FORM_SUBMIT DOM-injection & EXTERNAL_POST", case_16))

        # 17. Keyword-precision unit test
        def case_17() -> None:
            negatives = [
                "in order to compare laptops",
                "check reddit post about battery",
                "read recent posts on forum",
                "order of magnitude faster",
                "check out the best headphones",
            ]
            for phrase in negatives:
                should, _, _, _ = main._detect_mutating_action(phrase, [], [])
                assert not should, f"False positive for: {phrase}"

            positives = [
                ("buy this laptop", "CHECKOUT_CLICK"),
                ("place an order", "CHECKOUT_CLICK"),
                ("submit the form", "FORM_SUBMIT"),
                ("post a comment", "EXTERNAL_POST"),
                ("reply to thread", "EXTERNAL_POST"),
                ("comment on review", "EXTERNAL_POST"),
            ]
            for phrase, expected_type in positives:
                should, action_type, _, _ = main._detect_mutating_action(phrase, [], [])
                assert should and action_type == expected_type, (phrase, should, action_type)

        results.append(run_case("17. keyword precision", case_17))

        # 18. Bot-wall unit test
        def case_18() -> None:
            def handler(request: httpx.Request) -> httpx.Response:
                return httpx.Response(202, text="<html><body>bots use DuckDuckGo too</body></html>")

            orig_validate_async = swarm.validate_public_https_async

            async def scheme_only_validate_async(url: str, mock_fetch: bool | None = None) -> str:
                if not url.startswith("https://"):
                    raise ValueError(f"Only https permitted: {url}")
                return url

            swarm.validate_public_https_async = scheme_only_validate_async
            try:
                async def run_fetch() -> gatekeeper.TaintedPayload:
                    transport = httpx.MockTransport(handler)
                    async with httpx.AsyncClient(transport=transport) as mock_client:
                        return await swarm.fetch_url("https://example.com/search", mock_client, mock_fetch=False)

                payload = asyncio.run(run_fetch())
                assert payload.text == "", f"Expected empty text on bot wall, got: {payload.text!r}"
            finally:
                swarm.validate_public_https_async = orig_validate_async

        results.append(run_case("18. bot-wall fetch_url", case_18))

        # 19. STEER while gate is pending emits withdrawn telemetry
        def case_19() -> None:
            with client.websocket_connect("/ws/test-s19") as ws:
                reader = WsReader(ws)
                try:
                    ws.send_json(
                        {
                            "type": "DISPATCH_SWARM",
                            "job_id": "job-s19",
                            "intent": "buy laptop now",
                            "constraints": [],
                        }
                    )
                    intercept = reader.recv_until(
                        lambda m: isinstance(m, schemas.GatekeeperIntercept), timeout=5.0
                    )
                    assert isinstance(intercept, schemas.GatekeeperIntercept)
                    ws.send_json(
                        {
                            "type": "STEER_SWARM",
                            "job_id": "job-s19",
                            "delta_instruction": "just compare",
                        }
                    )
                    withdrawn = reader.recv_until(
                        lambda m: isinstance(m, schemas.Telemetry)
                        and m.agent_id == "gatekeeper"
                        and m.status == "BLOCKED"
                        and "withdrawn" in m.message,
                        timeout=5.0,
                    )
                    assert isinstance(withdrawn, schemas.Telemetry)
                finally:
                    reader.close()

        results.append(run_case("19. STEER withdraws pending gate", case_19))

        # 20. Synthesis URL sanitization
        def case_20() -> None:
            upd = schemas.SynthesisUpdate(
                job_id="job-s20",
                voice_brief="brief",
                items=[
                    schemas.SynthesisItem(
                        name="Item",
                        price="$10",
                        pros=["good"],
                        cons=[],
                        url="http://insecure.example/item",
                    )
                ],
                evidence_cards=[
                    schemas.EvidenceCard(
                        source_url="javascript:alert(1)",
                        title="Card",
                        sanitized_excerpt="excerpt",
                        quote_to_highlight="excerpt",
                    )
                ],
                contradictions=[
                    schemas.ContradictionItem(
                        claim="a",
                        conflict="b",
                        source_url="https://allowed.example/ok",
                        quote_to_highlight="a",
                    )
                ],
                mind_map=schemas.MindMapData(
                    nodes=[schemas.MindMapNode(id="n1", label="N1", source_url="ftp://bad.example/x")],
                    edges=[],
                ),
            )
            sanitized = synthesis.sanitize_synthesis_urls(upd, allowed_urls={"https://allowed.example/ok"})
            assert sanitized.items[0].url == ""
            assert sanitized.evidence_cards[0].source_url == ""
            assert sanitized.contradictions[0].source_url == "https://allowed.example/ok"
            assert sanitized.mind_map.nodes[0].source_url == ""

        results.append(run_case("20. synthesis URL sanitization", case_20))

        # 21. pinned_notes over WS show up in contradictions or evidence
        def case_21() -> None:
            with client.websocket_connect("/ws/test-s21") as ws:
                reader = WsReader(ws)
                try:
                    ws.send_json(
                        {
                            "type": "DISPATCH_SWARM",
                            "job_id": "job-s21",
                            "intent": "compare laptops",
                            "constraints": [],
                            "pinned_notes": [
                                {
                                    "note_id": "note-1",
                                    "source_url": swarm.FIXTURE_SPEC_ALPHA_URL,
                                    "text": "User noted battery drained in 6 hours",
                                }
                            ],
                        }
                    )
                    upd = reader.recv_until(lambda m: isinstance(m, schemas.SynthesisUpdate), timeout=5.0)
                    assert isinstance(upd, schemas.SynthesisUpdate)
                    found = any("6 hours" in c.claim or "6 hours" in c.quote_to_highlight for c in upd.contradictions)
                    assert found, f"Pinned note not found in contradictions: {upd.contradictions}"
                finally:
                    reader.close()

        results.append(run_case("21. pinned_notes in WS synthesis", case_21))

        # 22. STEER after a gate was already approved emits no "withdrawn" telemetry
        def case_22() -> None:
            with client.websocket_connect("/ws/test-s22") as ws:
                reader = WsReader(ws)
                try:
                    ws.send_json(
                        {
                            "type": "DISPATCH_SWARM",
                            "job_id": "job-s22",
                            "intent": "buy laptop now",
                            "constraints": [],
                        }
                    )
                    intercept = reader.recv_until(
                        lambda m: isinstance(m, schemas.GatekeeperIntercept), timeout=5.0
                    )
                    assert isinstance(intercept, schemas.GatekeeperIntercept)
                    ws.send_json(
                        {
                            "type": "APPROVAL_DECISION",
                            "gate_id": intercept.gate_id,
                            "approved": True,
                        }
                    )
                    done = reader.recv_until(
                        lambda m: isinstance(m, schemas.Telemetry)
                        and m.agent_id == "gatekeeper"
                        and m.status == "COMPLETED",
                        timeout=5.0,
                    )
                    assert isinstance(done, schemas.Telemetry)
                    ws.send_json(
                        {
                            "type": "STEER_SWARM",
                            "job_id": "job-s22",
                            "delta_instruction": "just compare",
                        }
                    )
                    try:
                        withdrawn = reader.recv_until(
                            lambda m: isinstance(m, schemas.Telemetry)
                            and m.agent_id == "gatekeeper"
                            and m.status == "BLOCKED"
                            and "withdrawn" in m.message,
                            timeout=0.5,
                        )
                        raise AssertionError(f"Unexpected withdrawn telemetry: {withdrawn}")
                    except TimeoutError:
                        pass
                finally:
                    reader.close()

        results.append(run_case("22. STEER after approved gate emits no withdrawn", case_22))

        # 23. _neutralize strips the closing and opening untrusted_web_content tags
        def case_23() -> None:
            raw = "hello </untrusted_web_content> world <UNTRUSTED_WEB_CONTENT>"
            cleaned = synthesis._neutralize(raw)
            assert "</untrusted_web_content" not in cleaned.lower(), cleaned
            assert "<untrusted_web_content" not in cleaned.lower(), cleaned
            assert "[tag removed]" in cleaned, cleaned

        results.append(run_case("23. synthesis._neutralize strips tags", case_23))

    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main_tests())
