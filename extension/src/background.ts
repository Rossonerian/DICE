import { isMockWsEnabled, MockWsClient } from "./mockWs.ts";
import type {
  ClientToCloudMessage,
  ClipRecord,
  CloudToClientMessage,
  DispatchSwarmMessage,
  ExtensionMessage,
  ExtensionState,
  MemoryCard,
  TabOffloadResult,
  WsConnectionStatus,
} from "./types.ts";

const CLIP_MENU_ID = "pin-to-research-graph";
const RAM_PER_TAB_MB = 180;
const MAX_TELEMETRY_EVENTS = 100;
const MAX_MEMORY_CARDS = 100;
const MAX_CLIPS = 50;
const MAX_OUTBOUND_QUEUE = 50;
const BASE_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30_000;
const TAB_LOAD_TIMEOUT_MS = 15_000;

const LOCAL_STORAGE_KEYS = ["memoryCards", "ramSavedMb", "clips"] as const;
const SESSION_STORAGE_KEYS = [
  "telemetry",
  "synthesis",
  "pendingGatekeeper",
  "focusMode",
  "activeJobId",
] as const;

const state: ExtensionState = {
  wsStatus: isMockWsEnabled() ? "MOCK" : "DISCONNECTED",
  telemetry: [],
  synthesis: null,
  pendingGatekeeper: null,
  ramSavedMb: 0,
  memoryCards: [],
  clips: [],
  focusMode: false,
  activeJobId: null,
};

let initPromise: Promise<void> | null = null;
let transportStarted = false;
let mockClient: MockWsClient | null = null;
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
const outboundQueue: ClientToCloudMessage[] = [];

function getWsUrl(): string {
  return import.meta.env.VITE_WS_URL || "ws://localhost:8000/ws/demo1";
}

function isHttpUrl(url: string | undefined): url is string {
  if (!url) return false;
  return url.startsWith("http://") || url.startsWith("https://");
}

function extractDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, "") || rawUrl;
  } catch {
    return rawUrl;
  }
}

function normalizeUrlForMatch(
  rawUrl: string,
  stripWww = false
): string {
  try {
    const parsed = new URL(rawUrl);
    const cleanPath = parsed.pathname.replace(/\/+$/, "") || "/";
    const host = stripWww
      ? parsed.hostname.replace(/^www\./i, "")
      : parsed.hostname;
    const portPart = parsed.port ? `:${parsed.port}` : "";
    return `${parsed.protocol}//${host}${portPart}${cleanPath}${parsed.search}`;
  } catch {
    return rawUrl.trim().replace(/\/+$/, "");
  }
}

function getStateSnapshot(): ExtensionState {
  return {
    wsStatus: state.wsStatus,
    telemetry: [...state.telemetry],
    synthesis: state.synthesis,
    pendingGatekeeper: state.pendingGatekeeper,
    ramSavedMb: state.ramSavedMb,
    memoryCards: [...state.memoryCards],
    clips: [...state.clips],
    focusMode: state.focusMode,
    activeJobId: state.activeJobId,
  };
}

function broadcastToExtension(message: ExtensionMessage): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // Side panel or popup may not be open; ignore absent receivers.
  });
}

async function persistLocalState(): Promise<void> {
  try {
    await chrome.storage.local.set({
      memoryCards: state.memoryCards,
      ramSavedMb: state.ramSavedMb,
      clips: state.clips,
    });
  } catch (err) {
    console.warn("[DICE] Failed to persist local storage:", err);
  }
}

async function persistSessionState(): Promise<void> {
  try {
    if (!chrome.storage.session) return;
    await chrome.storage.session.set({
      telemetry: state.telemetry,
      synthesis: state.synthesis,
      pendingGatekeeper: state.pendingGatekeeper,
      focusMode: state.focusMode,
      activeJobId: state.activeJobId,
    });
  } catch (err) {
    console.warn("[DICE] Failed to persist session storage:", err);
  }
}

