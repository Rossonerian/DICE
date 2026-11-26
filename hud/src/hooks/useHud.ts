import { useCallback, useEffect, useRef, useState } from 'react';
import { createWsClient, type WsClient } from '../wsClient';
import type {
  GatekeeperInterceptMessage,
  PinnedNote,
  SpotlightTarget,
  SynthesisUpdateMessage,
  TelemetryMessage,
  WsConnectionStatus,
} from '../types';
import { getHudMemoryMb, isSafeExternalUrl, openExternal } from './platform';

export interface TranscriptLine {
  id: number;
  role: 'user' | 'agent' | 'system';
  text: string;
}

export interface SpotlightState extends SpotlightTarget {
  nonce: number;
}

export interface GateDecisionRecord {
  gate_id: string;
  approved: boolean;
  at: number;
}

export interface HudApi {
  status: WsConnectionStatus;
  isMock: boolean;
  jobId: string | null;
  isRunning: boolean;
  telemetry: TelemetryMessage[];
  latest: TelemetryMessage | null;
  tabsOffloaded: number;
  workersActive: number;
  ramMb: number;
  synthesis: SynthesisUpdateMessage | null;
  gate: GatekeeperInterceptMessage | null;
  gatePending: boolean;
  lastGateDecision: GateDecisionRecord | null;
  clearLastGateDecision: () => void;
  spotlight: SpotlightState | null;
  pinned: PinnedNote[];
  transcript: TranscriptLine[];
  highContrast: boolean;
  setHighContrast: (v: boolean) => void;
  dispatch: (intent: string, constraints?: string[], contextUrl?: string) => Promise<string>;
  steer: (delta: string, cancelDomains?: string[]) => string;
  decide: (approved: boolean) => void;
  doSpotlight: (source_url: string, quote: string, badge_text: string) => void;
  clearSpotlight: () => void;
  handoff: (url: string) => Promise<boolean>;
  pinNote: (source_url: string, text: string) => void;
  unpinNote: (note_id: string) => void;
  addTranscript: (role: TranscriptLine['role'], text: string) => void;
  resetSession: () => Promise<void>;
}

interface PendingWaiter {
  resolve: (brief: string) => void;
  timer: number;
}

let jobSeq = 0;
let noteSeq = 0;
let lineSeq = 0;
let nonceSeq = 0;

function buildResetUrl(): string {
  const raw = (import.meta.env?.VITE_WS_URL as string | undefined) ?? 'ws://localhost:8000/ws/demo1';
  const parsed = new URL(raw);
  const protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  const segments = parsed.pathname.split('/').filter(Boolean);
  const sessionId = segments.length > 0 ? segments[segments.length - 1] : 'demo1';
  return `${protocol}//${parsed.host}/sessions/${encodeURIComponent(sessionId)}/reset`;
}

