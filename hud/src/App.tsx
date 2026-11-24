import { useEffect } from 'react';
import { useHud } from './hooks/useHud';
import VoiceDock from './components/VoiceDock';
import ShowingStage from './components/ShowingStage';
import MindMap from './components/MindMap';
import MonitorDrawer, { ApprovalCard } from './components/MonitorDrawer';

export default function App() {
  const hud = useHud();

  useEffect(() => {
    document.documentElement.classList.toggle('hc', hud.highContrast);
    if (!hud.highContrast && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  }, [hud.highContrast]);

  const dot = hud.status === 'CONNECTED' ? 'bg-emerald-400' : hud.status === 'MOCK' ? 'bg-amber-400' : hud.status === 'CONNECTING' ? 'bg-cyan-400' : 'bg-red-500';

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <header className="panel flex items-center justify-between border-b border-slate-700 bg-slate-900 px-3 py-2" data-tauri-drag-region>
        <div className="flex items-center gap-2" data-tauri-drag-region>
          <span className="text-lg">🎲</span>
          <span className="font-bold tracking-wide">DICE HUD</span>
          <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
          <span className="muted text-xs text-slate-400">{hud.status}</span>
        </div>
        <button
          onClick={() => hud.setHighContrast(!hud.highContrast)}
          aria-pressed={hud.highContrast}
          className={`rounded border px-2 py-1 text-xs font-semibold ${hud.highContrast ? 'border-yellow-300 bg-yellow-300 text-black' : 'border-slate-500 text-slate-200 hover:bg-slate-800'}`}
        >
          {hud.highContrast ? '◐ Narrated / High-Contrast: ON' : '◐ Narrated / High-Contrast'}
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col gap-2 p-3">
          <div className="min-h-0 flex-1">
            <ShowingStage hud={hud} />
          </div>
          <details className="panel rounded-lg border border-slate-700 bg-slate-900/60" open>
            <summary className="cursor-pointer px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-300">Citation Mind Map</summary>
            <MindMap hud={hud} />
          </details>
        </main>
        <MonitorDrawer hud={hud} />
      </div>
      <VoiceDock hud={hud} />
      <ApprovalCard hud={hud} />
    </div>
  );
}