async function hydrateState(): Promise<void> {
  try {
    const localData = await chrome.storage.local.get([...LOCAL_STORAGE_KEYS]);
    if (Array.isArray(localData.memoryCards)) {
      state.memoryCards = localData.memoryCards as MemoryCard[];
    }
    if (
      typeof localData.ramSavedMb === "number" &&
      Number.isFinite(localData.ramSavedMb)
    ) {
      state.ramSavedMb = Math.max(0, localData.ramSavedMb);
    }
    if (Array.isArray(localData.clips)) {
      state.clips = localData.clips as ClipRecord[];
    }
  } catch (err) {
    console.warn("[DICE] Failed to load local storage:", err);
  }

  try {
    if (chrome.storage.session) {
      const sessionData = await chrome.storage.session.get([
        ...SESSION_STORAGE_KEYS,
      ]);
      if (Array.isArray(sessionData.telemetry)) {
        state.telemetry = sessionData.telemetry as ExtensionState["telemetry"];
      }
      if (sessionData.synthesis && typeof sessionData.synthesis === "object") {
        state.synthesis =
          sessionData.synthesis as ExtensionState["synthesis"];
      }
      if (
        sessionData.pendingGatekeeper &&
        typeof sessionData.pendingGatekeeper === "object"
      ) {
        state.pendingGatekeeper =
          sessionData.pendingGatekeeper as ExtensionState["pendingGatekeeper"];
      }
      if (typeof sessionData.focusMode === "boolean") {
        state.focusMode = sessionData.focusMode;
      }
      if (
        typeof sessionData.activeJobId === "string" ||
        sessionData.activeJobId === null
      ) {
        state.activeJobId = sessionData.activeJobId;
      }
    }
  } catch (err) {
    console.warn("[DICE] Failed to load session storage:", err);
  }
}

function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = hydrateState();
  }
  return initPromise;
}

function updateWsStatus(nextStatus: WsConnectionStatus): void {
  if (state.wsStatus === nextStatus) return;
  state.wsStatus = nextStatus;
  broadcastToExtension({ type: "WS_STATUS_CHANGED", status: nextStatus });
}

function isCloudToClientMessage(value: unknown): value is CloudToClientMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { type?: unknown };
  return (
    candidate.type === "TELEMETRY" ||
    candidate.type === "SYNTHESIS_UPDATE" ||
    candidate.type === "GATEKEEPER_INTERCEPT"
  );
}

function handleIncomingCloudEvent(event: CloudToClientMessage): void {
  switch (event.type) {
    case "TELEMETRY":
      state.telemetry = [...state.telemetry, event].slice(-MAX_TELEMETRY_EVENTS);
      break;
    case "SYNTHESIS_UPDATE":
      state.synthesis = event;
      state.activeJobId = event.job_id;
      break;
    case "GATEKEEPER_INTERCEPT":
      state.pendingGatekeeper = event;
      break;
  }

  void persistSessionState();
  broadcastToExtension({ type: "WS_EVENT", event });
}

function clearReconnectTimer(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (isMockWsEnabled() || reconnectTimer !== null) return;
  const delay = Math.min(
    BASE_RECONNECT_MS * Math.pow(2, reconnectAttempt),
    MAX_RECONNECT_MS
  );
  reconnectAttempt += 1;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delay);
}

function flushOutboundQueue(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  while (outboundQueue.length > 0) {
    const next = outboundQueue.shift();
    if (!next) continue;
    try {
      socket.send(JSON.stringify(next));
    } catch (err) {
      console.warn("[DICE] Failed flushing queued WS message:", err);
      outboundQueue.unshift(next);
      break;
    }
  }
}

function connectWebSocket(): void {
  if (isMockWsEnabled()) return;
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  clearReconnectTimer();
  updateWsStatus("CONNECTING");

  let ws: WebSocket;
  try {
    ws = new WebSocket(getWsUrl());
  } catch (err) {
    console.warn("[DICE] WebSocket construction failed:", err);
    updateWsStatus("DISCONNECTED");
    scheduleReconnect();
    return;
  }

  socket = ws;

  ws.addEventListener("open", () => {
    if (socket !== ws) return;
    reconnectAttempt = 0;
    updateWsStatus("CONNECTED");
    flushOutboundQueue();
  });

  ws.addEventListener("message", (event) => {
    if (socket !== ws || typeof event.data !== "string") return;
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (isCloudToClientMessage(parsed)) {
        handleIncomingCloudEvent(parsed);
      }
    } catch (err) {
      console.warn("[DICE] Ignoring non-JSON WS message:", err);
    }
  });

  ws.addEventListener("close", () => {
    if (socket !== ws) return;
    socket = null;
    updateWsStatus("DISCONNECTED");
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    if (socket !== ws) return;
    // Let close handler drive status + backoff, or close cleanly if stuck.
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try {
        ws.close();
      } catch {
        // Ignore close errors during error teardown.
      }
    }
  });
}

