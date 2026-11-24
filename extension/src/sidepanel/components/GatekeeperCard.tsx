import { useState } from "react";
import type { GatekeeperInterceptMessage } from "../../types";

interface GatekeeperCardProps {
  intercept: GatekeeperInterceptMessage;
  onDecision: (gateId: string, approved: boolean) => Promise<void>;
}

export function GatekeeperCard({ intercept, onDecision }: GatekeeperCardProps) {
  const [submitting, setSubmitting] = useState<"approve" | "reject" | null>(
    null
  );

  const handleDecision = async (approved: boolean) => {
    if (submitting) return;
    setSubmitting(approved ? "approve" : "reject");
    try {
      await onDecision(intercept.gate_id, approved);
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <section
      role="alertdialog"
      aria-label="Cedar Gatekeeper Security Intercept"
      className="mx-3 mt-2.5 shrink-0 rounded-xl border-2 border-red-500 bg-gradient-to-b from-red-950/95 via-rose-950/95 to-slate-950 p-3 shadow-[0_0_26px_rgba(239,68,68,0.4)]"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-500 text-[11px] font-black text-white animate-pulse">
            !
          </span>
          <div className="min-w-0">
            <div className="text-[11px] font-black uppercase tracking-wider text-red-200">
              Gatekeeper Intercept
            </div>
            <div className="font-mono text-[9px] text-red-300/80">
              {intercept.gate_id} · {intercept.decision}
            </div>
          </div>
        </div>

        <span className="shrink-0 rounded-md border border-red-400/60 bg-red-500/25 px-1.5 py-0.5 font-mono text-[10px] font-bold text-red-100">
          {intercept.action_type}
        </span>
      </div>

      <div className="mt-2 space-y-1.5 text-[11px]">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-red-300">
            Cedar Rule:
          </span>
          <code className="rounded bg-black/45 px-1.5 py-0.5 font-mono text-[10px] text-amber-200 border border-red-500/30">
            {intercept.cedar_rule}
          </code>
        </div>

        <p className="leading-snug text-red-50">{intercept.reason}</p>

        <div className="rounded-lg border border-red-500/40 bg-black/50 p-2 font-mono text-[10px]">
          <div className="truncate text-red-300/80">
            Target: <span className="text-red-100">{intercept.target_url}</span>
          </div>
          <div className="mt-1 text-amber-200 break-words">
            Diff: {intercept.action_diff}
          </div>
        </div>
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={submitting !== null}
          onClick={() => void handleDecision(false)}
          className="rounded-lg border border-red-400/70 bg-red-900/60 px-3 py-1.5 text-xs font-bold text-red-100 transition hover:bg-red-800/80 disabled:opacity-50"
        >
          {submitting === "reject" ? "Rejecting..." : "Reject"}
        </button>
        <button
          type="button"
          disabled={submitting !== null}
          onClick={() => void handleDecision(true)}
          className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-bold text-slate-950 shadow-sm shadow-emerald-500/30 transition hover:bg-emerald-400 disabled:opacity-50"
        >
          {submitting === "approve" ? "Signing..." : "Approve"}
        </button>
      </div>
    </section>
  );
}
