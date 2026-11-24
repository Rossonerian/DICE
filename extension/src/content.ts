import type { ExtensionMessage } from "./types";

const INIT_FLAG = "__diceContentScriptInitialized";
const SPOTLIGHT_HOST_ID = "dice-spotlight-host";
const FOCUS_STYLE_ID = "dice-focus-mode-style";

const IGNORED_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "HEAD",
  "TEXTAREA",
  "SELECT",
  "OPTION",
  "TITLE",
]);

const INLINE_DISPLAY_VALUES = new Set([
  "inline",
  "contents",
  "inline-block",
  "inline-flex",
  "inline-grid",
  "ruby",
  "ruby-base",
  "ruby-text",
]);

const FOCUS_MODE_CSS = `
aside:not(#${SPOTLIGHT_HOST_ID}),
[role="complementary"]:not(#${SPOTLIGHT_HOST_ID}),
[id*="sidebar" i]:not(html):not(body):not(main):not(#${SPOTLIGHT_HOST_ID}),
[class*="sidebar" i]:not(html):not(body):not(main):not(#${SPOTLIGHT_HOST_ID}),
[class*="promo" i]:not(html):not(body):not(main):not(#${SPOTLIGHT_HOST_ID}),
[class*="banner" i]:not(html):not(body):not(main):not(#${SPOTLIGHT_HOST_ID}),
[class*="ad-slot" i]:not(html):not(body):not(main):not(#${SPOTLIGHT_HOST_ID}),
[aria-label*="advertisement" i]:not(html):not(body):not(main):not(#${SPOTLIGHT_HOST_ID}) {
  display: none !important;
}
`.trim();

const SPOTLIGHT_SHADOW_CSS = `
:host {
  all: initial;
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483647;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

.dice-overlay-root {
  position: fixed;
  inset: 0;
  pointer-events: none;
}

.dice-boxes-layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
}

.dice-highlight-box {
  position: fixed;
  pointer-events: none;
  box-sizing: border-box;
  border-radius: 5px;
  background: rgba(245, 158, 11, 0.16);
  border: 2px solid rgba(245, 158, 11, 0.96);
  box-shadow:
    0 0 0 1px rgba(34, 211, 238, 0.55),
    0 0 18px rgba(245, 158, 11, 0.45),
    inset 0 0 10px rgba(34, 211, 238, 0.14);
  animation: dice-spotlight-pulse 2s ease-in-out infinite;
}

@keyframes dice-spotlight-pulse {
  0%, 100% {
    box-shadow:
      0 0 0 1px rgba(34, 211, 238, 0.55),
      0 0 16px rgba(245, 158, 11, 0.42),
      inset 0 0 8px rgba(34, 211, 238, 0.12);
  }
  50% {
    box-shadow:
      0 0 0 2px rgba(34, 211, 238, 0.85),
      0 0 24px rgba(245, 158, 11, 0.7),
      inset 0 0 12px rgba(34, 211, 238, 0.22);
  }
}

.dice-badge {
  position: fixed;
  pointer-events: auto;
  box-sizing: border-box;
  min-width: 220px;
  max-width: min(340px, calc(100vw - 24px));
  background: rgba(11, 17, 32, 0.96);
  color: #f8fafc;
  border: 1.5px solid rgba(245, 158, 11, 0.88);
  border-radius: 10px;
  padding: 10px 12px;
  box-shadow:
    0 14px 34px rgba(0, 0, 0, 0.6),
    0 0 22px rgba(245, 158, 11, 0.24);
  backdrop-filter: blur(10px);
  z-index: 2;
}

.dice-badge-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 5px;
}

.dice-badge-title-wrap {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.dice-badge-dot {
  width: 8px;
  height: 8px;
  border-radius: 9999px;
  background: #f59e0b;
  box-shadow: 0 0 8px #f59e0b;
  flex-shrink: 0;
}

.dice-badge-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #fbbf24;
  line-height: 1.2;
}

.dice-badge-dismiss {
  appearance: none;
  border: 1px solid rgba(148, 163, 184, 0.35);
  background: rgba(30, 41, 59, 0.85);
  color: #e2e8f0;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  font-size: 15px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}

.dice-badge-dismiss:hover {
  background: rgba(239, 68, 68, 0.25);
  border-color: rgba(248, 113, 113, 0.8);
  color: #ffffff;
}

.dice-badge-dismiss:focus-visible {
  outline: 2px solid #22d3ee;
  outline-offset: 1px;
}

.dice-badge-body {
  font-size: 12.5px;
  line-height: 1.45;
  color: #e2e8f0;
  word-break: break-word;
}
`.trim();

