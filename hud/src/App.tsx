import { useEffect, useRef, useState } from 'react';
import { isTauri } from './hooks/platform';
import { useHud } from './hooks/useHud';
import VoiceDock from './components/VoiceDock';
import ShowingStage from './components/ShowingStage';
import MindMap from './components/MindMap';
import MonitorDrawer, { ApprovalCard } from './components/MonitorDrawer';

export default function App() {
  const hud = useHud();
  const mainShellRef = useRef<HTMLDivElement | null>(null);
  const [mapOpen, setMapOpen] = useState(() => (typeof window === 'undefined' ? true : window.innerHeight >= 620));

  useEffect(() => {
    document.documentElement.classList.toggle('hc', hud.highContrast);
    if (!hud.highContrast && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  }, [hud.highContrast]);

  useEffect(() => {
    const el = mainShellRef.current;
    if (el) el.inert = !!hud.gate;
  }, [hud.gate]);

  const handleHide = () => {
    if (!isTauri()) return;
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      void win.hide().catch(() => win.minimize().catch(() => undefined));
    });
  };

  const dot =
    hud.status === 'CONNECTED'
      ? 'bg-emerald-400'
      : hud.status === 'MOCK'
        ? 'bg-amber-400'
        : hud.status === 'CONNECTING'
          ? 'bg-cyan-400'
          : 'bg-red-500';

  const nodeCount = hud.synthesis?.mind_map?.nodes.length ?? 0;

  return (
    <div className="flex h-full flex-col overflow-x-hidden bg-slate-950/95 text-slate-100">
      <div ref={mainShellRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
        <header
          className="panel flex items-center justify-between gap-2 border-b border-slate-700 bg-slate-900/90 px-3 py-2 shadow-2xl ring-1 ring-white/15 backdrop-blur-md"
          data-tauri-drag-region
        >
          <div className="flex min-w-0 items-center gap-2" data-tauri-drag-region>
            <span className="pointer-events-none select-none text-lg">🎲</span>
            <span className="pointer-events-none select-none truncate font-bold tracking-wide">DICE HUD</span>
            <span className={`pointer-events-none inline-block h-2 w-2 shrink-0 rounded-full ${dot}`} />
            <span className="muted pointer-events-none min-w-[6.5rem] shrink-0 select-none text-xs tabular-nums text-slate-400">
              {hud.status}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isTauri() && (
              <>
                <span
                  className="pointer-events-none hidden select-none rounded border border-slate-700 bg-slate-800/80 px-1.5 py-0.5 text-xs text-slate-400 sm:inline"
                  title="Global toggle shortcut"
                >
                  Alt+Space
                </span>
                <button
                  type="button"
                  onClick={handleHide}
                  title="Hide HUD (Alt+Space to restore)"
                  className="shrink-0 whitespace-nowrap rounded border border-slate-600 px-2 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800"
                >
                  Hide
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => void hud.resetSession()}
              title="Reset current research session"
              className="shrink-0 whitespace-nowrap rounded border border-slate-600 px-2 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={() => hud.setHighContrast(!hud.highContrast)}
              aria-pressed={hud.highContrast}
              title="Toggle Narrated / High-Contrast mode"
              className={`shrink-0 whitespace-nowrap rounded border px-2 py-1 text-xs font-semibold ${
                hud.highContrast
                  ? 'border-yellow-300 bg-yellow-300 text-black'
                  : 'border-slate-500 text-slate-200 hover:bg-slate-800'
              }`}
            >
              {hud.highContrast ? '◐ High-Contrast: ON' : '◐ High-Contrast'}
            </button>
          </div>
        </header>
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <main className="flex min-w-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto p-3">
            <div className="min-h-[180px] min-w-0 flex-1">
              <ShowingStage hud={hud} />
            </div>
            <details
              className="panel min-w-0 max-w-full shrink-0 overflow-hidden rounded-lg border border-slate-700 bg-slate-900/60 shadow-2xl ring-1 ring-white/15 backdrop-blur-md"
              open={mapOpen}
            >
              <summary
                onClick={(e) => {
                  e.preventDefault();
                  setMapOpen((v) => !v);
                }}
                className="cursor-pointer select-none px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-300"
              >
                Citation Mind Map ({nodeCount})
              </summary>
              <MindMap hud={hud} />
            </details>
          </main>
          <MonitorDrawer hud={hud} />
        </div>
        <VoiceDock hud={hud} />
      </div>
      <ApprovalCard hud={hud} />
    </div>
  );
}
