import { createHash } from 'node:crypto';
import type { BridgeConfig } from './config.js';
import { buildTask, parseClaimedResult } from './prompt.js';
import { hash, readAssignment, type AssignmentPolicy } from './protocol.js';
import {
  RelayError,
  type BridgeLog,
  type NodePort,
  type RelayIdentity,
  type RelayMessage,
  type RelayPort,
  type SpawnReceipt,
} from './ports.js';
import type { BridgeStore, TaskRow } from './store.js';

const PAGE_SIZE = 100;
const MAX_BACKLOG = 1000;
/** Well inside Relaycast's 24-hour idempotency record, so a repeat cannot launch again. */
const INVOKE_REPLAY_WINDOW_MS = 3_600_000;
/** A launch can still be under way this long after the invoke, so not-found is not yet proof. */
const STOP_GRACE_MS = 600_000;

const short = (value: string, length: number) =>
  createHash('sha256').update(value).digest('hex').slice(0, length);

export interface BridgeDeps {
  config: BridgeConfig;
  store: BridgeStore;
  relay: RelayPort;
  node: NodePort;
  now?: () => number;
  log?: BridgeLog;
}

/**
 * The execution side of a chief assignment. It holds the worker's Relay identity, starts
 * one native spawn per task and owes the chief a report for every task it accepts.
 *
 * It holds no chief authority and runs no shell: all work happens in the spawned agent.
 */
export class ExecutionBridge {
  private readonly config: BridgeConfig;
  private readonly store: BridgeStore;
  private readonly relay: RelayPort;
  private readonly node: NodePort;
  private readonly now: () => number;
  private readonly log: BridgeLog;
  private readonly policy: AssignmentPolicy;
  private identity: RelayIdentity | undefined;

  constructor(deps: BridgeDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.relay = deps.relay;
    this.node = deps.node;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
    const { chief, repositories, actions, limits, maxEvidenceAgeMs } = deps.config;
    this.policy = {
      chiefAgentId: chief.agentId,
      chiefId: chief.chiefId,
      organizationId: chief.organizationId,
      projectId: chief.projectId,
      repositories: Object.keys(repositories),
      actions,
      maxReservationMicros: limits.maxReservationMicros,
      maxEvidenceAgeMs,
    };
  }

  /** Refuses to run unless the token, ledger and node all match the configuration. */
  async start(): Promise<void> {
    const identity = await this.relay.identity();
    const { worker, workspaceId, chief, harness, node } = this.config;
    if (identity.agentId !== worker.agentId || identity.workspaceId !== workspaceId) {
      throw new Error('bridge_refused:identity_mismatch');
    }
    if (identity.address !== undefined && identity.address !== worker.address) {
      throw new Error('bridge_refused:address_mismatch');
    }
    this.store.pinBinding({ workerAgentId: worker.agentId, workspaceId, chiefAgentId: chief.agentId, chiefId: chief.chiefId, node: node.id });
    const refusal = await this.node.preflight(harness, node);
    if (refusal) throw new Error(`bridge_refused:${refusal}`);
    this.identity = identity;
    this.log('bridge_started');
  }

  /** One pass. A Relay failure ends only its own phase; a storage failure propagates. */
  async tick(): Promise<void> {
    for (const phase of [this.ingest, this.advance, this.stopFinished, this.flushReports]) {
      try {
        await phase.call(this);
      } catch (error) {
        if (!(error instanceof RelayError)) throw error;
        this.log('relay_unavailable', { code: error.code, phase: phase.name });
      }
    }
  }

  private requireIdentity(): RelayIdentity {
    if (!this.identity) throw new Error('bridge_not_started');
    return this.identity;
  }

  private async ingest(): Promise<void> {
    const identity = this.requireIdentity();
    const direct = (await this.relay.conversations()).filter(
      (c) => c.type === '1:1' && c.participants.includes(identity.agentId)
    );
    const chief = direct.find((c) => c.participants.includes(this.config.chief.agentId));
    if (chief) this.store.pinChiefConversation(chief.id);
    // The listing is capped and newest-first, and every spawn adds a conversation, so
    // the chief's would age out of it. Its pinned ID is always read.
    const ids = new Set(direct.map((c) => c.id));
    const pinned = this.store.chiefConversation();
    if (pinned) ids.add(pinned);
    for (const id of ids) {
      const messages = await this.readNewMessages(id, this.store.cursor(id));
      for (const message of messages) {
        this.onMessage(message, identity);
        // Only after the message's effects are durable.
        this.store.advanceCursor(id, message.id);
      }
    }
  }

