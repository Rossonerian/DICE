import { useEffect, useMemo, useRef, useState } from 'react';
import type { HudApi } from '../hooks/useHud';
import { hostOf, isSafeExternalUrl, normalizeUrl } from '../hooks/platform';
import type { EvidenceCard } from '../types';

type Props = { hud: HudApi };

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    });
}

function Highlighted({ text, quote, active }: { text: string; quote: string; active: boolean }) {
  const q = quote.trim();
  if (!q) return <>{text}</>;
  const lowerText = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  const parts: Array<{ str: string; match: boolean }> = [];
  let cursor = 0;
  let idx = lowerText.indexOf(lowerQ, cursor);
  while (idx >= 0) {
    if (idx > cursor) parts.push({ str: text.slice(cursor, idx), match: false });
    parts.push({ str: text.slice(idx, idx + q.length), match: true });
    cursor = idx + q.length;
    idx = lowerText.indexOf(lowerQ, cursor);
  }
  if (parts.length === 0) return <>{text}</>;
  if (cursor < text.length) parts.push({ str: text.slice(cursor), match: false });

  let firstMatchAssigned = false;
  return (
    <>
      {parts.map((part, idxPart) => {
        if (!part.match) return <span key={idxPart}>{part.str}</span>;
        const isFirst = !firstMatchAssigned;
        firstMatchAssigned = true;
        return (
          <mark
            key={idxPart}
            className={active ? 'spot' : 'rounded bg-amber-500/30 px-0.5 text-amber-100'}
            data-spot={active && isFirst ? '1' : undefined}
          >
            {part.str}
          </mark>
        );
      })}
    </>
  );
}

function findActiveCard(cards: EvidenceCard[], url: string, quote: string): number {
  const u = normalizeUrl(url);
  const q = decodeHtmlEntities(quote).trim().toLowerCase();
  const byBoth = cards.findIndex(
    (c) => normalizeUrl(c.source_url) === u && q && decodeHtmlEntities(c.sanitized_excerpt).toLowerCase().includes(q),
  );
  if (byBoth >= 0) return byBoth;
  const byUrl = cards.findIndex((c) => normalizeUrl(c.source_url) === u);
  if (byUrl >= 0) return byUrl;
  return q ? cards.findIndex((c) => decodeHtmlEntities(c.sanitized_excerpt).toLowerCase().includes(q)) : -1;
}

