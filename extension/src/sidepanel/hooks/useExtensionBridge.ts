import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApprovalDecisionMessage,
  ClientToCloudMessage,
  ClipRecord,
  DispatchSwarmMessage,
  ExtensionMessage,
  ExtensionState,
  MemoryCard,
  SteerSwarmMessage,
  SynthesisUpdateMessage,
  TabOffloadResult,
} from "../../types";

const MAX_TELEMETRY_EVENTS = 100;

const INITIAL_STATE: ExtensionState = {
  wsStatus: import.meta.env.VITE_MOCK_WS === "true" ? "MOCK" : "DISCONNECTED",
  telemetry: [],
  synthesis: null,
  pendingGatekeeper: null,
  ramSavedMb: 0,
  memoryCards: [],
  clips: [],
  focusMode: false,
  activeJobId: null,
};

interface SynthesisWaiter {
  jobId: string;
  resolve: (value: SynthesisUpdateMessage | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SpotlightActionResult {
  ok: boolean;
  found: boolean;
  error?: string;
}

function hasChromeRuntime(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.runtime?.sendMessage === "function"
  );
}

async function sendRuntimeMessage<T>(message: ExtensionMessage): Promise<T> {
  if (!hasChromeRuntime()) {
    throw new Error("Chrome extension runtime API is unavailable in this view.");
  }
  return (await chrome.runtime.sendMessage(message)) as T;
}

async function queryActiveTabUrl(): Promise<string> {
  if (typeof chrome === "undefined" || typeof chrome.tabs?.query !== "function") {
    return "";
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) return tab.url;
    const [fallback] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    return fallback?.url ?? "";
  } catch {
    return "";
  }
}

export interface UseExtensionBridgeOptions {
  onSynthesisUpdate?: (synthesis: SynthesisUpdateMessage) => void;
}

