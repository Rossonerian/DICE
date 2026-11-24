# Build Prompt — Person B (AWS Cloud Swarm, Bedrock Synthesis & Gatekeeper)

> **Instructions:** Hand this file alongside `SOURCE_OF_TRUTH.md` to Person B (or paste both into your AI coding assistant).

---

## Role & Ownership
You are building the entire `backend/` directory of our AWS-powered Multi-Agent Orchestrator using `SOURCE_OF_TRUTH.md` as your strict technical contract.

## Hard Constraints
* **Allowed Dependencies ONLY:** Python 3.11+, `fastapi`, `uvicorn[standard]`, `boto3`, `httpx`, `beautifulsoup4`, `playwright`, `pydantic`, and `python-dotenv`.
* **Forbidden Complexity:** Do **NOT** use ephemeral AWS Fargate cold-start containers, Docker-in-Docker, or external vector databases. Keep the server runnable locally via `uvicorn main:app --reload` AND deployable as a single AWS EC2 / App Runner / ECS container.
* **Isolation:** Do **NOT** touch anything inside `extension/`.
* **Offline Testability:** Support a `MOCK_BEDROCK=true` environment flag that returns realistic, schema-valid `SYNTHESIS_UPDATE` JSON if AWS credentials are unavailable during local testing.

---

## Modules to Build

### 1. `backend/schemas.py`
* Implement strict Pydantic v2 models mirroring every Client → Cloud and Cloud → Client message in Section 3 of `SOURCE_OF_TRUTH.md` verbatim.

### 2. `backend/main.py` (FastAPI + WebSocket Orchestrator)
* Expose `GET /health` (returns pool status + active jobs) and `WS /ws/{session_id}`.
* Manage active `asyncio.Task`s per `job_id`.
* **Mid-Flight Barge-In Cancellation:** When `STEER_SWARM` arrives on the WebSocket, immediately cancel running scout tasks matching `cancel_domains` (or superseded constraints), emit a `TELEMETRY` event with `status: "CANCELLED"`, and spawn updated scouts without blocking the socket loop.
* Maintain a pending-approval registry (`dict[str, asyncio.Event]`) keyed by `gate_id` so `APPROVAL_DECISION` resumes or aborts paused Gatekeeper actions immediately.

### 3. `backend/swarm.py` (Two-Tier Scout Swarm)
* **Tier 1 (Fast Lane, <1.5s):** Async `httpx` parallel fetcher + `BeautifulSoup` clean-text extractor for fast HTML/forum/doc pages so `TELEMETRY` updates and initial findings stream immediately with zero dead air.
* **Tier 2 (Pre-Warmed Browser Pool):** Inside FastAPI's `lifespan` startup hook, launch **one** headless Chromium instance via Playwright and keep a pool of **2–3 reusable `BrowserContext`s** warm in memory (zero cold-start delay, isolated cookies per job). Escalate to Tier 2 only when Tier 1 returns sparse JS-rendered content or an interactive check is requested.
* Every fetched chunk must be passed through `gatekeeper.sanitize_html()` before returning to the orchestrator.

### 4. `backend/gatekeeper.py` (Sanitizer + Taint Tracking + Cedar Policy Gate)
* **DOM Sanitization:** Strip `<script>`, `<style>`, `noscript`, HTML comments, and hidden elements (`display:none`, `visibility:hidden`, `opacity:0`, `font-size:0`) before any text reaches AWS Bedrock.
* **Taint Tracking:** Wrap every scraped payload in a typed envelope with `source_trust = "UNTRUSTED_WEB"` so downstream tool calls know whether their trigger originated from untrusted web content.
* **Deterministic Cedar Policy Evaluator:**
  * Implement declarative Cedar-style authorization rules (structured to plug directly into AWS Bedrock AgentCore Policy, with a deterministic Python Cedar-rule evaluator as zero-dependency runtime fallback):
    * `permit` public HTTPS read-only swarm fetches and synthesis.
    * `forbid` (pause execution and emit `GATEKEEPER_INTERCEPT` with `decision: "FORBID_UNTIL_SIGNED"`) whenever an action of class `FORM_SUBMIT`, `CHECKOUT_CLICK`, or `EXTERNAL_POST` is requested from a flow containing `UNTRUSTED_WEB` taint.
  * Hold execution on an `asyncio.Event` until `APPROVAL_DECISION` returns `approved: true` (or abort cleanly and emit `status: "BLOCKED"` if `false`).

### 5. `backend/synthesis.py` (AWS Bedrock Dual-Model Conflict Resolver)
* Use `boto3` (`bedrock-runtime` Converse API) with model IDs loaded from `.env`.
* **Stage 1 (Fast Router — `BEDROCK_ROUTER_MODEL_ID`):** Extract atomic claims, prices, pros/cons, and exact verbatim `quote_to_highlight` strings from each sanitized source chunk at low latency.
* **Stage 2 (Reasoning Model — `BEDROCK_REASONING_MODEL_ID`):** Cross-reference overlapping claims across sources (plus any user `clips`) to detect genuine contradictions (e.g., official spec vs. user review), write a concise 1–2 sentence `voice_brief` for ElevenLabs, and output strict JSON matching `SYNTHESIS_UPDATE` (`items`, `contradictions`, `mind_map`).

### 6. `backend/test_ws.py` (End-to-End Verification Script)
* Write a standalone async test script (using `websockets` or FastAPI's `TestClient`) that connects to `/ws/test_session`, sends `DISPATCH_SWARM` → sends `STEER_SWARM` mid-flight → triggers a `GATEKEEPER_INTERCEPT` → sends `APPROVAL_DECISION`, and asserts that every emitted JSON payload passes Pydantic validation.

---

## Verification Checklist Before Handoff
- [ ] `uvicorn main:app --port 8000` starts cleanly with the warm Playwright pool initialized.
- [ ] `python test_ws.py` passes all 3 outbound schemas (`TELEMETRY`, `SYNTHESIS_UPDATE`, `GATEKEEPER_INTERCEPT`) with zero errors.
- [ ] Mid-flight `STEER_SWARM` cancels active scout tasks and emits `status: "CANCELLED"` telemetry within 200ms.
- [ ] Untrusted page content attempting a `FORM_SUBMIT` or `CHECKOUT_CLICK` reliably freezes behind `GATEKEEPER_INTERCEPT` until `APPROVAL_DECISION` is received.