export default function ShowingStage({ hud }: Props) {
  const { synthesis: s, spotlight, lastGateDecision, clearLastGateDecision } = hud;
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);
  const spokenFor = useRef<string>('');
  const spokenGateRef = useRef<string>('');
  const [expandedCards, setExpandedCards] = useState<Record<string, boolean>>({});

  const cards = s?.evidence_cards ?? [];
  const activeIdx = useMemo(
    () => (spotlight ? findActiveCard(cards, spotlight.source_url, spotlight.quote) : -1),
    [spotlight, cards],
  );

  useEffect(() => {
    if (!spotlight || activeIdx < 0) return;
    const el = cardRefs.current[activeIdx];
    if (!el) return;
    const raf = window.requestAnimationFrame(() => {
      const target = el.querySelector('mark[data-spot="1"]') ?? el;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [spotlight?.nonce, activeIdx]);

  // Narrated mode: speak the voice brief (and reset on toggle off so re-enabling re-narrates)
  useEffect(() => {
    if (!hud.highContrast) {
      spokenFor.current = '';
      return;
    }
    if (!s || spokenFor.current === s.voice_brief) return;
    spokenFor.current = s.voice_brief;
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(s.voice_brief));
    }
  }, [hud.highContrast, s]);

  // Narrated mode: speak Gatekeeper intercepts when active
  useEffect(() => {
    if (!hud.highContrast) {
      spokenGateRef.current = '';
      return;
    }
    const g = hud.gate;
    if (!g || spokenGateRef.current === g.gate_id) return;
    spokenGateRef.current = g.gate_id;
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(
        new SpeechSynthesisUtterance(
          `Gatekeeper froze ${g.action_type.replace(/_/g, ' ').toLowerCase()}. ${g.reason}. Say approve or reject.`,
        ),
      );
    }
  }, [hud.highContrast, hud.gate]);

  const gateBanner = lastGateDecision ? (
    <div
      role="status"
      className={`panel panel-semantic flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs ${
        lastGateDecision.approved
          ? 'panel-emerald border-emerald-500/80 bg-emerald-950/50 text-emerald-100'
          : 'panel-red border-red-500/80 bg-red-950/50 text-red-100'
      }`}
    >
      <span className="min-w-0 break-words font-medium">
        {lastGateDecision.approved
          ? `✓ Gatekeeper approved (${lastGateDecision.gate_id}) — action released.`
          : `🛑 Gatekeeper rejected (${lastGateDecision.gate_id}) — action blocked.`}
      </span>
      <button
        type="button"
        onClick={clearLastGateDecision}
        aria-label="Dismiss gate decision"
        className="shrink-0 rounded border border-white/25 px-2 py-0.5 text-xs font-semibold hover:bg-white/10"
      >
        Dismiss
      </button>
    </div>
  ) : null;

  if (!s) {
    return (
      <div className="flex h-full min-w-0 max-w-full flex-col gap-2 overflow-x-hidden">
        {gateBanner}
        <div className="panel flex min-h-0 flex-1 items-center justify-center rounded-lg border border-slate-700 bg-slate-900/60 p-6 text-center">
          <div>
            <div className="text-4xl">🎲</div>
            <div className="mt-2 text-lg font-semibold">Showing Stage</div>
            <div className="muted text-sm text-slate-400">Speak or type a research request. Sanitized evidence and comparisons appear here.</div>
          </div>
        </div>
      </div>
    );
  }

  const winner = s.items.length
    ? s.items.reduce((best, it) => (it.cons.length < best.cons.length ? it : best), s.items[0])
    : null;

  return (
    <div className="@container flex h-full min-w-0 max-w-full flex-col gap-3 overflow-x-hidden overflow-y-auto pr-1">
      {gateBanner}

      <div className="panel panel-semantic panel-cyan rounded-lg border border-cyan-700 bg-cyan-950/40 p-3">
        <div className="muted text-xs uppercase tracking-wide text-cyan-300">Voice brief</div>
        <div className="min-w-0 break-words text-sm">{decodeHtmlEntities(s.voice_brief)}</div>
      </div>

      <div className="grid grid-cols-1 gap-3 @md:grid-cols-2 @3xl:grid-cols-3">
        {s.items.map((it, itemIdx) => {
          const isWinner = winner === it;
          const safeUrl = isSafeExternalUrl(it.url);
          const domain = safeUrl ? hostOf(it.url) : '';
          const pinText = `${it.name} (${it.price}): +${it.pros.join(', ')} / −${it.cons.join(', ')}`;
          const existingPin = hud.pinned.find((n) => n.source_url === it.url && n.text === pinText);
          return (
            <div
              key={`${it.name}-${itemIdx}`}
              className={`panel flex flex-col rounded-lg border p-3 ${
                isWinner
                  ? 'panel-semantic panel-emerald border-emerald-500 bg-emerald-950/30'
                  : 'border-slate-700 bg-slate-900/60'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 break-words font-semibold">{decodeHtmlEntities(it.name)}</div>
                <div className="shrink-0 text-sm font-bold tabular-nums text-cyan-300">{it.price}</div>
              </div>
              {domain && <div className="muted mt-0.5 truncate text-xs text-slate-400">{domain}</div>}
              {isWinner && <div className="mt-0.5 text-xs font-semibold text-emerald-300">★ Top pick</div>}
              <ul className="mt-1 space-y-0.5 text-xs text-emerald-300">
                {it.pros.map((p, idx) => (
                  <li key={`${p}-${idx}`} className="min-w-0 break-words">
                    ＋ {decodeHtmlEntities(p)}
                  </li>
                ))}
              </ul>
              <ul className="mt-0.5 space-y-0.5 text-xs text-red-300">
                {it.cons.map((c, idx) => (
                  <li key={`${c}-${idx}`} className="min-w-0 break-words">
                    － {decodeHtmlEntities(c)}
                  </li>
                ))}
              </ul>
              <div className="mt-auto flex flex-wrap gap-2 pt-3">
                {safeUrl ? (
                  <button
                    type="button"
                    onClick={() => void hud.handoff(it.url)}
                    title={`Open verified link: ${it.url}`}
                    className="rounded bg-emerald-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-600"
                  >
                    Open {domain} ↗
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled
                    aria-disabled="true"
                    title="Verified HTTPS link unavailable"
                    className="cursor-not-allowed rounded bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-400 opacity-60"
                  >
                    Link unavailable
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => (existingPin ? hud.unpinNote(existingPin.note_id) : hud.pinNote(it.url, pinText))}
                  aria-pressed={!!existingPin}
                  className={`rounded border px-2.5 py-1 text-xs ${
                    existingPin
                      ? 'border-amber-300 bg-amber-400/20 font-semibold text-amber-200'
                      : 'border-amber-400 text-amber-300 hover:bg-amber-400/10'
                  }`}
                >
                  {existingPin ? '✓ Pinned' : '📌 Pin Note'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {s.contradictions.length > 0 && (
        <div className="panel panel-semantic panel-red rounded-lg border border-red-700 bg-red-950/30 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-red-300">Contradictions (click to spotlight)</div>
          <div className="mt-1 flex flex-col gap-1.5">
            {s.contradictions.map((c, i) => {
              const hasSource = !!c.source_url.trim();
              const isSpot = !!(hasSource && spotlight && normalizeUrl(spotlight.source_url) === normalizeUrl(c.source_url));
              const domain = hasSource ? hostOf(c.source_url) : 'Pinned note';
              if (!hasSource) {
                return (
                  <div key={i} className="rounded bg-red-900/30 p-2 text-left text-sm opacity-90">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 break-words font-semibold">⚠ {decodeHtmlEntities(c.claim)}</span>
                      <span className="muted shrink-0 text-xs text-red-200">{domain}</span>
                    </div>
                    <span className="muted block break-words text-xs text-red-200">{decodeHtmlEntities(c.conflict)}</span>
                  </div>
                );
              }
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => hud.doSpotlight(c.source_url, c.quote_to_highlight, `Contradiction: ${c.conflict}`)}
                  className={`rounded bg-red-900/40 p-2 text-left text-sm hover:bg-red-900/70 ${
                    isSpot ? 'ring-2 ring-cyan-400' : ''
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 break-words font-semibold">⚠ {decodeHtmlEntities(c.claim)}</span>
                    <span className="muted shrink-0 text-xs text-red-200">{domain}</span>
                  </div>
                  <span className="muted block break-words text-xs text-red-200">{decodeHtmlEntities(c.conflict)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {cards.map((c, i) => {
          const active = i === activeIdx && !!spotlight;
          const contra = s.contradictions.find(
            (x) => x.source_url.trim() && normalizeUrl(x.source_url) === normalizeUrl(c.source_url),
          );
          const rawQuote = active && spotlight ? spotlight.quote || c.quote_to_highlight : c.quote_to_highlight;
          const decodedTitle = decodeHtmlEntities(c.title);
          const decodedExcerpt = decodeHtmlEntities(c.sanitized_excerpt);
          const decodedQuote = decodeHtmlEntities(rawQuote).trim();
          const quoteMatched = !!decodedQuote && decodedExcerpt.toLowerCase().includes(decodedQuote.toLowerCase());
          const safeUrl = isSafeExternalUrl(c.source_url);
          const domain = safeUrl ? hostOf(c.source_url) : c.source_url ? hostOf(c.source_url) : 'Unknown source';
          const cardKey = `${c.source_url}-${i}`;
          const isLong = decodedExcerpt.length > 220;
          const isExpanded = active || !!expandedCards[cardKey];

          const spotBadgeText = spotlight?.badge_text || contra?.conflict || 'Spotlight';
          const isContradictionSpot =
            spotBadgeText.toLowerCase().startsWith('contradiction') || (!!contra && !spotlight?.badge_text);

          const pinText = c.quote_to_highlight || c.sanitized_excerpt.slice(0, 160);
          const existingPin = hud.pinned.find((n) => n.source_url === c.source_url && n.text === pinText);

          return (
            <div
              key={cardKey}
              ref={(el) => {
                cardRefs.current[i] = el;
              }}
              className={`panel rounded-lg border bg-slate-900/70 p-3 ${
                active ? 'panel-semantic card-spot border-cyan-400' : 'border-slate-700'
              }`}
            >
              {active && spotlight && (
                <div className="mb-2 flex items-center">
                  <span
                    className={`inline-flex max-w-full items-center gap-1 truncate rounded-full px-2.5 py-0.5 text-xs font-bold shadow ${
                      isContradictionSpot ? 'bg-red-600 text-white' : 'bg-cyan-700 text-white'
                    }`}
                    title={spotBadgeText}
                  >
                    {isContradictionSpot ? '⚠' : '✦'} {spotBadgeText}
                  </span>
                </div>
              )}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 break-words font-semibold">{decodedTitle}</div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {contra && (
                    <span
                      className="shrink-0 rounded bg-red-900/80 px-1.5 py-0.5 text-xs font-semibold text-red-200"
                      title={contra.conflict}
                    >
                      ⚠ Conflict
                    </span>
                  )}
                  <span className="muted shrink-0 text-xs text-slate-400">{domain}</span>
                </div>
              </div>
              <p className={`mt-1 min-w-0 break-words text-sm leading-relaxed text-slate-200 ${isExpanded ? '' : 'line-clamp-4'}`}>
                <Highlighted text={decodedExcerpt} quote={decodedQuote} active={active} />
              </p>
              {isLong && !active && (
                <button
                  type="button"
                  onClick={() => setExpandedCards((prev) => ({ ...prev, [cardKey]: !prev[cardKey] }))}
                  className="mt-1 text-xs font-semibold text-cyan-300 hover:underline"
                >
                  {isExpanded ? 'Show less' : 'Show more'}
                </button>
              )}
              {active && decodedQuote && !quoteMatched && (
                <div className="mt-2 rounded border border-cyan-500/40 bg-cyan-950/40 px-2.5 py-1.5 text-xs text-cyan-200">
                  <span className="font-semibold">Spotlighted quote:</span> “{decodedQuote}”
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-2 pt-1">
                {safeUrl ? (
                  <button
                    type="button"
                    onClick={() => void hud.handoff(c.source_url)}
                    title={`Open verified link: ${c.source_url}`}
                    className="rounded bg-emerald-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-600"
                  >
                    Open {domain} ↗
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled
                    aria-disabled="true"
                    title="Verified HTTPS link unavailable"
                    className="cursor-not-allowed rounded bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-400 opacity-60"
                  >
                    Link unavailable
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => (existingPin ? hud.unpinNote(existingPin.note_id) : hud.pinNote(c.source_url, pinText))}
                  aria-pressed={!!existingPin}
                  className={`rounded border px-2.5 py-1 text-xs ${
                    existingPin
                      ? 'border-amber-300 bg-amber-400/20 font-semibold text-amber-200'
                      : 'border-amber-400 text-amber-300 hover:bg-amber-400/10'
                  }`}
                >
                  {existingPin ? '✓ Pinned' : '📌 Pin Note'}
                </button>
                {active && (
                  <button
                    type="button"
                    onClick={hud.clearSpotlight}
                    className="rounded border border-slate-500 px-2.5 py-1 text-xs hover:bg-slate-800"
                  >
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
