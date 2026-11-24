import type {
  ClientToCloudMessage,
  CloudToClientMessage,
  ContradictionItem,
  EvidenceCard,
  GatekeeperInterceptMessage,
  MindMapData,
  SynthesisItem,
  SynthesisUpdateMessage,
  TelemetryAgentId,
  TelemetryMessage,
  TelemetryStatus,
  WsConnectionStatus,
} from './types';

type MessageCb = (msg: CloudToClientMessage) => void;
type StatusCb = (status: WsConnectionStatus) => void;

interface EnvShape {
  VITE_MOCK_WS?: string;
  VITE_WS_URL?: string;
}

function readEnv(): EnvShape {
  const meta = import.meta as unknown as { env?: EnvShape };
  return meta.env ?? {};
}

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30000;

export class WsClient {
  private ws: WebSocket | null = null;
  private status: WsConnectionStatus = 'DISCONNECTED';
  private msgCbs = new Set<MessageCb>();
  private statusCbs = new Set<StatusCb>();
  private queue: ClientToCloudMessage[] = [];
  private backoff = BACKOFF_START_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = true;
  private mockTimers = new Set<ReturnType<typeof setTimeout>>();
  private traceSeq = 0;
  private activeJobId = 'job_01';
  private mockTabs = 0;
  private readonly mock: boolean;
  private readonly url: string;

  constructor(url?: string, mock?: boolean) {
    const env = readEnv();
    this.mock = mock ?? env.VITE_MOCK_WS === 'true';
    this.url = url ?? env.VITE_WS_URL ?? 'ws://localhost:8000/ws/demo1';
  }

  get currentStatus(): WsConnectionStatus {
    return this.status;
  }

  getStatus(): WsConnectionStatus {
    return this.status;
  }

  get isMock(): boolean {
    return this.mock;
  }

  onMessage(cb: MessageCb): () => void {
    this.msgCbs.add(cb);
    return () => {
      this.msgCbs.delete(cb);
    };
  }

  onStatus(cb: StatusCb): () => void {
    this.statusCbs.add(cb);
    cb(this.status);
    return () => {
      this.statusCbs.delete(cb);
    };
  }

  connect(): void {
    this.closedByUser = false;
    if (this.mock) {
      this.setStatus('MOCK');
      return;
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.openSocket();
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearMockTimers();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.backoff = BACKOFF_START_MS;
    this.setStatus('DISCONNECTED');
  }

  send(msg: ClientToCloudMessage): void {
    if (this.mock) {
      this.handleMock(msg);
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.queue.push(msg);
    }
  }

  // ---------------- real mode ----------------

  private setStatus(s: WsConnectionStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const cb of [...this.statusCbs]) cb(s);
  }

  private emit(msg: CloudToClientMessage): void {
    for (const cb of [...this.msgCbs]) cb(msg);
  }