interface DomCharPos {
  node: Text;
  startOffset: number;
  endOffset: number;
}

interface NormalizedTextIndex {
  text: string;
  lowerText: string;
  foldedLowerText: string;
  posMap: DomCharPos[];
}

interface RawTextSegment {
  node: Text;
  startInFlat: number;
  endInFlat: number;
}

interface ActiveSpotlight {
  host: HTMLDivElement;
  range: Range;
  boxesLayer: HTMLDivElement;
  badgeEl: HTMLDivElement;
  cleanup: () => void;
}

let activeSpotlight: ActiveSpotlight | null = null;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function safeLowerChar(ch: string): string {
  const lower = ch.toLowerCase();
  return lower.length === 1 ? lower : lower[0];
}

function foldTypographicChar(ch: string): string {
  switch (ch) {
    case "\u2018":
    case "\u2019":
    case "\u201A":
    case "\u2032":
      return "'";
    case "\u201C":
    case "\u201D":
    case "\u201E":
    case "\u2033":
      return '"';
    case "\u2013":
    case "\u2014":
    case "\u2212":
      return "-";
    default:
      return ch;
  }
}

function foldTypographicLowerString(str: string): string {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    out += safeLowerChar(foldTypographicChar(str[i]));
  }
  return out;
}

function safeLowerString(str: string): string {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    out += safeLowerChar(str[i]);
  }
  return out;
}

function isElementVisible(
  el: Element,
  cache: WeakMap<Element, boolean>
): boolean {
  const cached = cache.get(el);
  if (cached !== undefined) return cached;

  let visible = true;
  if (
    IGNORED_TAGS.has(el.tagName.toUpperCase()) ||
    el.id === SPOTLIGHT_HOST_ID ||
    (el as HTMLElement).hidden === true
  ) {
    visible = false;
  } else {
    const style = window.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.opacity === "0"
    ) {
      visible = false;
    } else if (el.parentElement) {
      visible = isElementVisible(el.parentElement, cache);
    }
  }

  cache.set(el, visible);
  return visible;
}