function ensureTransportStarted(): void {
  if (isMockWsEnabled()) {
    if (!mockClient) {
      mockClient = new MockWsClient({
        onStatusChange: (status) => {
          updateWsStatus(status);
        },
        onEvent: (event) => {
          handleIncomingCloudEvent(event);
        },
      });
    }
    if (!transportStarted) {
      transportStarted = true;
      mockClient.start();
    }
    return;
  }

  transportStarted = true;
  connectWebSocket();
}

function enqueueOutbound(payload: ClientToCloudMessage): void {
  if (outboundQueue.length >= MAX_OUTBOUND_QUEUE) {
    outboundQueue.shift();
  }
  outboundQueue.push(payload);
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const current = await chrome.tabs.query({ active: true, currentWindow: true });
  if (current[0]) return current[0];
  const fallback = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  return fallback[0];
}

function mergeDedupedClips(
  stored: ClipRecord[],
  incoming: ClipRecord[]
): ClipRecord[] {
  const map = new Map<string, ClipRecord>();
  for (const clip of stored) {
    map.set(clip.clip_id, clip);
  }
  for (const clip of incoming) {
    map.set(clip.clip_id, clip);
  }
  return Array.from(map.values());
}

async function enrichDispatchPayload(
  payload: DispatchSwarmMessage
): Promise<DispatchSwarmMessage> {
  let activeTabUrl = payload.active_tab_url.trim();
  if (!activeTabUrl) {
    const activeTab = await getActiveTab();
    if (activeTab?.url) {
      activeTabUrl = activeTab.url;
    }
  }

  return {
    ...payload,
    active_tab_url: activeTabUrl,
    clips: mergeDedupedClips(state.clips, payload.clips ?? []),
  };
}

async function handleSendWs(
  payload: ClientToCloudMessage
): Promise<{ ok: boolean; payload: ClientToCloudMessage }> {
  await ensureInitialized();
  ensureTransportStarted();

  let outbound: ClientToCloudMessage = payload;
  if (payload.type === "DISPATCH_SWARM") {
    outbound = await enrichDispatchPayload(payload);
    state.activeJobId = outbound.job_id;
    state.pendingGatekeeper = null;
    await persistSessionState();
  } else if (payload.type === "STEER_SWARM") {
    outbound = {
      ...payload,
      job_id: payload.job_id || state.activeJobId || "job_01",
    };
  } else if (payload.type === "APPROVAL_DECISION") {
    if (state.pendingGatekeeper?.gate_id === payload.gate_id) {
      state.pendingGatekeeper = null;
      await persistSessionState();
      broadcastToExtension({ type: "STATE_SYNC", state: getStateSnapshot() });
    }
  }

  if (isMockWsEnabled()) {
    mockClient?.send(outbound);
    return { ok: true, payload: outbound };
  }

  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(outbound));
      return { ok: true, payload: outbound };
    } catch (err) {
      console.warn("[DICE] WS send failed, queuing payload:", err);
    }
  }

  enqueueOutbound(outbound);
  connectWebSocket();
  return { ok: true, payload: outbound };
}

