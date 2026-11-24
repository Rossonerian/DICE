import { useEffect, useMemo, useRef } from 'react';
import type { HudApi } from '../hooks/useHud';
import { hostOf, normalizeUrl } from '../hooks/platform';
import type { EvidenceCard } from '../types';

type Props = { hud: HudApi };

function Highlighted({ text, quote, active }: { text: string; quote: string; active: boolean }) {
  const q = quote.trim();
  const idx = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className={active ? 'spot' : 'rounded bg-amber-500/30 px-0.5 text-amber-100'} data-spot={active ? '1' : undefined}>
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  );
}

function findActiveCard(cards: EvidenceCard[], url: string, quote: string): number {
  const u = normalizeUrl(url);
  const q = quote.trim().toLowerCase();
  const byBoth = cards.findIndex((c) => normalizeUrl(c.source_url) === u && q && c.sanitized_excerpt.toLowerCase().includes(q));
  if (byBoth >= 0) return byBoth;
  const byUrl = cards.findIndex((c) => normalizeUrl(c.source_url) === u);
  if (byUrl >= 0) return byUrl;
  return q ? cards.findIndex((c) => c.sanitized_excerpt.toLowerCase().includes(q)) : -1;
}

export default function ShowingStage({ hud }: Props) {
  const { synthesis: s, spotlight } = hud;
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);
  const spokenFor = useRef<string>('');

  const cards = s?.evidence_cards ?? [];
  const activeIdx = useMemo(
    () => (spotlight ? findActiveCard(cards, spotlight.source_url, spotlight.quote) : -1),
    [spotlight, cards],
  );

  useEffect(() => {
    if (!spotlight || activeIdx < 0) return;
    const el = cardRefs.current[activeIdx];
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = window.setTimeout(() => {
      el.querySelector('mark[data-spot="1"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 450);
    return () => window.clearTimeout(t);
  }, [spotlight?.nonce, activeIdx]);

  // Narrated mode: speak the voice brief (optional, local speechSynthesis)
  useEffect(() => {
    if (!hud.highContrast || !s || spokenFor.current === s.voice_brief) return;
    spokenFor.current = s.voice_brief;
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(s.voice_brief));
    }
  }, [hud.highContrast, s]);

  if (!s) {
    return (
      <div className="panel flex h-full items-center justify-center rounded-lg border border-slate-700 bg-slate-900/60 p-6 text-center">
        <div>
          <div className="text-4xl">🎲</div>
          <div className="mt-2 text-lg font-semibold">Showing Stage</div>
          <div className="muted text-sm text-slate-400">Speak or type a research request. Sanitized evidence and comparisons appear here.</div>
        </div>
      </div>
    );
  }

  const winner = s.items.length
    ? s.items.reduce((best, it) => (it.cons.length < best.cons.length ? it : best), s.items[0])
    : null;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-1">
      <div className="panel rounded-lg border border-cyan-700 bg-cyan-950/40 p-3">
        <div className="muted text-xs uppercase tracking-wide text-cyan-300">Voice brief</div>
        <div className="text-sm">{s.voice_brief}</div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {s.items.map((it) => {
          const isWinner = winner === it;
          return (
            <div key={it.name} className={`panel rounded-lg border p-3 ${isWinner ? 'border-emerald-500 bg-emerald-950/30' : 'border-slate-700 bg-slate-900/60'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="font-semibold">{it.name}</div>
                <div className="text-sm font-bold text-cyan-300">{it.price}</div>
              </div>
              {isWinner && <div className="text-xs font-semibold text-emerald-300">★ Top pick</div>}
              <ul className="mt-1 text-xs text-emerald-300">
                {it.pros.map((p) => (
                  <li key={p}>＋ {p}</li>
                ))}
              </ul>
              <ul className="text-xs text-red-300">
                {it.cons.map((c) => (
                  <li key={c}>－ {c}</li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap gap-2">
                <button onClick={() => hud.handoff(it.url)} className="rounded bg-emerald-600 px-2 py-1 text-xs font-semibold text-white hover:bg-emerald-500">
                  Open Verified Link in Browser
                </button>
                <button
                  onClick={() => hud.pinNote(it.url, `${it.name} (${it.price}): +${it.pros.join(', ')} / −${it.cons.join(', ')}`)}
                  className="rounded border border-amber-400 px-2 py-1 text-xs text-amber-300 hover:bg-amber-400/10"
                >
                  📌 Pin Note
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {s.contradictions.length > 0 && (
        <div className="panel rounded-lg border border-red-700 bg-red-950/30 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-red-300">Contradictions (click to spotlight)</div>
          <div className="mt-1 flex flex-col gap-1">
            {s.contradictions.map((c, i) => (
              <button
                key={i}
                onClick={() => hud.doSpotlight(c.source_url, c.quote_to_highlight, `Contradiction: ${c.conflict}`)}
                className="rounded bg-red-900/40 p-2 text-left text-sm hover:bg-red-900/70"
              >
                <span className="font-semibold">⚠ {c.claim}</span>
                <span className="muted block text-xs text-red-200">{c.conflict}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {cards.map((c, i) => {
          const active = i === activeIdx && !!spotlight;
          const contra = s.contradictions.find((x) => normalizeUrl(x.source_url) === normalizeUrl(c.source_url));
          const quote = active && spotlight ? spotlight.quote || c.quote_to_highlight : c.quote_to_highlight;
          return (
            <div
              key={`${c.source_url}-${i}`}
              ref={(el) => {
                cardRefs.current[i] = el;
              }}
              className={`panel relative rounded-lg border bg-slate-900/70 p-3 ${active ? 'card-spot border-cyan-400' : 'border-slate-700'}`}
            >
              {active && spotlight && (
                <div className="absolute -top-3 right-3 z-10 rounded-full bg-red-600 px-3 py-1 text-xs font-bold text-white shadow-lg">
                  ⚠ {spotlight.badge_text || contra?.conflict || 'Contradiction'}
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold">{c.title}</div>
                <div className="muted text-xs text-slate-400">{hostOf(c.source_url)}</div>
              </div>
              <p className="mt-1 text-sm leading-relaxed text-slate-200">
                <Highlighted text={c.sanitized_excerpt} quote={quote} active={active} />
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button onClick={() => hud.handoff(c.source_url)} className="rounded bg-emerald-600 px-2 py-1 text-xs font-semibold text-white hover:bg-emerald-500">
                  Open Verified Link in Browser
                </button>
                <button
                  onClick={() => hud.pinNote(c.source_url, c.quote_to_highlight || c.sanitized_excerpt.slice(0, 160))}
                  className="rounded border border-amber-400 px-2 py-1 text-xs text-amber-300 hover:bg-amber-400/10"
                >
                  📌 Pin Note
                </button>
                {active && (
                  <button onClick={hud.clearSpotlight} className="rounded border border-slate-500 px-2 py-1 text-xs">
                    Clear spotlight
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