function getBlockContainer(
  el: Element,
  displayCache: WeakMap<Element, string>
): Element {
  let cur: Element | null = el;
  while (cur && cur.parentElement) {
    let display = displayCache.get(cur);
    if (display === undefined) {
      display = window.getComputedStyle(cur).display;
      displayCache.set(cur, display);
    }
    if (!INLINE_DISPLAY_VALUES.has(display)) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return cur ?? el;
}

function collectVisibleTextNodes(): Text[] {
  const root = document.body ?? document.documentElement;
  if (!root) return [];

  const visibilityCache = new WeakMap<Element, boolean>();
  const nodes: Text[] = [];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      if (node.nodeType !== Node.TEXT_NODE) return NodeFilter.FILTER_REJECT;
      const textNode = node as Text;
      if (textNode.data.length === 0) return NodeFilter.FILTER_REJECT;
      const parent = textNode.parentElement;
      if (!parent || !isElementVisible(parent, visibilityCache)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let current = walker.nextNode();
  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }
  return nodes;
}

function getValidRangeRects(range: Range): DOMRect[] {
  const raw = Array.from(range.getClientRects()).filter(
    (r) => r.width >= 1 && r.height >= 1
  );
  const deduped: DOMRect[] = [];
  for (const rect of raw) {
    const duplicate = deduped.some(
      (existing) =>
        Math.abs(existing.left - rect.left) < 1 &&
        Math.abs(existing.top - rect.top) < 1 &&
        Math.abs(existing.width - rect.width) < 1 &&
        Math.abs(existing.height - rect.height) < 1
    );
    if (!duplicate) {
      deduped.push(rect);
    }
  }
  return deduped;
}

function hasVisibleRect(range: Range): boolean {
  if (getValidRangeRects(range).length > 0) return true;
  const bound = range.getBoundingClientRect();
  return bound.width >= 1 && bound.height >= 1;
}

function findExactSingleNodeMatch(
  nodes: Text[],
  quote: string
): Range | null {
  let fallback: Range | null = null;
  for (const node of nodes) {
    let searchFrom = 0;
    while (searchFrom <= node.data.length - quote.length) {
      const idx = node.data.indexOf(quote, searchFrom);
      if (idx === -1) break;
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + quote.length);
      if (hasVisibleRect(range)) return range;
      if (!fallback) fallback = range;
      searchFrom = idx + 1;
    }
  }
  return fallback;
}

function findSegmentIndex(
  segments: RawTextSegment[],
  flatOffset: number
): number {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const seg = segments[mid];
    if (flatOffset < seg.startInFlat) {
      high = mid - 1;
    } else if (flatOffset >= seg.endInFlat) {
      low = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

function findExactCrossNodeMatch(
  nodes: Text[],
  quote: string
): Range | null {
  const segments: RawTextSegment[] = [];
  const parts: string[] = [];
  let cursor = 0;

  for (const node of nodes) {
    const len = node.data.length;
    segments.push({ node, startInFlat: cursor, endInFlat: cursor + len });
    parts.push(node.data);
    cursor += len;
  }

  const flatText = parts.join("");
  let searchFrom = 0;
  let fallback: Range | null = null;

  while (searchFrom <= flatText.length - quote.length) {
    const idx = flatText.indexOf(quote, searchFrom);
    if (idx === -1) break;

    const matchEnd = idx + quote.length;
    const startSegIdx = findSegmentIndex(segments, idx);
    const endSegIdx = findSegmentIndex(segments, matchEnd - 1);

    if (startSegIdx !== -1 && endSegIdx !== -1) {
      const startSeg = segments[startSegIdx];
      const endSeg = segments[endSegIdx];
      const range = document.createRange();
      range.setStart(startSeg.node, idx - startSeg.startInFlat);
      range.setEnd(endSeg.node, matchEnd - endSeg.startInFlat);
      if (hasVisibleRect(range)) return range;
      if (!fallback) fallback = range;
    }

    searchFrom = idx + 1;
  }

  return fallback;
}

function buildNormalizedTextIndex(nodes: Text[]): NormalizedTextIndex {
  const chars: string[] = [];
  const lowerChars: string[] = [];
  const foldedLowerChars: string[] = [];
  const posMap: DomCharPos[] = [];
  const displayCache = new WeakMap<Element, string>();

  let prevBlock: Element | null = null;
  let lastWasSpace = true;

  for (const node of nodes) {
    const parent = node.parentElement;
    const currBlock = parent ? getBlockContainer(parent, displayCache) : null;

    if (prevBlock !== null && currBlock !== prevBlock && !lastWasSpace) {
      chars.push(" ");
      lowerChars.push(" ");
      foldedLowerChars.push(" ");
      posMap.push({ node, startOffset: 0, endOffset: 0 });
      lastWasSpace = true;
    }
    prevBlock = currBlock;

    const data = node.data;
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (/\s/.test(ch)) {
        if (!lastWasSpace) {
          chars.push(" ");
          lowerChars.push(" ");
          foldedLowerChars.push(" ");
          posMap.push({ node, startOffset: i, endOffset: i + 1 });
          lastWasSpace = true;
        }
      } else {
        chars.push(ch);
        lowerChars.push(safeLowerChar(ch));
        foldedLowerChars.push(safeLowerChar(foldTypographicChar(ch)));
        posMap.push({ node, startOffset: i, endOffset: i + 1 });
        lastWasSpace = false;
      }
    }
  }

  return {
    text: chars.join(""),
    lowerText: lowerChars.join(""),
    foldedLowerText: foldedLowerChars.join(""),
    posMap,
  };
}

function findInNormalizedIndex(
  index: NormalizedTextIndex,
  needle: string,
  caseInsensitive: boolean,
  folded = false
): Range | null {
  if (!needle) return null;
  const haystack = folded
    ? index.foldedLowerText
    : caseInsensitive
      ? index.lowerText
      : index.text;

  let searchFrom = 0;
  let fallback: Range | null = null;

  while (searchFrom <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, searchFrom);
    if (idx === -1) break;

    const startPos = index.posMap[idx];
    const endPos = index.posMap[idx + needle.length - 1];
    if (startPos && endPos && endPos.endOffset > 0) {
      const range = document.createRange();
      range.setStart(startPos.node, startPos.startOffset);
      range.setEnd(endPos.node, endPos.endOffset);
      if (hasVisibleRect(range)) return range;
      if (!fallback) fallback = range;
    }

    searchFrom = idx + 1;
  }

  return fallback;
}

