# Source of Truth — Zero-Extension Floating WebKit HUD & AWS Swarm

This document is the locked architectural and wire-protocol contract for a zero-conflict, two-person build. Both developers must build strictly against these schemas so neither blocks the other.

---

## 1. Architecture & Minimal Dependency Stack

We are building an **ultra-lightweight, zero-extension floating WebKit HUD (Tauri v2)** that acts as a voice-first executive browsing assistant over Chrome, Safari, or any browser—slashing local RAM bloat by intercepting multi-site research *before* tabs ever spawn locally and offloading parallel browsing to an **AWS Cloud Orchestrator**.

To prevent build-time friction and keep client RAM flat (~80–120 MB), we eliminate browser extensions, Rust/WASM sanitizers, local ONNX/HNSW vector indexes, custom `AudioWorklet`/VAD pipelines, and cold-start Fargate containers:

* **Person A — Floating WebKit HUD (`hud/`):**
  * **Stack:** Tauri v2 (thin Rust shell wrapping native OS WebKit: `WKWebView` on macOS / `WebKitGTK` on Linux / `WebView2` on Windows), TypeScript, React, Tailwind CSS, `@elevenlabs/client` (WebRTC Conversational AI).
  * **Frontend Dependencies:** `react`, `react-dom`, `@elevenlabs/client`, `tailwindcss`, `@tauri-apps/api`, `@tauri-apps/plugin-global-shortcut`, `@tauri-apps/plugin-opener`.
  * **Zero-Cookie Isolation:** Never injects into Chrome/Safari profiles. Renders sanitized evidence and voice-synced highlights inside its own **Showing Stage**, and hands off only the single verified final URL to Chrome/Safari via OS default-browser launch.
* **Person B — Cloud Plane (`backend/`):**
  * **Stack:** Python 3.11+, FastAPI + Uvicorn (HTTP + WebSocket Secure), `boto3` (AWS Bedrock Dual-Model + Cedar Policy evaluation), `httpx` + `beautifulsoup4` (Tier-1 fast search/HTML fetch), `playwright` (Tier-2 pre-warmed browser pool—2–3 persistent contexts kept warm in memory, zero cold starts).
  * **Backend Dependencies (8):** `fastapi`, `uvicorn[standard]`, `boto3`, `httpx`, `beautifulsoup4`, `playwright`, `pydantic`, `python-dotenv`.

---

## 2. Zero-Conflict Repo Ownership

```text
repo-root/
├── SOURCE_OF_TRUTH.md        # Locked contract (shared)
├── PROMPT_PERSON_A.md        # Build instructions for Person A (Tauri WebKit HUD)
├── PROMPT_PERSON_B.md        # Build instructions for Person B (AWS Cloud Backend)
├── .env.example              # Shared environment variable template
├── hud/                      # PERSON A OWNS 100%
│   ├── src-tauri/            # Minimal Tauri v2 Rust config (always-on-top, hotkey, opener, RAM stat)
│   └── src/
│       ├── wsClient.ts       # Resilient WebSocket client + VITE_MOCK_WS fallback
│       ├── types.ts          # Mirrors Section 3 schemas verbatim
│       └── components/       # Voice Orb (ElevenLabs WebRTC), Showing Stage, Mind Map, Monitor & Gatekeeper
└── backend/                  # PERSON B OWNS 100%
    ├── main.py               # FastAPI app + /ws/{session_id} + /health
    ├── swarm.py              # Tier-1 httpx fetch + Tier-2 warm Playwright pool + cancellation tokens
    ├── synthesis.py          # AWS Bedrock Dual-Model (Fast Router + Reasoning Conflict Resolver)
    ├── gatekeeper.py         # HTML/hidden-text sanitizer + Taint tagger + Cedar policy evaluator
    ├── schemas.py            # Mirrors Section 3 schemas verbatim
    └── test_ws.py            # End-to-end WebSocket verification script
```

---

## 3. Locked Wire Contracts

Do not modify any field names or enum values below without both developers agreeing and updating `hud/src/types.ts` and `backend/schemas.py` simultaneously.

### A. WebSocket Endpoint
* Local Dev: `ws://localhost:8000/ws/{session_id}`
* Production / AWS: `wss://<aws-host>/ws/{session_id}`

### B. Client → Cloud Messages (`hud` sends, `backend` handles)

```json
// 1. Start or update a swarm job
{
  "type": "DISPATCH_SWARM",
  "job_id": "job_01",
  "intent": "Compare top 3 ANC headphones under 25k INR and check Reddit hinge issues",
  "constraints": ["under_25k_inr", "check_reddit_hinge"],
  "context_url": "https://example.com/product",
  "pinned_notes": [
    {
      "note_id": "nt_01",
      "source_url": "https://example.com/review",
      "text": "The hinge developed a hairline crack after 4 months."
    }
  ]
}
```

```json
// 2. Mid-flight voice barge-in steering (cancels stale workers immediately)
{
  "type": "STEER_SWARM",
  "job_id": "job_01",
  "delta_instruction": "Drop Sony XM5 and prioritize multipoint Bluetooth",
  "cancel_domains": ["sony.co.in"]
}
```

```json
// 3. User decision on a Gatekeeper Cedar approval card
{
  "type": "APPROVAL_DECISION",
  "gate_id": "gate_99",
  "approved": true
}
```

### C. Cloud → Client Messages (`backend` emits, `hud` renders)