export function useHud(): HudApi {
  const clientRef = useRef<WsClient | null>(null);
  if (!clientRef.current) clientRef.current = createWsClient();
  const client = clientRef.current;

  const [status, setStatus] = useState<WsConnectionStatus>(client.getStatus());
  const [telemetry, setTelemetry] = useState<TelemetryMessage[]>([]);
  const [tabsOffloaded, setTabsOffloaded] = useState(0);
  const [synthesis, setSynthesis] = useState<SynthesisUpdateMessage | null>(null);
  const [gate, setGate] = useState<GatekeeperInterceptMessage | null>(null);
  const [gatePending, setGatePending] = useState(false);
  const [lastGateDecision, setLastGateDecision] = useState<GateDecisionRecord | null>(null);
  const [spotlight, setSpotlight] = useState<SpotlightState | null>(null);
  const [pinned, setPinned] = useState<PinnedNote[]>([]);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [ramMb, setRamMb] = useState(0);
  const [highContrast, setHighContrast] = useState(false);

  const jobRef = useRef<string | null>(null);
  const turnSeqRef = useRef(0);
  const awaitingSteerRef = useRef(false);
  const pinnedRef = useRef<PinnedNote[]>([]);
  const waiters = useRef<PendingWaiter[]>([]);
  const gateRef = useRef<GatekeeperInterceptMessage | null>(null);
  const gatePendingRef = useRef(false);
  const gatePendingTimerRef = useRef<number | null>(null);
  const lastDispatchRef = useRef<{ key: string; promise: Promise<string>; at: number } | null>(null);

  gateRef.current = gate;
  gatePendingRef.current = gatePending;
  pinnedRef.current = pinned;

  const clearGateTimers = useCallback(() => {
    if (gatePendingTimerRef.current !== null) {
      window.clearTimeout(gatePendingTimerRef.current);
      gatePendingTimerRef.current = null;
    }
  }, []);

  const clearGateState = useCallback(() => {
    clearGateTimers();
    gateRef.current = null;
    setGate(null);
    gatePendingRef.current = false;
    setGatePending(false);
  }, [clearGateTimers]);

  const resolveAllWaiters = useCallback((message: string) => {
    const pending = waiters.current;
    waiters.current = [];
    for (const w of pending) {
      window.clearTimeout(w.timer);
      w.resolve(message);
    }
  }, []);

  const addTranscript = useCallback((role: TranscriptLine['role'], text: string) => {
    setTranscript((t) => [...t.slice(-79), { id: ++lineSeq, role, text }]);
  }, []);

  const clearLastGateDecision = useCallback(() => setLastGateDecision(null), []);

  useEffect(() => {
    const offStatus = client.onStatus(setStatus);
    const offMsg = client.onMessage((m) => {
      if (!jobRef.current) return;

      if (m.type === 'TELEMETRY') {
        if (awaitingSteerRef.current) {
          if (m.status !== 'CANCELLED') return;
          awaitingSteerRef.current = false;
        }

        setTelemetry((t) => [...t.slice(-59), m]);
        setTabsOffloaded((prev) => Math.max(prev, m.tabs_offloaded));

        if (m.status === 'RUNNING' || m.status === 'CANCELLED') {
          setIsRunning(true);
        } else if (
          (m.agent_id === 'synthesis' && m.status === 'COMPLETED') ||
          (m.agent_id === 'scout_swarm' && m.status === 'COMPLETED' && /no reachable sources/i.test(m.message))
        ) {
          setIsRunning(false);
        }

        if (m.agent_id === 'gatekeeper') {
          const isAwaitingPrompt = /awaiting/i.test(m.message);
          const isWithdrawn = m.status === 'CANCELLED' || (m.status === 'BLOCKED' && /withdrawn|superseded/i.test(m.message));
          if (isWithdrawn) {
            clearGateState();
          } else if (gatePendingRef.current && !isAwaitingPrompt && (m.status === 'COMPLETED' || m.status === 'BLOCKED')) {
            clearGateState();
            setIsRunning(false);
          } else if (m.status === 'BLOCKED' || m.status === 'COMPLETED') {
            setIsRunning(false);
          }
        }
      } else if (m.type === 'SYNTHESIS_UPDATE') {
        if (m.job_id !== jobRef.current || awaitingSteerRef.current) return;
        setSynthesis(m);
        setSpotlight(null);
        setIsRunning(false);
        addTranscript('system', `Synthesis: ${m.voice_brief}`);
        resolveAllWaiters(m.voice_brief);
      } else if (m.type === 'GATEKEEPER_INTERCEPT') {
        if (awaitingSteerRef.current) return;
        clearGateTimers();
        gatePendingRef.current = false;
        setGatePending(false);
        gateRef.current = m;
        setGate(m);
        setIsRunning(false);
        addTranscript('system', `Gatekeeper froze ${m.action_type} → ${m.target_url}`);
      }
    });
    client.connect();
    return () => {
      offStatus();
      offMsg();
      clearGateTimers();
      resolveAllWaiters('Session closed.');
      client.close();
    };
  }, [client, addTranscript, clearGateState, clearGateTimers, resolveAllWaiters]);

  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const tick = () => {
      if (inFlight) return;
      inFlight = true;
      getHudMemoryMb()
        .then((v) => {
          if (alive) setRamMb(v);
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };
    tick();
    const id = window.setInterval(tick, 3000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const dispatch = useCallback(
    (intent: string, constraints: string[] = [], contextUrl?: string): Promise<string> => {
      const trimmedIntent = typeof intent === 'string' ? intent.trim() : '';
      if (!trimmedIntent) {
        return Promise.resolve('Research intent cannot be empty.');
      }
      const cleanConstraints = Array.isArray(constraints)
        ? constraints.map((c) => String(c).trim()).filter(Boolean)
        : [];
      const cleanContextUrl =
        typeof contextUrl === 'string' && contextUrl.trim() ? contextUrl.trim() : undefined;

      const dedupeKey = JSON.stringify([trimmedIntent, cleanConstraints, cleanContextUrl ?? '']);
      const now = Date.now();
      if (
        lastDispatchRef.current &&
        lastDispatchRef.current.key === dedupeKey &&
        waiters.current.length > 0 &&
        now - lastDispatchRef.current.at < 1500
      ) {
        return lastDispatchRef.current.promise;
      }

      turnSeqRef.current += 1;
      awaitingSteerRef.current = false;
      resolveAllWaiters('Research superseded by a new dispatch.');
      clearGateState();

      const job_id = `job_${String(++jobSeq).padStart(2, '0')}_${Date.now().toString(36)}`;
      jobRef.current = job_id;
      setJobId(job_id);
      setIsRunning(true);
      setTabsOffloaded(0);

      const notes = pinnedRef.current;
      client.send({
        type: 'DISPATCH_SWARM',
        job_id,
        intent: trimmedIntent,
        constraints: cleanConstraints,
        ...(cleanContextUrl ? { context_url: cleanContextUrl } : {}),
        ...(notes.length ? { pinned_notes: notes } : {}),
      });

      const promise = new Promise<string>((resolve) => {
        const entry: PendingWaiter = {
          resolve,
          timer: 0,
        };
        entry.timer = window.setTimeout(() => {
          waiters.current = waiters.current.filter((w) => w !== entry);
          resolve('Swarm dispatched. Offloading research to the cloud; results are streaming into the Showing Stage.');
        }, 12000);
        waiters.current.push(entry);
      });

      lastDispatchRef.current = { key: dedupeKey, promise, at: now };
      return promise;
    },
    [client, clearGateState, resolveAllWaiters],
  );

  const steer = useCallback(
    (delta: string, cancelDomains?: string[]): string => {
      const job_id = jobRef.current;
      if (!job_id) {
        return 'No active research job to steer.';
      }
      const trimmed = typeof delta === 'string' ? delta.trim() : '';
      if (!trimmed) {
        return 'Steering instruction cannot be empty.';
      }
      const cleanDomains = Array.isArray(cancelDomains)
        ? cancelDomains.map((d) => String(d).trim()).filter(Boolean)
        : undefined;

      turnSeqRef.current += 1;
      awaitingSteerRef.current = true;
      resolveAllWaiters('Research steered; awaiting updated synthesis.');
      clearGateState();
      setIsRunning(true);

      client.send({
        type: 'STEER_SWARM',
        job_id,
        delta_instruction: trimmed,
        ...(cleanDomains && cleanDomains.length ? { cancel_domains: cleanDomains } : {}),
      });
      return 'Steering sent. Stale workers are being cancelled and redirected.';
    },
    [client, clearGateState, resolveAllWaiters],
  );

  const decide = useCallback(
    (approved: boolean) => {
      const g = gateRef.current;
      if (!g || gatePendingRef.current) return;
      gatePendingRef.current = true;
      setGatePending(true);
      setLastGateDecision({ gate_id: g.gate_id, approved, at: Date.now() });
      client.send({ type: 'APPROVAL_DECISION', gate_id: g.gate_id, approved });
      addTranscript('system', `Gate ${g.gate_id} ${approved ? 'approved' : 'rejected'}`);

      clearGateTimers();
      if (client.getStatus() === 'DISCONNECTED') {
        clearGateState();
        return;
      }
      gatePendingTimerRef.current = window.setTimeout(() => {
        clearGateState();
      }, 2500);
    },
    [client, addTranscript, clearGateState, clearGateTimers],
  );

  const doSpotlight = useCallback((source_url: string, quote: string, badge_text: string) => {
    setSpotlight({ source_url, quote, badge_text, nonce: ++nonceSeq });
  }, []);
  const clearSpotlight = useCallback(() => setSpotlight(null), []);

  const handoff = useCallback(
    async (url: string): Promise<boolean> => {
      if (!isSafeExternalUrl(url)) {
        addTranscript('system', 'Blocked unsafe handoff URL (https:// required).');
        return false;
      }
      const opened = await openExternal(url);
      if (opened) {
        addTranscript('system', `Handed off to default browser: ${url}`);
      } else {
        addTranscript('system', `Browser handoff failed or was blocked: ${url}`);
      }
      return opened;
    },
    [addTranscript],
  );

  const pinNote = useCallback((source_url: string, text: string) => {
    setPinned((p) =>
      p.some((n) => n.source_url === source_url && n.text === text)
        ? p
        : [...p, { note_id: `nt_${String(++noteSeq).padStart(2, '0')}`, source_url, text }],
    );
  }, []);
  const unpinNote = useCallback((id: string) => setPinned((p) => p.filter((n) => n.note_id !== id)), []);

  const resetSession = useCallback(async () => {
    if (!client.isMock) {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 3000);
      try {
        await fetch(buildResetUrl(), { method: 'POST', signal: controller.signal });
      } catch {
        /* fall back gracefully if backend reset endpoint is unreachable */
      } finally {
        window.clearTimeout(timeoutId);
      }
    }

    client.reset();
    turnSeqRef.current += 1;
    awaitingSteerRef.current = false;
    lastDispatchRef.current = null;
    resolveAllWaiters('Session reset.');
    clearGateState();
    jobRef.current = null;
    setJobId(null);
    setIsRunning(false);
    setLastGateDecision(null);
    setSynthesis(null);
    setSpotlight(null);
    setTranscript([]);
    setTelemetry([]);
    setTabsOffloaded(0);
    setPinned([]);
  }, [client, clearGateState, resolveAllWaiters]);

  const latest = telemetry.length ? telemetry[telemetry.length - 1] : null;

  return {
    status,
    isMock: client.isMock,
    jobId,
    isRunning,
    telemetry,
    latest,
    tabsOffloaded,
    workersActive: jobId ? (latest?.workers_active ?? 0) : 0,
    ramMb,
    synthesis,
    gate,
    gatePending,
    lastGateDecision,
    clearLastGateDecision,
    spotlight,
    pinned,
    transcript,
    highContrast,
    setHighContrast,
    dispatch,
    steer,
    decide,
    doSpotlight,
    clearSpotlight,
    handoff,
    pinNote,
    unpinNote,
    addTranscript,
    resetSession,
  };
}