function findQuoteRange(rawQuote: string): Range | null {
  if (!rawQuote || rawQuote.trim().length === 0) return null;

  const nodes = collectVisibleTextNodes();
  if (nodes.length === 0) return null;

  const singleExact = findExactSingleNodeMatch(nodes, rawQuote);
  if (singleExact) return singleExact;

  const crossExact = findExactCrossNodeMatch(nodes, rawQuote);
  if (crossExact) return crossExact;

  const normQuote = rawQuote.replace(/\s+/g, " ").trim();
  if (!normQuote) return null;

  const normalized = buildNormalizedTextIndex(nodes);

  const exactNormMatch = findInNormalizedIndex(normalized, normQuote, false);
  if (exactNormMatch) return exactNormMatch;

  const ciNormMatch = findInNormalizedIndex(
    normalized,
    safeLowerString(normQuote),
    true
  );
  if (ciNormMatch) return ciNormMatch;

  const foldedQuote = foldTypographicLowerString(normQuote);
  return findInNormalizedIndex(normalized, foldedQuote, true, true);
}

function scrollRangeIntoView(range: Range): void {
  const anchor =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement;

  let cur = anchor;
  while (cur && cur !== document.documentElement && cur !== document.body) {
    const style = window.getComputedStyle(cur);
    const overflowY = style.overflowY;
    if (
      (overflowY === "auto" ||
        overflowY === "scroll" ||
        overflowY === "overlay") &&
      cur.scrollHeight > cur.clientHeight + 2
    ) {
      const elRect = cur.getBoundingClientRect();
      const rangeRect = range.getBoundingClientRect();
      if (
        rangeRect.top < elRect.top + 20 ||
        rangeRect.bottom > elRect.bottom - 20
      ) {
        const targetScrollTop =
          cur.scrollTop +
          (rangeRect.top - elRect.top) -
          cur.clientHeight / 2 +
          rangeRect.height / 2;
        cur.scrollTo({
          top: Math.max(0, targetScrollTop),
          behavior: "smooth",
        });
      }
    }
    cur = cur.parentElement;
  }

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;

  const targetTop = Math.max(
    0,
    window.scrollY + rect.top - window.innerHeight / 2 + rect.height / 2
  );
  const needsHorizontal = rect.left < 0 || rect.right > window.innerWidth;
  const targetLeft = needsHorizontal
    ? Math.max(
        0,
        window.scrollX + rect.left - window.innerWidth / 2 + rect.width / 2
      )
    : window.scrollX;

  window.scrollTo({
    top: targetTop,
    left: targetLeft,
    behavior: "smooth",
  });
}

