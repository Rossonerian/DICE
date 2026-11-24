# Build Prompt — Person A (Client Extension, ElevenLabs Voice & Visual Stage)

> **Instructions:** Hand this file alongside `SOURCE_OF_TRUTH.md` to Person A (or paste both into your AI coding assistant).

---

## Role & Ownership
You are building the entire `extension/` directory of our Chrome Manifest V3 Agentic Research & Voice-Steering Extension using `SOURCE_OF_TRUTH.md` as your strict technical contract.

## Hard Constraints
* **Allowed Dependencies ONLY:** Chrome Manifest V3, TypeScript, React, Tailwind CSS, Vite (with `@crxjs/vite-plugin` or plain `esbuild`), and `@elevenlabs/client`.
* **Forbidden Complexity:** Do **NOT** add Rust/WASM, ONNX, local vector/embedding libraries, heavy graph libraries (like D3/Cytoscape), or custom `AudioWorklet` / Offscreen WebRTC pipelines.
* **Isolation:** Do **NOT** touch anything inside `backend/`.
* **Offline Testability:** Implement a `VITE_MOCK_WS=true` mode that simulates realistic `TELEMETRY`, `SYNTHESIS_UPDATE`, and `GATEKEEPER_INTERCEPT` WebSocket events locally so you can build and verify the entire UI without waiting for Person B.

---

## Modules to Build

### 1. `extension/src/types.ts`
* Mirror every Client → Cloud and Cloud → Client JSON schema from Section 3 of `SOURCE_OF_TRUTH.md` verbatim using strict TypeScript interfaces and discriminated unions.

### 2. `extension/manifest.json` & `extension/src/background.ts` (Service Worker + Tab-Architect)
* Configure Manifest V3 permissions: `sidePanel`, `tabs`, `activeTab`, `scripting`, `contextMenus`, `storage`.
* Maintain a resilient WebSocket client to `VITE_WS_URL` with automatic exponential backoff reconnect, relaying messages cleanly between the Side Panel and the backend.
* **Tab-Architect (RAM Saver):**
  * Expose a one-click `"Offload & Save RAM"` action triggered from the Side Panel.
  * Serialize inactive tabs into lightweight Memory Cards (`url`, `title`, `timestamp`) in `chrome.storage.local`, group related tabs via `chrome.tabs.group()`, and hibernate inactive tabs via `chrome.tabs.discard()`.
  * Calculate and emit an estimated RAM-saved metric (e.g., `~180 MB per discarded tab`) to the Side Panel.
* **One-Click Research Clipping:**
  * Register a right-click Context Menu item `"Pin to Research Graph"` that captures selected text, page title, and URL into a `ClipRecord` in `chrome.storage.local` and attaches saved clips to the next `DISPATCH_SWARM` payload.

### 3. `extension/src/content.ts` (Morph — Closed Shadow DOM Spotlight)
* Listen for `SPOTLIGHT_QUOTE` messages from the Side Panel / Service Worker.
* Locate the matching text node on the page (case-insensitive substring match fallback if exact range fails), smooth-scroll it into view, and mount an **isolated Shadow DOM (`mode: 'closed'`)** highlight box + floating Contradiction Badge so host page scripts cannot read or alter it.
* Include a toggleable `"Focus Mode"` message handler that hides common ad/sidebar clutter (`aside`, `[role="complementary"]`, fixed promo banners) via non-destructive CSS visibility rules.

### 4. `extension/src/sidepanel/` (Executive Assistant UI + ElevenLabs WebRTC)
* **ElevenLabs Conversational AI (WebRTC):**
  * Integrate `@elevenlabs/client` (`Conversation.startSession` using WebRTC) directly in the Side Panel for full-duplex, interruptible voice steering.
  * Provide a **Silent Mode text input bar** with 100% feature parity (typing dispatches the exact same `DISPATCH_SWARM` / `STEER_SWARM` payloads).
  * Register the 3 Client Tools defined in `SOURCE_OF_TRUTH.md`:
    1. `dispatch_swarm(intent, constraints)`
    2. `steer_swarm(delta_instruction, cancel_domains?)`
    3. `spotlight_quote(url, quote, badge_text)`
* **Clean 4-Section Side Panel Layout:**
  1. **Voice Orb & Transcript Dock:** Compact header/footer showing live mic state, barge-in indicator, RAM saved badge, and silent text input.
  2. **Comparison & Contradiction Cards:** Renders `SYNTHESIS_UPDATE.items` (pros/cons/price/link) and clickable `contradictions` cards. Clicking a contradiction opens or focuses `source_url` and triggers `SPOTLIGHT_QUOTE` in `content.ts`.
  3. **Mind Map View:** Lightweight custom SVG/HTML node-edge graph rendering `mind_map.nodes` and `mind_map.edges` with clickable source links.
  4. **Glass-Box Monitor & Gatekeeper Approval Card:** Live scrolling feed of `TELEMETRY` events (`agent_id`, `status`, `latency_ms`, `workers_active`) plus a **blocking high-contrast red Approval Card** whenever `GATEKEEPER_INTERCEPT` arrives, showing `cedar_rule`, `action_type`, `reason`, and `action_diff`, with **Approve** and **Reject** buttons that send `APPROVAL_DECISION` over WebSocket.

---

## Verification Checklist Before Handoff
- [ ] `npm run build` completes with zero TypeScript or bundler errors.
- [ ] `extension/dist/` loads unpacked in `chrome://extensions` with zero CSP or runtime console errors.
- [ ] With `VITE_MOCK_WS=true`, all 4 Side Panel views, the Shadow DOM spotlight on a live webpage, Tab-Architect discarding, and the Gatekeeper Approval Card work end-to-end.