  private openSocket(): void {
    this.setStatus('CONNECTING');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = BACKOFF_START_MS;
      this.setStatus('CONNECTED');
      const pending = this.queue;
      this.queue = [];
      for (const m of pending) ws.send(JSON.stringify(m));
    };
    ws.onmessage = (ev: MessageEvent) => {
      try {
        const data: unknown = JSON.parse(String(ev.data));
        if (data && typeof data === 'object' && 'type' in data) {
          this.emit(data as CloudToClientMessage);
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.setStatus('DISCONNECTED');
      if (!this.closedByUser) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer !== null) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this.openSocket();
    }, delay);
  }

  // ---------------- mock mode ----------------

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.mockTimers.delete(t);
      fn();
    }, ms);
    this.mockTimers.add(t);
  }

  private clearMockTimers(): void {
    for (const t of this.mockTimers) clearTimeout(t);
    this.mockTimers.clear();
  }

  private tele(
    agent_id: TelemetryAgentId,
    status: TelemetryStatus,
    message: string,
    latency_ms: number,
    workers_active: number,
    tabs_offloaded: number,
  ): TelemetryMessage {
    this.traceSeq += 1;
    return {
      type: 'TELEMETRY',
      trace_id: `tr_${(0x9918a4c2 + this.traceSeq).toString(16)}`,
      agent_id,
      status,
      message,
      latency_ms,
      workers_active,
      tabs_offloaded,
    };
  }

  private handleMock(msg: ClientToCloudMessage): void {
    switch (msg.type) {
      case 'DISPATCH_SWARM':
        this.mockDispatch(msg.job_id, msg.intent);
        break;
      case 'STEER_SWARM':
        this.mockSteer(msg.job_id, msg.delta_instruction, msg.cancel_domains ?? []);
        break;
      case 'APPROVAL_DECISION':
        this.later(250, () =>
          this.emit(
            this.tele(
              'gatekeeper',
              msg.approved ? 'COMPLETED' : 'BLOCKED',
              msg.approved
                ? `Action ${msg.gate_id} approved by user signature; released from Cedar hold`
                : `Action ${msg.gate_id} rejected by user; mutating request blocked`,
              90,
              0,
              this.mockTabs,
            ),
          ),
        );
        break;
    }
  }

  private mockDispatch(jobId: string, intent: string): void {
    this.clearMockTimers();
    this.activeJobId = jobId;
    this.mockTabs = 0;
    const short = intent.length > 60 ? `${intent.slice(0, 57)}...` : intent;

    this.later(200, () => {
      this.mockTabs = 2;
      this.emit(this.tele('scout_swarm', 'RUNNING', `Tier-1 fan-out started for "${short}"`, 120, 2, 2));
    });
    this.later(900, () => {
      this.mockTabs = 5;
      this.emit(
        this.tele('scout_swarm', 'RUNNING', 'Tier-1 fetched 4 Reddit threads; escalating 1 JS page to warm Playwright', 420, 3, 5),
      );
    });
    this.later(1700, () => {
      this.mockTabs = 7;
      this.emit(this.tele('scout_swarm', 'COMPLETED', 'Scouts finished: 7 pages offloaded to AWS', 780, 0, 7));
    });
    this.later(1800, () => {
      this.emit(this.tele('synthesis', 'RUNNING', 'Reasoning model resolving cross-source conflicts', 950, 1, 7));
    });
    this.later(2800, () => {
      this.emit(this.tele('synthesis', 'COMPLETED', 'Synthesis ready: 1 contradiction found', 1240, 0, 7));
      this.emit(this.buildSynthesis(jobId, null, []));
    });
    this.later(3600, () => {
      this.emit(this.tele('gatekeeper', 'RUNNING', 'Cedar evaluating untrusted action from sanitized page', 60, 1, 7));
    });
    this.later(4000, () => {
      this.emit(this.tele('gatekeeper', 'BLOCKED', 'forbid_untrusted_mutating_action: awaiting signature', 75, 0, 7));
      this.emit(this.buildGate());
    });
  }

  private mockSteer(jobId: string, delta: string, cancelDomains: string[]): void {
    this.clearMockTimers();
    this.activeJobId = jobId || this.activeJobId;
    const tabs = this.mockTabs;
    this.emit(
      this.tele('scout_swarm', 'CANCELLED', `Barge-in: stale workers cancelled${cancelDomains.length ? ` (${cancelDomains.join(', ')})` : ''}`, 35, 0, tabs),
    );
    this.later(400, () => {
      this.mockTabs = tabs + 2;
      this.emit(this.tele('scout_swarm', 'RUNNING', `Re-dispatching scouts: ${delta}`, 180, 3, this.mockTabs));
    });
    this.later(1300, () => {
      this.mockTabs = tabs + 4;
      this.emit(this.tele('scout_swarm', 'COMPLETED', 'Refined scouting complete', 620, 0, this.mockTabs));
    });
    this.later(1500, () => {
      this.emit(this.tele('synthesis', 'RUNNING', 'Re-synthesizing with updated instruction', 700, 1, this.mockTabs));
    });
    this.later(2400, () => {
      this.emit(this.tele('synthesis', 'COMPLETED', 'Refined synthesis ready', 1010, 0, this.mockTabs));
      this.emit(this.buildSynthesis(this.activeJobId, delta, cancelDomains));
    });
  }

  private buildSynthesis(jobId: string, delta: string | null, cancelDomains: string[]): SynthesisUpdateMessage {
    const excluded = (url: string): boolean => cancelDomains.some((d) => d && url.includes(d));
    const dropSony = cancelDomains.some((d) => d.includes('sony')) || (delta !== null && /sony|xm5/i.test(delta));
    const multipoint = delta !== null && /multipoint/i.test(delta);

    const allItems: SynthesisItem[] = [
      {
        name: 'Model A',
        price: '₹22,990',
        pros: ['Strong ANC', 'Lightweight', 'Multipoint Bluetooth'],
        cons: ['Hinge cracks reported'],
        url: 'https://example.com/model-a',
      },
      {
        name: 'Model B',
        price: '₹24,500',
        pros: ['Excellent comfort', multipoint ? 'Multipoint Bluetooth (2 devices)' : 'Balanced sound'],
        cons: ['Average mic'],
        url: 'https://example.com/model-b',
      },
      {
        name: 'Sony WH-1000XM5',
        price: '₹24,990',
        pros: ['Class-leading ANC', 'Great call quality'],
        cons: ['Non-folding design', 'Hinge complaints on Reddit'],
        url: 'https://www.sony.co.in/headphones/wh-1000xm5',
      },
    ];
    let items = allItems.filter((i) => !excluded(i.url));
    if (dropSony) items = items.filter((i) => !/sony/i.test(i.name) && !/sony/i.test(i.url));
    if (multipoint) {
      items = [...items].sort(
        (a, b) =>
          Number(b.pros.some((p) => /multipoint/i.test(p))) - Number(a.pros.some((p) => /multipoint/i.test(p))),
      );
    }

    const quote = '30 hours of playback';
    const allCards: EvidenceCard[] = [
      {
        source_url: 'https://example.com/model-a',
        title: 'Model A Official Specs',
        sanitized_excerpt: `Engineered for long flights with ${quote} and adaptive noise cancellation. Supports multipoint Bluetooth pairing with two devices.`,
        quote_to_highlight: quote,
      },
      {
        source_url: 'https://reddit.com/r/headphones/comments/model_a_hinge',
        title: 'Reddit: Model A hinge cracked after 4 months',
        sanitized_excerpt:
          'Mine developed a hairline crack at the hinge after 4 months. Battery also averages 18-20 hours with ANC on, nowhere near the claimed figure.',
        quote_to_highlight: 'hairline crack at the hinge',
      },
      {
        source_url: 'https://www.sony.co.in/headphones/wh-1000xm5',
        title: 'Sony WH-1000XM5 Product Page',
        sanitized_excerpt: 'Industry-leading noise cancellation with up to 30 hours of battery life and multipoint connection.',
        quote_to_highlight: 'up to 30 hours of battery life',
      },
    ];
    let cards = allCards.filter((c) => !excluded(c.source_url));
    if (dropSony) cards = cards.filter((c) => !/sony/i.test(c.source_url));

    const contradictions: ContradictionItem[] = [
      {
        claim: '30-hour battery life',
        conflict: 'User benchmarks average 18-20 hours with ANC on',
        source_url: 'https://example.com/model-a',
        quote_to_highlight: quote,
      },
    ];

    const nodes: MindMapData['nodes'] = [
      { id: 'n1', label: 'ANC Headphones', source_url: '' },
      { id: 'n2', label: 'Model A Battery Conflict', source_url: 'https://example.com/model-a' },
      { id: 'n3', label: 'Model A Hinge Reports', source_url: 'https://reddit.com/r/headphones/comments/model_a_hinge' },
      { id: 'n4', label: 'Model B', source_url: 'https://example.com/model-b' },
    ];
    const edges: MindMapData['edges'] = [
      { from: 'n1', to: 'n2', label: 'contradicts' },
      { from: 'n1', to: 'n3', label: 'warns' },
      { from: 'n1', to: 'n4', label: 'alternative' },
    ];
    if (!dropSony) {
      nodes.push({ id: 'n5', label: 'Sony XM5', source_url: 'https://www.sony.co.in/headphones/wh-1000xm5' });
      edges.push({ from: 'n1', to: 'n5', label: 'candidate' });
    }
    const liveNodes = nodes.filter((n) => !excluded(n.source_url));
    const ids = new Set(liveNodes.map((n) => n.id));
    const liveEdges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));

    let voice_brief: string;
    if (delta === null) {
      voice_brief =
        'Two models look solid, but Model A has recent Reddit hinge complaints and its 30-hour battery claim is contradicted by user benchmarks. Want me to drop it?';
    } else {
      voice_brief = `Updated for "${delta}". ${dropSony ? 'Dropped Sony XM5. ' : ''}${
        multipoint ? 'Model A and Model B both support multipoint Bluetooth; ' : ''
      }Model B looks like the safest pick at ${items.find((i) => i.name === 'Model B')?.price ?? '₹24,500'}.`;
    }

    return {
      type: 'SYNTHESIS_UPDATE',
      job_id: jobId,
      voice_brief,
      items,
      evidence_cards: cards,
      contradictions,
      mind_map: { nodes: liveNodes, edges: liveEdges },
    };
  }

  private buildGate(): GatekeeperInterceptMessage {
    return {
      type: 'GATEKEEPER_INTERCEPT',
      gate_id: 'gate_99',
      decision: 'FORBID_UNTIL_SIGNED',
      cedar_rule: 'forbid_untrusted_mutating_action',
      action_type: 'FORM_SUBMIT',
      target_url: 'https://example.com/checkout',
      reason: 'Untrusted web content attempted to trigger a state-changing form submission.',
      action_diff: 'POST /checkout with user session',
    };
  }
}

export function createWsClient(url?: string, mock?: boolean): WsClient {
  return new WsClient(url, mock);
}