async function handleOffloadTabs(): Promise<TabOffloadResult> {
  await ensureInitialized();

  let tabs = await chrome.tabs.query({ currentWindow: true });
  if (tabs.length === 0) {
    tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  }

  const eligibleTabs = tabs.filter(
    (tab): tab is chrome.tabs.Tab & { id: number; url: string } =>
      typeof tab.id === "number" &&
      !tab.active &&
      !tab.pinned &&
      isHttpUrl(tab.url)
  );

  // Group eligible tabs by domain before discarding so tab IDs stay stable.
  const tabsByDomain = new Map<string, number[]>();
  for (const tab of eligibleTabs) {
    const domain = extractDomain(tab.url);
    const list = tabsByDomain.get(domain);
    if (list) {
      list.push(tab.id);
    } else {
      tabsByDomain.set(domain, [tab.id]);
    }
  }

  const groupedDomains: string[] = [];
  for (const [domain, tabIds] of tabsByDomain.entries()) {
    if (tabIds.length < 2) continue;
    try {
      const groupId = await chrome.tabs.group({
        tabIds: tabIds as [number, ...number[]],
      });
      groupedDomains.push(domain);
      const tabGroupsApi = (
        chrome as unknown as {
          tabGroups?: {
            update?: (
              groupId: number,
              updateProperties: { title?: string }
            ) => Promise<unknown>;
          };
        }
      ).tabGroups;
      if (typeof tabGroupsApi?.update === "function") {
        await tabGroupsApi.update(groupId, { title: domain }).catch(() => {});
      }
    } catch (err) {
      console.warn(`[DICE] Failed grouping tabs for ${domain}:`, err);
    }
  }

  const newlyCreatedCards: MemoryCard[] = [];
  let discardedCount = 0;

  for (const tab of eligibleTabs) {
    if (tab.discarded) continue;
    try {
      const result = await chrome.tabs.discard(tab.id);
      if (result) {
        discardedCount += 1;
        const domain = extractDomain(tab.url);
        newlyCreatedCards.push({
          id: `mc_${Date.now()}_${tab.id}_${Math.random().toString(36).slice(2, 6)}`,
          url: tab.url,
          title: tab.title?.trim() || domain,
          domain,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      console.warn(`[DICE] Failed discarding tab ${tab.id}:`, err);
    }
  }

  if (newlyCreatedCards.length > 0) {
    state.memoryCards = [...newlyCreatedCards, ...state.memoryCards].slice(
      0,
      MAX_MEMORY_CARDS
    );
    state.ramSavedMb += discardedCount * RAM_PER_TAB_MB;
    await persistLocalState();
  }

  broadcastToExtension({
    type: "RAM_UPDATED",
    ramSavedMb: state.ramSavedMb,
    memoryCards: [...state.memoryCards],
  });

  return {
    discardedCount,
    groupedDomains,
    ramSavedMb: state.ramSavedMb,
    memoryCards: [...state.memoryCards],
  };
}

async function handleRestoreMemoryCard(cardId: string): Promise<{
  ok: boolean;
  restored: boolean;
  ramSavedMb: number;
  memoryCards: MemoryCard[];
}> {
  await ensureInitialized();
  const target = state.memoryCards.find((card) => card.id === cardId);

  if (target) {
    if (isHttpUrl(target.url)) {
      await chrome.tabs.create({ url: target.url, active: true });
    }
    state.memoryCards = state.memoryCards.filter((card) => card.id !== cardId);
    state.ramSavedMb = Math.max(0, state.ramSavedMb - RAM_PER_TAB_MB);
    await persistLocalState();
    broadcastToExtension({
      type: "RAM_UPDATED",
      ramSavedMb: state.ramSavedMb,
      memoryCards: [...state.memoryCards],
    });
  }

  return {
    ok: true,
    restored: Boolean(target),
    ramSavedMb: state.ramSavedMb,
    memoryCards: [...state.memoryCards],
  };
}

async function handleRemoveClip(
  clipId: string
): Promise<{ ok: boolean; clips: ClipRecord[] }> {
  await ensureInitialized();
  state.clips = state.clips.filter((clip) => clip.clip_id !== clipId);
  await persistLocalState();
  broadcastToExtension({ type: "CLIPS_UPDATED", clips: [...state.clips] });
  return { ok: true, clips: [...state.clips] };
}

async function handleClearClips(): Promise<{ ok: boolean; clips: ClipRecord[] }> {
  await ensureInitialized();
  state.clips = [];
  await persistLocalState();
  broadcastToExtension({ type: "CLIPS_UPDATED", clips: [] });
  return { ok: true, clips: [] };
}

function waitForTabComplete(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      resolve();
    };

    const onUpdated = (
      updatedTabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo
    ) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup();
      }
    };

    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) {
        cleanup();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    timeoutId = setTimeout(cleanup, TAB_LOAD_TIMEOUT_MS);

    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") {
          cleanup();
        }
      })
      .catch(() => {
        cleanup();
      });
  });
}

async function sendMessageToTabWithFallback<T = unknown>(
  tabId: number,
  message: ExtensionMessage
): Promise<T> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as T;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    return (await chrome.tabs.sendMessage(tabId, message)) as T;
  }
}

