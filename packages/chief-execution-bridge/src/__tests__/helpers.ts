import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionBridge } from '../bridge.js';
import { configSchema, relayWorkspaceOf, type BridgeConfig } from '../config.js';
import {
  RelayError,
  type NodePort,
  type RelayConversation,
  type RelayIdentity,
  type RelayMessage,
  type RelayPort,
  type SendReport,
  type SpawnReceipt,
  type SpawnRequest,
} from '../ports.js';
import { hash, type Assignment, type WorkerReport } from '../protocol.js';
import { BridgeStore } from '../store.js';

export const T0 = 1_800_000_000_000;
export const CHIEF = 'agent-chief';
export const WORKER = 'agent-worker';

/** The fields a fixture can vary without desynchronising its evidence and digests. */
type AssignmentOverrides = Partial<
  Pick<Assignment, 'taskId' | 'repository' | 'acceptance' | 'reservationMicros' | 'action' | 'workspaceId'>
> & { summary?: string };

export function makeAssignment(overrides: AssignmentOverrides = {}): {
  assignment: Assignment;
  digest: string;
} {
  const { summary, ...fields } = overrides;
  const taskId = fields.taskId ?? 'task-1';
  const repository = fields.repository ?? 'acme/app';
  const workspaceId = fields.workspaceId ?? 'ws-1';
  const evidence = {
    sourceId: 'source',
    sessionId: 'session',
    version: 'v1',
    organizationId: 'org-1',
    workspaceId,
    projectId: 'project-1',
    repository,
    workKey: 'work-1',
    resourceKeys: ['res-1'],
    observedAt: T0,
    summary: summary ?? 'Fix the failing test',
    references: [],
  };
  const assignment: Assignment = {
    protocol: 'relay-chief.assignment.v1',
    taskId,
    chiefId: 'chief-1',
    organizationId: 'org-1',
    workspaceId: 'ws-1',
    projectId: 'project-1',
    repository,
    workKey: 'work-1',
    resourceKeys: ['res-1'],
    action: 'investigate',
    worker: { agentId: WORKER, address: 'worker@node', actions: ['investigate'] },
    policyVersion: 'p1',
    configurationRevision: 1,
    policyDigest: 'a'.repeat(64),
    reservationMicros: 1000,
    evidenceDigest: hash(evidence),
    evidence,
    acceptance: ['The test passes'],
    ...fields,
  };
  return { assignment, digest: hash(assignment) };
}

/** In-memory Relay. Nothing here reaches a network. */
export class FakeRelay implements RelayPort {
  identityValue: RelayIdentity = { agentId: WORKER, workspaceId: 'ws-1', address: 'worker@node' };
  private seq = 1_000_000_000_000_000_000n;
  private readonly conversationsById = new Map<string, { peer: string; messages: RelayMessage[] }>();
  /** Report keys in send order, one per attempt that reached Relay. */
  readonly reportAttempts: SendReport[] = [];
  readonly delivered = new Map<string, WorkerReport>();
  readonly spawns: SpawnRequest[] = [];
  readonly invocations = new Map<string, SpawnReceipt>();
  failNextReports = 0;
  /** Delivered, but the sender is told the outcome is unknown. */
  loseNextReportResponse = false;
  invokeFailure: RelayError | undefined;
  loseNextInvokeResponse = false;
  spawnOutcome: Partial<SpawnReceipt> = {};
  conversationListLimit = 100;
  invokeCalls = 0;
  readConversations: string[] = [];
  unavailableConversations = new Set<string>();
  unavailableInvocations = new Set<string>();
  reportLastMessage = false;
  extraConversations: RelayConversation[] = [];

  async identity(): Promise<RelayIdentity> {
    return this.identityValue;
  }

  private nextId(): string {
    this.seq += 1n;
    return String(this.seq);
  }

  deliver(
    peer: string,
    peerName: string,
    text: string,
    metadata?: Record<string, unknown>,
    sentAt?: number
  ): string {
    const conversationId = `dm-${peer}`;
    const conversation = this.conversationsById.get(conversationId) ?? { peer, messages: [] };
    this.conversationsById.set(conversationId, conversation);
    const id = this.nextId();
    conversation.messages.push({ id, agentId: peer, agentName: peerName, text, metadata, sentAt });
    return id;
  }

  deliverAssignment(
    assignment: Assignment,
    digest: string,
    from = CHIEF,
    metadataOverride?: Record<string, unknown>
  ): string {
    return this.deliver(from, from === CHIEF ? 'chief' : from, 'assignment', {
      chief_assignment: assignment,
      assignment_digest: digest,
      ...metadataOverride,
    });
  }

  /** Re-delivers the most recent message from `peer` under a new message ID. */
  replayLast(peer: string): void {
    const conversation = this.conversationsById.get(`dm-${peer}`);
    const last = conversation?.messages.at(-1);
    if (!conversation || !last) throw new Error('nothing to replay');
    conversation.messages.push({ ...last, id: this.nextId() });
  }

  async conversations(): Promise<RelayConversation[]> {
    const real = [...this.conversationsById.entries()].map(([id, c]): RelayConversation => ({
      id,
      type: '1:1',
      participants: [WORKER, c.peer],
      ...(this.reportLastMessage ? { lastMessageId: c.messages.at(-1)?.id } : {}),
    }));
    // Newest first, as Relaycast lists them.
    return [...this.extraConversations, ...real.reverse()].slice(0, this.conversationListLimit);
  }

