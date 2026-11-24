/**
 * Locked wire-protocol contracts (Section 3 of source_of_truth (1).md)
 * and internal Chrome extension runtime types.
 */

// ---------------------------------------------------------------------------
// Client -> Cloud Messages
// ---------------------------------------------------------------------------

export interface ClipRecord {
  clip_id: string;
  source_url: string;
  page_title: string;
  text: string;
}

export interface DispatchSwarmMessage {
  type: "DISPATCH_SWARM";
  job_id: string;
  intent: string;
  constraints: string[];
  active_tab_url: string;
  clips: ClipRecord[];
}

export interface SteerSwarmMessage {
  type: "STEER_SWARM";
  job_id: string;
  delta_instruction: string;
  cancel_domains: string[];
}

export interface ApprovalDecisionMessage {
  type: "APPROVAL_DECISION";
  gate_id: string;
  approved: boolean;
}

export type ClientToCloudMessage =
  | DispatchSwarmMessage
  | SteerSwarmMessage
  | ApprovalDecisionMessage;

// ---------------------------------------------------------------------------
// Cloud -> Client Messages
// ---------------------------------------------------------------------------

export type TelemetryAgentId = "scout_swarm" | "synthesis" | "gatekeeper";

export type TelemetryStatus =
  | "RUNNING"
  | "COMPLETED"
  | "CANCELLED"
  | "BLOCKED";

export interface TelemetryMessage {
  type: "TELEMETRY";
  trace_id: string;
  agent_id: TelemetryAgentId;
  status: TelemetryStatus;
  message: string;
  latency_ms: number;
  workers_active: number;
}

export interface SynthesisItem {
  name: string;
  price: string;
  pros: string[];
  cons: string[];
  url: string;
}

export interface ContradictionItem {
  claim: string;
  conflict: string;
  source_url: string;
  quote_to_highlight: string;
}

export interface MindMapNode {
  id: string;
  label: string;
  source_url: string;
}

export interface MindMapEdge {
  from: string;
  to: string;
  label: string;
}

export interface MindMapData {
  nodes: MindMapNode[];
  edges: MindMapEdge[];
}

export interface SynthesisUpdateMessage {
  type: "SYNTHESIS_UPDATE";
  job_id: string;
  voice_brief: string;
  items: SynthesisItem[];
  contradictions: ContradictionItem[];
  mind_map: MindMapData;
}

export type GatekeeperActionType =
  | "FORM_SUBMIT"
  | "CHECKOUT_CLICK"
  | "EXTERNAL_POST";

export interface GatekeeperInterceptMessage {
  type: "GATEKEEPER_INTERCEPT";
  gate_id: string;
  decision: string;
  cedar_rule: string;
  action_type: GatekeeperActionType;
  target_url: string;
  reason: string;
  action_diff: string;
}

export type CloudToClientMessage =
  | TelemetryMessage
  | SynthesisUpdateMessage
  | GatekeeperInterceptMessage;

// ---------------------------------------------------------------------------
// Internal Extension State & Tab-Architect Types
// ---------------------------------------------------------------------------

export interface MemoryCard {
  id: string;
  url: string;
  title: string;
  domain: string;
  timestamp: number;
}

export interface TabOffloadResult {
  discardedCount: number;
  groupedDomains: string[];
  ramSavedMb: number;
  memoryCards: MemoryCard[];
}

export type WsConnectionStatus =
  | "CONNECTING"
  | "CONNECTED"
  | "DISCONNECTED"
  | "MOCK";

export interface ExtensionState {
  wsStatus: WsConnectionStatus;
  telemetry: TelemetryMessage[];
  synthesis: SynthesisUpdateMessage | null;
  pendingGatekeeper: GatekeeperInterceptMessage | null;
  ramSavedMb: number;
  memoryCards: MemoryCard[];
  clips: ClipRecord[];
  focusMode: boolean;
  activeJobId: string | null;
}

// ---------------------------------------------------------------------------
// Internal chrome.runtime Messaging Union
// ---------------------------------------------------------------------------

export type ExtensionMessage =
  | { type: "GET_STATE" }
  | { type: "STATE_SYNC"; state: ExtensionState }
  | { type: "SEND_WS"; payload: ClientToCloudMessage }
  | { type: "WS_EVENT"; event: CloudToClientMessage }
  | { type: "WS_STATUS_CHANGED"; status: WsConnectionStatus }
  | { type: "OFFLOAD_TABS" }
  | { type: "RESTORE_MEMORY_CARD"; cardId: string }
  | { type: "RAM_UPDATED"; ramSavedMb: number; memoryCards: MemoryCard[] }
  | { type: "CLIPS_UPDATED"; clips: ClipRecord[] }
  | { type: "REMOVE_CLIP"; clipId: string }
  | { type: "CLEAR_CLIPS" }
  | { type: "TRIGGER_SPOTLIGHT"; url: string; quote: string; badge_text: string }
  | { type: "SPOTLIGHT_QUOTE"; quote: string; badge_text: string }
  | { type: "CLEAR_SPOTLIGHT" }
  | { type: "TOGGLE_FOCUS_MODE"; enabled: boolean }
  | { type: "FOCUS_MODE"; enabled: boolean };