function updateOverlayPositions(): void {
  if (!activeSpotlight) return;

  const { range, boxesLayer, badgeEl } = activeSpotlight;
  if (!range.startContainer.isConnected || !range.endContainer.isConnected) {
    boxesLayer.textContent = "";
    return;
  }

  let rects = getValidRangeRects(range);
  const bound = range.getBoundingClientRect();
  if (rects.length === 0 && bound.width >= 1 && bound.height >= 1) {
    rects = [bound];
  }

  while (boxesLayer.children.length < rects.length) {
    const box = document.createElement("div");
    box.className = "dice-highlight-box";
    boxesLayer.appendChild(box);
  }
  while (boxesLayer.children.length > rects.length) {
    boxesLayer.lastElementChild?.remove();
  }

  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const box = boxesLayer.children[i] as HTMLDivElement;
    box.style.left = `${r.left - 3}px`;
    box.style.top = `${r.top - 2}px`;
    box.style.width = `${r.width + 6}px`;
    box.style.height = `${r.height + 4}px`;
  }

  const anchorRect =
    bound.width >= 1 || bound.height >= 1 ? bound : (rects[0] ?? bound);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const badgeRect = badgeEl.getBoundingClientRect();
  const badgeW = badgeRect.width || 280;
  const badgeH = badgeRect.height || 76;
  const margin = 12;
  const gap = 10;

  const left = clamp(
    anchorRect.left,
    margin,
    Math.max(margin, vw - badgeW - margin)
  );

  const aboveTop = anchorRect.top - badgeH - gap;
  const belowTop = anchorRect.bottom + gap;
  let top: number;

  if (aboveTop >= margin) {
    top = Math.min(aboveTop, vh - badgeH - margin);
  } else if (belowTop + badgeH <= vh - margin) {
    top = Math.max(margin, belowTop);
  } else {
    top = clamp(aboveTop, margin, Math.max(margin, vh - badgeH - margin));
  }

  badgeEl.style.left = `${left}px`;
  badgeEl.style.top = `${top}px`;
}

function clearSpotlight(): void {
  if (activeSpotlight) {
    activeSpotlight.cleanup();
    activeSpotlight.host.remove();
    activeSpotlight = null;
  }
  document.getElementById(SPOTLIGHT_HOST_ID)?.remove();
}

