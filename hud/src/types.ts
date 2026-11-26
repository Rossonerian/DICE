// Mirrors SOURCE_OF_TRUTH.md Section 3 verbatim. Do not change without updating backend/schemas.py.

export interface PinnedNote {
  note_id: string;
  source_url: string;
  text: string;
}

// ---- Client -> Cloud ----
export interface DispatchSwarmMessage {
  type: 'DISPATCH_SWARM';
  job_id: string;
  intent: string;
  constraints: string[];
  context_url?: string;
  pinned_notes?: PinnedNote[];
}

export interface SteerSwarmMessage {
  type: 'STEER_SWARM';
  job_id: string;
  delta_instruction: string;
  cancel_domains?: string[];
}

export interface ApprovalDecisionMessage {
  type: 'APPROVAL_DECISION';
  gate_id: string;
  approved: boolean;
}

export type ClientToCloudMessage =
  | DispatchSwarmMessage
  | SteerSwarmMessage
  | ApprovalDecisionMessage;

// ---- Cloud -> Client ----
export type TelemetryAgentId = 'scout_swarm' | 'synthesis' | 'gatekeeper';
export type TelemetryStatus = 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'BLOCKED';

export interface TelemetryMessage {
  type: 'TELEMETRY';
  trace_id: string;
  agent_id: TelemetryAgentId;
  status: TelemetryStatus;
  message: string;
  latency_ms: number;
  workers_active: number;
  tabs_offloaded: number;
  tier?: 1 | 2;
}

export interface SynthesisItem {
  name: string;
  price: string;
  pros: string[];
  cons: string[];
  url: string;
}

export interface EvidenceCard {
  source_url: string;
  title: string;
  sanitized_excerpt: string;
  quote_to_highlight: string;
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
  type: 'SYNTHESIS_UPDATE';
  job_id: string;
  voice_brief: string;
  items: SynthesisItem[];
  evidence_cards: EvidenceCard[];
  contradictions: ContradictionItem[];
  mind_map: MindMapData;
}

export type GatekeeperActionType = 'FORM_SUBMIT' | 'CHECKOUT_CLICK' | 'EXTERNAL_POST';

export interface GatekeeperInterceptMessage {
  type: 'GATEKEEPER_INTERCEPT';
  gate_id: string;
  decision: 'FORBID_UNTIL_SIGNED';
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

// ---- HUD-local ----
export type WsConnectionStatus = 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'MOCK';

export interface SpotlightTarget {
  source_url: string;
  quote: string;
  badge_text: string;
}
