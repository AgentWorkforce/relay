import { createAgentActivityState, reduceAgentActivity } from '@agent-relay/sdk';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  AgentIdentity,
  AgentActivityState,
  AgentObservabilityCapabilities,
  AgentSession,
  AgentSessionCapabilities,
  AgentSessionEvent,
  MessageContext,
  MessageReceipt,
  RelayMessage,
} from '@agent-relay/sdk';
import type { HarnessV1Diagnostic } from '@ai-sdk/harness';
import { HarnessHost, type NormalizedHarnessEvent } from './harness-host.js';

export interface RelayHarnessSessionOptions {
  identity: AgentIdentity;
  host: HarnessHost;
  maxQueueSize?: number;
  maxDedupeEntries?: number;
  /** Durable queue used for on-idle messages accepted by a native sidecar. */
  deferredQueuePath?: string;
}

interface QueuedMessage {
  message: RelayMessage;
  context: MessageContext;
  key: string;
  state: 'queued';
  order: number;
}

interface DeliveryTombstone {
  key: string;
  deliveryId: string;
  messageId: string;
  state: 'in_doubt' | 'accepted';
}

type DurableDeliveryEntry = QueuedMessage | DeliveryTombstone;

function durableEntryId(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function senderName(message: RelayMessage): string {
  return message.from.name?.trim() || message.from.id?.trim() || 'unknown sender';
}

function relayReplyInstruction(message: RelayMessage): string {
  const sender = senderName(message);
  if (message.threadId) {
    return `Reply through Agent Relay by calling reply_to_thread with message_id ${JSON.stringify(message.threadId)}. Do not only print the reply in your terminal.`;
  }
  if (message.target?.kind === 'channel') {
    return `Reply through Agent Relay by calling post_message with channel ${JSON.stringify(message.target.channelName)}. Do not only print the reply in your terminal.`;
  }
  return `Reply through Agent Relay by calling send_dm with to ${JSON.stringify(sender)}. Do not only print the reply in your terminal.`;
}

export function formatInboundRelayPrompt(message: RelayMessage): string {
  const metadata = {
    from: senderName(message),
    kind: message.kind ?? 'unknown',
    target: message.target,
    messageId: message.id,
    threadId: message.threadId,
    text: message.text,
  };
  const encoded = JSON.stringify(metadata).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
  return `<agent-relay-message-json>\n${encoded}\n</agent-relay-message-json>\n\n${relayReplyInstruction(message)}`;
}

const EXACT = { available: true, fidelities: ['exact'] } as const;

export const AI_SDK_OBSERVABILITY_CAPABILITIES: AgentObservabilityCapabilities = {
  activities: {
    starting: EXACT,
    thinking: { available: true, fidelities: ['exact', 'inferred'] },
    typing: EXACT,
    using_tool: EXACT,
    waiting: EXACT,
    idle: EXACT,
    error: EXACT,
  },
  events: {
    lifecycle: EXACT,
    turns: EXACT,
    text: EXACT,
    reasoning: EXACT,
    tools: EXACT,
    tool_approvals: EXACT,
    files: EXACT,
    compaction: EXACT,
    model: EXACT,
    warnings: EXACT,
    usage: EXACT,
    diagnostics: EXACT,
    errors: EXACT,
  },
};

const AI_SDK_EVENT_TYPES: AgentSessionEvent['type'][] = [
  'activity.changed',
  'observability.capabilities',
  'message.received',
  'delivery.accepted',
  'delivery.failed',
  'session.starting',
  'session.started',
  'session.resumed',
  'session.suspended',
  'session.detached',
  'session.stopped',
  'session.destroyed',
  'session.failed',
  'turn.started',
  'step.finished',
  'turn.finished',
  'turn.settled',
  'text.started',
  'text.delta',
  'text.finished',
  'reasoning.started',
  'reasoning.delta',
  'reasoning.finished',
  'tool.called',
  'tool.completed',
  'tool.failed',
  'tool.approval.requested',
  'tool.approval.resolved',
  'file.changed',
  'context.compacted',
  'model.resolved',
  'warning',
  'usage.updated',
  'diagnostic',
  'error',
];

function finishReason(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const reason = value as { raw?: unknown; unified?: unknown };
    if (typeof reason.raw === 'string') return reason.raw;
    if (typeof reason.unified === 'string') return reason.unified;
  }
  return 'unknown';
}