async function findMatchingTab(targetUrl: string): Promise<chrome.tabs.Tab | undefined> {
  const normalizedTarget = normalizeUrlForMatch(targetUrl);
  const normalizedNoWww = normalizeUrlForMatch(targetUrl, true);
  const allTabs = await chrome.tabs.query({});
  const currentWindowTabs = await chrome.tabs.query({ currentWindow: true });
  const prioritized = [
    ...currentWindowTabs,
    ...allTabs.filter((t) => !currentWindowTabs.some((ct) => ct.id === t.id)),
  ];

  const exactMatch = prioritized.find(
    (tab) => tab.url === targetUrl && typeof tab.id === "number"
  );
  if (exactMatch) return exactMatch;

  const normalizedMatch = prioritized.find(
    (tab) =>
      typeof tab.id === "number" &&
      typeof tab.url === "string" &&
      normalizeUrlForMatch(tab.url) === normalizedTarget
  );
  if (normalizedMatch) return normalizedMatch;

  return prioritized.find(
    (tab) =>
      typeof tab.id === "number" &&
      typeof tab.url === "string" &&
      normalizeUrlForMatch(tab.url, true) === normalizedNoWww
  );
}

async function handleTriggerSpotlight(
  url: string,
  quote: string,
  badge_text: string
): Promise<{ ok: boolean; found: boolean; error?: string }> {
  const trimmedUrl = url.trim();
  let targetTab: chrome.tabs.Tab | undefined;

  if (!trimmedUrl) {
    targetTab = await getActiveTab();
  } else {
    targetTab = await findMatchingTab(trimmedUrl);
  }

  if (targetTab && typeof targetTab.id === "number") {
    const tabId = targetTab.id;
    const needsLoadWait =
      Boolean(targetTab.discarded) || targetTab.status !== "complete";

    if (typeof targetTab.windowId === "number") {
      await chrome.windows
        .update(targetTab.windowId, { focused: true })
        .catch(() => {});
    }
    await chrome.tabs.update(tabId, { active: true });

    if (needsLoadWait) {
      await waitForTabComplete(tabId);
    }

    const latestTab = await chrome.tabs.get(tabId).catch(() => targetTab);
    if (!isHttpUrl(latestTab?.url)) {
      return {
        ok: false,
        found: false,
        error: "Active tab URL cannot run content scripts.",
      };
    }

    try {
      const response = await sendMessageToTabWithFallback<{
        ok?: boolean;
        found?: boolean;
      }>(tabId, {
        type: "SPOTLIGHT_QUOTE",
        quote,
        badge_text,
      });
      return {
        ok: response?.ok ?? true,
        found: Boolean(response?.found),
      };
    } catch (err) {
      return {
        ok: false,
        found: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (!isHttpUrl(trimmedUrl)) {
    return {
      ok: false,
      found: false,
      error: "Target URL must be http:// or https:// to open a tab.",
    };
  }

  try {
    const created = await chrome.tabs.create({ url: trimmedUrl, active: true });
    if (typeof created.id !== "number") {
      return { ok: false, found: false, error: "Created tab has no ID." };
    }
    await waitForTabComplete(created.id);
    const response = await sendMessageToTabWithFallback<{
      ok?: boolean;
      found?: boolean;
    }>(created.id, {
      type: "SPOTLIGHT_QUOTE",
      quote,
      badge_text,
    });
    return {
      ok: response?.ok ?? true,
      found: Boolean(response?.found),
    };
  } catch (err) {
    return {
      ok: false,
      found: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function handleToggleFocusMode(
  enabled: boolean
): Promise<{ ok: boolean; enabled: boolean; error?: string }> {
  await ensureInitialized();
  state.focusMode = enabled;
  await persistSessionState();

  const activeTab = await getActiveTab();
  if (!activeTab || typeof activeTab.id !== "number" || !isHttpUrl(activeTab.url)) {
    return { ok: true, enabled };
  }

  try {
    await sendMessageToTabWithFallback(activeTab.id, {
      type: "FOCUS_MODE",
      enabled,
    });
    return { ok: true, enabled };
  } catch (err) {
    return {
      ok: false,
      enabled,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function handleClearSpotlight(): Promise<{ ok: boolean }> {
  const activeTab = await getActiveTab();
  if (!activeTab || typeof activeTab.id !== "number" || !isHttpUrl(activeTab.url)) {
    return { ok: false };
  }
  try {
    await sendMessageToTabWithFallback(activeTab.id, {
      type: "CLEAR_SPOTLIGHT",
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function configureSidePanel(): void {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => {
      console.warn("[DICE] sidePanel.setPanelBehavior failed:", err);
    });
}

function registerContextMenus(): void {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create(
      {
        id: CLIP_MENU_ID,
        title: "Pin to Research Graph",
        contexts: ["selection"],
      },
      () => {
        if (chrome.runtime.lastError) {
          console.warn(
            "[DICE] contextMenus.create:",
            chrome.runtime.lastError.message
          );
        }
      }
    );
  });
}

chrome.runtime.onInstalled.addListener(() => {
  configureSidePanel();
  registerContextMenus();
  void ensureInitialized().then(() => {
    ensureTransportStarted();
  });
});

chrome.runtime.onStartup.addListener(() => {
  configureSidePanel();
  void ensureInitialized().then(() => {
    ensureTransportStarted();
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CLIP_MENU_ID) return;
  const selectedText = info.selectionText?.trim();
  if (!selectedText) return;

  void (async () => {
    await ensureInitialized();
    const sourceUrl = info.pageUrl || tab?.url || "";
    const pageTitle = tab?.title?.trim() || extractDomain(sourceUrl) || "Clipped Page";
    const duplicate = state.clips.some(
      (c) => c.source_url === sourceUrl && c.text === selectedText
    );
    if (duplicate) {
      broadcastToExtension({ type: "CLIPS_UPDATED", clips: [...state.clips] });
      return;
    }

    const clip: ClipRecord = {
      clip_id: `clp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      source_url: sourceUrl,
      page_title: pageTitle,
      text: selectedText,
    };

    state.clips = [clip, ...state.clips].slice(0, MAX_CLIPS);
    await persistLocalState();
    broadcastToExtension({ type: "CLIPS_UPDATED", clips: [...state.clips] });
  })();
});

async function dispatchRuntimeMessage(
  message: ExtensionMessage
): Promise<unknown> {
  await ensureInitialized();
  ensureTransportStarted();

  switch (message.type) {
    case "GET_STATE":
      return getStateSnapshot();
    case "SEND_WS":
      return handleSendWs(message.payload);
    case "OFFLOAD_TABS":
      return handleOffloadTabs();
    case "RESTORE_MEMORY_CARD":
      return handleRestoreMemoryCard(message.cardId);
    case "REMOVE_CLIP":
      return handleRemoveClip(message.clipId);
    case "CLEAR_CLIPS":
      return handleClearClips();
    case "TRIGGER_SPOTLIGHT":
      return handleTriggerSpotlight(
        message.url,
        message.quote,
        message.badge_text
      );
    case "TOGGLE_FOCUS_MODE":
      return handleToggleFocusMode(message.enabled);
    case "CLEAR_SPOTLIGHT":
      return handleClearSpotlight();
    default:
      return undefined;
  }
}

const HANDLED_TYPES = new Set<ExtensionMessage["type"]>([
  "GET_STATE",
  "SEND_WS",
  "OFFLOAD_TABS",
  "RESTORE_MEMORY_CARD",
  "REMOVE_CLIP",
  "CLEAR_CLIPS",
  "TRIGGER_SPOTLIGHT",
  "TOGGLE_FOCUS_MODE",
  "CLEAR_SPOTLIGHT",
]);

chrome.runtime.onMessage.addListener((rawMessage: unknown, _sender, sendResponse) => {
  if (
    !rawMessage ||
    typeof rawMessage !== "object" ||
    typeof (rawMessage as { type?: unknown }).type !== "string"
  ) {
    return false;
  }

  const msg = rawMessage as ExtensionMessage;
  if (!HANDLED_TYPES.has(msg.type)) {
    return false;
  }

  void dispatchRuntimeMessage(msg)
    .then(sendResponse)
    .catch((err) => {
      console.error("[DICE] Background message error:", err);
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  return true;
});

// Bootstrap service worker state & transport immediately on wake.
configureSidePanel();
void ensureInitialized().then(() => {
  ensureTransportStarted();
});
