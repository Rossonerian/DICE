import { useCallback, useEffect, useRef, useState } from "react";
import { Conversation } from "@elevenlabs/client";
import type {
  DisconnectionDetails,
  MessagePayload,
  Mode,
  Status,
} from "@elevenlabs/client";
import type { SynthesisUpdateMessage } from "../../types";
import type { SpotlightActionResult } from "./useExtensionBridge";

export interface TranscriptEntry {
  id: string;
  role: "user" | "agent" | "tool" | "system";
  text: string;
  timestamp: number;
  channel: "voice" | "silent" | "system";
}

interface VoiceBridgeDeps {
  dispatchSwarm: (
    intent: string,
    constraints?: string[],
    waitForSynthesisMs?: number
  ) => Promise<{
    jobId: string;
    synthesis: SynthesisUpdateMessage | null;
  }>;
  steerSwarm: (
    deltaInstruction: string,
    cancelDomains?: string[],
    waitForSynthesisMs?: number
  ) => Promise<{
    jobId: string;
    synthesis: SynthesisUpdateMessage | null;
  }>;
  triggerSpotlight: (
    url: string,
    quote: string,
    badgeText: string
  ) => Promise<SpotlightActionResult>;
  onSpotlightFeedback?: (message: string) => void;
}

function normalizeStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item ?? "").trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(/[,;\n]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function createEntryId(): string {
  return `tx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function isAgentIdConfigured(agentId: string): boolean {
  const trimmed = agentId.trim();
  return Boolean(trimmed) && trimmed !== "your_elevenlabs_agent_id";
}

export function useElevenLabsVoice(deps: VoiceBridgeDeps) {
  const defaultAgentId = (
    import.meta.env.VITE_ELEVENLABS_AGENT_ID || ""
  ).trim();

  const [agentId, setAgentId] = useState<string>(defaultAgentId);
  const [voiceStatus, setVoiceStatus] = useState<Status>("disconnected");
  const [voiceMode, setVoiceMode] = useState<Mode>("listening");
  const [isMuted, setIsMuted] = useState(false);
  const [bargeInActive, setBargeInActive] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);

  const depsRef = useRef(deps);
  depsRef.current = deps;

  const conversationRef = useRef<Conversation | null>(null);
  const bargeInTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeToolWaitCountRef = useRef<number>(0);

  const appendTranscript = useCallback(
    (
      role: TranscriptEntry["role"],
      text: string,
      channel: TranscriptEntry["channel"] = "system"
    ) => {
      const cleaned = text.trim();
      if (!cleaned) return;
      setTranscript((prev) =>
        [
          ...prev,
          {
            id: createEntryId(),
            role,
            text: cleaned,
            timestamp: Date.now(),
            channel,
          },
        ].slice(-60)
      );
    },
    []
  );

  const triggerBargeInPulse = useCallback(() => {
    setBargeInActive(true);
    if (bargeInTimerRef.current) {
      clearTimeout(bargeInTimerRef.current);
    }
    bargeInTimerRef.current = setTimeout(() => {
      setBargeInActive(false);
      bargeInTimerRef.current = null;
    }, 2400);
  }, []);

  const notifySynthesisToVoice = useCallback(
    (synthesis: SynthesisUpdateMessage) => {
      const conv = conversationRef.current;
      if (!conv || !conv.isOpen()) return;
      if (activeToolWaitCountRef.current > 0) {
        return;
      }
      try {
        conv.sendContextualUpdate(
          `Research synthesis updated (${synthesis.job_id}): ${synthesis.voice_brief} (${synthesis.items.length} options, ${synthesis.contradictions.length} contradiction(s)).`
        );
      } catch {
        // Ignore if session closed mid-flight.
      }
    },
    []
  );

  const notifySilentPromptToVoice = useCallback((summary: string) => {
    const conv = conversationRef.current;
    if (!conv || !conv.isOpen()) return;
    try {
      conv.sendContextualUpdate(summary);
    } catch {
      // Ignore if session closed.
    }
  }, []);

  useEffect(() => {
    if (voiceStatus !== "connected") {
      setAudioLevel(0);
      return;
    }

    const timer = setInterval(() => {
      const conv = conversationRef.current;
      if (!conv) return;
      try {
        const level =
          voiceMode === "speaking" ? conv.getOutputVolume() : conv.getInputVolume();
        const clamped = Number.isFinite(level)
          ? Math.min(1, Math.max(0, level))
          : 0;
        setAudioLevel(clamped);
      } catch {
        setAudioLevel(0);
      }
    }, 90);

    return () => {
      clearInterval(timer);
    };
  }, [voiceStatus, voiceMode]);

  useEffect(() => {
    return () => {
      if (bargeInTimerRef.current) {
        clearTimeout(bargeInTimerRef.current);
      }
      const conv = conversationRef.current;
      if (conv) {
        conversationRef.current = null;
        void conv.endSession().catch(() => {});
      }
    };
  }, []);

  const startVoiceSession = useCallback(
    async (overrideAgentId?: string) => {
      const targetAgentId = (overrideAgentId ?? agentId).trim();
      setVoiceError(null);

      if (!isAgentIdConfigured(targetAgentId)) {
        const msg =
          "Set VITE_ELEVENLABS_AGENT_ID in extension/.env (or enter an Agent ID in Voice Settings) to enable live WebRTC voice. Silent Mode works immediately with full parity.";
        setVoiceError(msg);
        appendTranscript("system", msg, "system");
        return;
      }

      if (conversationRef.current) {
        await conversationRef.current.endSession().catch(() => {});
        conversationRef.current = null;
      }

      setVoiceStatus("connecting");
      try {
        const session = await Conversation.startSession({
          agentId: targetAgentId,
          connectionType: "webrtc",
          onConnect: ({ conversationId: id }) => {
            setConversationId(id);
            setVoiceStatus("connected");
            setVoiceError(null);
            appendTranscript(
              "system",
              `ElevenLabs WebRTC connected (session ${id.slice(0, 10)}).`,
              "voice"
            );
          },
          onDisconnect: (details: DisconnectionDetails) => {
            conversationRef.current = null;
            setVoiceStatus("disconnected");
            setVoiceMode("listening");
            setIsMuted(false);
            setConversationId(null);
            if (details.reason === "error") {
              const errMsg = details.message || "WebRTC voice session disconnected with an error.";
              setVoiceError(errMsg);
              appendTranscript("system", errMsg, "voice");
            }
          },
          onMessage: (payload: MessagePayload) => {
            appendTranscript(
              payload.role === "user" ? "user" : "agent",
              payload.message,
              "voice"
            );
          },
          onModeChange: ({ mode }) => {
            setVoiceMode(mode);
          },
          onStatusChange: ({ status }) => {
            setVoiceStatus(status);
          },
          onInterruption: () => {
            triggerBargeInPulse();
            appendTranscript(
              "system",
              "Voice barge-in detected — agent interrupted.",
              "voice"
            );
          },
          onError: (message) => {
            setVoiceError(message);
            appendTranscript("system", `Voice error: ${message}`, "voice");
          },
          clientTools: {
            dispatch_swarm: async (parameters: {
              intent?: string;
              constraints?: string[] | string;
            }) => {
              const intent = String(parameters?.intent ?? "").trim();
              const constraints = normalizeStringArray(parameters?.constraints);
              appendTranscript(
                "tool",
                `dispatch_swarm("${intent}"${constraints.length ? `, [${constraints.join(", ")}]` : ""})`,
                "voice"
              );

              activeToolWaitCountRef.current += 1;
              try {
                const { jobId, synthesis } =
                  await depsRef.current.dispatchSwarm(intent, constraints, 2200);

                if (synthesis?.voice_brief) {
                  return synthesis.voice_brief;
                }

                return `Research swarm dispatched for "${intent}" (${jobId}). Live scouts are gathering sources now; comparison cards and contradictions will appear shortly.`;
              } finally {
                activeToolWaitCountRef.current = Math.max(
                  0,
                  activeToolWaitCountRef.current - 1
                );
              }
            },

            steer_swarm: async (parameters: {
              delta_instruction?: string;
              cancel_domains?: string[] | string;
            }) => {
              const deltaInstruction = String(
                parameters?.delta_instruction ?? ""
              ).trim();
              const cancelDomains = normalizeStringArray(
                parameters?.cancel_domains
              );
              triggerBargeInPulse();
              appendTranscript(
                "tool",
                `steer_swarm("${deltaInstruction}"${cancelDomains.length ? `, cancel: [${cancelDomains.join(", ")}]` : ""})`,
                "voice"
              );

              activeToolWaitCountRef.current += 1;
              try {
                const { synthesis } = await depsRef.current.steerSwarm(
                  deltaInstruction,
                  cancelDomains,
                  1400
                );

                if (synthesis?.voice_brief) {
                  return synthesis.voice_brief;
                }

                const droppedNote = cancelDomains.length
                  ? ` Cancelled domains: ${cancelDomains.join(", ")}.`
                  : "";
                return `Swarm steered mid-flight: "${deltaInstruction}".${droppedNote} Re-ranking live results now.`;
              } finally {
                activeToolWaitCountRef.current = Math.max(
                  0,
                  activeToolWaitCountRef.current - 1
                );
              }
            },

            spotlight_quote: async (parameters: {
              url?: string;
              quote?: string;
              badge_text?: string;
            }) => {
              const url = String(parameters?.url ?? "").trim();
              const quote = String(parameters?.quote ?? "").trim();
              const badgeText =
                String(parameters?.badge_text ?? "").trim() ||
                "Contradiction Spotlight";

              appendTranscript(
                "tool",
                `spotlight_quote("${quote.slice(0, 48)}", ${url || "active tab"})`,
                "voice"
              );

              const result = await depsRef.current.triggerSpotlight(
                url,
                quote,
                badgeText
              );

              const statusText = result.found
                ? `Spotlight mounted on page for "${quote}" with badge "${badgeText}".`
                : result.ok
                  ? `Focused source page and attempted spotlight for "${quote}".`
                  : `Spotlight could not highlight page: ${result.error || "tab restricted"}.`;

              depsRef.current.onSpotlightFeedback?.(statusText);
              return statusText;
            },
          },
        });

        conversationRef.current = session;
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Could not start ElevenLabs WebRTC voice session.";
        setVoiceStatus("disconnected");
        setVoiceError(message);
        appendTranscript("system", `Voice connection failed: ${message}`, "voice");
      }
    },
    [agentId, appendTranscript, triggerBargeInPulse]
  );

  const stopVoiceSession = useCallback(async () => {
    const conv = conversationRef.current;
    conversationRef.current = null;
    if (conv) {
      await conv.endSession().catch(() => {});
    }
    setVoiceStatus("disconnected");
    setVoiceMode("listening");
    setIsMuted(false);
    setConversationId(null);
  }, []);

  const toggleMute = useCallback(() => {
    const conv = conversationRef.current;
    if (!conv || !conv.isOpen()) return;
    const nextMuted = !isMuted;
    conv.setMicMuted(nextMuted);
    setIsMuted(nextMuted);
  }, [isMuted]);

  const clearTranscript = useCallback(() => {
    setTranscript([]);
  }, []);

  return {
    agentId,
    setAgentId,
    isAgentConfigured: isAgentIdConfigured(agentId),
    voiceStatus,
    voiceMode,
    isMuted,
    bargeInActive,
    audioLevel,
    voiceError,
    conversationId,
    transcript,
    appendTranscript,
    triggerBargeInPulse,
    notifySynthesisToVoice,
    notifySilentPromptToVoice,
    startVoiceSession,
    stopVoiceSession,
    toggleMute,
    clearTranscript,
  };
}