  private async readNewMessages(conversationId: string, cursor: string | undefined): Promise<RelayMessage[]> {
    const messages: RelayMessage[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.relay.messages(conversationId, { after: cursor, before, limit: PAGE_SIZE });
      messages.push(...page);
      if (messages.length > MAX_BACKLOG) throw new RelayError('relay_backlog_limit', true);
      if (page.length < PAGE_SIZE) break;
      const oldest = page.map((m) => m.id).sort()[0];
      if (!oldest || oldest === before) throw new RelayError('relay_page_invalid', true);
      before = oldest;
    }
    return messages.sort((a, b) => a.id.localeCompare(b.id));
  }

  private onMessage(message: RelayMessage, identity: RelayIdentity): void {
    if (message.agentId === identity.agentId) return;
    const metadata = message.metadata ?? {};
    if ('chief_assignment' in metadata || 'assignment_digest' in metadata) {
      this.onAssignment(message, metadata, identity);
      return;
    }
    this.onAgentMessage(message);
    // Any other DM is ignored. Only a validated assignment ever reaches a native spawn.
  }

  private onAssignment(message: RelayMessage, metadata: Record<string, unknown>, identity: RelayIdentity): void {
    const now = this.now();
    let read: ReturnType<typeof readAssignment>;
    try {
      read = readAssignment(
        {
          workspaceId: identity.workspaceId,
          senderAgentId: message.agentId,
          recipientAgentId: identity.agentId,
          recipientAddress: this.config.worker.address,
        },
        metadata,
        this.policy,
        now
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('worker_assignment_')) throw error;
      this.store.quarantine(message.id, error.message, metadata, message.agentId, now);
      this.log('assignment_refused', { code: error.message });
      return;
    }
    const { assignment, digest } = read;
    const outcome = this.store.claim({
      assignment,
      digest,
      agentName: `chief-${short(`${assignment.taskId}|${digest}`, 24)}`,
      invocationKey: `chief-spawn-${short(`${assignment.taskId}|${digest}`, 40)}`,
      budgetMicros: this.config.limits.budgetMicros,
      now,
    });
    if (outcome === 'conflict') {
      this.store.quarantine(message.id, 'task_digest_conflict', metadata, message.agentId, now);
    }
    this.log('assignment_received', { taskId: assignment.taskId, outcome });
  }

  private onAgentMessage(message: RelayMessage): void {
    const task = this.store.taskForAgent(message.agentName);
    if (!task) return;
    if (task.boundAgentId && task.boundAgentId !== message.agentId) {
      this.log('session_binding_mismatch', { taskId: task.taskId });
      return;
    }
    this.store.bindAgent(task.taskId, message.agentId);
    // The text is model-authored: it selects the report state and nothing else.
    const claimed = parseClaimedResult(message.text);
    if (claimed) this.store.setPendingResult(task.taskId, claimed);
  }

  private async advance(): Promise<void> {
    const now = this.now();
    const { maxQueuedMs, maxRuntimeMs, maxConcurrent } = this.config.limits;
    const tasks = this.store.activeTasks();
    const queued: TaskRow[] = [];
    for (const task of tasks) {
      if (task.state === 'queued') {
        if (now - task.createdAt > maxQueuedMs) this.fail(task, 'queue_timeout');
        else queued.push(task);
        continue;
      }
      await this.advanceStarted(task, now, maxRuntimeMs);
    }
    const running = this.store.activeTasks().filter((t) => t.state !== 'queued');
    const busy = new Set(running.map((t) => t.repository));
    let active = running.length;
    let checked = false;
    for (const task of queued) {
      if (active >= maxConcurrent) break;
      if (busy.has(task.repository)) continue;
      if (!checked) {
        const refusal = await this.node.preflight(this.config.harness, this.config.node);
        if (refusal) {
          this.log('node_not_ready', { code: refusal });
          return;
        }
        checked = true;
      }
      if (!this.store.markInvoking(task.taskId, now)) continue;
      active += 1;
      busy.add(task.repository);
      await this.invoke({ ...task, state: 'invoking', invokingAt: now });
    }
  }

  private async advanceStarted(task: TaskRow, now: number, maxRuntimeMs: number): Promise<void> {
    const startedAt = task.invokingAt ?? task.createdAt;
    if (task.state === 'running' && task.pendingResult) {
      this.finishClaimed(task);
      return;
    }
    if (now - startedAt > maxRuntimeMs) {
      this.fail(task, 'runtime_exceeded');
      return;
    }
    if (task.state === 'invoking') {
      // Only a crash or an unknown outcome leaves this state. The same key cannot launch twice
      // while Relaycast still holds it; beyond that the outcome is unknown and is not retried.
      if (now - startedAt >= INVOKE_REPLAY_WINDOW_MS) this.fail(task, 'execution_outcome_unknown');
      else await this.invoke(task);
      return;
    }
    if (task.state === 'launched' && task.invocationId) {
      this.applyReceipt(task, await this.relay.invocation(task.invocationId), now);
    }
  }

