import { useState } from "react";
import type { ContradictionItem, SynthesisUpdateMessage } from "../../types";
import type { SpotlightActionResult } from "../hooks/useExtensionBridge";

interface ComparisonViewProps {
  synthesis: SynthesisUpdateMessage | null;
  onSpotlightQuote: (
    url: string,
    quote: string,
    badgeText: string
  ) => Promise<SpotlightActionResult>;
  onClearSpotlight: () => Promise<void>;
  onOpenUrl: (url: string) => void;
  onRunDemoQuery?: () => Promise<void>;
}

function getHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, "");
  } catch {
    return rawUrl;
  }
}

export function ComparisonView({
  synthesis,
  onSpotlightQuote,
  onClearSpotlight,
  onOpenUrl,
  onRunDemoQuery,
}: ComparisonViewProps) {
  const [activeSpotlightIndex, setActiveSpotlightIndex] = useState<number | null>(
    null
  );
  const [spotlightStatus, setSpotlightStatus] = useState<{
    index: number;
    text: string;
    tone: "success" | "warn" | "error";
  } | null>(null);

  if (!synthesis) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-800 bg-slate-900/40 px-4 py-8 text-center">
        <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full border border-cyan-500/30 bg-cyan-500/10 text-cyan-300">
          ⇄
        </div>
        <h3 className="text-xs font-semibold text-slate-200">
          No Synthesis Results Yet
        </h3>
        <p className="mt-1 max-w-[260px] text-[11px] leading-relaxed text-slate-400">
          Connect voice or type a query in Silent Mode to dispatch parallel
          research scouts and uncover claim contradictions.
        </p>
        {onRunDemoQuery && (
          <button
            type="button"
            onClick={() => void onRunDemoQuery()}
            className="mt-3 rounded-lg bg-cyan-500/15 border border-cyan-500/40 px-3 py-1.5 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/25"
          >
            Run Demo Query
          </button>
        )}
      </div>
    );
  }

  const handleContradictionClick = async (
    item: ContradictionItem,
    index: number
  ) => {
    setActiveSpotlightIndex(index);
    setSpotlightStatus({
      index,
      text: "Opening source & mounting Shadow DOM spotlight...",
      tone: "warn",
    });

    try {
      const result = await onSpotlightQuote(
        item.source_url,
        item.quote_to_highlight,
        item.conflict
      );

      if (result.found) {
        setSpotlightStatus({
          index,
          text: `Highlighted "${item.quote_to_highlight}" in closed Shadow DOM.`,
          tone: "success",
        });
      } else if (result.ok) {
        setSpotlightStatus({
          index,
          text: `Focused ${getHostname(item.source_url)} (exact quote text not matched on DOM).`,
          tone: "warn",
        });
      } else {
        setSpotlightStatus({
          index,
          text: result.error || "Unable to spotlight this page.",
          tone: "error",
        });
      }
    } catch (err) {
      setSpotlightStatus({
        index,
        text: err instanceof Error ? err.message : "Spotlight failed.",
        tone: "error",
      });
    } finally {
      setActiveSpotlightIndex(null);
    }
  };

  return (
    <div className="space-y-3">
      {/* Voice Brief Synthesis Banner */}
      <div className="rounded-xl border border-cyan-500/30 bg-gradient-to-br from-cyan-950/35 via-slate-900/90 to-slate-950 p-3">
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-cyan-300">
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
            Executive Voice Brief
          </span>
          <span className="rounded bg-slate-900/90 px-1.5 py-0.5 font-mono text-[9px] text-slate-400 border border-slate-800">
            {synthesis.job_id}
          </span>
        </div>
        <p className="text-xs leading-relaxed text-slate-100">
          {synthesis.voice_brief}
        </p>
      </div>

      {/* Clickable Contradiction Cards */}
      {synthesis.contradictions.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-amber-300">
              <span>⚠</span>
              <span>Contradictions ({synthesis.contradictions.length})</span>
            </h3>
            <button
              type="button"
              onClick={() => void onClearSpotlight()}
              className="text-[10px] text-slate-400 hover:text-slate-200"
            >
              Clear spotlight
            </button>
          </div>

          {synthesis.contradictions.map((c, idx) => {
            const isBusy = activeSpotlightIndex === idx;
            const status =
              spotlightStatus?.index === idx ? spotlightStatus : null;

            return (
              <button
                key={`${c.source_url}-${idx}`}
                type="button"
                onClick={() => void handleContradictionClick(c, idx)}
                className="w-full text-left rounded-xl border border-amber-500/45 bg-amber-950/20 p-2.5 transition hover:border-amber-400 hover:bg-amber-950/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[11px] font-semibold text-amber-200">
                    Claim: {c.claim}
                  </span>
                  <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-300">
                    {isBusy ? "Focusing..." : "Spotlight ↗"}
                  </span>
                </div>

                <p className="mt-1 text-[11px] leading-snug text-slate-200">
                  {c.conflict}
                </p>

                <div className="mt-2 flex flex-wrap items-center justify-between gap-1.5 rounded-md border border-amber-500/20 bg-slate-950/70 px-2 py-1">
                  <span className="truncate font-mono text-[10px] text-amber-300/90">
                    &ldquo;{c.quote_to_highlight}&rdquo;
                  </span>
                  <span className="truncate text-[10px] text-slate-400">
                    {getHostname(c.source_url)}
                  </span>
                </div>

                {status && (
                  <div
                    className={`mt-1.5 text-[10px] ${
                      status.tone === "success"
                        ? "text-emerald-300"
                        : status.tone === "error"
                          ? "text-rose-300"
                          : "text-amber-300"
                    }`}
                  >
                    {status.text}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Comparison Cards */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
            Comparison Matrix ({synthesis.items.length})
          </h3>
        </div>

        {synthesis.items.map((item, idx) => (
          <article
            key={`${item.name}-${idx}`}
            className="rounded-xl border border-slate-800/90 bg-slate-900/75 p-3 transition hover:border-slate-700"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h4 className="text-xs font-bold text-slate-100 leading-snug">
                  {item.name}
                </h4>
                {item.url && (
                  <button
                    type="button"
                    onClick={() => onOpenUrl(item.url)}
                    className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-cyan-400 hover:text-cyan-300 hover:underline"
                  >
                    <span className="truncate max-w-[200px]">
                      {getHostname(item.url)}
                    </span>
                    <span>↗</span>
                  </button>
                )}
              </div>

              <span className="shrink-0 rounded-md border border-emerald-500/35 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-bold tabular-nums text-emerald-300">
                {item.price}
              </span>
            </div>

            <div className="mt-2 grid grid-cols-1 gap-1.5">
              {item.pros.length > 0 && (
                <ul className="space-y-0.5">
                  {item.pros.map((pro, pIdx) => (
                    <li
                      key={pIdx}
                      className="flex items-start gap-1.5 text-[11px] text-slate-300"
                    >
                      <span className="mt-0.5 text-emerald-400 font-bold">+</span>
                      <span>{pro}</span>
                    </li>
                  ))}
                </ul>
              )}

              {item.cons.length > 0 && (
                <ul className="space-y-0.5 border-t border-slate-800/80 pt-1.5">
                  {item.cons.map((con, cIdx) => (
                    <li
                      key={cIdx}
                      className="flex items-start gap-1.5 text-[11px] text-slate-400"
                    >
                      <span className="mt-0.5 text-rose-400 font-bold">−</span>
                      <span>{con}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