```json
// 1. Live telemetry & Glass-Box Monitor event
{
  "type": "TELEMETRY",
  "trace_id": "tr_9918a4c2",
  "agent_id": "scout_swarm",
  "status": "RUNNING",
  "message": "Tier-1 fetched 4 Reddit threads; escalating 1 JS page to warm Playwright",
  "latency_ms": 420,
  "workers_active": 3,
  "tabs_offloaded": 5
}
```
*Allowed `agent_id` values:* `"scout_swarm" | "synthesis" | "gatekeeper"`  
*Allowed `status` values:* `"RUNNING" | "COMPLETED" | "CANCELLED" | "BLOCKED"`

```json
// 2. Synthesis result (renders Showing Stage evidence, comparison, citations & mind map)
{
  "type": "SYNTHESIS_UPDATE",
  "job_id": "job_01",
  "voice_brief": "Two models look solid, but Model A has recent Reddit hinge complaints. Want me to drop it?",
  "items": [
    {
      "name": "Model A",
      "price": "₹22,990",
      "pros": ["Strong ANC", "Lightweight"],
      "cons": ["Hinge cracks reported"],
      "url": "https://example.com/model-a"
    }
  ],
  "evidence_cards": [
    {
      "source_url": "https://example.com/model-a",
      "title": "Model A Official Specs",
      "sanitized_excerpt": "Engineered for long flights with 30 hours of playback and adaptive noise cancellation...",
      "quote_to_highlight": "30 hours of playback"
    }
  ],
  "contradictions": [
    {
      "claim": "30-hour battery life",
      "conflict": "User benchmarks average 18-20 hours with ANC on",
      "source_url": "https://example.com/model-a",
      "quote_to_highlight": "30 hours of playback"
    }
  ],
  "mind_map": {
    "nodes": [
      { "id": "n1", "label": "ANC Headphones", "source_url": "" },
      { "id": "n2", "label": "Model A Battery Conflict", "source_url": "https://example.com/model-a" }
    ],
    "edges": [
      { "from": "n1", "to": "n2", "label": "contradicts" }
    ]
  }
}
```

```json
// 3. Gatekeeper Cedar Intercept (freezes mutating/tainted action until approved)
{
  "type": "GATEKEEPER_INTERCEPT",
  "gate_id": "gate_99",
  "decision": "FORBID_UNTIL_SIGNED",
  "cedar_rule": "forbid_untrusted_mutating_action",
  "action_type": "FORM_SUBMIT",
  "target_url": "https://example.com/checkout",
  "reason": "Untrusted web content attempted to trigger a state-changing form submission.",
  "action_diff": "POST /checkout with user session"
}
```
*Allowed `action_type` values:* `"FORM_SUBMIT" | "CHECKOUT_CLICK" | "EXTERNAL_POST"`

### D. ElevenLabs Client Tools (Registered in Floating HUD)
Person A wires these 4 ElevenLabs WebRTC Client Tools directly to the HUD's WebSocket and Showing Stage:
1. `dispatch_swarm(intent: string, constraints: string[])` → sends `DISPATCH_SWARM` over WSS and returns the initial Tier-1 `voice_brief` string so the voice agent can speak immediately.
2. `steer_swarm(delta_instruction: string, cancel_domains?: string[])` → sends `STEER_SWARM` over WSS to abort and redirect live cloud workers mid-sentence.
3. `spotlight_evidence(source_url: string, quote: string, badge_text: string)` → focuses the matching `evidence_card` inside the HUD's **Showing Stage**, smooth-scrolls to `quote`, and applies a glowing highlight + Contradiction Badge.
4. `handoff_to_browser(url: string)` → opens the single verified winning URL directly in the user's default browser (Safari/Chrome) via Tauri's `opener` plugin.

---

## 4. Shared Environment Variables (`.env.example`)

```env
# Person A (hud/.env)
VITE_WS_URL=ws://localhost:8000/ws/demo1
VITE_ELEVENLABS_AGENT_ID=your_elevenlabs_agent_id
VITE_MOCK_WS=false

# Person B (backend/.env)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret
BEDROCK_ROUTER_MODEL_ID=amazon.nova-lite-v1:0
BEDROCK_REASONING_MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0
MOCK_BEDROCK=false
```

---

## 5. 10-Minute Integration Checklist

1. **Person B** starts `uvicorn main:app --port 8000` and runs `python test_ws.py` to confirm `TELEMETRY`, `SYNTHESIS_UPDATE`, and `GATEKEEPER_INTERCEPT` validate cleanly.
2. **Person A** sets `VITE_MOCK_WS=false`, points `VITE_WS_URL` to `ws://localhost:8000/ws/demo1`, adds the ElevenLabs Agent ID, and runs `npm run tauri dev`.
3. **End-to-End Smoke Test:**
   * Press `Alt+Space` (or `Option+Space`) over Chrome or Safari → HUD floats cleanly above the browser with ~100 MB RAM footprint.
   * Speak a query → confirm `TELEMETRY` cards stream live and `SYNTHESIS_UPDATE` populates the Showing Stage, Comparison cards, and Mind Map.
   * Interrupt mid-sentence → confirm `STEER_SWARM` emits a `CANCELLED` telemetry event and updates results.
   * Click a contradiction → confirm the Showing Stage spotlights the exact quote; click **"Open in Browser"** → confirm the verified URL hands off cleanly to Chrome/Safari.
   * Trigger a form/checkout action → confirm the red `GATEKEEPER_INTERCEPT` card blocks execution until approved.