function mountSpotlight(quote: string, badgeText: string): boolean {
  clearSpotlight();

  const range = findQuoteRange(quote);
  if (!range) {
    return false;
  }

  const rootTarget = document.documentElement ?? document.body;
  if (!rootTarget) {
    return false;
  }

  const host = document.createElement("div");
  host.id = SPOTLIGHT_HOST_ID;
  host.style.cssText = [
    "position: fixed !important",
    "inset: 0 !important",
    "width: 100vw !important",
    "height: 100vh !important",
    "z-index: 2147483647 !important",
    "pointer-events: none !important",
    "margin: 0 !important",
    "padding: 0 !important",
    "border: none !important",
    "background: transparent !important",
    "display: block !important",
    "visibility: visible !important",
    "opacity: 1 !important",
  ].join("; ");

  const shadow = host.attachShadow({ mode: "closed" });

  const styleEl = document.createElement("style");
  styleEl.textContent = SPOTLIGHT_SHADOW_CSS;

  const overlayRoot = document.createElement("div");
  overlayRoot.className = "dice-overlay-root";

  const boxesLayer = document.createElement("div");
  boxesLayer.className = "dice-boxes-layer";

  const badgeEl = document.createElement("div");
  badgeEl.className = "dice-badge";
  badgeEl.setAttribute("role", "status");
  badgeEl.setAttribute("aria-label", "DICE Contradiction Spotlight");

  const headerEl = document.createElement("div");
  headerEl.className = "dice-badge-header";

  const titleWrapEl = document.createElement("div");
  titleWrapEl.className = "dice-badge-title-wrap";

  const dotEl = document.createElement("span");
  dotEl.className = "dice-badge-dot";

  const titleEl = document.createElement("span");
  titleEl.className = "dice-badge-title";
  titleEl.textContent = "DICE Contradiction";

  titleWrapEl.append(dotEl, titleEl);

  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.className = "dice-badge-dismiss";
  dismissBtn.setAttribute("aria-label", "Dismiss DICE contradiction spotlight");
  dismissBtn.title = "Dismiss";
  dismissBtn.textContent = "×";
  dismissBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearSpotlight();
  });

  headerEl.append(titleWrapEl, dismissBtn);

  const bodyEl = document.createElement("div");
  bodyEl.className = "dice-badge-body";
  bodyEl.textContent =
    badgeText.trim() || "Claim contradiction detected on this source.";

  badgeEl.append(headerEl, bodyEl);
  overlayRoot.append(boxesLayer, badgeEl);
  shadow.append(styleEl, overlayRoot);
  rootTarget.appendChild(host);

  let rafId = 0;
  const schedulePositionUpdate = (): void => {
    if (rafId !== 0) return;
    rafId = window.requestAnimationFrame(() => {
      rafId = 0;
      updateOverlayPositions();
    });
  };

  window.addEventListener("scroll", schedulePositionUpdate, {
    capture: true,
    passive: true,
  });
  window.addEventListener("scrollend", schedulePositionUpdate, {
    capture: true,
    passive: true,
  });
  window.addEventListener("resize", schedulePositionUpdate, { passive: true });

  activeSpotlight = {
    host,
    range,
    boxesLayer,
    badgeEl,
    cleanup: () => {
      if (rafId !== 0) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
      window.removeEventListener("scroll", schedulePositionUpdate, {
        capture: true,
      });
      window.removeEventListener("scrollend", schedulePositionUpdate, {
        capture: true,
      });
      window.removeEventListener("resize", schedulePositionUpdate);
    },
  };

  scrollRangeIntoView(range);
  updateOverlayPositions();
  schedulePositionUpdate();

  return true;
}

function applyFocusMode(enabled: boolean): void {
  const existing = document.getElementById(FOCUS_STYLE_ID);
  if (!enabled) {
    existing?.remove();
    return;
  }

  if (existing) {
    return;
  }

  const target = document.head ?? document.documentElement;
  if (!target) return;

  const styleEl = document.createElement("style");
  styleEl.id = FOCUS_STYLE_ID;
  styleEl.textContent = FOCUS_MODE_CSS;
  target.appendChild(styleEl);
}

function handleRuntimeMessage(
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
): boolean | undefined {
  if (!isObjectRecord(message) || typeof message.type !== "string") {
    return undefined;
  }

  const msg = message as ExtensionMessage;
  switch (msg.type) {
    case "SPOTLIGHT_QUOTE": {
      const quote = typeof msg.quote === "string" ? msg.quote : "";
      const badgeText =
        typeof msg.badge_text === "string" ? msg.badge_text : "";
      const found = mountSpotlight(quote, badgeText);
      sendResponse({ ok: true, found });
      return false;
    }

    case "CLEAR_SPOTLIGHT": {
      clearSpotlight();
      sendResponse({ ok: true });
      return false;
    }

    case "FOCUS_MODE": {
      const enabled = Boolean(msg.enabled);
      applyFocusMode(enabled);
      sendResponse({ ok: true, enabled });
      return false;
    }

    default:
      return undefined;
  }
}

function initDiceContentScript(): void {
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
}

const globalState = globalThis as unknown as Record<string, boolean | undefined>;
if (!globalState[INIT_FLAG]) {
  globalState[INIT_FLAG] = true;
  initDiceContentScript();
}
