import { useEffect, useMemo, useRef, useState } from "react";
import type {
  GatekeeperInterceptMessage,
  TelemetryAgentId,
  TelemetryMessage,
  TelemetryStatus,
} from "../../types";

interface GlassBoxMonitorProps {
  telemetry: TelemetryMessage[];
  pendingGatekeeper: GatekeeperInterceptMessage | null;
  onApprovalDecision: (gateId: string, approved: boolean) => Promise<void>;
}

const AGENT_STYLE: Record<
  TelemetryAgentId,
  { label: string; badge: string }
> = {
  scout_swarm: {
    label: "scout_swarm",
    badge: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
  },
  synthesis: {
    label: "synthesis",
    badge: "border-indigo-500/40 bg-indigo-500/10 text-indigo-300",
  },
  gatekeeper: {
    label: "gatekeeper",
    badge: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  },
};

const STATUS_STYLE: Record<TelemetryStatus, string> = {
  RUNNING: "border-cyan-400/50 bg-cyan-500/15 text-cyan-200",
  COMPLETED: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
  CANCELLED: "border-amber-500/50 bg-amber-500/15 text-amber-200",
  BLOCKED: "border-red-500/70 bg-red-500/25 text-red-200 font-bold",
};

export function GlassBoxMonitor({
  telemetry,
  pendingGatekeeper,
  onApprovalDecision,
}: GlassBoxMonitorProps) {
  const [agentFilter, setAgentFilter] = useState<TelemetryAgentId | "all">(
    "all"
  );
  const feedEndRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(
    () =>
      agentFilter === "all"
        ? telemetry
        : telemetry.filter((t) => t.agent_id === agentFilter),
    [telemetry, agentFilter]
  );

  const activeWorkers = useMemo(() => {
    const latestByAgent = new Map<TelemetryAgentId, TelemetryMessage>();
    for (const ev of telemetry) {
      latestByAgent.set(ev.agent_id, ev);
    }
    let total = 0;
    for (const ev of latestByAgent.values()) {
      if (ev.status === "RUNNING") {
        total += ev.workers_active;
      }
    }
    return total;
  }, [telemetry]);

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [filtered.length]);

  return (
    <div className="space-y-2.5">
      {/* Inline reference if Gatekeeper is blocking (main blocking card also pinned at top) */}
      {pendingGatekeeper && (
        <div className="rounded-lg border border-red-500/50 bg-red-950/35 px-2.5 py-2 text-[11px] text-red-200 flex items-center justify-between gap-2">
          <span>
            Action halted: <strong>{pendingGatekeeper.action_type}</strong> (
            <code>{pendingGatekeeper.gate_id}</code>)
          </span>
          <button
            type="button"
            onClick={() =>
              void onApprovalDecision(pendingGatekeeper.gate_id, false)
            }
            className="shrink-0 rounded border border-red-400/60 bg-red-900/60 px-2 py-0.5 text-[10px] font-semibold text-red-100 hover:bg-red-800"
          >
            Quick Reject
          </button>
        </div>
      )}

      {/* Telemetry Summary & Agent Filters */}
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
          <span className="rounded border border-slate-800 bg-slate-900 px-1.5 py-0.5 font-mono text-slate-200">
            {telemetry.length} events
          </span>
          <span className="rounded border border-slate-800 bg-slate-900 px-1.5 py-0.5 font-mono text-cyan-300">
            {activeWorkers} workers active
          </span>
        </div>

        <div className="flex items-center gap-1 text-[10px]">
          {(["all", "scout_swarm", "synthesis", "gatekeeper"] as const).map(
            (filterKey) => (
              <button
                key={filterKey}
                type="button"
                onClick={() => setAgentFilter(filterKey)}
                className={`rounded-md border px-1.5 py-0.5 font-medium transition ${
                  agentFilter === filterKey
                    ? "border-cyan-500/50 bg-cyan-500/15 text-cyan-200"
                    : "border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200"
                }`}
              >
                {filterKey === "all" ? "All" : filterKey}
              </button>
            )
          )}
        </div>
      </div>

      {/* Live Scrolling Telemetry Feed */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 px-4 py-8 text-center">
          <div className="text-xs font-semibold text-slate-300">
            Glass-Box Telemetry Idle
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            Live worker trace IDs, latencies, cancellations, and Cedar policy
            checks will stream here.
          </p>
        </div>
      ) : (
        <div className="max-h-[340px] space-y-1.5 overflow-y-auto pr-0.5">
          {filtered.map((ev, idx) => {
            const agentMeta = AGENT_STYLE[ev.agent_id];
            const statusClass = STATUS_STYLE[ev.status];

            return (
              <div
                key={`${ev.trace_id}-${idx}`}
                className={`rounded-lg border p-2 text-[11px] ${
                  ev.status === "BLOCKED"
                    ? "border-red-500/50 bg-red-950/25"
                    : ev.status === "CANCELLED"
                      ? "border-amber-500/40 bg-amber-950/20"
                      : "border-slate-800/90 bg-slate-900/75"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-1">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold ${agentMeta.badge}`}
                    >
                      {agentMeta.label}
                    </span>
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${statusClass}`}
                    >
                      {ev.status}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 font-mono text-[9px] text-slate-400 tabular-nums">
                    <span>{ev.trace_id}</span>
                    <span>·</span>
                    <span>{ev.latency_ms}ms</span>
                    <span>·</span>
                    <span>{ev.workers_active}w</span>
                  </div>
                </div>

                <p className="mt-1.5 leading-snug text-slate-200">
                  {ev.message}
                </p>
              </div>
            );
          })}
          <div ref={feedEndRef} />
        </div>
      )}
    </div>
  );
}