function scalarUsage(value: unknown): Record<string, number | string | boolean | null> {
  if (!value || typeof value !== 'object') return {};
  const usage = value as {
    inputTokens?: { total?: number; noCache?: number; cacheRead?: number; cacheWrite?: number };
    outputTokens?: { total?: number; text?: number; reasoning?: number };
  };
  return {
    inputTokens: usage.inputTokens?.total ?? null,
    inputNoCacheTokens: usage.inputTokens?.noCache ?? null,
    inputCacheReadTokens: usage.inputTokens?.cacheRead ?? null,
    inputCacheWriteTokens: usage.inputTokens?.cacheWrite ?? null,
    outputTokens: usage.outputTokens?.total ?? null,
    outputTextTokens: usage.outputTokens?.text ?? null,
    outputReasoningTokens: usage.outputTokens?.reasoning ?? null,
  };
}

function warningMessage(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value);
  const warning = value as { message?: unknown; details?: unknown; setting?: unknown; tool?: unknown };
  if (typeof warning.message === 'string') return warning.message;
  if (typeof warning.details === 'string') return warning.details;
  if (typeof warning.setting === 'string') return `Unsupported setting: ${warning.setting}`;
  if (typeof warning.tool === 'string') return `Unsupported tool: ${warning.tool}`;
  return JSON.stringify(value);
}

function diagnosticEvent(value: unknown): {
  type: 'diagnostic';
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  subsystem?: string;
  data?: Record<string, unknown>;
} {
  const diagnostic = (value ?? {}) as HarnessV1Diagnostic;
  return {
    type: 'diagnostic',
    level: diagnostic.level === 'trace' ? 'debug' : diagnostic.level,
    message:
      'message' in diagnostic && typeof diagnostic.message === 'string'
        ? diagnostic.message
        : JSON.stringify(diagnostic),
    subsystem: diagnostic.subsystem,
    data: diagnostic as unknown as Record<string, unknown>,
  };
}

export function toAgentSessionEvent(event: NormalizedHarnessEvent): AgentSessionEvent | undefined {
  const { observability } = event;
  const canonical = { observability };
  switch (event.type) {
    case 'session.starting':
    case 'session.detached':
    case 'session.stopped':
    case 'session.destroyed':
      return { type: event.type, ...canonical };
    case 'session.started':
    case 'session.resumed':
      return { type: event.type, observability };
    case 'session.suspended':
      return { type: event.type, reason: 'turn_suspended', ...canonical };
    case 'session.failed':
      return { type: event.type, error: String(event.error), ...canonical };
    case 'turn.started':
    case 'turn.settled':
      return { type: event.type, turnId: String(event.turnId), ...canonical };
    case 'turn.finished':
      return {
        type: event.type,
        turnId: String(event.turnId),
        finishReason: finishReason(event.finishReason),
        ...canonical,
      };
    case 'step.finished':
      return {
        type: event.type,
        turnId: String(event.turnId ?? observability.turnId),
        finishReason: finishReason(event.finishReason),
        usage: scalarUsage(event.usage),
        ...canonical,
      };
    case 'text.started':
    case 'text.finished':
    case 'reasoning.started':
    case 'reasoning.finished':
      return { type: event.type, blockId: String(event.blockId), ...canonical };
    case 'text.delta':
    case 'reasoning.delta':
      return {
        type: event.type,
        blockId: String(event.blockId),
        delta: String(event.delta),
        ...canonical,
      };
    case 'tool.called':
      return {
        type: event.type,
        callId: String(event.callId),
        tool: String(event.tool),
        input: event.input,
        ...canonical,
      };
    case 'tool.completed':
      return {
        type: event.type,
        callId: String(event.callId),
        tool: String(event.tool),
        output: event.output,
        ...canonical,
      };
    case 'tool.failed':
      return {
        type: event.type,
        callId: String(event.callId),
        tool: String(event.tool),
        error: String(event.error),
        ...canonical,
      };
    case 'tool.approval.requested':
      return {
        type: event.type,
        approvalId: String(event.approvalId),
        callId: event.callId === undefined ? undefined : String(event.callId),
        ...canonical,
      };
    case 'tool.approval.resolved':
      return {
        type: event.type,
        approvalId: String(event.approvalId),
        approved: Boolean(event.approved),
        reason: event.reason === undefined ? undefined : String(event.reason),
        ...canonical,
      };
    case 'file.changed':
      return {
        type: event.type,
        path: String(event.path),
        operation: event.operation as 'create' | 'modify' | 'delete',
        ...canonical,
      };
    case 'context.compacted':
      return {
        type: event.type,
        trigger: event.trigger === 'manual' ? 'manual' : 'automatic',
        beforeTokens: event.tokensBefore as number | undefined,
        afterTokens: event.tokensAfter as number | undefined,
        ...canonical,
      };
    case 'model.resolved':
      return { type: event.type, model: String(event.modelId), ...canonical };
    case 'warning':
      return { type: event.type, message: warningMessage(event.warning), ...canonical };
    case 'usage.updated':
      return { type: event.type, usage: scalarUsage(event.usage), ...canonical };
    case 'diagnostic': {
      const mapped = diagnosticEvent(event.diagnostic);
      return { ...mapped, observability };
    }
    case 'error':
      return { type: event.type, error: String(event.error), observability };
    default:
      return undefined;
  }
}

