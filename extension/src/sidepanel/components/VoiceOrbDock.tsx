import { useEffect, useRef, useState } from "react";
import type { Mode, Status } from "@elevenlabs/client";
import type {
  ClipRecord,
  MemoryCard,
  TabOffloadResult,
  WsConnectionStatus,
} from "../../types";
import type { TranscriptEntry } from "../hooks/useElevenLabsVoice";

export type SilentActionMode = "dispatch" | "steer";

interface VoiceOrbDockProps {
  wsStatus: WsConnectionStatus;
  ramSavedMb: number;
  memoryCards: MemoryCard[];
  clips: ClipRecord[];
  focusMode: boolean;
  activeJobId: string | null;
  hasSynthesis: boolean;
  hasSonyInSynthesis: boolean;
  offloading: boolean;
  // ElevenLabs voice props
  agentId: string;
  onAgentIdChange: (next: string) => void;
  isAgentConfigured: boolean;
  voiceStatus: Status;
  voiceMode: Mode;
  isMuted: boolean;
  bargeInActive: boolean;
  audioLevel: number;
  voiceError: string | null;
  transcript: TranscriptEntry[];
  onStartVoice: () => Promise<void>;
  onStopVoice: () => Promise<void>;
  onToggleMute: () => void;
  onClearTranscript: () => void;
  // Extension actions
  onOffloadTabs: () => Promise<TabOffloadResult | null>;
  onRestoreMemoryCard: (cardId: string) => Promise<void>;
  onToggleFocusMode: (enabled: boolean) => Promise<void>;
  onRemoveClip: (clipId: string) => Promise<void>;
  onClearClips: () => Promise<void>;
  onSilentDispatch: (intent: string, constraints: string[]) => Promise<void>;
  onSilentSteer: (
    deltaInstruction: string,
    cancelDomains: string[]
  ) => Promise<void>;
}

const WS_BADGE_MAP: Record<
  WsConnectionStatus,
  { label: string; dot: string; pill: string }
> = {
  MOCK: {
    label: "MOCK",
    dot: "bg-amber-400",
    pill: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  },
  CONNECTED: {
    label: "CONNECTED",
    dot: "bg-emerald-400",
    pill: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  },
  CONNECTING: {
    label: "CONNECTING",
    dot: "bg-cyan-400 animate-pulse",
    pill: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
  },
  DISCONNECTED: {
    label: "DISCONNECTED",
    dot: "bg-rose-400",
    pill: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  },
};

function inferCancelDomainsFromPrompt(prompt: string): string[] {
  const inferred = new Set<string>();
  const urlMatches = prompt.match(
    /\b(?:[a-z0-9-]+\.)+(?:com|co\.in|in|org|net|io|ai)\b/gi
  );
  if (urlMatches) {
    for (const domain of urlMatches) {
      inferred.add(domain.toLowerCase());
    }
  }
  const dropMatches = prompt.matchAll(
    /\b(?:drop|remove|exclude|skip|cancel)\s+([a-z0-9.-]{3,24})/gi
  );
  for (const match of dropMatches) {
    const token = match[1]?.toLowerCase().replace(/[^a-z0-9.-]/g, "");
    if (token && !["the", "this", "that", "all"].includes(token)) {
      inferred.add(token);
    }
  }
  return Array.from(inferred);
}

