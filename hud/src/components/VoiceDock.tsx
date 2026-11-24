import { useCallback, useEffect, useRef, useState } from 'react';
import { Conversation } from '@elevenlabs/client';
import type { HudApi } from '../hooks/useHud';

type Props = { hud: HudApi };

const DEMO_QUERY = 'Compare top 3 ANC headphones under 25k INR and check Reddit hinge issues';
const AGENT_ID = (import.meta.env.VITE_ELEVENLABS_AGENT_ID as string | undefined) ?? '';

type VoiceState = 'idle' | 'connecting' | 'listening' | 'speaking' | 'error';

export default function VoiceDock({ hud }: Props) {
  const [voice, setVoice] = useState<VoiceState>('idle');
  const [voiceErr, setVoiceErr] = useState('');
  const [text, setText] = useState('');
  const [ctxUrl, setCtxUrl] = useState('');
  const [mode, setMode] = useState<'new' | 'steer'>('new');
  const convRef = useRef<Awaited<ReturnType<typeof Conversation.startSession>> | null>(null);
  const hudRef = useRef(hud);
  hudRef.current = hud;
  const ctxRef = useRef(ctxUrl);
  ctxRef.current = ctxUrl;

  const submit = useCallback(() => {
    const v = text.trim();
    if (!v) return;
    const h = hudRef.current;
    h.addTranscript('user', v);
    if (mode === 'steer' && h.jobId) {
      h.addTranscript('agent', h.steer(v));
    } else {
      void h.dispatch(v, [], ctxUrl.trim() || undefined);
      if (mode === 'new') setMode('steer');
    }
    setText('');
  }, [text, mode, ctxUrl]);

  const stopVoice = useCallback(async () => {
    const c = convRef.current;
    convRef.current = null;
    setVoice('idle');
    try {
      await c?.endSession();
    } catch {
      /* ignore */
    }
  }, []);

  const startVoice = useCallback(async () => {
    if (!AGENT_ID || AGENT_ID === 'your_elevenlabs_agent_id') {
      setVoiceErr('Set VITE_ELEVENLABS_AGENT_ID in hud/.env to enable voice. Silent Mode below works fully.');
      setVoice('error');
      return;
    }
    setVoice('connecting');
    setVoiceErr('');
    try {
      const conv = await Conversation.startSession({
        agentId: AGENT_ID,
        connectionType: 'webrtc',
        clientTools: {
          dispatch_swarm: async (p: { intent: string; constraints?: string[] }) => {
            const h = hudRef.current;
            h.addTranscript('user', `🎙 ${p.intent}`);
            return h.dispatch(p.intent, p.constraints ?? [], ctxRef.current.trim() || undefined);
          },
          steer_swarm: (p: { delta_instruction: string; cancel_domains?: string[] }) => {
            const h = hudRef.current;
            h.addTranscript('user', `🎙 ${p.delta_instruction}`);
            return h.steer(p.delta_instruction, p.cancel_domains);
          },
          spotlight_evidence: (p: { source_url: string; quote: string; badge_text: string }) => {
            hudRef.current.doSpotlight(p.source_url, p.quote, p.badge_text);
            return 'Spotlight applied in the Showing Stage.';
          },
          handoff_to_browser: (p: { url: string }) => hudRef.current.handoff(p.url),
        },
        onModeChange: ({ mode: m }) => setVoice(m === 'speaking' ? 'speaking' : 'listening'),
        onMessage: ({ role, message }) => {
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
        onDisconnect: () => {
          convRef.current = null;
          setVoice('idle');
        },
        onError: (m: string) => {
          setVoiceErr(String(m));
          setVoice('error');
        },
      });
      convRef.current = conv;
      setVoice('listening');
    } catch (e) {
      setVoiceErr(e instanceof Error ? e.message : String(e));
      setVoice('error');
    }
  }, []);

  useEffect(
    () => () => {
      void convRef.current?.endSession().catch(() => undefined);
    },
    [],
  );

  const active = voice === 'listening' || voice === 'speaking';
  const orbColor =
    voice === 'speaking' ? 'bg-cyan-400' : voice === 'listening' ? 'bg-emerald-400' : voice === 'error' ? 'bg-red-500' : 'bg-slate-600';

  return (
    <section className="panel flex flex-col gap-2 border-t border-slate-700 bg-slate-900/90 p-3">
      <div className="flex items-center gap-3">
        <button
          onClick={() => (active || voice === 'connecting' ? void stopVoice() : void startVoice())}
          className={`h-12 w-12 shrink-0 rounded-full ${orbColor} ${active ? 'orb-active' : ''} text-xl text-slate-900 shadow-lg`}
          title={active ? 'End voice session' : 'Start voice session (ElevenLabs WebRTC)'}
          aria-label="Voice orb"
        >
          🎙
        </button>
        <div className="min-w-0 flex-1">
          <div className="muted text-xs uppercase tracking-wide text-slate-400">
            Voice: {voice}
            {hud.isMock ? ' · mock backend' : ''}
          </div>
          {voiceErr && <div className="truncate text-xs text-amber-300">{voiceErr}</div>}
          <div className="mt-1 max-h-16 overflow-y-auto text-xs" aria-live="polite">
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
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="muted text-slate-400">📌 Pinned notes (sent with next dispatch):</span>
          {hud.pinned.map((n) => (
            <span key={n.note_id} className="flex max-w-[16rem] items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-amber-200">
              <span className="truncate" title={n.text}>
                {n.text}
              </span>
              <button onClick={() => hud.unpinNote(n.note_id)} aria-label="Remove note">
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded border border-slate-600 text-xs">
          <button onClick={() => setMode('new')} className={`px-2 py-1 ${mode === 'new' ? 'bg-cyan-600 text-white' : 'bg-slate-800'}`}>
            New Research
          </button>
          <button onClick={() => setMode('steer')} className={`px-2 py-1 ${mode === 'steer' ? 'bg-amber-500 text-black' : 'bg-slate-800'}`}>
            Steer / Barge-In
          </button>
        </div>
        {hud.isMock && (
          <button
            onClick={() => {
              setMode('new');
              setText(DEMO_QUERY);
            }}
            className="rounded-full border border-cyan-500 px-2 py-1 text-xs text-cyan-300 hover:bg-cyan-500/20"
          >
            Demo Query
          </button>
        )}
        <input
          value={ctxUrl}
          onChange={(e) => setCtxUrl(e.target.value)}
          placeholder="Paste context URL (optional)"
          className="min-w-[10rem] flex-1 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs"
        />
      </div>
      <div className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder={mode === 'new' || !hud.jobId ? 'Silent Mode: type a research request…' : 'Silent Mode: steer the live swarm (e.g. Drop Sony XM5, prioritize multipoint)…'}
          className="flex-1 rounded border border-slate-600 bg-slate-800 px-3 py-2 text-sm"
        />
        <button onClick={submit} className="rounded bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-500">
          {mode === 'steer' && hud.jobId ? 'Steer' : 'Dispatch'}
        </button>
      </div>
    </section>
  );
}