export class RelayHarnessSession implements AgentSession {
  readonly identity: AgentIdentity;
  readonly capabilities: AgentSessionCapabilities;
  readonly host: HarnessHost;
  readonly #maxQueueSize: number;
  readonly #maxDedupeEntries: number;
  readonly #deferredQueuePath?: string;
  readonly #queue: QueuedMessage[] = [];
  readonly #receipts = new Map<string, MessageReceipt>();
  readonly #listeners = new Set<(event: AgentSessionEvent) => void | Promise<void>>();
  #operation = Promise.resolve();
  #nextQueueOrder = 0;
  #released = false;
  #releaseCompleted = false;
  #hostDestroyed = false;
  #releaseEmitted = false;
  #drainRetry?: ReturnType<typeof setTimeout>;
  #drainRetryDelayMs = 100;
  #activity: AgentActivityState = createAgentActivityState();

  constructor(options: RelayHarnessSessionOptions) {
    this.identity = options.identity;
    this.host = options.host;
    this.#maxQueueSize = options.maxQueueSize ?? 100;
    this.#maxDedupeEntries = options.maxDedupeEntries ?? 10_000;
    this.#deferredQueuePath = options.deferredQueuePath;
    this.capabilities = {
      messaging: { receive: true },
      delivery: {
        modes: ['immediate', 'next-message', 'next-tool-call', 'on-idle'],
        queue: true,
      },
      events: { emits: AI_SDK_EVENT_TYPES },
      lifecycle: { release: true },
      observability: AI_SDK_OBSERVABILITY_CAPABILITIES,
    };
    this.host.onEvent(async (event) => {
      const mapped = toAgentSessionEvent(event);
      if (mapped) {
        const reduction = reduceAgentActivity(this.#activity, mapped);
        this.#activity = reduction.state;
        await this.#emit(mapped);
        if (reduction.transition) await this.#emit(reduction.transition);
      }
      if (event.type === 'turn.settled') await this.#serialized(() => this.#drain());
    });
  }

  onEvent(listener: (event: AgentSessionEvent) => void | Promise<void>): () => void {
    this.#listeners.add(listener);
    listener({
      type: 'observability.capabilities',
      capabilities: AI_SDK_OBSERVABILITY_CAPABILITIES,
      observability: {
        source: 'ai-sdk',
        fidelity: 'exact',
        sequence: 0,
        timestamp: new Date().toISOString(),
      },
    });
    return () => this.#listeners.delete(listener);
  }

  async #emit(event: AgentSessionEvent): Promise<void> {
    await Promise.allSettled(
      [...this.#listeners].map((listener) => listener({ ...event, agent: this.identity }))
    );
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  #remember(key: string, receipt: MessageReceipt): MessageReceipt {
    this.#receipts.set(key, receipt);
    while (this.#receipts.size > this.#maxDedupeEntries) {
      const oldest = this.#receipts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#receipts.delete(oldest);
    }
    return receipt;
  }

  #scheduleDrainRetry(): void {
    if (this.#released || this.#drainRetry) return;
    const delay = this.#drainRetryDelayMs;
    this.#drainRetryDelayMs = Math.min(delay * 2, 5_000);
    this.#drainRetry = setTimeout(() => {
      this.#drainRetry = undefined;
      void this.#serialized(() => this.#drain()).catch(() => undefined);
    }, delay);
    this.#drainRetry.unref?.();
  }

  #resetDrainRetry(): void {
    if (this.#drainRetry) clearTimeout(this.#drainRetry);
    this.#drainRetry = undefined;
    this.#drainRetryDelayMs = 100;
  }

  #durableReceipt(entry: DurableDeliveryEntry): MessageReceipt {
    if (entry.state === 'queued') {
      return {
        status: 'deferred',
        deliveryId: entry.context.id,
        availableAt: new Date(Date.now() + 100).toISOString(),
        reason: 'queued_until_idle',
        metadata: { queued: true, restored: true },
      };
    }
    if (entry.state === 'accepted') {
      return {
        status: 'accepted',
        deliveryId: entry.deliveryId,
        metadata: { restored: true },
      };
    }
    return {
      status: 'failed',
      deliveryId: entry.deliveryId,
      reason: 'Deferred delivery was in progress when the native sidecar stopped',
      retryable: false,
    };
  }

  #entryDirectory(state: DurableDeliveryEntry['state']): string | undefined {
    if (!this.#deferredQueuePath) return undefined;
    return resolve(this.#deferredQueuePath, state === 'queued' ? 'queue' : 'receipts');
  }

  #entryPath(key: string, state: DurableDeliveryEntry['state']): string | undefined {
    const directory = this.#entryDirectory(state);
    return directory ? resolve(directory, `${durableEntryId(key)}.json`) : undefined;
  }

  async #syncEntryDirectories(directory: string): Promise<void> {
    if (!this.#deferredQueuePath || process.platform === 'win32') return;
    const parent = dirname(this.#deferredQueuePath);
    // The sidecar path is runtimeRoot/deferred-relay/<session hash>. Syncing
    // every newly-created directory level makes a first-use persist durable as
    // well as the entry rename itself.
    for (const path of [directory, this.#deferredQueuePath, parent, dirname(parent)]) {
      const directory = await open(path, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  }

  async #persistEntry(entry: DurableDeliveryEntry): Promise<void> {
    const directory = this.#entryDirectory(entry.state);
    const destination = this.#entryPath(entry.key, entry.state);
    if (!directory || !destination || !this.#deferredQueuePath) return;
    await mkdir(directory, { recursive: true });
    const temporaryDirectory = await mkdtemp(resolve(directory, '.relay-deferred-'));
    const temporary = resolve(temporaryDirectory, 'entry.json');
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify({ version: 2, entry }), 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, destination);
      await this.#syncEntryDirectories(directory);
      if (entry.state !== 'queued') {
        const queued = this.#entryPath(entry.key, 'queued');
        if (queued) {
          // The compact terminal receipt is authoritative once published.
          // Cleanup cannot revoke it, and restore checks receipts before live
          // queue entries, so a cleanup failure must not reverse the result.
          await rm(queued, { force: true }).catch(() => undefined);
          const queueDirectory = this.#entryDirectory('queued');
          if (queueDirectory) {
            await this.#syncEntryDirectories(queueDirectory).catch(() => undefined);
          }
        }
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  #parseEntry(value: unknown): DurableDeliveryEntry {
    if (!value || typeof value !== 'object') throw new Error('Invalid deferred Relay delivery entry');
    const envelope = value as { version?: unknown; entry?: unknown };
    if (envelope.version !== 2 || !envelope.entry || typeof envelope.entry !== 'object') {
      throw new Error('Invalid deferred Relay delivery entry');
    }
    const entry = envelope.entry as {
      key?: unknown;
      state?: unknown;
      message?: unknown;
      context?: unknown;
      order?: unknown;
      deliveryId?: unknown;
      messageId?: unknown;
    };
    if (typeof entry.key !== 'string') throw new Error('Invalid deferred Relay delivery entry');
    if (entry.state === 'queued') {
      if (!entry.message || !entry.context || typeof entry.order !== 'number') {
        throw new Error('Invalid deferred Relay delivery entry');
      }
      return entry as QueuedMessage;
    }
    if (
      (entry.state === 'accepted' || entry.state === 'in_doubt') &&
      typeof entry.deliveryId === 'string' &&
      typeof entry.messageId === 'string'
    ) {
      return entry as DeliveryTombstone;
    }
    throw new Error('Invalid deferred Relay delivery entry');
  }

  async #loadEntry(key: string): Promise<DurableDeliveryEntry | undefined> {
    for (const state of ['accepted', 'queued'] as const) {
      const path = this.#entryPath(key, state);
      if (!path) return undefined;
      try {
        const entry = this.#parseEntry(JSON.parse(await readFile(path, 'utf8')));
        if (entry.key !== key) throw new Error('Deferred Relay delivery key does not match its index');
        return entry;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return undefined;
  }

  async #removeEntry(key: string): Promise<void> {
    const path = this.#entryPath(key, 'queued');
    const directory = this.#entryDirectory('queued');
    if (!path || !directory) return;
    await rm(path, { force: true });
    await this.#syncEntryDirectories(directory);
  }

  async #removeDurableSession(): Promise<void> {
    if (!this.#deferredQueuePath) return;
    try {
      await stat(this.#deferredQueuePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await rm(this.#deferredQueuePath, { recursive: true, force: true });
    if (process.platform === 'win32') return;
    const parent = dirname(this.#deferredQueuePath);
    for (const path of [parent, dirname(parent)]) {
      const directory = await open(path, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  }

  /** Restore deferred messages after a sidecar restart before reading stdin. */
  async restoreDeferredMessages(): Promise<void> {
    if (!this.#deferredQueuePath) return;
    const queueDirectory = this.#entryDirectory('queued');
    if (!queueDirectory) return;
    let files: string[];
    try {
      files = await readdir(queueDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let cleanedStaleEntry = false;
    for (const file of files.filter((candidate) => candidate.endsWith('.json'))) {
      const entry = this.#parseEntry(JSON.parse(await readFile(resolve(queueDirectory, file), 'utf8')));
      if (file !== `${durableEntryId(entry.key)}.json`) {
        throw new Error('Deferred Relay delivery key does not match its index');
      }
      if (entry.state !== 'queued') throw new Error('Invalid queued Relay delivery entry');
      const current = await this.#loadEntry(entry.key);
      if (current?.state !== 'queued') {
        await rm(resolve(queueDirectory, file), { force: true }).catch(() => undefined);
        cleanedStaleEntry = true;
        continue;
      }
      this.#queue.push(current);
      this.#nextQueueOrder = Math.max(this.#nextQueueOrder, current.order + 1);
      this.#remember(current.key, this.#durableReceipt(current));
    }
    if (cleanedStaleEntry) await this.#syncEntryDirectories(queueDirectory).catch(() => undefined);
    this.#queue.sort((left, right) => left.order - right.order || left.key.localeCompare(right.key));
    await this.#serialized(() => this.#drain());
  }

  async #accept(message: RelayMessage, context: MessageContext): Promise<MessageReceipt> {
    const prompt = formatInboundRelayPrompt(message);
    if (this.host.hasActiveTurn) await this.host.submitUserMessage(prompt);
    else await this.host.startTurn(prompt, context.id);
    const receipt: MessageReceipt = { status: 'accepted', deliveryId: context.id };
    await this.#emit({ type: 'message.received', message });
    return receipt;
  }

  async #drain(): Promise<void> {
    if (this.#released || this.host.hasActiveTurn) return;
    const queued = this.#queue.shift();
    if (!queued) return;
    const inDoubt: DeliveryTombstone = {
      key: queued.key,
      deliveryId: queued.context.id,
      messageId: queued.message.id,
      state: 'in_doubt',
    };
    try {
      await this.#persistEntry(inDoubt);
    } catch {
      // The durable queued entry is still authoritative. Without a durable
      // in-doubt marker it is unsafe to publish a terminal failure: a restart
      // could restore and accept the queued entry. Keep it live and retry the
      // transition with bounded backoff or when the broker redelivers it.
      this.#queue.unshift(queued);
      this.#remember(queued.key, this.#durableReceipt(queued));
      this.#scheduleDrainRetry();
      return;
    }
    this.#resetDrainRetry();
    let receipt: MessageReceipt;
    try {
      receipt = await this.#accept(queued.message, queued.context);
    } catch (error) {
      const receipt: MessageReceipt = {
        status: 'failed',
        deliveryId: queued.context.id,
        reason: error instanceof Error ? error.message : String(error),
        retryable: false,
      };
      this.#remember(queued.key, receipt);
      await this.#emit({
        type: 'delivery.failed',
        messageId: queued.message.id,
        deliveryId: queued.context.id,
        reason: receipt.reason,
        retryable: false,
      });
      await this.#drain();
      return;
    }

    const accepted: DeliveryTombstone = { ...inDoubt, state: 'accepted' };
    try {
      await this.#persistEntry(accepted);
    } catch {
      // The host already accepted the message. The durable in-doubt marker is
      // sufficient to prevent replay if the accepted transition cannot be
      // published; do not report a false delivery failure for a turn that has
      // started successfully.
    }
    this.#remember(queued.key, receipt);
    await this.#emit({
      type: 'delivery.accepted',
      messageId: queued.message.id,
      deliveryId: queued.context.id,
    });
  }

  receiveMessage(message: RelayMessage, context: MessageContext): Promise<MessageReceipt> {
    return this.#serialized(async () => {
      if (this.#released) {
        return { status: 'failed', deliveryId: context.id, reason: 'Session is released' };
      }
      const key = context.idempotencyKey ?? message.id ?? context.id;
      const previous = this.#receipts.get(key);
      if (previous) {
        if (previous.status === 'deferred' && !this.host.hasActiveTurn) await this.#drain();
        return this.#receipts.get(key) ?? previous;
      }
      const active = this.#queue.find((entry) => entry.key === key);
      if (active) {
        const receipt = this.#remember(key, this.#durableReceipt(active));
        if (!this.host.hasActiveTurn) await this.#drain();
        return this.#receipts.get(key) ?? receipt;
      }
      const durable = await this.#loadEntry(key);
      if (durable) return this.#remember(key, this.#durableReceipt(durable));

      const shouldQueue =
        this.host.hasActiveTurn && (context.mode === 'next-message' || context.mode === 'on-idle');
      if (shouldQueue) {
        if (this.#queue.length >= this.#maxQueueSize) {
          return this.#remember(key, {
            status: 'failed',
            deliveryId: context.id,
            reason: `AI SDK harness input queue is full (${this.#maxQueueSize})`,
            retryable: true,
          });
        }
        const queued: QueuedMessage = {
          message,
          context,
          key,
          state: 'queued',
          order: this.#nextQueueOrder++,
        };
        this.#queue.push(queued);
        try {
          await this.#persistEntry(queued);
        } catch (error) {
          this.#queue.pop();
          const inDoubt: DeliveryTombstone = {
            key,
            deliveryId: context.id,
            messageId: message.id,
            state: 'in_doubt',
          };
          await this.#persistEntry(inDoubt).catch(() => undefined);
          return this.#remember(key, {
            status: 'failed',
            deliveryId: context.id,
            reason: `Could not durably queue Relay delivery: ${error instanceof Error ? error.message : String(error)}`,
            retryable: false,
          });
        }
        return this.#remember(key, {
          status: 'deferred',
          deliveryId: context.id,
          availableAt: new Date(Date.now() + 100).toISOString(),
          reason: 'queued_until_idle',
          metadata: { queued: true },
        });
      }

      try {
        const receipt = this.#remember(key, await this.#accept(message, context));
        await this.#emit({
          type: 'delivery.accepted',
          messageId: message.id,
          deliveryId: context.id,
        });
        return receipt;
      } catch (error) {
        return this.#remember(key, {
          status: 'failed',
          deliveryId: context.id,
          reason: error instanceof Error ? error.message : String(error),
          retryable: true,
        });
      }
    });
  }

  async release(reason?: string): Promise<void> {
    return this.#serialized(async () => {
      if (this.#releaseCompleted) return;
      this.#released = true;
      this.#resetDrainRetry();
      const queued = this.#queue.splice(0);
      let persistenceError: unknown;
      for (const entry of queued) {
        try {
          await this.#removeEntry(entry.key);
        } catch (error) {
          persistenceError ??= error;
          this.#queue.push(entry);
        }
      }
      if (!persistenceError) {
        try {
          await this.#removeDurableSession();
        } catch (error) {
          persistenceError = error;
        }
      }
      let destroyError: unknown;
      if (!this.#hostDestroyed) {
        try {
          await this.host.destroy();
          this.#hostDestroyed = true;
        } catch (error) {
          destroyError = error;
        }
      }
      let emitError: unknown;
      if (!this.#releaseEmitted) {
        try {
          await this.#emit({ type: 'session.released', reason });
          this.#releaseEmitted = true;
        } catch (error) {
          emitError = error;
        }
      }
      if (persistenceError) throw persistenceError;
      if (destroyError) throw destroyError;
      if (emitError) throw emitError;
      this.#releaseCompleted = true;
    });
  }
}
