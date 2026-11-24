import type {
  ApprovalDecisionMessage,
  ClientToCloudMessage,
  ClipRecord,
  CloudToClientMessage,
  ContradictionItem,
  DispatchSwarmMessage,
  GatekeeperInterceptMessage,
  MindMapData,
  MindMapEdge,
  MindMapNode,
  SteerSwarmMessage,
  SynthesisItem,
  SynthesisUpdateMessage,
  TelemetryMessage,
  WsConnectionStatus,
} from "./types.ts";

export interface MockWsHandlers {
  onStatusChange: (status: WsConnectionStatus) => void;
  onEvent: (event: CloudToClientMessage) => void;
}

/**
 * Returns true when offline mock WebSocket mode is enabled via Vite/esbuild env.
 */
export function isMockWsEnabled(): boolean {
  return import.meta.env.VITE_MOCK_WS === "true";
}

function nextTraceId(): string {
  return `tr_${Math.random().toString(16).slice(2, 10)}`;
}

function extractSpotlightQuote(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 72) {
    return normalized;
  }
  const sliced = normalized.slice(0, 72);
  const lastSpace = sliced.lastIndexOf(" ");
  return (lastSpace > 24 ? sliced.slice(0, lastSpace) : sliced).trim();
}

function matchesDomainOrBrand(
  textOrUrl: string,
  cancelDomains: string[]
): boolean {
  const haystack = textOrUrl.toLowerCase();
  return cancelDomains.some((raw) => {
    const domain = raw.trim().toLowerCase();
    if (!domain) return false;
    if (haystack.includes(domain)) return true;
    const hostPart = domain.replace(/^https?:\/\//, "").split("/")[0] ?? "";
    const brandToken = hostPart.split(".")[0] ?? "";
    return brandToken.length >= 3 && haystack.includes(brandToken);
  });
}

function isHeadphoneQuery(intent: string, constraints: string[]): boolean {
  const combined = `${intent} ${constraints.join(" ")}`.toLowerCase();
  return /headphone|anc|sony|bose|sennheiser|hinge|audio|earbud/.test(combined);
}

function buildInitialSynthesis(msg: DispatchSwarmMessage): SynthesisUpdateMessage {
  const { job_id, intent, constraints, active_tab_url, clips } = msg;
  const primaryClip = clips[0];
  const isDemoHeadphones = isHeadphoneQuery(intent, constraints);
  const isExampleActiveTab = active_tab_url.toLowerCase().includes("example.com");

  if (isDemoHeadphones) {
    const items: SynthesisItem[] = [
      {
        name: "Sony WH-1000XM5",
        price: "₹24,990",
        pros: [
          "Class-leading active noise cancellation",
          "Lightweight 250g headband & fast USB-C charging",
        ],
        cons: [
          "Frequent Reddit hinge fracture reports after 4-6 months",
          "Non-folding yoke design makes carrying case bulky",
        ],
        url: "https://www.sony.co.in/headphones/products/wh-1000xm5",
      },
      {
        name: "Sennheiser Accentum Plus",
        price: "₹15,990",
        pros: [
          "50-hour battery life with multipoint Bluetooth 5.2",
          "Reinforced steel-slider headband; clean neutral tuning",
        ],
        cons: [
          "ANC trails Sony & Bose on deep cabin rumble",
          "Touch controls take brief adjustment",
        ],
        url: "https://www.sennheiser-hearing.com/en-IN/p/accentum-plus-wireless/",
      },
      {
        name: "Bose QuietComfort SC",
        price: "₹22,900",
        pros: [
          "All-day clamping comfort & strong low-end ANC",
          "Reliable physical buttons and foldable hinges",
        ],
        cons: [
          "24-hour battery ceiling lags newer rivals",
          "Soft case included instead of hardshell in SC SKU",
        ],
        url: "https://www.boseindia.com/en_in/products/headphones/noise_cancelling_headphones/bose-quietcomfort-headphones.html",
      },
    ];

    const clipContradiction: ContradictionItem = primaryClip
      ? {
          claim: `Clipped spec claim from ${primaryClip.page_title || "active research page"}`,
          conflict: `Cross-checked benchmark notes discrepancy against pinned evidence ("${extractSpotlightQuote(primaryClip.text)}").`,
          source_url: primaryClip.source_url || active_tab_url || "https://example.com/",
          quote_to_highlight: extractSpotlightQuote(primaryClip.text),
        }
      : isExampleActiveTab
        ? {
            claim: "Vendor benchmark claims zero mechanical failures under standard use",
            conflict: "Independent reference page & community threads flag hinge stress inconsistencies.",
            source_url: active_tab_url,
            quote_to_highlight: "Example Domain",
          }
        : {
            claim: "30-hour continuous ANC battery & reinforced polymer hinge",
            conflict: "User endurance tests average 20-22h with ANC + LDAC enabled, with Reddit hinge crack reports.",
            source_url: "https://en.wikipedia.org/wiki/Noise-cancelling_headphones",
            quote_to_highlight: "Noise-cancelling headphones",
          };

    const contradictions: ContradictionItem[] = [
      clipContradiction,
      {
        claim: "Sony WH-1000XM5 swivel yoke rated for multi-year travel",
        conflict: "r/SonyHeadphones megathread logs recurring hairline hinge cracks near the right earcup.",
        source_url: "https://www.sony.co.in/headphones/products/wh-1000xm5",
        quote_to_highlight: "WH-1000XM5",
      },
    ];

    const mind_map: MindMapData = {
      nodes: [
        { id: "n1", label: "ANC Under ₹25k", source_url: active_tab_url || "" },
        {
          id: "n2",
          label: "Sony WH-1000XM5",
          source_url: "https://www.sony.co.in/headphones/products/wh-1000xm5",
        },
        {
          id: "n3",
          label: "Reddit Hinge Cracks",
          source_url: contradictions[0].source_url,
        },
        {
          id: "n4",
          label: "Sennheiser Accentum+",
          source_url: "https://www.sennheiser-hearing.com/en-IN/p/accentum-plus-wireless/",
        },
        {
          id: "n5",
          label: "Bose QuietComfort SC",
          source_url: "https://www.boseindia.com/en_in/products/headphones/noise_cancelling_headphones/bose-quietcomfort-headphones.html",
        },
      ],
      edges: [
        { from: "n1", to: "n2", label: "top ANC" },
        { from: "n2", to: "n3", label: "contradicts" },
        { from: "n1", to: "n4", label: "best battery" },
        { from: "n1", to: "n5", label: "best comfort" },
      ],
    };

    const clipNote =
      clips.length > 0
        ? ` I also folded in ${clips.length} pinned research clip${clips.length > 1 ? "s" : ""}.`
        : "";

    return {
      type: "SYNTHESIS_UPDATE",
      job_id,
      voice_brief: `Three contenders fit under ₹25,000, led by Sennheiser Accentum Plus and Bose QuietComfort SC. Sony WH-1000XM5 has strong ANC, but Reddit flags recurring hinge cracks.${clipNote} Want me to drop Sony XM5?`,
      items,
      contradictions,
      mind_map,
    };
  }

  // Generic intent synthesis builder
  const shortTopic = intent.trim().slice(0, 48) || "Research Query";
  const fallbackSourceUrl = primaryClip?.source_url
    ? primaryClip.source_url
    : isExampleActiveTab
      ? active_tab_url
      : "https://example.com/";
  const fallbackQuote = primaryClip
    ? extractSpotlightQuote(primaryClip.text)
    : "Example Domain";

  const constraintNote =
    constraints.length > 0 ? constraints.join(", ") : "cost, reliability & spec accuracy";

  const items: SynthesisItem[] = [
    {
      name: `${shortTopic} — Option A (Verified Leader)`,
      price: "₹18,490",
      pros: [
        `Matches primary constraints (${constraintNote})`,
        "Consistent independent benchmark validation",
      ],
      cons: ["Slightly higher entry price than budget tier"],
      url: fallbackSourceUrl,
    },
    {
      name: `${shortTopic} — Option B (Value Pick)`,
      price: "₹12,990",
      pros: [
        "Strong price-to-performance ratio",
        "Positive long-term durability feedback",
      ],
      cons: ["Marketing sheet overstates real-world battery/throughput"],
      url: "https://example.com/",
    },
    {
      name: `${shortTopic} — Option C (Pro Alternative)`,
      price: "₹23,500",
      pros: [
        "Full feature coverage for power users",
        "Low defect rate in community reports",
      ],
      cons: ["Heavier footprint & proprietary accessories"],
      url: "https://en.wikipedia.org/wiki/Comparison",
    },
  ];

  const contradictions: ContradictionItem[] = [
    {
      claim: `Official specification summary for ${shortTopic}`,
      conflict: primaryClip
        ? `User evidence contradicts spec sheet: "${extractSpotlightQuote(primaryClip.text)}"`
        : "Independent user testing reports ~20% lower sustained performance than advertised.",
      source_url: fallbackSourceUrl,
      quote_to_highlight: fallbackQuote,
    },
  ];

  const mind_map: MindMapData = {
    nodes: [
      { id: "n1", label: shortTopic, source_url: active_tab_url || "" },
      { id: "n2", label: "Option A Leader", source_url: items[0].url },
      { id: "n3", label: "Option B Value", source_url: items[1].url },
      { id: "n4", label: "Spec Contradiction", source_url: contradictions[0].source_url },
      { id: "n5", label: "Option C Pro", source_url: items[2].url },
    ],
    edges: [
      { from: "n1", to: "n2", label: "top pick" },
      { from: "n1", to: "n3", label: "budget" },
      { from: "n3", to: "n4", label: "contradicts" },
      { from: "n1", to: "n5", label: "pro tier" },
    ],
  };

  return {
    type: "SYNTHESIS_UPDATE",
    job_id,
    voice_brief: `Synthesized 3 options for ${shortTopic} across ${clips.length || 4} sources and flagged 1 claim contradiction. Ready to refine or inspect the highlighted conflict.`,
    items,
    contradictions,
    mind_map,
  };
}

function buildSteeredSynthesis(
  steer: SteerSwarmMessage,
  previous: SynthesisUpdateMessage | null,
  lastIntent: string
): SynthesisUpdateMessage {
  const { job_id, delta_instruction, cancel_domains } = steer;
  const base =
    previous ??
    buildInitialSynthesis({
      type: "DISPATCH_SWARM",
      job_id,
      intent: lastIntent || delta_instruction,
      constraints: [],
      active_tab_url: "",
      clips: [],
    });

  const keptItems = base.items.filter(
    (item) =>
      !matchesDomainOrBrand(item.url, cancel_domains) &&
      !matchesDomainOrBrand(item.name, cancel_domains)
  );

  // Add a steered replacement item that directly reflects the delta instruction.
  const steeredCandidate: SynthesisItem = isHeadphoneQuery(
    `${lastIntent} ${delta_instruction}`,
    []
  )
    ? {
        name: "JBL Tour One M2 (Multipoint Pick)",
        price: "₹19,999",
        pros: [
          `Prioritized for: ${delta_instruction}`,
          "Seamless Bluetooth 5.3 multipoint + 50h battery & metal hinges",
        ],
        cons: ["Slightly tighter earcup clamping out of the box"],
        url: "https://in.jbl.com/over-ear-headphones/TOUR-ONE-M2.html",
      }
    : {
        name: `Steered Match (${delta_instruction.slice(0, 32)})`,
        price: "₹17,990",
        pros: [
          `Directly aligned with: ${delta_instruction}`,
          "Excluded penalized domains and verified multipoint/durability specs",
        ],
        cons: ["Limited regional colorway stock"],
        url: "https://example.com/",
      };

  const alreadyHasCandidate = keptItems.some(
    (item) => item.name === steeredCandidate.name
  );
  const items = alreadyHasCandidate
    ? keptItems
    : [steeredCandidate, ...keptItems].slice(0, 3);

  const keptContradictions = base.contradictions.filter(
    (c) =>
      !matchesDomainOrBrand(c.source_url, cancel_domains) &&
      !matchesDomainOrBrand(c.claim, cancel_domains)
  );

  const contradictions: ContradictionItem[] =
    keptContradictions.length > 0
      ? keptContradictions
      : [
          {
            claim: `Updated focus: ${delta_instruction}`,
            conflict:
              "Multipoint codec switching can drop LDAC bitrate to AAC when two hosts stay connected simultaneously.",
            source_url: "https://en.wikipedia.org/wiki/Bluetooth",
            quote_to_highlight: "Bluetooth",
          },
        ];

  const retainedNodes: MindMapNode[] = base.mind_map.nodes
    .filter(
      (n) =>
        n.id !== "n_steer" &&
        !matchesDomainOrBrand(n.source_url, cancel_domains) &&
        !matchesDomainOrBrand(n.label, cancel_domains)
    )
    .slice(0, 5);

  const rootId = retainedNodes[0]?.id ?? "n1";
  const steerNodeId = "n_steer";
  const nodes: MindMapNode[] = [
    ...retainedNodes,
    {
      id: steerNodeId,
      label: `Steered: ${delta_instruction.slice(0, 26)}`,
      source_url: steeredCandidate.url,
    },
  ];

  const validIds = new Set(nodes.map((n) => n.id));
  const retainedEdges: MindMapEdge[] = base.mind_map.edges.filter(
    (e) => validIds.has(e.from) && validIds.has(e.to)
  );
  if (rootId !== steerNodeId && validIds.has(rootId)) {
    retainedEdges.push({
      from: rootId,
      to: steerNodeId,
      label: "prioritized",
    });
  }

  const droppedSummary =
    cancel_domains.length > 0
      ? `Dropped ${cancel_domains.join(", ")} and `
      : "";

  return {
    type: "SYNTHESIS_UPDATE",
    job_id,
    voice_brief: `${droppedSummary}re-ranked ${items.length} options for "${delta_instruction}". ${items[0]?.name ?? "Top match"} now leads on your updated criteria.`,
    items,
    contradictions,
    mind_map: {
      nodes,
      edges: retainedEdges,
    },
  };
}

/**
 * Offline WebSocket simulator for VITE_MOCK_WS=true.
 */
export class MockWsClient {
  private readonly handlers: MockWsHandlers;
  private branchTimers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = true;
  private lastIntent = "";
  private lastSynthesis: SynthesisUpdateMessage | null = null;
  private gateCounter = 98;

  constructor(handlers: MockWsHandlers) {
    this.handlers = handlers;
  }

  start(): void {
    this.stopped = false;
    this.handlers.onStatusChange("MOCK");
  }

  stop(): void {
    this.stopped = true;
    this.clearBranchTimers();
  }

  send(message: ClientToCloudMessage): void {
    if (this.stopped) {
      this.start();
    }

    switch (message.type) {
      case "DISPATCH_SWARM":
        this.handleDispatch(message);
        break;
      case "STEER_SWARM":
        this.handleSteer(message);
        break;
      case "APPROVAL_DECISION":
        this.handleApprovalDecision(message);
        break;
    }
  }

  private schedule(delayMs: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.branchTimers.delete(timer);
      if (!this.stopped) {
        fn();
      }
    }, delayMs);
    this.branchTimers.add(timer);
  }

  private clearBranchTimers(): void {
    for (const timer of this.branchTimers) {
      clearTimeout(timer);
    }
    this.branchTimers.clear();
  }

  private emitTelemetry(
    agent_id: TelemetryMessage["agent_id"],
    status: TelemetryMessage["status"],
    message: string,
    latency_ms: number,
    workers_active: number
  ): void {
    this.handlers.onEvent({
      type: "TELEMETRY",
      trace_id: nextTraceId(),
      agent_id,
      status,
      message,
      latency_ms,
      workers_active,
    });
  }

  private handleDispatch(msg: DispatchSwarmMessage): void {
    this.clearBranchTimers();
    this.lastIntent = msg.intent;
    const synthesis = buildInitialSynthesis(msg);
    this.lastSynthesis = synthesis;

    const clipSuffix =
      msg.clips.length > 0
        ? ` (+${msg.clips.length} pinned clip${msg.clips.length > 1 ? "s" : ""})`
        : "";

    this.schedule(30, () => {
      this.emitTelemetry(
        "scout_swarm",
        "RUNNING",
        `Dispatching Tier-1 fetchers for "${msg.intent.slice(0, 60)}"${clipSuffix}`,
        115,
        3
      );
    });

    this.schedule(170, () => {
      this.emitTelemetry(
        "scout_swarm",
        "COMPLETED",
        "Tier-1 fetched 5 product & community threads; escalated 1 JS review page to warm Playwright.",
        340,
        0
      );
    });

    this.schedule(240, () => {
      this.emitTelemetry(
        "synthesis",
        "RUNNING",
        "Bedrock dual-model router cross-checking spec claims against benchmark & Reddit evidence.",
        190,
        2
      );
    });

    this.schedule(390, () => {
      this.emitTelemetry(
        "synthesis",
        "COMPLETED",
        `Synthesized ${synthesis.items.length} options, ${synthesis.contradictions.length} contradiction(s), and ${synthesis.mind_map.nodes.length}-node mind map.`,
        285,
        0
      );
      this.handlers.onEvent(synthesis);
    });

    this.schedule(820, () => {
      this.emitTelemetry(
        "gatekeeper",
        "RUNNING",
        "HTML sanitizer & Cedar taint-tagger inspecting downstream page actions...",
        85,
        1
      );
    });

    this.schedule(1000, () => {
      this.emitTelemetry(
        "gatekeeper",
        "COMPLETED",
        "Sanitizer stripped hidden untrusted spans; taint tags attached for policy check.",
        95,
        0
      );
    });

    this.schedule(1220, () => {
      this.gateCounter += 1;
      const gateId = `gate_${this.gateCounter}`;
      this.emitTelemetry(
        "gatekeeper",
        "BLOCKED",
        `Cedar rule forbid_untrusted_mutating_action halted FORM_SUBMIT (${gateId}) awaiting signature.`,
        48,
        0
      );

      const intercept: GatekeeperInterceptMessage = {
        type: "GATEKEEPER_INTERCEPT",
        gate_id: gateId,
        decision: "FORBID_UNTIL_SIGNED",
        cedar_rule: "forbid_untrusted_mutating_action",
        action_type: "FORM_SUBMIT",
        target_url: "https://example.com/checkout",
        reason:
          "Untrusted web content attempted to trigger a state-changing form submission.",
        action_diff: "POST /checkout with user session",
      };
      this.handlers.onEvent(intercept);
    });
  }

  private handleSteer(msg: SteerSwarmMessage): void {
    this.clearBranchTimers();
    const updated = buildSteeredSynthesis(msg, this.lastSynthesis, this.lastIntent);
    this.lastSynthesis = updated;

    const cancelledLabel =
      msg.cancel_domains.length > 0 ? msg.cancel_domains.join(", ") : "stale branch";

    this.schedule(20, () => {
      this.emitTelemetry(
        "scout_swarm",
        "CANCELLED",
        `Cancelled in-flight workers for [${cancelledLabel}]; applying barge-in: "${msg.delta_instruction}"`,
        32,
        0
      );
    });

    this.schedule(140, () => {
      this.emitTelemetry(
        "scout_swarm",
        "RUNNING",
        `Pivoting live swarm toward "${msg.delta_instruction}"...`,
        145,
        2
      );
    });

    this.schedule(290, () => {
      this.emitTelemetry(
        "scout_swarm",
        "COMPLETED",
        `Excluded [${cancelledLabel}] and collected updated candidate specs.`,
        260,
        0
      );
    });

    this.schedule(360, () => {
      this.emitTelemetry(
        "synthesis",
        "RUNNING",
        "Recomputing comparison matrix & mind map after voice steering...",
        160,
        1
      );
    });

    this.schedule(500, () => {
      this.emitTelemetry(
        "synthesis",
        "COMPLETED",
        `Steered synthesis complete (${updated.items.length} items, ${updated.mind_map.nodes.length} nodes).`,
        220,
        0
      );
      this.handlers.onEvent(updated);
    });
  }

  private handleApprovalDecision(msg: ApprovalDecisionMessage): void {
    this.schedule(50, () => {
      this.emitTelemetry(
        "gatekeeper",
        msg.approved ? "COMPLETED" : "BLOCKED",
        msg.approved
          ? `Signed Cedar permit accepted for ${msg.gate_id}; mutating action released.`
          : `User rejected ${msg.gate_id}; mutating action permanently blocked by Cedar policy.`,
        42,
        0
      );
    });
  }
}