  async messages(
    conversationId: string,
    page: { after?: string; before?: string; limit: number }
  ): Promise<RelayMessage[]> {
    this.readConversations.push(conversationId);
    if (this.unavailableConversations.has(conversationId)) throw new RelayError('relay_http_503', true);
    const all = this.conversationsById.get(conversationId)?.messages ?? [];
    return all
      .filter((m) => (!page.after || m.id > page.after) && (!page.before || m.id < page.before))
      .slice(-page.limit);
  }

  async sendReport(report: SendReport): Promise<void> {
    this.reportAttempts.push(report);
    if (this.failNextReports > 0) {
      this.failNextReports -= 1;
      throw new RelayError('relay_http_503', true);
    }
    const body = report.data.chief_report as WorkerReport;
    this.delivered.set(report.idempotencyKey, body);
    if (this.loseNextReportResponse) {
      this.loseNextReportResponse = false;
      throw new RelayError('relay_transport_failed', true);
    }
  }

  deliveredReports(): WorkerReport[] {
    return [...this.delivered.values()];
  }

  states(taskId = 'task-1'): string[] {
    return this.deliveredReports()
      .filter((r) => r.taskId === taskId)
      .map((r) => `${r.sequence}:${r.state}`);
  }

  async invokeSpawn(request: SpawnRequest): Promise<SpawnReceipt> {
    this.invokeCalls += 1;
    if (this.invokeFailure) throw this.invokeFailure;
    const existing = [...this.invocations.values()].find((r) => r.id === `inv-${request.idempotencyKey}`);
    if (!existing) this.spawns.push(request);
    const receipt: SpawnReceipt = existing ?? {
      id: `inv-${request.idempotencyKey}`,
      status: 'completed',
      nodeId: 'node-1',
      name: request.name,
      spawned: true,
      ready: true,
      taskUnconfirmed: false,
      ...this.spawnOutcome,
    };
    this.invocations.set(receipt.id, receipt);
    if (this.loseNextInvokeResponse) {
      this.loseNextInvokeResponse = false;
      throw new RelayError('relay_transport_failed', true);
    }
    return receipt;
  }

  async invocation(id: string): Promise<SpawnReceipt> {
    if (this.unavailableInvocations.has(id)) throw new RelayError('relay_http_503', true);
    const receipt = this.invocations.get(id);
    if (!receipt) throw new RelayError('relay_http_404', false);
    return receipt;
  }
}

export class FakeNode implements NodePort {
  refusal: string | undefined;
  /** When set, decides each preflight in turn instead of `refusal`. */
  onPreflight: (() => string | undefined) | undefined;
  /** Agents actually stopped. */
  readonly ended: string[] = [];
  /** Every stop asked of the node, whatever its outcome. */
  readonly endAttempts: string[] = [];
  endOutcome: 'ended' | 'not_found' | 'refused' = 'ended';
  endThrows = false;

  async preflight(): Promise<string | undefined> {
    return this.onPreflight ? this.onPreflight() : this.refusal;
  }

  async endAgent(name: string): Promise<'ended' | 'not_found' | 'refused'> {
    if (this.endThrows) throw new Error('core_unavailable');
    this.endAttempts.push(name);
    if (this.endOutcome === 'ended') this.ended.push(name);
    return this.endOutcome;
  }
}

export function makeConfig(overrides: Record<string, unknown> = {}): BridgeConfig {
  return configSchema.parse({
    relayOrigin: 'https://relay.example',
    workspaceId: 'ws-1',
    worker: { agentId: WORKER, address: 'worker@node' },
    chief: {
      agentId: CHIEF,
      address: 'chief@host',
      chiefId: 'chief-1',
      organizationId: 'org-1',
      projectId: 'project-1',
    },
    repositories: { 'acme/app': '/srv/work/app', 'acme/other': '/srv/work/other' },
    actions: ['investigate', 'coordinate', 'unblock'],
    maxEvidenceAgeMs: 3_600_000,
    harness: 'claude',
    node: { id: 'node-1', name: 'node-one' },
    isolation: { dedicatedNode: true, scrubbedEnvironment: true },
    limits: {
      maxConcurrent: 2,
      maxReservationMicros: 5000,
      budgetMicros: 100_000,
      maxRuntimeMs: 1_800_000,
      maxQueuedMs: 900_000,
    },
    ledgerPath: '/tmp/unused.db',
    ...overrides,
  });
}

export interface Harness {
  relay: FakeRelay;
  node: FakeNode;
  store: BridgeStore;
  bridge: ExecutionBridge;
  clock: { now: number };
  path: string;
  reopen(): Promise<void>;
  logs: Array<{ event: string; fields?: Record<string, string | number> }>;
}

export async function makeHarness(configOverrides: Record<string, unknown> = {}): Promise<Harness> {
  const path = join(mkdtempSync(join(tmpdir(), 'chief-bridge-')), 'ledger.db');
  const relay = new FakeRelay();
  const node = new FakeNode();
  const clock = { now: T0 + 1000 };
  const logs: Harness['logs'] = [];
  const config = makeConfig(configOverrides);
  relay.identityValue.workspaceId = relayWorkspaceOf(config);
  const build = (store: BridgeStore) =>
    new ExecutionBridge({
      config,
      store,
      relay,
      node,
      now: () => clock.now,
      log: (event, fields) => logs.push({ event, fields }),
    });
  const store = new BridgeStore(path);
  const harness: Harness = {
    relay,
    node,
    store,
    bridge: build(store),
    clock,
    path,
    logs,
    async reopen() {
      harness.store.close();
      harness.store = new BridgeStore(path);
      harness.bridge = build(harness.store);
      await harness.bridge.start();
    },
  };
  await harness.bridge.start();
  return harness;
}

export function agentNameOf(h: Harness, taskId = 'task-1'): string {
  const task = h.store.task(taskId);
  if (!task) throw new Error('no task');
  return task.agentName;
}
