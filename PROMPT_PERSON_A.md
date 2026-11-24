# Build Prompt — Person A (Zero-Extension Floating WebKit HUD & ElevenLabs)

> **Instructions:** Hand this file alongside `SOURCE_OF_TRUTH.md` to Person A (or paste both into your AI coding assistant).

---

## Role & Ownership
You are building the entire `hud/` directory: an **ultra-lightweight, zero-extension floating WebKit HUD (Tauri v2)** that floats over Chrome, Safari, or any application and acts as a voice-first executive browsing assistant, strictly following `SOURCE_OF_TRUTH.md`.

## Hard Constraints
* **Allowed Dependencies ONLY:** Tauri v2 (`@tauri-apps/api`, `@tauri-apps/plugin-global-shortcut`, `@tauri-apps/plugin-opener`), TypeScript, React, Tailwind CSS, Vite, and `@elevenlabs/client`.
* **Zero Browser Extensions:** Do **NOT** build a Chrome/Safari extension or attempt DOM injection into external browsers. Everything renders inside the native WebKit HUD (~80–120 MB RAM) and hands off final URLs to the OS default browser.
* **Forbidden Complexity:** Do **NOT** add local WASM sanitizers, ONNX/local embedding models, heavy graph libraries (D3/Cytoscape), or custom `AudioWorklet` / raw WebRTC audio pipelines.
* **Isolation:** Do **NOT** touch anything inside `backend/`.
* **Offline Testability:** Implement a `VITE_MOCK_WS=true` mode in `wsClient.ts` that simulates realistic `TELEMETRY`, `SYNTHESIS_UPDATE`, and `GATEKEEPER_INTERCEPT` events locally so you can test the entire HUD without waiting for Person B.

---

## Modules to Build

### 1. `hud/src-tauri/` (Minimal Native WebKit Window Shell)
* Configure `tauri.conf.json` for a sleek floating HUD window:
  * `alwaysOnTop: true`, resizable floating dimensions (e.g., `960x680`), clean titlebar/frameless styling, and native WebKit rendering (`WKWebView` / `WebKitGTK` / `WebView2`).
* Register a global hotkey (`Alt+Space` / `Option+Space`) using `@tauri-apps/plugin-global-shortcut` to toggle/summon the floating HUD instantly over Chrome or Safari.
* Expose one tiny Rust command `get_hud_memory_mb()` (or safe fallback) so the HUD displays its live local memory footprint alongside `tabs_offloaded` from telemetry—proving flat local RAM while AWS runs the swarm.
* Enable `@tauri-apps/plugin-opener` so clicking **"Hand Off to Browser"** opens the single verified winning URL straight into the user's default browser (Safari/Chrome).

### 2. `hud/src/types.ts` & `hud/src/wsClient.ts`
* Mirror every Client → Cloud and Cloud → Client JSON schema from Section 3 of `SOURCE_OF_TRUTH.md` verbatim.
* Build a resilient WebSocket client connecting to `VITE_WS_URL` with auto-reconnect and a clean `VITE_MOCK_WS=true` simulator.

### 3. `hud/src/components/` (Executive Assistant UI + ElevenLabs WebRTC)
* **Voice Steering Dock (`VoiceDock.tsx`):**
  * Integrate `@elevenlabs/client` (`Conversation.startSession` using WebRTC) directly inside the HUD for full-duplex, interruptible voice steering.
  * Provide a **Silent Mode text input bar** + optional **Paste Context URL** input with 100% feature parity (typing dispatches the exact same `DISPATCH_SWARM` / `STEER_SWARM` payloads).
  * Register the 4 Client Tools from `SOURCE_OF_TRUTH.md`:
    1. `dispatch_swarm(intent, constraints)`
    2. `steer_swarm(delta_instruction, cancel_domains?)`
    3. `spotlight_evidence(source_url, quote, badge_text)`
    4. `handoff_to_browser(url)`
* **The Showing Stage (`ShowingStage.tsx`):**
  * Centerpiece panel displaying sanitized `evidence_cards` (readable source excerpts free of `X-Frame-Options` iframe blocks) and structured `SYNTHESIS_UPDATE.items` comparison cards.
  * **Voice-Synced Spotlighting:** When `spotlight_evidence` fires (or when the user clicks a contradiction card), auto-scroll to the matching `evidence_card`, highlight the exact `quote_to_highlight` substring in bright amber/cyan, and attach a floating **Contradiction Badge**.
  * Include a prominent **"Open Verified Link in Browser"** button on every winning item/evidence card (calls Tauri `opener`) plus a quick **"Pin Note"** button to save key excerpts into `pinned_notes` for follow-up queries.
  * Include a 1-click **"Narrated / High-Contrast Mode"** accessibility toggle for effortless reading.
* **Citation Mind Map (`MindMap.tsx`):**
  * Lightweight custom SVG/HTML node-edge graph rendering `mind_map.nodes` and `mind_map.edges` with clickable nodes that spotlight the matching source in the Showing Stage.
* **Glass-Box Monitor & Gatekeeper Approval Card (`MonitorDrawer.tsx`):**
  * Collapsible right-hand telemetry strip showing live `TELEMETRY` events (`agent_id`, `status`, `latency_ms`, `workers_active`), **Local HUD RAM (MB)**, and **Tabs Offloaded to AWS**.
  * Whenever `GATEKEEPER_INTERCEPT` arrives, render a **blocking high-contrast red Approval Card** showing `cedar_rule`, `action_type`, `reason`, and `action_diff`, with **Approve** and **Reject** buttons (and voice confirmation support) that send `APPROVAL_DECISION` back over WebSocket.

---

## Verification Checklist Before Handoff
- [ ] `npm run tauri dev` launches a crisp, always-on-top WebKit HUD with zero console or Rust build errors.
- [ ] Pressing `Alt+Space` / `Option+Space` toggles the HUD cleanly over Chrome or Safari.
- [ ] With `VITE_MOCK_WS=true`, voice/text dispatch, mid-flight steering, Showing Stage quote spotlighting, Mind Map rendering, Browser Handoff, and the Gatekeeper Approval Card all work end-to-end.