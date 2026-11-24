import { useMemo, useState } from "react";
import type {
  MindMapData,
  MindMapEdge,
  MindMapNode,
  SynthesisUpdateMessage,
} from "../../types";
import type { SpotlightActionResult } from "../hooks/useExtensionBridge";

interface MindMapViewProps {
  synthesis: SynthesisUpdateMessage | null;
  onOpenUrl: (url: string) => void;
  onSpotlightQuote: (
    url: string,
    quote: string,
    badgeText: string
  ) => Promise<SpotlightActionResult>;
}

interface PositionedNode {
  node: MindMapNode;
  layer: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PositionedGraph {
  width: number;
  height: number;
  nodes: PositionedNode[];
  nodeMap: Map<string, PositionedNode>;
  edges: MindMapEdge[];
}

const NODE_WIDTH = 136;
const NODE_HEIGHT = 50;
const H_GAP = 22;
const V_GAP = 64;
const PADDING_X = 24;
const PADDING_Y = 28;

function wrapLabelLines(label: string, maxCharsPerLine = 19): [string, string?] {
  const words = label.trim().split(/\s+/);
  if (words.length === 0) return ["Node"];
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharsPerLine) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
      if (lines.length === 1 && current.length > maxCharsPerLine) {
        break;
      }
    }
  }
  if (current && lines.length < 2) {
    lines.push(current);
  }

  const first = lines[0] ?? "";
  const second = lines[1];
  const clampLine = (s: string) =>
    s.length > maxCharsPerLine ? `${s.slice(0, maxCharsPerLine - 1)}…` : s;

  return second ? [clampLine(first), clampLine(second)] : [clampLine(first)];
}

function computeLayeredLayout(data: MindMapData): PositionedGraph {
  const nodes = data.nodes ?? [];
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = (data.edges ?? []).filter(
    (e) => nodeIds.has(e.from) && nodeIds.has(e.to)
  );

  if (nodes.length === 0) {
    return {
      width: 400,
      height: 240,
      nodes: [],
      nodeMap: new Map(),
      edges: [],
    };
  }

  const childrenMap = new Map<string, string[]>();
  const parentsMap = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const n of nodes) {
    childrenMap.set(n.id, []);
    parentsMap.set(n.id, []);
    inDegree.set(n.id, 0);
  }

  for (const e of edges) {
    childrenMap.get(e.from)?.push(e.to);
    parentsMap.get(e.to)?.push(e.from);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  const roots = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0);
  const startNodes = roots.length > 0 ? roots : [nodes[0]];

  const layerById = new Map<string, number>();
  const queue: string[] = [];

  for (const root of startNodes) {
    layerById.set(root.id, 0);
    queue.push(root.id);
  }

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const currLayer = layerById.get(curr) ?? 0;
    for (const childId of childrenMap.get(curr) ?? []) {
      if (!layerById.has(childId)) {
        layerById.set(childId, currLayer + 1);
        queue.push(childId);
      }
    }
  }

  // Handle any disconnected components cleanly
  let maxAssignedLayer = Math.max(0, ...Array.from(layerById.values()));
  for (const n of nodes) {
    if (!layerById.has(n.id)) {
      maxAssignedLayer += 1;
      layerById.set(n.id, maxAssignedLayer);
    }
  }

  const layers = new Map<number, MindMapNode[]>();
  for (const n of nodes) {
    const layer = layerById.get(n.id) ?? 0;
    const list = layers.get(layer);
    if (list) {
      list.push(n);
    } else {
      layers.set(layer, [n]);
    }
  }

  const sortedLayerIndices = Array.from(layers.keys()).sort((a, b) => a - b);
  const maxCols = Math.max(
    1,
    ...sortedLayerIndices.map((idx) => layers.get(idx)?.length ?? 1)
  );
  const width = Math.max(
    420,
    maxCols * NODE_WIDTH + Math.max(0, maxCols - 1) * H_GAP + PADDING_X * 2
  );
  const height = Math.max(
    260,
    sortedLayerIndices.length * NODE_HEIGHT +
      Math.max(0, sortedLayerIndices.length - 1) * V_GAP +
      PADDING_Y * 2
  );

  // Order each layer by parent x-barycenter to keep edge crossings minimal
  const orderIndexById = new Map<string, number>();
  const positionedNodes: PositionedNode[] = [];
  const nodeMap = new Map<string, PositionedNode>();

  for (const layerIdx of sortedLayerIndices) {
    const layerNodes = [...(layers.get(layerIdx) ?? [])];
    if (layerIdx > 0) {
      layerNodes.sort((a, b) => {
        const aParents = parentsMap.get(a.id) ?? [];
        const bParents = parentsMap.get(b.id) ?? [];
        const aAvg =
          aParents.length > 0
            ? aParents.reduce((sum, id) => sum + (orderIndexById.get(id) ?? 0), 0) /
              aParents.length
            : 999;
        const bAvg =
          bParents.length > 0
            ? bParents.reduce((sum, id) => sum + (orderIndexById.get(id) ?? 0), 0) /
              bParents.length
            : 999;
        return aAvg - bAvg;
      });
    }

    const rowWidth =
      layerNodes.length * NODE_WIDTH +
      Math.max(0, layerNodes.length - 1) * H_GAP;
    const startX = (width - rowWidth) / 2;
    const y = PADDING_Y + layerIdx * (NODE_HEIGHT + V_GAP);

    layerNodes.forEach((node, idx) => {
      const x = startX + idx * (NODE_WIDTH + H_GAP);
      orderIndexById.set(node.id, x + NODE_WIDTH / 2);
      const positioned: PositionedNode = {
        node,
        layer: layerIdx,
        x,
        y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      };
      positionedNodes.push(positioned);
      nodeMap.set(node.id, positioned);
    });
  }

  return {
    width,
    height,
    nodes: positionedNodes,
    nodeMap,
    edges,
  };
}

function getHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, "");
  } catch {
    return rawUrl;
  }
}

export function MindMapView({
  synthesis,
  onOpenUrl,
  onSpotlightQuote,
}: MindMapViewProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number>(1);
  const [spotlightNote, setSpotlightNote] = useState<string | null>(null);

  const mindMap = synthesis?.mind_map ?? null;
  const graph = useMemo(
    () =>
      computeLayeredLayout(
        mindMap ?? {
          nodes: [],
          edges: [],
        }
      ),
    [mindMap]
  );

  if (!synthesis || graph.nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-800 bg-slate-900/40 px-4 py-8 text-center">
        <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full border border-indigo-500/30 bg-indigo-500/10 text-indigo-300">
          ◈
        </div>
        <h3 className="text-xs font-semibold text-slate-200">
          Knowledge Mind Map Empty
        </h3>
        <p className="mt-1 max-w-[260px] text-[11px] leading-relaxed text-slate-400">
          Dispatch a research swarm to visualize synthesized entities, steered
          priorities, and contradiction edges.
        </p>
      </div>
    );
  }

  const activeNode =
    graph.nodeMap.get(selectedNodeId ?? "") ?? graph.nodes[0] ?? null;

  const handleSpotlightNode = async (node: MindMapNode) => {
    if (!node.source_url) return;
    const matchedContradiction = synthesis.contradictions.find(
      (c) => c.source_url === node.source_url
    );
    const quote = matchedContradiction?.quote_to_highlight || node.label;
    const badgeText =
      matchedContradiction?.conflict || `Mind Map Node: ${node.label}`;
    setSpotlightNote("Triggering closed Shadow DOM spotlight...");
    const result = await onSpotlightQuote(node.source_url, quote, badgeText);
    setSpotlightNote(
      result.found
        ? `Highlighted "${quote}" on source page.`
        : result.ok
          ? `Opened ${getHostname(node.source_url)} for "${quote}".`
          : result.error || "Unable to spotlight source."
    );
  };

  return (
    <div className="space-y-2.5">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          Entity &amp; Contradiction Graph ({graph.nodes.length} nodes ·{" "}
          {graph.edges.length} edges)
        </div>
        <div className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-900 px-1 py-0.5 text-[10px]">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.75, +(z - 0.15).toFixed(2)))}
            className="px-1.5 text-slate-300 hover:text-white"
            title="Zoom out"
          >
            −
          </button>
          <span className="min-w-[34px] text-center font-mono text-[10px] text-slate-400">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.15).toFixed(2)))}
            className="px-1.5 text-slate-300 hover:text-white"
            title="Zoom in"
          >
            +
          </button>
        </div>
      </div>

      {/* Custom SVG Node-Edge Graph */}
      <div className="overflow-auto rounded-xl border border-slate-800/90 bg-[radial-gradient(circle_at_top,_rgba(30,41,59,0.45),_rgba(2,6,23,0.95))] p-2">
        <svg
          viewBox={`0 0 ${graph.width} ${graph.height}`}
          style={{
            width: `${Math.round(zoom * 100)}%`,
            minWidth: "100%",
          }}
          className="h-auto select-none"
          role="img"
          aria-label="Research Knowledge Mind Map"
        >
          <defs>
            <marker
              id="dice-arrow-default"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#38bdf8" />
            </marker>
            <marker
              id="dice-arrow-contradict"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#f59e0b" />
            </marker>
            <marker
              id="dice-arrow-priority"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#34d399" />
            </marker>
          </defs>

          {/* Edges */}
          {graph.edges.map((edge, idx) => {
            const fromNode = graph.nodeMap.get(edge.from);
            const toNode = graph.nodeMap.get(edge.to);
            if (!fromNode || !toNode) return null;

            const startX = fromNode.x + fromNode.width / 2;
            const startY = fromNode.y + fromNode.height;
            const endX = toNode.x + toNode.width / 2;
            const endY = toNode.y;

            const isDownward = endY >= startY;
            const cpOffset = isDownward
              ? Math.max(24, (endY - startY) * 0.48)
              : 40;
            const y1 = isDownward ? startY : fromNode.y;
            const y2 = isDownward ? endY : toNode.y + toNode.height;
            const pathD = isDownward
              ? `M ${startX} ${y1} C ${startX} ${y1 + cpOffset}, ${endX} ${y2 - cpOffset}, ${endX} ${y2}`
              : `M ${startX} ${y1} C ${startX} ${y1 - cpOffset}, ${endX} ${y2 + cpOffset}, ${endX} ${y2}`;

            const midX = (startX + endX) / 2;
            const midY = (y1 + y2) / 2;

            const lowerLabel = edge.label.toLowerCase();
            const isContradiction = lowerLabel.includes("contradict");
            const isPriority = lowerLabel.includes("priorit");

            const stroke = isContradiction
              ? "#f59e0b"
              : isPriority
                ? "#34d399"
                : "#38bdf8";
            const markerEnd = isContradiction
              ? "url(#dice-arrow-contradict)"
              : isPriority
                ? "url(#dice-arrow-priority)"
                : "url(#dice-arrow-default)";

            const labelText = edge.label.slice(0, 18);
            const pillW = Math.max(46, labelText.length * 6.2 + 14);

            return (
              <g key={`${edge.from}-${edge.to}-${idx}`}>
                <path
                  d={pathD}
                  fill="none"
                  stroke={stroke}
                  strokeOpacity={0.78}
                  strokeWidth={isContradiction ? 2 : 1.6}
                  strokeDasharray={isContradiction ? "5 3" : undefined}
                  markerEnd={markerEnd}
                />
                {labelText && (
                  <g transform={`translate(${midX}, ${midY})`}>
                    <rect
                      x={-pillW / 2}
                      y={-9}
                      width={pillW}
                      height={18}
                      rx={9}
                      fill="#0b1220"
                      stroke={stroke}
                      strokeOpacity={0.55}
                      strokeWidth={1}
                    />
                    <text
                      x={0}
                      y={3.5}
                      textAnchor="middle"
                      fontSize="9.5"
                      fontWeight={600}
                      fill={
                        isContradiction
                          ? "#fcd34d"
                          : isPriority
                            ? "#6ee7b7"
                            : "#bae6fd"
                      }
                    >
                      {labelText}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* Nodes */}
          {graph.nodes.map((pNode) => {
            const { node, x, y, width, height, layer } = pNode;
            const isSelected = activeNode?.node.id === node.id;
            const isContradictNode = graph.edges.some(
              (e) =>
                e.to === node.id &&
                e.label.toLowerCase().includes("contradict")
            );
            const isRoot = layer === 0;
            const hasUrl = Boolean(node.source_url?.trim());
            const lines = wrapLabelLines(node.label);

            const fill = isContradictNode
              ? "#2a1608"
              : isRoot
                ? "#0b2239"
                : "#0f172a";
            const stroke = isSelected
              ? "#22d3ee"
              : isContradictNode
                ? "#f59e0b"
                : isRoot
                  ? "#38bdf8"
                  : "#334155";

            return (
              <g
                key={node.id}
                transform={`translate(${x}, ${y})`}
                onClick={() => {
                  setSelectedNodeId(node.id);
                  setSpotlightNote(null);
                }}
                className="cursor-pointer"
              >
                <title>
                  {node.label}
                  {hasUrl ? ` (${node.source_url})` : ""}
                </title>
                <rect
                  width={width}
                  height={height}
                  rx={10}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={isSelected ? 2.2 : 1.3}
                />
                {lines.length === 1 ? (
                  <text
                    x={hasUrl ? width / 2 - 6 : width / 2}
                    y={height / 2 + 4}
                    textAnchor="middle"
                    fontSize="11"
                    fontWeight={600}
                    fill="#f8fafc"
                  >
                    {lines[0]}
                  </text>
                ) : (
                  <>
                    <text
                      x={hasUrl ? width / 2 - 6 : width / 2}
                      y={height / 2 - 3}
                      textAnchor="middle"
                      fontSize="10.5"
                      fontWeight={600}
                      fill="#f8fafc"
                    >
                      {lines[0]}
                    </text>
                    <text
                      x={hasUrl ? width / 2 - 6 : width / 2}
                      y={height / 2 + 11}
                      textAnchor="middle"
                      fontSize="10.5"
                      fontWeight={600}
                      fill="#cbd5e1"
                    >
                      {lines[1]}
                    </text>
                  </>
                )}

                {hasUrl && (
                  <g
                    transform={`translate(${width - 20}, 6)`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenUrl(node.source_url);
                    }}
                  >
                    <rect
                      width={14}
                      height={14}
                      rx={4}
                      fill="#1e293b"
                      stroke="#38bdf8"
                      strokeOpacity={0.5}
                    />
                    <text
                      x={7}
                      y={10.5}
                      textAnchor="middle"
                      fontSize="9"
                      fontWeight={700}
                      fill="#38bdf8"
                    >
                      ↗
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Selected Node Inspector + Source Link Actions */}
      {activeNode && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Selected Node ({activeNode.node.id})
              </div>
              <div className="text-xs font-bold text-slate-100">
                {activeNode.node.label}
              </div>
            </div>
            {activeNode.node.source_url && (
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => void handleSpotlightNode(activeNode.node)}
                  className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300 hover:bg-amber-500/20"
                >
                  Spotlight
                </button>
                <button
                  type="button"
                  onClick={() => onOpenUrl(activeNode.node.source_url)}
                  className="rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-300 hover:bg-cyan-500/20"
                >
                  Open ↗
                </button>
              </div>
            )}
          </div>

          {activeNode.node.source_url ? (
            <div className="mt-1 truncate font-mono text-[10px] text-cyan-400/90">
              {activeNode.node.source_url}
            </div>
          ) : (
            <div className="mt-1 text-[10px] text-slate-500">
              Root query node (no external source URL)
            </div>
          )}

          {spotlightNote && (
            <div className="mt-1.5 text-[10px] text-amber-300">
              {spotlightNote}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