export function useExtensionBridge(options?: UseExtensionBridgeOptions) {
  const [state, setState] = useState<ExtensionState>(INITIAL_STATE);
  const [isHydrated, setIsHydrated] = useState(false);
  const [offloading, setOffloading] = useState(false);

  const stateRef = useRef(state);
  stateRef.current = state;

  const onSynthesisRef = useRef(options?.onSynthesisUpdate);
  onSynthesisRef.current = options?.onSynthesisUpdate;

  const synthesisWaitersRef = useRef<Set<SynthesisWaiter>>(new Set());

  const resolveMatchingWaiters = useCallback((synthesis: SynthesisUpdateMessage) => {
    for (const waiter of Array.from(synthesisWaitersRef.current)) {
      if (!waiter.jobId || waiter.jobId === synthesis.job_id) {
        clearTimeout(waiter.timer);
        synthesisWaitersRef.current.delete(waiter);
        waiter.resolve(synthesis);
      }
    }
  }, []);

  const createSynthesisWaiter = useCallback(
    (jobId: string, timeoutMs: number): Promise<SynthesisUpdateMessage | null> => {
      return new Promise((resolve) => {
        const waiter: SynthesisWaiter = {
          jobId,
          resolve,
          timer: setTimeout(() => {
            synthesisWaitersRef.current.delete(waiter);
            resolve(null);
          }, timeoutMs),
        };
        synthesisWaitersRef.current.add(waiter);
      });
    },
    []
  );

  useEffect(() => {
    let cancelled = false;

    const hydrate = async () => {
      if (!hasChromeRuntime()) {
        if (!cancelled) setIsHydrated(true);
        return;
      }
      try {
        const snapshot = await sendRuntimeMessage<ExtensionState>({
          type: "GET_STATE",
        });
        if (!cancelled && snapshot && typeof snapshot === "object") {
          setState(snapshot);
        }
      } catch (err) {
        console.warn("[DICE UI] Failed to hydrate state from background:", err);
      } finally {
        if (!cancelled) setIsHydrated(true);
      }
    };

    void hydrate();

    if (!hasChromeRuntime() || !chrome.runtime.onMessage) {
      return () => {
        cancelled = true;
      };
    }

    const handleRuntimeMessage = (rawMessage: unknown) => {
      if (
        !rawMessage ||
        typeof rawMessage !== "object" ||
        typeof (rawMessage as { type?: unknown }).type !== "string"
      ) {
        return;
      }

      const msg = rawMessage as ExtensionMessage;
      switch (msg.type) {
        case "STATE_SYNC":
          setState(msg.state);
          break;

        case "WS_STATUS_CHANGED":
          setState((prev) => ({ ...prev, wsStatus: msg.status }));
          break;

        case "WS_EVENT": {
          const event = msg.event;
          if (event.type === "TELEMETRY") {
            setState((prev) => ({
              ...prev,
              telemetry: [...prev.telemetry, event].slice(-MAX_TELEMETRY_EVENTS),
            }));
          } else if (event.type === "SYNTHESIS_UPDATE") {
            setState((prev) => ({
              ...prev,
              synthesis: event,
              activeJobId: event.job_id,
            }));
            resolveMatchingWaiters(event);
            onSynthesisRef.current?.(event);
          } else if (event.type === "GATEKEEPER_INTERCEPT") {
            setState((prev) => ({
              ...prev,
              pendingGatekeeper: event,
            }));
          }
          break;
        }

        case "RAM_UPDATED":
          setState((prev) => ({
            ...prev,
            ramSavedMb: msg.ramSavedMb,
            memoryCards: msg.memoryCards,
          }));
          break;

        case "CLIPS_UPDATED":
          setState((prev) => ({
            ...prev,
            clips: msg.clips,
          }));
          break;

        case "FOCUS_MODE":
          setState((prev) => ({
            ...prev,
            focusMode: msg.enabled,
          }));
          break;

        default:
          break;
      }
    };

    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
    const waiters = synthesisWaitersRef.current;

    return () => {
      cancelled = true;
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
      for (const waiter of Array.from(waiters)) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
      waiters.clear();
    };
  }, [resolveMatchingWaiters]);

  const dispatchSwarm = useCallback(
    async (
      intent: string,
      constraints: string[] = [],
      waitForSynthesisMs = 0
    ): Promise<{
      jobId: string;
      payload: DispatchSwarmMessage;
      synthesis: SynthesisUpdateMessage | null;
    }> => {
      const cleanIntent = intent.trim();
      const jobId = `job_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      const activeTabUrl = await queryActiveTabUrl();

      const payload: DispatchSwarmMessage = {
        type: "DISPATCH_SWARM",
        job_id: jobId,
        intent: cleanIntent,
        constraints,
        active_tab_url: activeTabUrl,
        clips: stateRef.current.clips,
      };

      const waiterPromise =
        waitForSynthesisMs > 0
          ? createSynthesisWaiter(jobId, waitForSynthesisMs)
          : Promise.resolve(null);

      setState((prev) => ({
        ...prev,
        activeJobId: jobId,
        pendingGatekeeper: null,
      }));

      await sendRuntimeMessage<{ ok: boolean; payload: DispatchSwarmMessage }>({
        type: "SEND_WS",
        payload,
      });

      const synthesis = await waiterPromise;
      return { jobId, payload, synthesis };
    },
    [createSynthesisWaiter]
  );

  const steerSwarm = useCallback(
    async (
      deltaInstruction: string,
      cancelDomains: string[] = [],
      waitForSynthesisMs = 0
    ): Promise<{
      jobId: string;
      payload: SteerSwarmMessage;
      synthesis: SynthesisUpdateMessage | null;
    }> => {
      const jobId = stateRef.current.activeJobId || "job_01";
      const payload: SteerSwarmMessage = {
        type: "STEER_SWARM",
        job_id: jobId,
        delta_instruction: deltaInstruction.trim(),
        cancel_domains: cancelDomains,
      };

      const waiterPromise =
        waitForSynthesisMs > 0
          ? createSynthesisWaiter(jobId, waitForSynthesisMs)
          : Promise.resolve(null);

      await sendRuntimeMessage<{ ok: boolean; payload: SteerSwarmMessage }>({
        type: "SEND_WS",
        payload,
      });

      const synthesis = await waiterPromise;
      return { jobId, payload, synthesis };
    },
    [createSynthesisWaiter]
  );

  const sendApprovalDecision = useCallback(
    async (gateId: string, approved: boolean): Promise<void> => {
      const payload: ApprovalDecisionMessage = {
        type: "APPROVAL_DECISION",
        gate_id: gateId,
        approved,
      };

      setState((prev) =>
        prev.pendingGatekeeper?.gate_id === gateId
          ? { ...prev, pendingGatekeeper: null }
          : prev
      );

      await sendRuntimeMessage<{ ok: boolean; payload: ClientToCloudMessage }>({
        type: "SEND_WS",
        payload,
      });
    },
    []
  );

  const triggerSpotlight = useCallback(
    async (
      url: string,
      quote: string,
      badgeText: string
    ): Promise<SpotlightActionResult> => {
      const res = await sendRuntimeMessage<SpotlightActionResult>({
        type: "TRIGGER_SPOTLIGHT",
        url,
        quote,
        badge_text: badgeText,
      });
      return res ?? { ok: false, found: false, error: "No response from background." };
    },
    []
  );

  const clearSpotlight = useCallback(async (): Promise<void> => {
    await sendRuntimeMessage({ type: "CLEAR_SPOTLIGHT" }).catch(() => {});
  }, []);

  const offloadTabs = useCallback(async (): Promise<TabOffloadResult | null> => {
    setOffloading(true);
    try {
      const result = await sendRuntimeMessage<TabOffloadResult>({
        type: "OFFLOAD_TABS",
      });
      if (result && typeof result === "object") {
        setState((prev) => ({
          ...prev,
          ramSavedMb: result.ramSavedMb,
          memoryCards: result.memoryCards,
        }));
      }
      return result ?? null;
    } finally {
      setOffloading(false);
    }
  }, []);

  const restoreMemoryCard = useCallback(async (cardId: string): Promise<void> => {
    const res = await sendRuntimeMessage<{
      ok: boolean;
      ramSavedMb: number;
      memoryCards: MemoryCard[];
    }>({
      type: "RESTORE_MEMORY_CARD",
      cardId,
    });
    if (res && typeof res.ramSavedMb === "number") {
      setState((prev) => ({
        ...prev,
        ramSavedMb: res.ramSavedMb,
        memoryCards: res.memoryCards,
      }));
    }
  }, []);

  const removeClip = useCallback(async (clipId: string): Promise<void> => {
    const res = await sendRuntimeMessage<{ ok: boolean; clips: ClipRecord[] }>({
      type: "REMOVE_CLIP",
      clipId,
    });
    if (res && Array.isArray(res.clips)) {
      setState((prev) => ({ ...prev, clips: res.clips }));
    }
  }, []);

  const clearClips = useCallback(async (): Promise<void> => {
    const res = await sendRuntimeMessage<{ ok: boolean; clips: ClipRecord[] }>({
      type: "CLEAR_CLIPS",
    });
    if (res && Array.isArray(res.clips)) {
      setState((prev) => ({ ...prev, clips: res.clips }));
    }
  }, []);

  const toggleFocusMode = useCallback(async (enabled: boolean): Promise<void> => {
    setState((prev) => ({ ...prev, focusMode: enabled }));
    await sendRuntimeMessage<{ ok: boolean; enabled: boolean }>({
      type: "TOGGLE_FOCUS_MODE",
      enabled,
    }).catch(() => {});
  }, []);

  return {
    state,
    isHydrated,
    offloading,
    dispatchSwarm,
    steerSwarm,
    sendApprovalDecision,
    triggerSpotlight,
    clearSpotlight,
    offloadTabs,
    restoreMemoryCard,
    removeClip,
    clearClips,
    toggleFocusMode,
  };
}
