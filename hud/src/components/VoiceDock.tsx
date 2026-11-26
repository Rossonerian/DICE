import { useCallback, useEffect, useRef, useState } from 'react';
import { Conversation } from '@elevenlabs/client';
import type { HudApi } from '../hooks/useHud';
import { isSafeExternalUrl, normalizeUrl } from '../hooks/platform';

type Props = { hud: HudApi };

const DEMO_QUERY = 'Compare top 3 ANC headphones under 25k INR and check Reddit hinge issues';
const AGENT_ID = ((import.meta.env.VITE_ELEVENLABS_AGENT_ID as string | undefined) ?? '').trim();
const VOICE_CONFIGURED = Boolean(AGENT_ID) && AGENT_ID !== 'your_elevenlabs_agent_id';

type VoiceState = 'idle' | 'connecting' | 'listening' | 'speaking' | 'mic_denied' | 'error';

function asString(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v).trim();
  return '';
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(asString).filter(Boolean);
  }
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export default function VoiceDock({ hud }: Props) {
  const [voice, setVoice] = useState<VoiceState>('idle');
  const [voiceErr, setVoiceErr] = useState('');
  const [text, setText] = useState('');
  const [ctxUrl, setCtxUrl] = useState('');
  const [mode, setMode] = useState<'new' | 'steer'>('new');
  const [submitting, setSubmitting] = useState(false);

  const convRef = useRef<Awaited<ReturnType<typeof Conversation.startSession>> | null>(null);
  const sessionTokenRef = useRef(0);
  const startingRef = useRef(false);
  const mountedRef = useRef(true);
  const submittingRef = useRef(false);
  const wasRunningRef = useRef(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const hudRef = useRef(hud);
  hudRef.current = hud;
  const ctxRef = useRef(ctxUrl);
  ctxRef.current = ctxUrl;

  useEffect(() => {
    if (wasRunningRef.current && !hud.isRunning) {
      setMode('new');
    }
    wasRunningRef.current = hud.isRunning;
  }, [hud.isRunning]);

  useEffect(() => {
    if (!hud.jobId) {
      setMode('new');
    }
  }, [hud.jobId]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [hud.transcript.length]);

  const submit = useCallback(() => {
    const v = text.trim();
    const h = hudRef.current;
    if (!v || submittingRef.current || h.gate) return;

    submittingRef.current = true;
    setSubmitting(true);
    h.addTranscript('user', v);

    if (mode === 'steer' && h.jobId) {
      h.addTranscript('agent', h.steer(v));
    } else {
      void h.dispatch(v, [], ctxUrl.trim() || undefined);
      setMode('steer');
    }

    setText('');
    window.setTimeout(() => {
      submittingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }, 150);
  }, [text, mode, ctxUrl]);

  const stopVoice = useCallback(async () => {
    ++sessionTokenRef.current;
    startingRef.current = false;
    const c = convRef.current;
    convRef.current = null;
    if (mountedRef.current) setVoice('idle');
    if (c) {
      try {
        await c.endSession();
      } catch {
        /* ignore */
      }
    }
  }, []);

  const startVoice = useCallback(async () => {
    if (!VOICE_CONFIGURED) {
      if (mountedRef.current) {
        setVoiceErr('Voice disabled (no ElevenLabs Agent ID). Silent Mode below works fully.');
        setVoice('idle');
      }
      return;
    }
    if (startingRef.current) return;
    if (convRef.current) {
      await stopVoice();
    }

    startingRef.current = true;
    const tok = ++sessionTokenRef.current;
    if (mountedRef.current) {
      setVoice('connecting');
      setVoiceErr('');
    }

    try {
      const conv = await Conversation.startSession({
        agentId: AGENT_ID,
        connectionType: 'webrtc',
        clientTools: {
          dispatch_swarm: async (p: unknown) => {
            const obj = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
            const intent = asString(obj.intent);
            if (!intent) return 'Blocked: missing research intent.';
            const constraints = asStringArray(obj.constraints);
            const h = hudRef.current;
            h.addTranscript('user', `🎙 ${intent}`);
            if (mountedRef.current) setMode('steer');
            return h.dispatch(intent, constraints, ctxRef.current.trim() || undefined);
          },
          steer_swarm: (p: unknown) => {
            const obj = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
            const delta = asString(obj.delta_instruction);
            if (!delta) return 'Blocked: missing steer instruction.';
            const cancelDomains = asStringArray(obj.cancel_domains);
            const h = hudRef.current;
            if (!h.jobId) return 'No active research job to steer.';
            h.addTranscript('user', `🎙 ${delta}`);
            return h.steer(delta, cancelDomains.length ? cancelDomains : undefined);
          },
          spotlight_evidence: (p: unknown) => {
            const obj = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
            const source_url = asString(obj.source_url);
            const quote = asString(obj.quote);
            const badge_text = asString(obj.badge_text) || 'Evidence';
            if (!source_url && !quote) return 'Blocked: missing spotlight source_url or quote.';
            hudRef.current.doSpotlight(source_url, quote, badge_text);
            return 'Spotlight applied in the Showing Stage.';
          },
          handoff_to_browser: async (p: unknown) => {
            const obj = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
            const rawUrl = asString(obj.url);
            if (!isSafeExternalUrl(rawUrl)) {
              return 'Blocked: only verified https:// URLs can be opened.';
            }
            const s = hudRef.current.synthesis;
            const target = normalizeUrl(rawUrl);
            const verified = s
              ? [
                  ...s.items.map((i) => i.url),
                  ...s.evidence_cards.map((c) => c.source_url),
                  ...s.contradictions.map((c) => c.source_url),
                  ...s.mind_map.nodes.map((n) => n.source_url),
                ].some((u) => Boolean(u) && normalizeUrl(u) === target)
              : false;
            if (!verified) {
              return 'Blocked: URL is not in the verified synthesis results.';
            }
            const ok = await hudRef.current.handoff(rawUrl);
            return ok ? `Opened ${rawUrl} in the default browser.` : `Blocked: failed to open ${rawUrl}.`;
          },
        },
        onModeChange: ({ mode: m }) => {
          if (!mountedRef.current || sessionTokenRef.current !== tok) return;
          setVoice(m === 'speaking' ? 'speaking' : 'listening');
        },
        onMessage: ({ role, message }) => {
          if (!mountedRef.current || sessionTokenRef.current !== tok) return;
          const h = hudRef.current;
          if (role === 'user') {
            h.addTranscript('user', message);
            // Voice confirmation hook for the Gatekeeper approval card
            if (h.gate) {
              if (/\b(approve|approved|confirm|go ahead)\b/i.test(message) && !/\b(don't|do not|not)\b/i.test(message)) h.decide(true);
              else if (/\b(reject|deny|block|cancel|stop)\b/i.test(message)) h.decide(false);
            }
          } else {
            h.addTranscript('agent', message);
          }
        },
        onDisconnect: (details) => {
          if (!mountedRef.current || sessionTokenRef.current !== tok) return;
          convRef.current = null;
          setVoice('idle');
          if (details?.reason === 'error') {
            const msg = 'Voice disconnected — Silent Mode active.';
            setVoiceErr(msg);
            hudRef.current.addTranscript('system', msg);
          }
        },
        onError: (m: string) => {
          if (!mountedRef.current || sessionTokenRef.current !== tok) return;
          const c = convRef.current;
          convRef.current = null;
          if (c) void c.endSession().catch(() => undefined);
          setVoiceErr(String(m));
          setVoice('error');
        },
      });

      if (sessionTokenRef.current === tok) {
        startingRef.current = false;
      }
      if (!mountedRef.current || sessionTokenRef.current !== tok) {
        await conv.endSession().catch(() => undefined);
        return;
      }
      convRef.current = conv;
      setVoice('listening');
    } catch (e) {
      if (sessionTokenRef.current === tok) {
        startingRef.current = false;
      }
      if (!mountedRef.current || sessionTokenRef.current !== tok) return;
      const name = e instanceof Error ? e.name : '';
      const msg = e instanceof Error ? e.message : String(e);
      const isMicDenied =
        name === 'NotAllowedError' ||
        name === 'PermissionDeniedError' ||
        /notallowed|permission denied|microphone/i.test(msg);
      setVoiceErr(isMicDenied ? 'Microphone access denied — use Silent Mode below to type requests.' : msg);
      setVoice(isMicDenied ? 'mic_denied' : 'error');
    }
  }, [stopVoice]);

  useEffect(() => {
    mountedRef.current = true;
    const onVisibility = () => {
      if (document.hidden) void stopVoice();
    };
    const onPageHide = () => {
      void stopVoice();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      mountedRef.current = false;
      ++sessionTokenRef.current;
      startingRef.current = false;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      const c = convRef.current;
      convRef.current = null;
      void c?.endSession().catch(() => undefined);
    };
  }, [stopVoice]);

  const active = voice === 'listening' || voice === 'speaking';
  const orbColor = !VOICE_CONFIGURED
    ? 'bg-slate-800 text-slate-400 opacity-50 cursor-not-allowed'
    : voice === 'speaking'
      ? 'bg-cyan-400 text-slate-950'
      : voice === 'listening'
        ? 'bg-emerald-400 text-slate-950'
        : voice === 'connecting'
          ? 'bg-amber-400 text-slate-950 animate-pulse'
          : voice === 'mic_denied' || voice === 'error'
            ? 'bg-red-600 text-white'
            : 'bg-slate-700 text-slate-100';

  const orbLabel = !VOICE_CONFIGURED
    ? 'Voice disabled (no Agent ID) — Silent Mode active'
    : voice === 'connecting'
      ? 'Connecting voice session — click to cancel'
      : voice === 'listening'
        ? 'Listening — click to stop voice session'
        : voice === 'speaking'
          ? 'Agent speaking — click to stop voice session'
          : voice === 'mic_denied'
            ? 'Microphone access denied — click to retry'
            : voice === 'error'
              ? 'Voice error — click to retry'
              : 'Idle — click to start voice session (ElevenLabs WebRTC)';

  const canSubmit = Boolean(text.trim()) && !submitting && !hud.gate;
  const steerDisabled = !hud.jobId;

  return (
    <section className="panel flex flex-col gap-2 border-t border-slate-700 bg-slate-900/90 p-3 backdrop-blur-md ring-1 ring-white/15">
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!VOICE_CONFIGURED}
          onClick={() => (active || voice === 'connecting' ? void stopVoice() : void startVoice())}
          className={`h-12 w-12 shrink-0 rounded-full ${orbColor} ${active ? 'orb-active' : ''} text-xl shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400`}
          title={orbLabel}
          aria-label={orbLabel}
          aria-busy={voice === 'connecting'}
        >
          🎙
        </button>
        <div className="min-w-0 flex-1">
          <div className="muted text-xs uppercase tracking-wide text-slate-400">
            Voice: {VOICE_CONFIGURED ? voice : 'off · Silent Mode active'}
            {hud.isMock ? ' · mock backend' : ''}
          </div>
          {voiceErr && <div className="line-clamp-2 break-words text-xs text-amber-300">{voiceErr}</div>}
          <div ref={transcriptRef} className="mt-1 max-h-16 overflow-y-auto text-xs" aria-live="polite">
            {hud.transcript.slice(-4).map((l) => (
              <div key={l.id} className={l.role === 'user' ? 'text-cyan-300' : l.role === 'agent' ? 'text-emerald-300' : 'muted text-slate-400'}>
                {l.role === 'user' ? 'You: ' : l.role === 'agent' ? 'Agent: ' : '• '}
                {l.text}
              </div>
            ))}
          </div>
        </div>
      </div>

      {hud.pinned.length > 0 && (
        <div className="flex max-h-14 flex-wrap items-center gap-1 overflow-y-auto text-xs">
          <span className="muted text-slate-400">📌 Pinned notes (sent with next dispatch):</span>
          {hud.pinned.map((n) => (
            <span key={n.note_id} className="flex max-w-[16rem] items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-amber-200">
              <span className="truncate" title={n.text}>
                {n.text}
              </span>
              <button
                type="button"
                onClick={() => hud.unpinNote(n.note_id)}
                aria-label="Remove note"
                className="inline-flex min-h-6 min-w-6 items-center justify-center rounded hover:bg-amber-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded border border-slate-600 text-xs">
          <button
            type="button"
            onClick={() => setMode('new')}
            aria-pressed={mode === 'new'}
            className={`px-2 py-1 ${mode === 'new' ? 'bg-cyan-700 text-white' : 'bg-slate-800 text-slate-200 hover:bg-slate-700'}`}
          >
            New Research
          </button>
          <button
            type="button"
            disabled={steerDisabled}
            onClick={() => setMode('steer')}
            aria-pressed={mode === 'steer'}
            className={`px-2 py-1 ${mode === 'steer' && !steerDisabled ? 'bg-amber-400 text-slate-950' : 'bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40'}`}
          >
            Steer / Barge-In
          </button>
        </div>
        {!hud.jobId && (
          <button
            type="button"
            onClick={() => {
              setMode('new');
              setText(DEMO_QUERY);
              inputRef.current?.focus();
            }}
            className="rounded-full border border-cyan-500 px-2 py-1 text-xs text-cyan-300 hover:bg-cyan-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            Demo Query
          </button>
        )}
        <input
          value={ctxUrl}
          onChange={(e) => setCtxUrl(e.target.value)}
          aria-label="Context URL"
          placeholder="Paste context URL (optional)"
          className="min-w-[10rem] flex-1 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        />
      </div>
      <div className="flex gap-2">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && !hud.gate) {
              submit();
            }
          }}
          aria-label="Silent Mode research input"
          placeholder={
            mode === 'new' || !hud.jobId
              ? 'Silent Mode: type a research request…'
              : 'Silent Mode: steer the live swarm (e.g. Drop Sony XM5, prioritize multipoint)…'
          }
          className="flex-1 rounded border border-slate-600 bg-slate-800 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        />
        <button
          type="button"
          disabled={!canSubmit}
          onClick={submit}
          className="rounded bg-cyan-700 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {mode === 'steer' && hud.jobId ? 'Steer' : 'Dispatch'}
        </button>
      </div>
    </section>
  );
}
