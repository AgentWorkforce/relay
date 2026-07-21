import { createAgentActivityState, reduceAgentActivity } from '@agent-relay/sdk';
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
}

interface QueuedMessage {
  message: RelayMessage;
  context: MessageContext;
  key: string;
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
  readonly #queue: QueuedMessage[] = [];
  readonly #receipts = new Map<string, MessageReceipt>();
  readonly #listeners = new Set<(event: AgentSessionEvent) => void | Promise<void>>();
  #operation = Promise.resolve();
  #released = false;
  #activity: AgentActivityState = createAgentActivityState();

  constructor(options: RelayHarnessSessionOptions) {
    this.identity = options.identity;
    this.host = options.host;
    this.#maxQueueSize = options.maxQueueSize ?? 100;
    this.#maxDedupeEntries = options.maxDedupeEntries ?? 10_000;
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

  async #accept(message: RelayMessage, context: MessageContext): Promise<MessageReceipt> {
    const prompt = formatInboundRelayPrompt(message);
    if (this.host.hasActiveTurn) await this.host.submitUserMessage(prompt);
    else await this.host.startTurn(prompt, context.id);
    const receipt: MessageReceipt = { status: 'accepted', deliveryId: context.id };
    await this.#emit({ type: 'message.received', message });
    await this.#emit({ type: 'delivery.accepted', messageId: message.id, deliveryId: context.id });
    return receipt;
  }

  async #drain(): Promise<void> {
    if (this.#released || this.host.hasActiveTurn) return;
    const queued = this.#queue.shift();
    if (!queued) return;
    try {
      const receipt = await this.#accept(queued.message, queued.context);
      this.#remember(queued.key, receipt);
    } catch (error) {
      const receipt: MessageReceipt = {
        status: 'failed',
        deliveryId: queued.context.id,
        reason: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
      this.#remember(queued.key, receipt);
      await this.#emit({
        type: 'delivery.failed',
        messageId: queued.message.id,
        deliveryId: queued.context.id,
        reason: receipt.reason,
        retryable: true,
      });
      await this.#drain();
    }
  }

  receiveMessage(message: RelayMessage, context: MessageContext): Promise<MessageReceipt> {
    return this.#serialized(async () => {
      if (this.#released) {
        return { status: 'failed', deliveryId: context.id, reason: 'Session is released' };
      }
      const key = context.idempotencyKey ?? message.id ?? context.id;
      const previous = this.#receipts.get(key);
      if (previous) return previous;

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
        this.#queue.push({ message, context, key });
        return this.#remember(key, {
          status: 'deferred',
          deliveryId: context.id,
          availableAt: new Date(Date.now() + 100).toISOString(),
          reason: 'queued_until_idle',
          metadata: { queued: true },
        });
      }

      try {
        return this.#remember(key, await this.#accept(message, context));
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
      if (this.#released) return;
      this.#released = true;
      this.#queue.length = 0;
      await this.host.destroy();
      await this.#emit({ type: 'session.released', reason });
    });
  }
}
