import { useMemo } from 'react';
import type { HudApi } from '../hooks/useHud';
import { normalizeUrl } from '../hooks/platform';

type Props = { hud: HudApi };

const W = 640;
const COL_W = 200;
const ROW_H = 58;

export default function MindMap({ hud }: Props) {
  const mm = hud.synthesis?.mind_map;

  const layout = useMemo(() => {
    if (!mm || mm.nodes.length === 0) return null;
    const depth = new Map<string, number>();
    const incoming = new Set(mm.edges.map((e) => e.to));
    const roots = mm.nodes.filter((n) => !incoming.has(n.id));
    const queue = (roots.length ? roots : [mm.nodes[0]]).map((n) => n.id);
    queue.forEach((id) => depth.set(id, 0));
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      for (const e of mm.edges) {
        if (e.from === id && !depth.has(e.to)) {
          depth.set(e.to, (depth.get(id) ?? 0) + 1);
          queue.push(e.to);
        }
      }
    }
    mm.nodes.forEach((n) => {
      if (!depth.has(n.id)) depth.set(n.id, 0);
    });
    const cols = new Map<number, string[]>();
    mm.nodes.forEach((n) => {
      const d = depth.get(n.id) ?? 0;
      cols.set(d, [...(cols.get(d) ?? []), n.id]);
    });
    const maxRows = Math.max(...Array.from(cols.values()).map((c) => c.length));
    const height = Math.max(120, maxRows * ROW_H + 30);
    const pos = new Map<string, { x: number; y: number }>();
    cols.forEach((ids, d) => {
      ids.forEach((id, r) => {
        pos.set(id, { x: 20 + d * COL_W + 80, y: (height / (ids.length + 1)) * (r + 1) });
      });
    });
    const width = Math.max(W, (Math.max(...Array.from(cols.keys())) + 1) * COL_W + 40);
    return { pos, height, width };
  }, [mm]);

  if (!mm || !layout) {
    return <div className="muted p-3 text-xs text-slate-400">Citation mind map will appear after synthesis.</div>;
  }

  const clickNode = (id: string) => {
    const n = mm.nodes.find((x) => x.id === id);
    if (!n || !n.source_url) return;
    const s = hud.synthesis;
    const url = normalizeUrl(n.source_url);
    const contra = s?.contradictions.find((c) => normalizeUrl(c.source_url) === url);
    const ev = s?.evidence_cards.find((c) => normalizeUrl(c.source_url) === url);
    hud.doSpotlight(n.source_url, contra?.quote_to_highlight ?? ev?.quote_to_highlight ?? '', contra ? `Contradiction: ${contra.conflict}` : n.label);
  };

  return (
    <div className="overflow-auto">
      <svg viewBox={`0 0 ${layout.width} ${layout.height}`} width="100%" style={{ minWidth: 420, maxHeight: 260 }} role="img" aria-label="Citation mind map">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="#94a3b8" />
          </marker>
        </defs>
        {mm.edges.map((e, i) => {
          const a = layout.pos.get(e.from);
          const b = layout.pos.get(e.to);
          if (!a || !b) return null;
          const x1 = a.x + 70;
          const x2 = b.x - 70;
          const mx = (x1 + x2) / 2;
          const my = (a.y + b.y) / 2;
          return (
            <g key={i}>
              <path d={`M${x1} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${x2} ${b.y}`} stroke="#94a3b8" fill="none" strokeWidth={1.5} markerEnd="url(#arrow)" />
              <text x={mx} y={my - 4} textAnchor="middle" fontSize={10} fill={e.label === 'contradicts' ? '#f87171' : '#cbd5e1'}>
                {e.label}
              </text>
            </g>
          );
        })}
        {mm.nodes.map((n) => {
          const p = layout.pos.get(n.id);
          if (!p) return null;
          const clickable = !!n.source_url;
          const label = n.label.length > 26 ? n.label.slice(0, 25) + '…' : n.label;
          const hot = hud.spotlight && n.source_url && normalizeUrl(hud.spotlight.source_url) === normalizeUrl(n.source_url);
          return (
            <g key={n.id} onClick={() => clickNode(n.id)} style={{ cursor: clickable ? 'pointer' : 'default' }}>
              <title>{n.source_url || n.label}</title>
              <rect x={p.x - 70} y={p.y - 17} width={140} height={34} rx={9} fill={hot ? '#164e63' : '#0f172a'} stroke={hot ? '#22d3ee' : clickable ? '#fbbf24' : '#64748b'} strokeWidth={hot ? 2.5 : 1.5} />
              <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={11} fill="#f1f5f9">
                {label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
