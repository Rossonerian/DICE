import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createWsClient, type WsClient } from '../wsClient';
import type {
  GatekeeperInterceptMessage,
  PinnedNote,
  SpotlightTarget,
  SynthesisUpdateMessage,
  TelemetryMessage,
  WsConnectionStatus,
} from '../types';
import { getHudMemoryMb, openExternal } from './platform';

export interface TranscriptLine {
  id: number;
  role: 'user' | 'agent' | 'system';
  text: string;
}

export interface SpotlightState extends SpotlightTarget {
  nonce: number;
}

export interface HudApi {
  status: WsConnectionStatus;
  isMock: boolean;
  jobId: string | null;
  telemetry: TelemetryMessage[];
  latest: TelemetryMessage | null;
  tabsOffloaded: number;
  workersActive: number;
  ramMb: number;
  synthesis: SynthesisUpdateMessage | null;
  gate: GatekeeperInterceptMessage | null;
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
  handoff: (url: string) => string;
  pinNote: (source_url: string, text: string) => void;
  unpinNote: (note_id: string) => void;
  addTranscript: (role: TranscriptLine['role'], text: string) => void;
}

let jobSeq = 0;
let noteSeq = 0;
let lineSeq = 0;
let nonceSeq = 0;

export function useHud(): HudApi {
  const clientRef = useRef<WsClient | null>(null);
  if (!clientRef.current) clientRef.current = createWsClient();
  const client = clientRef.current;

  const [status, setStatus] = useState<WsConnectionStatus>(client.getStatus());
  const [telemetry, setTelemetry] = useState<TelemetryMessage[]>([]);
  const [synthesis, setSynthesis] = useState<SynthesisUpdateMessage | null>(null);
  const [gate, setGate] = useState<GatekeeperInterceptMessage | null>(null);
  const [spotlight, setSpotlight] = useState<SpotlightState | null>(null);
  const [pinned, setPinned] = useState<PinnedNote[]>([]);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [ramMb, setRamMb] = useState(0);
  const [highContrast, setHighContrast] = useState(false);

  const jobRef = useRef<string | null>(null);
  const pinnedRef = useRef<PinnedNote[]>([]);
  const waiters = useRef<Array<(brief: string) => void>>([]);

  const gateRef = useRef<GatekeeperInterceptMessage | null>(null);
  gateRef.current = gate;
  pinnedRef.current = pinned;

  const addTranscript = useCallback((role: TranscriptLine['role'], text: string) => {
    setTranscript((t) => [...t.slice(-79), { id: ++lineSeq, role, text }]);
  }, []);

  useEffect(() => {
    const offStatus = client.onStatus(setStatus);
    const offMsg = client.onMessage((m) => {
      if (m.type === 'TELEMETRY') {
        setTelemetry((t) => [...t.slice(-59), m]);
      } else if (m.type === 'SYNTHESIS_UPDATE') {
        setSynthesis(m);
        setSpotlight(null);
        addTranscript('system', `Synthesis: ${m.voice_brief}`);
        const w = waiters.current;
        waiters.current = [];
        w.forEach((fn) => fn(m.voice_brief));
      } else if (m.type === 'GATEKEEPER_INTERCEPT') {
        setGate(m);
        addTranscript('system', `Gatekeeper froze ${m.action_type} → ${m.target_url}`);
      }
    });
    client.connect();
    return () => {
      offStatus();
      offMsg();
      client.close();
    };
  }, [client, addTranscript]);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      getHudMemoryMb().then((v) => {
        if (alive) setRamMb(v);
      });
    tick();
    const id = window.setInterval(tick, 3000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const dispatch = useCallback(
    (intent: string, constraints: string[] = [], contextUrl?: string) => {
      const job_id = `job_${String(++jobSeq).padStart(2, '0')}_${Date.now().toString(36)}`;
      jobRef.current = job_id;
      setJobId(job_id);
      const notes = pinnedRef.current;
      client.send({
        type: 'DISPATCH_SWARM',
        job_id,
        intent,
        constraints,
        ...(contextUrl ? { context_url: contextUrl } : {}),
        ...(notes.length ? { pinned_notes: notes } : {}),
      });
      return new Promise<string>((resolve) => {
        const timer = window.setTimeout(() => {
          waiters.current = waiters.current.filter((f) => f !== fn);
          resolve('Swarm dispatched. Offloading research to the cloud; results are streaming into the Showing Stage.');
        }, 12000);
        const fn = (brief: string) => {
          window.clearTimeout(timer);
          resolve(brief);
        };
        waiters.current.push(fn);
      });
    },
    [client],
  );

  const steer = useCallback(
    (delta: string, cancelDomains?: string[]) => {
      const job_id = jobRef.current ?? 'job_01';
      client.send({
        type: 'STEER_SWARM',
        job_id,
        delta_instruction: delta,
        ...(cancelDomains && cancelDomains.length ? { cancel_domains: cancelDomains } : {}),
      });
      return 'Steering sent. Stale workers are being cancelled and redirected.';
    },
    [client],
  );

  const decide = useCallback(
    (approved: boolean) => {
      const g = gateRef.current;
      if (!g) return;
      client.send({ type: 'APPROVAL_DECISION', gate_id: g.gate_id, approved });
      addTranscript('system', `Gate ${g.gate_id} ${approved ? 'approved' : 'rejected'}`);
      gateRef.current = null;
      setGate(null);
    },
    [client, addTranscript],
  );

  const doSpotlight = useCallback((source_url: string, quote: string, badge_text: string) => {
    setSpotlight({ source_url, quote, badge_text, nonce: ++nonceSeq });
  }, []);
  const clearSpotlight = useCallback(() => setSpotlight(null), []);

  const handoff = useCallback((url: string) => {
    void openExternal(url);
    addTranscript('system', `Handed off to default browser: ${url}`);
    return `Opened ${url} in the default browser.`;
  }, [addTranscript]);

  const pinNote = useCallback((source_url: string, text: string) => {
    setPinned((p) =>
      p.some((n) => n.source_url === source_url && n.text === text)
        ? p
        : [...p, { note_id: `nt_${String(++noteSeq).padStart(2, '0')}`, source_url, text }],
    );
  }, []);
  const unpinNote = useCallback((id: string) => setPinned((p) => p.filter((n) => n.note_id !== id)), []);

  const latest = telemetry.length ? telemetry[telemetry.length - 1] : null;
  const tabsOffloaded = useMemo(() => telemetry.reduce((m, t) => Math.max(m, t.tabs_offloaded), 0), [telemetry]);

  return {
    status,
    isMock: client.isMock,
    jobId,
    telemetry,
    latest,
    tabsOffloaded,
    workersActive: latest?.workers_active ?? 0,
    ramMb,
    synthesis,
    gate,
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
  };
}