  private async invoke(task: TaskRow): Promise<void> {
    const directory = this.config.repositories[task.repository];
    const prompt = buildTask(task.assignment, task.digest);
    if (!directory || !prompt) {
      this.fail(task, directory ? 'task_too_large' : 'repository_not_configured');
      return;
    }
    let receipt: SpawnReceipt;
    try {
      receipt = await this.relay.invokeSpawn({
        name: task.agentName,
        harness: this.config.harness,
        task: prompt,
        targetNodeName: this.config.node.name,
        directory,
        idempotencyKey: task.invocationKey,
      });
    } catch (error) {
      if (!(error instanceof RelayError)) throw error;
      this.log('spawn_invoke_failed', { taskId: task.taskId, code: error.code });
      if (!error.retryable) this.fail(task, 'spawn_refused');
      return;
    }
    this.store.markLaunched(task.taskId, receipt.id);
    this.applyReceipt({ ...task, state: 'launched', invocationId: receipt.id }, receipt, this.now());
  }

  /** Native receipts report the launch only. Task completion comes from the bound agent. */
  private applyReceipt(task: TaskRow, receipt: SpawnReceipt, now: number): void {
    if (receipt.id !== task.invocationId) {
      this.fail(task, 'session_binding_mismatch');
      return;
    }
    if (receipt.status === 'failed') {
      this.fail(task, 'spawn_failed');
      return;
    }
    if (receipt.status !== 'completed') return;
    if (!receipt.spawned || !receipt.ready) {
      this.fail(task, 'spawn_not_ready');
      return;
    }
    if (receipt.name !== task.agentName || receipt.nodeId !== this.config.node.id) {
      this.fail(task, 'session_binding_mismatch');
      return;
    }
    if (receipt.taskUnconfirmed) this.log('spawn_task_unconfirmed', { taskId: task.taskId });
    this.store.markRunning(task.taskId, now);
    const current = this.store.task(task.taskId);
    if (current?.state === 'running' && current.pendingResult) this.finishClaimed(current);
  }

  private finishClaimed(task: TaskRow): void {
    const state = task.pendingResult === 'completed' ? 'completed' : 'failed';
    this.store.finish(task.taskId, state, state === 'failed' ? 'agent_reported_failure' : undefined, this.now());
    this.log('task_finished', { taskId: task.taskId, state });
  }

  private fail(task: TaskRow, reason: string): void {
    this.store.finish(task.taskId, 'failed', reason, this.now());
    this.log('task_finished', { taskId: task.taskId, state: 'failed', reason });
  }

  /** Ends every spawned agent whose task is over, so a finished task holds no capacity. */
  private async stopFinished(): Promise<void> {
    const now = this.now();
    for (const task of this.store.stopPending()) {
      let outcome: Awaited<ReturnType<NodePort['endAgent']>>;
      try {
        outcome = await this.node.endAgent(task.agentName);
      } catch {
        this.log('agent_stop_failed', { taskId: task.taskId });
        continue;
      }
      if (outcome === 'refused') this.log('agent_stop_refused', { taskId: task.taskId });
      const launchSettled = task.runningAt !== undefined || now - (task.invokingAt ?? now) > STOP_GRACE_MS;
      if (outcome !== 'not_found' || launchSettled) this.store.clearStop(task.taskId);
    }
  }

  /** At-least-once and in order per task. The chief treats an identical repeat as a no-op. */
  private async flushReports(): Promise<void> {
    const now = this.now();
    // Each pass sends the lowest unsent report per task, so a delivered report frees the next.
    for (let delivered = true; delivered; ) {
      delivered = false;
      for (const { report, attempts } of this.store.dueReports(now)) {
        try {
          await this.relay.sendReport({
            address: this.config.chief.address,
            text: `Worker ${report.state}`,
            data: { chief_report: report },
            idempotencyKey: `chief-report-${short(`${report.taskId}|${report.sequence}|${hash(report)}`, 40)}`,
          });
          this.store.markReportSent(report.taskId, report.sequence);
          delivered = true;
        } catch (error) {
          if (!(error instanceof RelayError)) throw error;
          this.store.markReportRetry(report.taskId, report.sequence, attempts, now);
          this.log('report_retry', { taskId: report.taskId, sequence: report.sequence, code: error.code });
        }
      }
    }
  }
}
