import { useState } from 'react';
import type { HudApi } from '../hooks/useHud';
import type { TelemetryStatus } from '../types';

type Props = { hud: HudApi };

const statusColor: Record<TelemetryStatus, string> = {
  RUNNING: 'bg-cyan-600',
  COMPLETED: 'bg-emerald-600',
  CANCELLED: 'bg-amber-500 text-black',
  BLOCKED: 'bg-red-600',
};

export function ApprovalCard({ hud }: Props) {
  const g = hud.gate;
  if (!g) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" role="alertdialog" aria-modal="true" aria-label="Gatekeeper approval required">
      <div className="gate-flash w-full max-w-lg rounded-xl border-4 border-red-500 bg-red-950 p-5 text-white shadow-2xl">
        <div className="text-xl font-extrabold uppercase tracking-wide text-red-300">🛑 Gatekeeper: Action Frozen</div>
        <div className="mt-1 text-xs text-red-200">{g.decision} · gate {g.gate_id}</div>
        <dl className="mt-3 space-y-2 text-sm">
          <div>
            <dt className="text-xs font-bold uppercase text-red-300">Cedar rule</dt>
            <dd className="font-mono">{g.cedar_rule}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold uppercase text-red-300">Action type</dt>
            <dd className="font-mono">{g.action_type}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold uppercase text-red-300">Target URL</dt>
            <dd className="break-all font-mono">{g.target_url}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold uppercase text-red-300">Reason</dt>
            <dd>{g.reason}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold uppercase text-red-300">Action diff</dt>
            <dd className="rounded bg-black/60 p-2 font-mono text-xs">{g.action_diff}</dd>
          </div>
        </dl>
        <div className="mt-2 text-xs text-red-200">Voice: say “approve” or “reject”.</div>
        <div className="mt-4 flex gap-3">
          <button autoFocus onClick={() => hud.decide(true)} className="flex-1 rounded bg-emerald-600 py-3 text-base font-bold hover:bg-emerald-500">
            Approve
          </button>
          <button onClick={() => hud.decide(false)} className="flex-1 rounded bg-white py-3 text-base font-bold text-red-700 hover:bg-red-100">
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MonitorDrawer({ hud }: Props) {
  const [open, setOpen] = useState(true);
  return (
    <aside className={`panel flex shrink-0 flex-col border-l border-slate-700 bg-slate-900/90 transition-all ${open ? 'w-72' : 'w-9'}`}>
      <button onClick={() => setOpen(!open)} className="border-b border-slate-700 p-2 text-xs font-semibold text-slate-300 hover:bg-slate-800" aria-label="Toggle monitor drawer">
        {open ? '▶ Glass-Box Monitor' : '◀'}
      </button>
      {open && (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
          <div className="grid grid-cols-2 gap-2 text-center">
            <div className="rounded bg-slate-800 p-2">
              <div className="text-lg font-bold text-cyan-300">{hud.ramMb.toFixed(0)} MB</div>
              <div className="muted text-[10px] uppercase text-slate-400">Local HUD RAM</div>
            </div>
            <div className="rounded bg-slate-800 p-2">
              <div className="text-lg font-bold text-emerald-300">{hud.tabsOffloaded}</div>
              <div className="muted text-[10px] uppercase text-slate-400">Tabs Offloaded to AWS</div>
            </div>
          </div>
          <div className="rounded bg-slate-800 p-2 text-xs">
            Workers active: <b>{hud.workersActive}</b> · Link: <b>{hud.status}</b>
          </div>
          <div className="muted text-[10px] uppercase tracking-wide text-slate-400">Live telemetry</div>
          <div className="flex min-h-0 flex-1 flex-col-reverse gap-1 overflow-y-auto">
            {[...hud.telemetry].reverse().map((t, i) => (
              <div key={`${t.trace_id}-${i}`} className="rounded border border-slate-700 bg-slate-800/70 p-2 text-xs">
                <div className="flex items-center justify-between gap-1">
                  <span className="font-mono font-semibold">{t.agent_id}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${statusColor[t.status]}`}>{t.status}</span>
                </div>
                <div className="mt-1 text-slate-200">{t.message}</div>
                <div className="muted mt-1 text-[10px] text-slate-400">
                  {t.latency_ms} ms · {t.workers_active} workers · {t.trace_id}
                </div>
              </div>
            ))}
            {hud.telemetry.length === 0 && <div className="muted text-xs text-slate-400">No events yet.</div>}
          </div>
        </div>
      )}
    </aside>
  );
}
