import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SynthesisUpdateMessage } from "../types";
import { ComparisonView } from "./components/ComparisonView";
import { GatekeeperCard } from "./components/GatekeeperCard";
import { GlassBoxMonitor } from "./components/GlassBoxMonitor";
import { MindMapView } from "./components/MindMapView";
import { VoiceOrbDock } from "./components/VoiceOrbDock";
import { useElevenLabsVoice } from "./hooks/useElevenLabsVoice";
import { useExtensionBridge } from "./hooks/useExtensionBridge";

type StageView = "compare" | "mindmap" | "monitor" | "stack";

function openExternalUrl(rawUrl: string): void {
  const url = rawUrl.trim();
  if (!url) return;
  if (typeof chrome !== "undefined" && typeof chrome.tabs?.create === "function") {
    void chrome.tabs.create({ url, active: true }).catch(() => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export default function App() {
  const [activeView, setActiveView] = useState<StageView>("compare");
  const [unreadCompare, setUnreadCompare] = useState(false);
  const [unreadMindMap, setUnreadMindMap] = useState(false);
  const [unreadMonitor, setUnreadMonitor] = useState(false);

  const onSynthesisCallbackRef = useRef<
    (synthesis: SynthesisUpdateMessage) => void
  >(() => {});

  const bridge = useExtensionBridge({
    onSynthesisUpdate: (synthesis) => {
      onSynthesisCallbackRef.current(synthesis);
    },
  });

  const voice = useElevenLabsVoice({
    dispatchSwarm: bridge.dispatchSwarm,
    steerSwarm: bridge.steerSwarm,
    triggerSpotlight: bridge.triggerSpotlight,
    onSpotlightFeedback: (msg) => {
      voice.appendTranscript("system", msg, "system");
    },
  });

  const {
    notifySynthesisToVoice,
    appendTranscript,
    notifySilentPromptToVoice,
    triggerBargeInPulse,
    voiceStatus,
  } = voice;

  useEffect(() => {
    onSynthesisCallbackRef.current = (synthesis: SynthesisUpdateMessage) => {
      notifySynthesisToVoice(synthesis);
      if (voiceStatus !== "connected") {
        appendTranscript("agent", synthesis.voice_brief, "silent");
      } else {
        appendTranscript(
          "system",
          `Synthesis updated (${synthesis.items.length} items, ${synthesis.contradictions.length} conflicts).`,
          "system"
        );
      }
      setActiveView((curr) => {
        if (curr !== "compare" && curr !== "stack") setUnreadCompare(true);
        if (curr !== "mindmap" && curr !== "stack") setUnreadMindMap(true);
        return curr;
      });
    };
  }, [notifySynthesisToVoice, appendTranscript, voiceStatus]);

  const prevTelemetryCountRef = useRef(bridge.state.telemetry.length);
  useEffect(() => {
    const nextLen = bridge.state.telemetry.length;
    if (nextLen > prevTelemetryCountRef.current) {
      if (activeView !== "monitor" && activeView !== "stack") {
        setUnreadMonitor(true);
      }
    }
    prevTelemetryCountRef.current = nextLen;
  }, [bridge.state.telemetry.length, activeView]);

  const selectView = useCallback((view: StageView) => {
    setActiveView(view);
    if (view === "compare" || view === "stack") setUnreadCompare(false);
    if (view === "mindmap" || view === "stack") setUnreadMindMap(false);
    if (view === "monitor" || view === "stack") setUnreadMonitor(false);
  }, []);

  const handleSilentDispatch = useCallback(
    async (intent: string, constraints: string[]) => {
      appendTranscript("user", intent, "silent");
      notifySilentPromptToVoice(
        `User dispatched research via text: "${intent}".`
      );
      await bridge.dispatchSwarm(intent, constraints);
    },
    [bridge, appendTranscript, notifySilentPromptToVoice]
  );

  const handleSilentSteer = useCallback(
    async (deltaInstruction: string, cancelDomains: string[]) => {
      triggerBargeInPulse();
      const suffix =
        cancelDomains.length > 0 ? ` (cancel: ${cancelDomains.join(", ")})` : "";
      appendTranscript(
        "user",
        `[Steer] ${deltaInstruction}${suffix}`,
        "silent"
      );
      notifySilentPromptToVoice(
        `User steered active swarm via text: "${deltaInstruction}"${suffix}.`
      );
      await bridge.steerSwarm(deltaInstruction, cancelDomains);
    },
    [bridge, triggerBargeInPulse, appendTranscript, notifySilentPromptToVoice]
  );

  const handleApprovalDecision = useCallback(
    async (gateId: string, approved: boolean) => {
      await bridge.sendApprovalDecision(gateId, approved);
      appendTranscript(
        "system",
        `Gatekeeper ${gateId} ${approved ? "APPROVED" : "REJECTED"} by user.`,
        "system"
      );
    },
    [bridge, appendTranscript]
  );

  const handleRunDemoQuery = useCallback(async () => {
    await handleSilentDispatch(
      "Compare top 3 ANC headphones under 25k INR and check Reddit hinge issues",
      ["under_25k_inr", "check_reddit_hinge"]
    );
  }, [handleSilentDispatch]);

  const { state } = bridge;

  const hasRunningTelemetry = useMemo(
    () => state.telemetry.some((ev) => ev.status === "RUNNING"),
    [state.telemetry]
  );

  const hasSonyInSynthesis = useMemo(
    () =>
      Boolean(
        state.synthesis?.items.some((item) =>
          item.name.toLowerCase().includes("sony")
        )
      ),
    [state.synthesis]
  );

  const itemCount = state.synthesis?.items.length ?? 0;
  const contradictionCount = state.synthesis?.contradictions.length ?? 0;
  const mindMapCount = state.synthesis?.mind_map.nodes.length ?? 0;

  return (
    <div className="flex h-screen w-full flex-col bg-[#060a13] text-slate-100 select-text">
      {/* Section 1: Always-Docked Voice Orb, Tab-Architect, Clips & Silent Input */}
      <VoiceOrbDock
        wsStatus={state.wsStatus}
        ramSavedMb={state.ramSavedMb}
        memoryCards={state.memoryCards}
        clips={state.clips}
        focusMode={state.focusMode}
        activeJobId={state.activeJobId}
        hasSynthesis={Boolean(state.synthesis)}
        hasSonyInSynthesis={hasSonyInSynthesis}
        offloading={bridge.offloading}
        agentId={voice.agentId}
        onAgentIdChange={voice.setAgentId}
        isAgentConfigured={voice.isAgentConfigured}
        voiceStatus={voice.voiceStatus}
        voiceMode={voice.voiceMode}
        isMuted={voice.isMuted}
        bargeInActive={voice.bargeInActive}
        audioLevel={voice.audioLevel}
        voiceError={voice.voiceError}
        transcript={voice.transcript}
        onStartVoice={voice.startVoiceSession}
        onStopVoice={voice.stopVoiceSession}
        onToggleMute={voice.toggleMute}
        onClearTranscript={voice.clearTranscript}
        onOffloadTabs={bridge.offloadTabs}
        onRestoreMemoryCard={bridge.restoreMemoryCard}
        onToggleFocusMode={bridge.toggleFocusMode}
        onRemoveClip={bridge.removeClip}
        onClearClips={bridge.clearClips}
        onSilentDispatch={handleSilentDispatch}
        onSilentSteer={handleSilentSteer}
      />

      {/* Blocking High-Contrast Red Gatekeeper Approval Card */}
      {state.pendingGatekeeper && (
        <GatekeeperCard
          intercept={state.pendingGatekeeper}
          onDecision={handleApprovalDecision}
        />
      )}

      {/* Navigation Bar for Sections 2, 3 & 4 */}
      <nav
        aria-label="Workspace Sections"
        className="shrink-0 flex items-center gap-1 border-b border-slate-800/90 bg-slate-950/80 px-3 py-1.5"
      >
        <button
          type="button"
          onClick={() => selectView("compare")}
          className={`relative flex-1 inline-flex items-center justify-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition ${
            activeView === "compare"
              ? "bg-slate-800 text-cyan-200 shadow-inner"
              : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"
          }`}
        >
          <span>Compare</span>
          {(itemCount > 0 || contradictionCount > 0) && (
            <span className="rounded bg-slate-950/80 px-1 text-[9px] tabular-nums text-cyan-300">
              {itemCount}
            </span>
          )}
          {contradictionCount > 0 && (
            <span
              className="rounded bg-amber-500/20 px-1 text-[9px] font-bold text-amber-300"
              title={`${contradictionCount} contradiction(s)`}
            >
              !{contradictionCount}
            </span>
          )}
          {unreadCompare && (
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
          )}
        </button>

        <button
          type="button"
          onClick={() => selectView("mindmap")}
          className={`relative flex-1 inline-flex items-center justify-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition ${
            activeView === "mindmap"
              ? "bg-slate-800 text-indigo-200 shadow-inner"
              : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"
          }`}
        >
          <span>Mind Map</span>
          {mindMapCount > 0 && (
            <span className="rounded bg-slate-950/80 px-1 text-[9px] tabular-nums text-indigo-300">
              {mindMapCount}
            </span>
          )}
          {unreadMindMap && (
            <span className="h-1.5 w-1.5 rounded-full bg-indigo-400" />
          )}
        </button>

        <button
          type="button"
          onClick={() => selectView("monitor")}
          className={`relative flex-1 inline-flex items-center justify-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition ${
            activeView === "monitor"
              ? "bg-slate-800 text-emerald-200 shadow-inner"
              : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"
          }`}
        >
          <span>Monitor</span>
          {state.telemetry.length > 0 && (
            <span className="rounded bg-slate-950/80 px-1 text-[9px] tabular-nums text-slate-300">
              {state.telemetry.length}
            </span>
          )}
          {(unreadMonitor || hasRunningTelemetry) && (
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                hasRunningTelemetry ? "bg-cyan-400 animate-pulse" : "bg-emerald-400"
              }`}
            />
          )}
        </button>

        <button
          type="button"
          onClick={() =>
            selectView(activeView === "stack" ? "compare" : "stack")
          }
          title={
            activeView === "stack"
              ? "Switch to single-tab view"
              : "Stack all sections vertically"
          }
          className={`shrink-0 rounded-md border px-2 py-1 text-[10px] font-semibold transition ${
            activeView === "stack"
              ? "border-cyan-500/50 bg-cyan-500/15 text-cyan-200"
              : "border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200"
          }`}
        >
          All
        </button>
      </nav>

      {/* Main Scrollable Stage */}
      <main className="min-h-0 flex-1 overflow-y-auto px-3 py-3 space-y-5">
        {!bridge.isHydrated ? (
          <div className="py-8 text-center text-xs text-slate-500">
            Syncing DICE workspace...
          </div>
        ) : (
          <>
            {(activeView === "compare" || activeView === "stack") && (
              <section aria-label="Comparison and Contradiction Cards">
                {activeView === "stack" && (
                  <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-cyan-300">
                    2 · Comparison &amp; Contradictions
                  </div>
                )}
                <ComparisonView
                  synthesis={state.synthesis}
                  onSpotlightQuote={bridge.triggerSpotlight}
                  onClearSpotlight={bridge.clearSpotlight}
                  onOpenUrl={openExternalUrl}
                  onRunDemoQuery={handleRunDemoQuery}
                />
              </section>
            )}

            {(activeView === "mindmap" || activeView === "stack") && (
              <section aria-label="Knowledge Mind Map">
                {activeView === "stack" && (
                  <div className="mb-2 border-t border-slate-800 pt-3 text-[10px] font-bold uppercase tracking-wider text-indigo-300">
                    3 · Knowledge Mind Map
                  </div>
                )}
                <MindMapView
                  synthesis={state.synthesis}
                  onOpenUrl={openExternalUrl}
                  onSpotlightQuote={bridge.triggerSpotlight}
                />
              </section>
            )}

            {(activeView === "monitor" || activeView === "stack") && (
              <section aria-label="Glass-Box Telemetry Monitor">
                {activeView === "stack" && (
                  <div className="mb-2 border-t border-slate-800 pt-3 text-[10px] font-bold uppercase tracking-wider text-emerald-300">
                    4 · Glass-Box Monitor
                  </div>
                )}
                <GlassBoxMonitor
                  telemetry={state.telemetry}
                  pendingGatekeeper={state.pendingGatekeeper}
                  onApprovalDecision={handleApprovalDecision}
                />
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
