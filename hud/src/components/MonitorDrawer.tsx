import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { HudApi } from '../hooks/useHud';
import type { TelemetryMessage, TelemetryStatus } from '../types';

type Props = { hud: HudApi };

const statusColor: Record<TelemetryStatus, string> = {
  RUNNING: 'bg-cyan-700 text-white',
  COMPLETED: 'bg-emerald-700 text-white',
  CANCELLED: 'bg-amber-400 text-slate-950',
  BLOCKED: 'bg-red-700 text-white',
};

function inferTier(t: TelemetryMessage): 1 | 2 | null {
  if (t.tier === 1 || t.tier === 2) return t.tier;
  if (/playwright|tier-?2|\bt2\b/i.test(t.message)) return 2;
  if (/http|fetch|tier-?1|\bt1\b/i.test(t.message)) return 1;
  if (t.agent_id.startsWith('scout') && t.status !== 'BLOCKED' && /scouting|loaded|urls?|sources?/i.test(t.message)) {
    return 1;
  }
  return null;
}

export function ApprovalCard({ hud }: Props) {
  const g = hud.gate;
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [escHint, setEscHint] = useState(false);

  useEffect(() => {
    setEscHint(false);
    if (!g) return;

    dialogRef.current?.focus();

    const parent = overlayRef.current?.parentElement;
    const saved: Array<{ el: HTMLElement; inert: boolean }> = [];
    if (parent) {
      for (const child of Array.from(parent.children)) {
        if (child !== overlayRef.current && child instanceof HTMLElement) {
          saved.push({ el: child, inert: child.inert });
          child.inert = true;
        }
      }
    }
    return () => {
      for (const item of saved) {
        item.el.inert = item.inert;
      }
    };
  }, [g?.gate_id]);

  if (!g) return null;

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setEscHint(true);
      return;
    }
    if (e.key === 'Tab' && dialogRef.current) {
      const focusables = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusables.length === 0) {
        e.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (!active || active === first || !dialogRef.current.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (!active || active === last || !dialogRef.current.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  };

  return (
    <div
      ref={overlayRef}
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-label="Gatekeeper approval required"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="gate-flash max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border-4 border-red-500 bg-red-950 p-5 text-white shadow-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xl font-extrabold uppercase tracking-wide text-red-300">🛑 Gatekeeper: Action Frozen</div>
          <span className="rounded border border-amber-300 bg-amber-400 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-slate-950">
            UNTRUSTED_WEB
          </span>
        </div>
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
            <dd className="break-words">{g.reason}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold uppercase text-red-300">Action diff</dt>
            <dd className="max-h-32 overflow-y-auto break-all rounded bg-black/60 p-2 font-mono text-xs">{g.action_diff}</dd>
          </div>
        </dl>
        <div className="mt-2 text-xs text-red-200" role={escHint ? 'status' : undefined}>
          {escHint
            ? "Press Reject or say 'reject' to block (Escape does not dismiss security gates)."
            : "Voice: say “approve” or “reject” · Press Reject or say 'reject' to block."}
        </div>
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            disabled={hud.gatePending}
            onClick={() => hud.decide(true)}
            className="flex-1 rounded bg-emerald-700 py-3 text-base font-bold text-white hover:bg-emerald-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {hud.gatePending ? 'Submitting…' : 'Approve'}
          </button>
          <button
            type="button"
            disabled={hud.gatePending}
            onClick={() => hud.decide(false)}
            className="flex-1 rounded bg-white py-3 text-base font-bold text-red-800 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MonitorDrawer({ hud }: Props) {
  const [open, setOpen] = useState(true);
  const [showJump, setShowJump] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (el && isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [hud.telemetry, open]);

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
    isAtBottomRef.current = atBottom;
    setShowJump(!atBottom);
  };

  const jumpToLatest = () => {
    const el = listRef.current;
    if (!el) return;
    isAtBottomRef.current = true;
    setShowJump(false);
    el.scrollTop = el.scrollHeight;
  };

  return (
    <aside className={`panel flex shrink-0 flex-col border-l border-slate-700 bg-slate-900/90 backdrop-blur-md ring-1 ring-white/15 transition-all ${open ? 'w-72 xl:w-80' : 'w-9'}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="border-b border-slate-700 p-2 text-xs font-semibold text-slate-300 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        aria-label="Toggle monitor drawer"
      >
        {open ? '▶ Glass-Box Monitor' : '◀'}
      </button>
      {open && (
        <div className="relative flex min-h-0 flex-1 flex-col gap-2 p-2">
          <div className="grid grid-cols-2 gap-2 text-center">
            <div className="rounded bg-slate-800 p-2">
              <div className="text-lg font-bold tabular-nums text-cyan-300">{hud.ramMb.toFixed(0)} MB</div>
              <div className="muted text-xs uppercase text-slate-400">Local HUD RAM</div>
            </div>
            <div className="rounded bg-slate-800 p-2">
              <div className="text-lg font-bold tabular-nums text-emerald-300">{hud.tabsOffloaded}</div>
              <div className="muted text-xs uppercase text-slate-400">Tabs Offloaded to AWS</div>
            </div>
          </div>
          <div className="rounded bg-slate-800 p-2 text-xs">
            Workers active: <b className="tabular-nums">{hud.workersActive}</b> · Link: <b>{hud.status}</b>
          </div>
          <div className="muted text-xs uppercase tracking-wide text-slate-400">Live telemetry</div>
          <div ref={listRef} onScroll={handleScroll} className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
            {hud.telemetry.map((t) => {
              const tier = inferTier(t);
              const isCancelled = t.status === 'CANCELLED';
              return (
                <div
                  key={t.trace_id}
                  className={`rounded border border-slate-700 bg-slate-800/70 p-2 text-xs ${isCancelled ? 'opacity-55' : ''}`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className={`min-w-0 truncate font-mono font-semibold ${isCancelled ? 'line-through' : ''}`}>
                      {t.agent_id}
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      {tier !== null && (
                        <span
                          className={`rounded px-1.5 py-0.5 text-xs font-bold ${
                            tier === 2 ? 'bg-indigo-700 text-white' : 'bg-slate-700 text-slate-100'
                          }`}
                        >
                          {tier === 2 ? 'T2 PW' : 'T1 HTTP'}
                        </span>
                      )}
                      <span className={`rounded px-1.5 py-0.5 text-xs font-bold ${statusColor[t.status]}`}>
                        {t.status}
                      </span>
                    </div>
                  </div>
                  <div className={`mt-1 break-words text-slate-200 ${isCancelled ? 'line-through' : ''}`}>{t.message}</div>
                  <div className="muted mt-1 flex items-center gap-1 text-xs tabular-nums text-slate-400">
                    <span className="shrink-0">{t.latency_ms} ms · {t.workers_active} workers ·</span>
                    <span className="min-w-0 truncate">{t.trace_id}</span>
                  </div>
                </div>
              );
            })}
            {hud.telemetry.length === 0 && <div className="muted text-xs text-slate-400">No events yet.</div>}
          </div>
          {showJump && hud.telemetry.length > 0 && (
            <button
              type="button"
              onClick={jumpToLatest}
              className="self-center rounded-full bg-cyan-700 px-3 py-1 text-xs font-semibold text-white shadow-lg hover:bg-cyan-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            >
              Jump to latest ↓
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
