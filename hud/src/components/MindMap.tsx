import { useMemo } from 'react';
import type { HudApi } from '../hooks/useHud';
import { normalizeUrl } from '../hooks/platform';

type Props = { hud: HudApi };

const W = 640;
const COL_W = 230;
const ROW_H = 58;
const NODE_W = 148;
const NODE_H = 34;
const HALF_W = NODE_W / 2;
const HALF_H = NODE_H / 2;
const TOP_PAD = 28;

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
    const height = Math.max(140, maxRows * ROW_H + TOP_PAD + 20);
    const usableH = height - TOP_PAD;
    const pos = new Map<string, { x: number; y: number }>();
    cols.forEach((ids, d) => {
      ids.forEach((id, r) => {
        pos.set(id, { x: 20 + d * COL_W + HALF_W + 6, y: TOP_PAD + (usableH / (ids.length + 1)) * (r + 1) });
      });
    });
    const width = Math.max(W, (Math.max(...Array.from(cols.keys())) + 1) * COL_W + 60);
    return { pos, depth, height, width };
  }, [mm]);

  if (!mm || !layout) {
    if (hud.workersActive > 0 || hud.isRunning) {
      return (
        <div className="muted flex items-center gap-2 p-3 text-xs text-cyan-300">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-cyan-400" />
          Building citation graph…
        </div>
      );
    }
    return <div className="muted p-3 text-xs text-slate-400">Citation mind map will appear after synthesis.</div>;
  }

  const clickNode = (id: string) => {
    const n = mm.nodes.find((x) => x.id === id);
    if (!n || !n.source_url) return;
    const s = hud.synthesis;
    const url = normalizeUrl(n.source_url);
    const contra = s?.contradictions.find((c) => normalizeUrl(c.source_url) === url);
    const ev = s?.evidence_cards.find((c) => normalizeUrl(c.source_url) === url);
    hud.doSpotlight(
      n.source_url,
      contra?.quote_to_highlight ?? ev?.quote_to_highlight ?? '',
      contra ? `Contradiction: ${contra.conflict}` : n.label,
    );
  };

  return (
    <div className="max-h-[180px] w-full min-w-0 max-w-full overflow-auto sm:max-h-[260px]">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
        role="img"
        aria-label="Citation mind map"
      >
        <defs>
          <marker id="mm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="#94a3b8" />
          </marker>
          <marker id="mm-arrow-contra" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="#f87171" />
          </marker>
          {mm.nodes.map((n, i) => {
            const p = layout.pos.get(n.id);
            if (!p) return null;
            return (
              <clipPath key={`clip-${n.id}-${i}`} id={`mm-clip-${i}`}>
                <rect x={p.x - HALF_W + 6} y={p.y - HALF_H} width={NODE_W - 12} height={NODE_H} rx={6} />
              </clipPath>
            );
          })}
        </defs>
        {mm.edges.map((e, i) => {
          const a = layout.pos.get(e.from);
          const b = layout.pos.get(e.to);
          if (!a || !b) return null;
          const da = layout.depth.get(e.from) ?? 0;
          const db = layout.depth.get(e.to) ?? 0;
          const isContra = e.label.toLowerCase().includes('contradict');

          let dPath: string;
          let mx: number;
          let my: number;

          if (da < db) {
            const x1 = a.x + HALF_W;
            const x2 = b.x - HALF_W;
            mx = (x1 + x2) / 2;
            my = (a.y + b.y) / 2;
            dPath = `M${x1} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${x2} ${b.y}`;
          } else if (da === db) {
            const x1 = a.x + HALF_W;
            const x2 = b.x + HALF_W;
            const archX = x1 + 48;
            mx = x1 + 36;
            my = (a.y + b.y) / 2;
            dPath = `M${x1} ${a.y} C ${archX} ${a.y}, ${archX} ${b.y}, ${x2} ${b.y}`;
          } else {
            const y1 = a.y - HALF_H;
            const y2 = b.y - HALF_H;
            const archY = Math.max(8, Math.min(y1, y2) - 34);
            mx = (a.x + b.x) / 2;
            my = archY + 6;
            dPath = `M${a.x} ${y1} C ${a.x} ${archY}, ${b.x} ${archY}, ${b.x} ${y2}`;
          }

          const pillW = Math.max(44, e.label.length * 6.5 + 18);

          return (
            <g key={i} className="mm-edge">
              <path
                d={dPath}
                className={isContra ? 'mm-edge-line mm-edge-line--contra' : 'mm-edge-line'}
                fill="none"
                strokeWidth={1.6}
                markerEnd={isContra ? 'url(#mm-arrow-contra)' : 'url(#mm-arrow)'}
              />
              {e.label && (
                <>
                  <rect x={mx - pillW / 2} y={my - 10} width={pillW} height={18} rx={5} className="mm-edge-pill" strokeWidth={1} />
                  <text
                    x={mx}
                    y={my + 2.5}
                    textAnchor="middle"
                    fontSize={10}
                    className={isContra ? 'mm-edge-label mm-edge-label--contra' : 'mm-edge-label'}
                  >
                    {e.label}
                  </text>
                </>
              )}
            </g>
          );
        })}
        {mm.nodes.map((n, i) => {
          const p = layout.pos.get(n.id);
          if (!p) return null;
          const clickable = !!n.source_url;
          const label = n.label.length > 20 ? `${n.label.slice(0, 19)}…` : n.label;
          const hot = !!(hud.spotlight && n.source_url && normalizeUrl(hud.spotlight.source_url) === normalizeUrl(n.source_url));
          const rectClass = [
            'mm-node-rect',
            clickable ? 'mm-node-rect--clickable' : '',
            hot ? 'mm-node-rect--hot' : '',
          ]
            .filter(Boolean)
            .join(' ');

          return (
            <g
              key={n.id}
              className={`mm-node ${clickable ? 'mm-node--clickable outline-none' : ''}`}
              onClick={clickable ? () => clickNode(n.id) : undefined}
              onKeyDown={
                clickable
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        clickNode(n.id);
                      }
                    }
                  : undefined
              }
              tabIndex={clickable ? 0 : undefined}
              role={clickable ? 'button' : undefined}
              aria-label={clickable ? `Spotlight ${n.label}` : undefined}
              style={{ cursor: clickable ? 'pointer' : 'default' }}
            >
              <title>{n.source_url ? `${n.label} — ${n.source_url}` : n.label}</title>
              <rect
                x={p.x - HALF_W}
                y={p.y - HALF_H}
                width={NODE_W}
                height={NODE_H}
                rx={9}
                className={rectClass}
                strokeWidth={hot ? 2.5 : 1.5}
              />
              <text
                x={p.x}
                y={p.y + 4}
                textAnchor="middle"
                fontSize={11}
                clipPath={`url(#mm-clip-${i})`}
                className="mm-node-text"
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