function formatRelativeTime(timestamp: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${Math.floor(diffMin / 60)}h ago`;
}

export function VoiceOrbDock({
  wsStatus,
  ramSavedMb,
  memoryCards,
  clips,
  focusMode,
  activeJobId,
  hasSynthesis,
  hasSonyInSynthesis,
  offloading,
  agentId,
  onAgentIdChange,
  isAgentConfigured,
  voiceStatus,
  voiceMode,
  isMuted,
  bargeInActive,
  audioLevel,
  voiceError,
  transcript,
  onStartVoice,
  onStopVoice,
  onToggleMute,
  onClearTranscript,
  onOffloadTabs,
  onRestoreMemoryCard,
  onToggleFocusMode,
  onRemoveClip,
  onClearClips,
  onSilentDispatch,
  onSilentSteer,
}: VoiceOrbDockProps) {
  const [silentMode, setSilentMode] = useState<SilentActionMode>("dispatch");
  const [promptInput, setPromptInput] = useState("");
  const [cancelDomainsInput, setCancelDomainsInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showMemoryDrawer, setShowMemoryDrawer] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [showAgentSettings, setShowAgentSettings] = useState(false);
  const [offloadNotice, setOffloadNotice] = useState<string | null>(null);

  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (transcript.length > 0 && showTranscript) {
      transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [transcript.length, showTranscript]);

  useEffect(() => {
    if (!activeJobId && silentMode === "steer") {
      setSilentMode("dispatch");
    }
  }, [activeJobId, silentMode]);

  const wsBadge = WS_BADGE_MAP[wsStatus];
  const isVoiceConnected = voiceStatus === "connected";
  const isVoiceConnecting =
    voiceStatus === "connecting" || voiceStatus === "disconnecting";

  const orbScale = isVoiceConnected ? 1 + Math.min(0.22, audioLevel * 0.28) : 1;

  const orbToneClass = bargeInActive
    ? "from-amber-400 via-orange-500 to-rose-500 shadow-[0_0_26px_rgba(245,158,11,0.55)]"
    : !isVoiceConnected
      ? isVoiceConnecting
        ? "from-cyan-400 via-indigo-500 to-violet-500 shadow-[0_0_20px_rgba(56,189,248,0.45)]"
        : "from-slate-600 via-slate-700 to-slate-800 shadow-[0_0_12px_rgba(15,23,42,0.7)]"
      : isMuted
        ? "from-amber-500/80 via-slate-700 to-slate-800 shadow-[0_0_14px_rgba(245,158,11,0.3)]"
        : voiceMode === "speaking"
          ? "from-indigo-400 via-violet-500 to-cyan-400 shadow-[0_0_28px_rgba(99,102,241,0.6)]"
          : "from-cyan-400 via-teal-400 to-emerald-400 shadow-[0_0_24px_rgba(34,211,238,0.5)]";

  const voiceHeadline = bargeInActive
    ? "Barge-In Active"
    : voiceStatus === "connecting"
      ? "Connecting WebRTC..."
      : voiceStatus === "disconnecting"
        ? "Closing Voice..."
        : isVoiceConnected
          ? isMuted
            ? "Mic Muted"
            : voiceMode === "speaking"
              ? "Agent Speaking"
              : "Listening Live"
          : "Voice Standby";

  const handleOffloadClick = async () => {
    const result = await onOffloadTabs();
    if (!result) return;
    if (result.discardedCount > 0) {
      const domainSummary =
        result.groupedDomains.length > 0
          ? ` · grouped ${result.groupedDomains.length} domain(s)`
          : "";
      setOffloadNotice(
        `Hibernated ${result.discardedCount} tab(s) (+${result.discardedCount * 180} MB)${domainSummary}`
      );
      setShowMemoryDrawer(true);
    } else {
      setOffloadNotice("No eligible inactive HTTP tabs to hibernate.");
    }
    setTimeout(() => {
      setOffloadNotice((prev) =>
        prev && prev.startsWith("Hibernated") ? prev : null
      );
    }, 4500);
  };

  const handleSubmitPrompt = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = promptInput.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      if (silentMode === "steer" && activeJobId) {
        const manualDomains = cancelDomainsInput
          .split(/[,;\s]+/)
          .map((d) => d.trim())
          .filter(Boolean);
        const domains =
          manualDomains.length > 0
            ? manualDomains
            : inferCancelDomainsFromPrompt(text);
        await onSilentSteer(text, domains);
        setPromptInput("");
        setCancelDomainsInput("");
      } else {
        await onSilentDispatch(text, []);
        setPromptInput("");
      }
      setShowTranscript(true);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRunDemoQuery = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onSilentDispatch(
        "Compare top 3 ANC headphones under 25k INR and check Reddit hinge issues",
        ["under_25k_inr", "check_reddit_hinge"]
      );
      setShowTranscript(true);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDemoSteer = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onSilentSteer(
        "Drop Sony XM5 and prioritize multipoint Bluetooth",
        ["sony.co.in"]
      );
      setShowTranscript(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="shrink-0 border-b border-slate-800/90 bg-slate-950/95 px-3 pt-2.5 pb-2.5">
      {/* Executive Header + WS & RAM Badges */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-cyan-400 to-indigo-600 text-[11px] font-black tracking-tight text-slate-950 shadow-sm shadow-cyan-500/30">
            D
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-bold tracking-wide text-slate-100">
                DICE
              </span>
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold tracking-wider ${wsBadge.pill}`}
                title={`WebSocket state: ${wsBadge.label}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${wsBadge.dot}`} />
                {wsBadge.label}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setShowMemoryDrawer((v) => !v)}
            className="inline-flex items-center gap-1 rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 transition hover:bg-emerald-500/20"
            title="Toggle saved Memory Cards drawer"
          >
            <span className="tabular-nums">{ramSavedMb} MB saved</span>
            {memoryCards.length > 0 && (
              <span className="rounded bg-emerald-500/25 px-1 text-[9px] text-emerald-200">
                {memoryCards.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Tab-Architect + Focus Mode Utility Strip */}
      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => void handleOffloadClick()}
          disabled={offloading}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-700/80 bg-slate-900/90 px-2.5 py-1.5 text-[11px] font-medium text-slate-200 transition hover:border-cyan-500/50 hover:bg-slate-800/90 disabled:opacity-60"
        >
          <span className="text-cyan-400">⚡</span>
          <span>{offloading ? "Offloading..." : "Offload & Save RAM"}</span>
        </button>

        <button
          type="button"
          onClick={() => void onToggleFocusMode(!focusMode)}
          aria-pressed={focusMode}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition ${
            focusMode
              ? "border-indigo-400/60 bg-indigo-500/20 text-indigo-200 shadow-sm shadow-indigo-500/20"
              : "border-slate-700/80 bg-slate-900/90 text-slate-300 hover:border-slate-600 hover:text-slate-100"
          }`}
          title="Hide sidebars, promo banners, and ad clutter on the active tab"
        >
          <span
            className={`h-2 w-2 rounded-full ${
              focusMode ? "bg-indigo-400 shadow-[0_0_6px_#818cf8]" : "bg-slate-500"
            }`}
          />
          <span>Focus Mode</span>
        </button>
      </div>

      {offloadNotice && (
        <div className="mt-1.5 rounded-md border border-emerald-500/30 bg-emerald-950/40 px-2 py-1 text-[10px] text-emerald-200">
          {offloadNotice}
        </div>
      )}

      {/* Collapsible Memory Cards Drawer */}
      {showMemoryDrawer && (
        <div className="mt-2 rounded-lg border border-slate-800 bg-slate-900/80 p-2">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Memory Cards ({memoryCards.length})
            </span>
            <button
              type="button"
              onClick={() => setShowMemoryDrawer(false)}
              className="text-[10px] text-slate-400 hover:text-slate-200"
            >
              Hide
            </button>
          </div>
          {memoryCards.length === 0 ? (
            <p className="text-[11px] text-slate-500">
              No hibernated tabs yet. Use &ldquo;Offload &amp; Save RAM&rdquo; to
              discard inactive tabs into lightweight cards.
            </p>
          ) : (
            <div className="max-h-28 space-y-1 overflow-y-auto pr-0.5">
              {memoryCards.map((card) => (
                <div
                  key={card.id}
                  className="flex items-center justify-between gap-2 rounded border border-slate-800/90 bg-slate-950/70 px-2 py-1"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[11px] font-medium text-slate-200">
                      {card.title}
                    </div>
                    <div className="truncate text-[10px] text-slate-500">
                      {card.domain} · {formatRelativeTime(card.timestamp)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void onRestoreMemoryCard(card.id)}
                    className="shrink-0 rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-300 hover:bg-cyan-500/20"
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Pinned Clips Pill Bar */}
      {clips.length > 0 && (
        <div className="mt-2 rounded-lg border border-cyan-500/25 bg-cyan-950/20 p-1.5">
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-cyan-300">
              Pinned Clips ({clips.length})
            </span>
            <button
              type="button"
              onClick={() => void onClearClips()}
              className="text-[10px] text-slate-400 hover:text-rose-300"
            >
              Clear all
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {clips.map((clip) => (
              <span
                key={clip.clip_id}
                title={`${clip.page_title}: ${clip.text}`}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-cyan-500/35 bg-slate-900/90 px-2 py-0.5 text-[10px] text-cyan-100"
              >
                <span className="max-w-[190px] truncate">
                  &ldquo;{clip.text}&rdquo;
                </span>
                <button
                  type="button"
                  onClick={() => void onRemoveClip(clip.clip_id)}
                  aria-label="Remove pinned clip"
                  className="ml-0.5 text-slate-400 hover:text-rose-300"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Voice Orb Card */}
      <div className="mt-2 rounded-xl border border-slate-800/90 bg-gradient-to-br from-slate-900/95 via-slate-900/80 to-slate-950 p-2.5 shadow-inner">
        <div className="flex items-center gap-3">
          {/* Animated Multi-Ring Voice Orb */}
          <div className="relative flex h-12 w-12 shrink-0 items-center justify-center">
            {(isVoiceConnected || bargeInActive) && (
              <span
                className={`dice-wave-pulse absolute inset-0 rounded-full ${
                  bargeInActive
                    ? "bg-amber-400/35"
                    : voiceMode === "speaking"
                      ? "bg-indigo-400/35"
                      : "bg-cyan-400/30"
                }`}
              />
            )}
            <div
              className={`dice-orb-spin absolute inset-0.5 rounded-full border border-dashed ${
                bargeInActive
                  ? "border-amber-400/80"
                  : isVoiceConnected
                    ? "border-cyan-400/60"
                    : "border-slate-700/70"
              }`}
            />
            <div
              style={{ transform: `scale(${orbScale.toFixed(3)})` }}
              className={`relative flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-tr transition-transform duration-75 ${orbToneClass} ${
                !isVoiceConnected ? "dice-orb-breathe" : ""
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4 text-white drop-shadow"
              >
                {isMuted ? (
                  <>
                    <line x1="2" y1="2" x2="22" y2="22" />
                    <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
                    <path d="M5 10v2a7 7 0 0 0 12 5" />
                    <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
                    <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
                    <line x1="12" y1="19" x2="12" y2="22" />
                  </>
                ) : (
                  <>
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="22" />
                  </>
                )}
              </svg>
            </div>
          </div>

          {/* Voice State + Actions */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-1">
              <span className="truncate text-xs font-semibold text-slate-100">
                {voiceHeadline}
              </span>
              <button
                type="button"
                onClick={() => setShowAgentSettings((v) => !v)}
                className="rounded px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                title="Configure ElevenLabs Agent ID"
              >
                ⚙
              </button>
            </div>
            <p className="truncate text-[10px] text-slate-400">
              {isVoiceConnected
                ? "WebRTC full-duplex · tools active"
                : isAgentConfigured
                  ? "ElevenLabs WebRTC ready"
                  : "Silent Mode active · Agent ID optional"}
            </p>

            <div className="mt-1.5 flex items-center gap-1.5">
              {isVoiceConnected || isVoiceConnecting ? (
                <>
                  <button
                    type="button"
                    onClick={() => void onStopVoice()}
                    className="rounded-md border border-rose-500/50 bg-rose-500/15 px-2.5 py-1 text-[11px] font-semibold text-rose-200 hover:bg-rose-500/25"
                  >
                    Disconnect
                  </button>
                  {isVoiceConnected && (
                    <button
                      type="button"
                      onClick={onToggleMute}
                      className={`rounded-md border px-2 py-1 text-[11px] font-medium ${
                        isMuted
                          ? "border-amber-500/50 bg-amber-500/15 text-amber-200"
                          : "border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
                      }`}
                    >
                      {isMuted ? "Unmute" : "Mute"}
                    </button>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => void onStartVoice()}
                  className="rounded-md bg-gradient-to-r from-cyan-500 to-indigo-500 px-2.5 py-1 text-[11px] font-semibold text-slate-950 shadow-sm shadow-cyan-500/25 transition hover:brightness-110"
                >
                  Connect Voice
                </button>
              )}

              <button
                type="button"
                onClick={() => setShowTranscript((v) => !v)}
                className="ml-auto inline-flex items-center gap-1 rounded-md border border-slate-700/80 bg-slate-900 px-2 py-1 text-[10px] font-medium text-slate-300 hover:border-slate-600"
              >
                <span>Transcript</span>
                <span className="rounded bg-slate-800 px-1 text-[9px] tabular-nums text-cyan-300">
                  {transcript.length}
                </span>
              </button>
            </div>
          </div>
        </div>

        {/* Optional Agent ID Override Drawer */}
        {showAgentSettings && (
          <div className="mt-2 border-t border-slate-800 pt-2">
            <label className="block text-[10px] font-medium text-slate-400">
              ElevenLabs Agent ID (WebRTC)
            </label>
            <div className="mt-1 flex gap-1.5">
              <input
                type="text"
                value={agentId}
                onChange={(e) => onAgentIdChange(e.target.value)}
                placeholder="agent_..."
                className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowAgentSettings(false)}
                className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] text-slate-200 hover:bg-slate-700"
              >
                Done
              </button>
            </div>
          </div>
        )}

        {voiceError && (
          <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-950/40 px-2 py-1 text-[10px] text-amber-200">
            {voiceError}
          </div>
        )}

        {/* Collapsible Live Transcript Drawer */}
        {showTranscript && (
          <div className="mt-2 border-t border-slate-800 pt-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Live Transcript
              </span>
              {transcript.length > 0 && (
                <button
                  type="button"
                  onClick={onClearTranscript}
                  className="text-[10px] text-slate-500 hover:text-slate-300"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="max-h-28 space-y-1.5 overflow-y-auto pr-1">
              {transcript.length === 0 ? (
                <p className="text-[11px] text-slate-500">
                  Start speaking or type a research command below.
                </p>
              ) : (
                transcript.map((entry) => {
                  const roleStyle =
                    entry.role === "user"
                      ? "border-cyan-500/30 bg-cyan-950/35 text-cyan-100"
                      : entry.role === "agent"
                        ? "border-indigo-500/30 bg-indigo-950/35 text-indigo-100"
                        : entry.role === "tool"
                          ? "border-amber-500/30 bg-amber-950/30 font-mono text-[10px] text-amber-200"
                          : "border-slate-800 bg-slate-900/70 text-slate-400";
                  const label =
                    entry.role === "user"
                      ? entry.channel === "silent"
                        ? "You (Silent)"
                        : "You"
                      : entry.role === "agent"
                        ? "DICE"
                        : entry.role === "tool"
                          ? "Tool"
                          : "System";

                  return (
                    <div
                      key={entry.id}
                      className={`rounded-md border px-2 py-1 text-[11px] leading-snug ${roleStyle}`}
                    >
                      <span className="mr-1.5 text-[9px] font-bold uppercase tracking-wider opacity-75">
                        {label}:
                      </span>
                      <span>{entry.text}</span>
                    </div>
                  );
                })
              )}
              <div ref={transcriptEndRef} />
            </div>
          </div>
        )}
      </div>

      {/* Silent Mode Text Input Bar (100% Feature Parity) */}
      <form onSubmit={(e) => void handleSubmitPrompt(e)} className="mt-2 space-y-1.5">
        <div className="flex items-center justify-between gap-1.5">
          <div className="inline-flex rounded-md border border-slate-800 bg-slate-900 p-0.5 text-[10px]">
            <button
              type="button"
              onClick={() => setSilentMode("dispatch")}
              className={`rounded px-2 py-0.5 font-medium transition ${
                silentMode === "dispatch"
                  ? "bg-cyan-500/20 text-cyan-200"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              New Research
            </button>
            <button
              type="button"
              disabled={!activeJobId}
              onClick={() => setSilentMode("steer")}
              className={`rounded px-2 py-0.5 font-medium transition disabled:opacity-40 ${
                silentMode === "steer"
                  ? "bg-amber-500/20 text-amber-200"
                  : "text-slate-400 hover:text-slate-200"
              }`}
              title={
                activeJobId
                  ? `Steer active job ${activeJobId} mid-flight`
                  : "Run a research query first to steer live workers"
              }
            >
              Steer / Barge-In
            </button>
          </div>

          <div className="flex items-center gap-1">
            {(wsStatus === "MOCK" || !hasSynthesis) && (
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleRunDemoQuery()}
                className="rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-300 transition hover:bg-cyan-500/20 disabled:opacity-50"
              >
                Run Demo Query
              </button>
            )}
            {wsStatus === "MOCK" && hasSonyInSynthesis && (
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleDemoSteer()}
                className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300 transition hover:bg-amber-500/20 disabled:opacity-50"
              >
                Drop Sony XM5
              </button>
            )}
          </div>
        </div>

        {silentMode === "steer" && activeJobId && (
          <input
            type="text"
            value={cancelDomainsInput}
            onChange={(e) => setCancelDomainsInput(e.target.value)}
            placeholder="Cancel domains (optional, e.g. sony.co.in)"
            className="w-full rounded-md border border-amber-500/35 bg-slate-900/90 px-2.5 py-1 text-[11px] text-amber-100 placeholder:text-slate-500 focus:border-amber-400 focus:outline-none"
          />
        )}

        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={promptInput}
            onChange={(e) => setPromptInput(e.target.value)}
            placeholder={
              silentMode === "steer" && activeJobId
                ? "Barge-in instruction (e.g. Drop Sony XM5, prioritize multipoint)..."
                : "Silent Mode: Ask DICE to research & compare..."
            }
            className="min-w-0 flex-1 rounded-lg border border-slate-700/80 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!promptInput.trim() || submitting}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:opacity-40 ${
              silentMode === "steer" && activeJobId
                ? "bg-amber-500 text-slate-950 hover:bg-amber-400"
                : "bg-cyan-500 text-slate-950 hover:bg-cyan-400"
            }`}
          >
            {submitting
              ? "..."
              : silentMode === "steer" && activeJobId
                ? "Steer"
                : "Send"}
          </button>
        </div>
      </form>
    </section>
  );
}
