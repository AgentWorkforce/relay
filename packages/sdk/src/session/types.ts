import type { ActionAuditEvent } from '../actions/index.js';
import type { RelayMessage, RelayMessagingEvent } from '../messaging/index.js';

export type AgentSessionStatus = 'active' | 'idle' | 'blocked' | 'waiting' | 'offline';

/** High-frequency work state, separate from durable session presence and health. */
export type AgentActivity = 'starting' | 'thinking' | 'typing' | 'using_tool' | 'waiting' | 'idle' | 'error';

export type ObservabilityFidelity = 'exact' | 'inferred';
export type ObservabilitySource = 'ai-sdk' | 'pty-structured' | 'pty-terminal' | 'broker';

export type ObservabilitySupport =
  | { available: true; fidelities: readonly ObservabilityFidelity[] }
  | { available: false };

export const OBSERVABILITY_UNAVAILABLE = { available: false } as const satisfies ObservabilitySupport;
export const EXACT_OBSERVABILITY = {
  available: true,
  fidelities: ['exact'],
} as const satisfies ObservabilitySupport;
export const INFERRED_OBSERVABILITY = {
  available: true,
  fidelities: ['inferred'],
} as const satisfies ObservabilitySupport;
export const EXACT_AND_INFERRED_OBSERVABILITY = {
  available: true,
  fidelities: ['exact', 'inferred'],
} as const satisfies ObservabilitySupport;

export type AgentSemanticEventFamily =
  | 'lifecycle'
  | 'turns'
  | 'text'
  | 'reasoning'
  | 'tools'
  | 'tool_approvals'
  | 'files'
  | 'compaction'
  | 'model'
  | 'warnings'
  | 'usage'
  | 'diagnostics'
  | 'errors';

/** Runtime-declared observability coverage. Unsupported signals stay explicit. */
export interface AgentObservabilityCapabilities {
  activities: Record<AgentActivity, ObservabilitySupport>;
  events: Record<AgentSemanticEventFamily, ObservabilitySupport>;
}

export const AGENT_ACTIVITIES = [
  'starting',
  'thinking',
  'typing',
  'using_tool',
  'waiting',
  'idle',
  'error',
] as const satisfies readonly AgentActivity[];

export const AGENT_SEMANTIC_EVENT_FAMILIES = [
  'lifecycle',
  'turns',
  'text',
  'reasoning',
  'tools',
  'tool_approvals',
  'files',
  'compaction',
  'model',
  'warnings',
  'usage',
  'diagnostics',
  'errors',
] as const satisfies readonly AgentSemanticEventFamily[];

/** Fill omitted capability entries as unavailable, keeping declarations honest by default. */
export function createAgentObservabilityCapabilities(input: {
  activities?: Partial<Record<AgentActivity, ObservabilitySupport>>;
  events?: Partial<Record<AgentSemanticEventFamily, ObservabilitySupport>>;
}): AgentObservabilityCapabilities {
  return {
    activities: Object.fromEntries(
      AGENT_ACTIVITIES.map((activity) => [
        activity,
        input.activities?.[activity] ?? OBSERVABILITY_UNAVAILABLE,
      ])
    ) as unknown as Record<AgentActivity, ObservabilitySupport>,
    events: Object.fromEntries(
      AGENT_SEMANTIC_EVENT_FAMILIES.map((family) => [
        family,
        input.events?.[family] ?? OBSERVABILITY_UNAVAILABLE,
      ])
    ) as unknown as Record<AgentSemanticEventFamily, ObservabilitySupport>,
  };
}

/** Provenance attached to every canonical observation emitted by a runtime. */
export interface AgentObservabilityMetadata {
  source: ObservabilitySource;
  fidelity: ObservabilityFidelity;
  sequence: number;
  timestamp: Date | string;
  turnId?: string;
}

export interface AgentIdentityInput {
  id?: string;
  name: string;
  handle?: string;
  displayName?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentIdentity {
  id: string;
  name: string;
  handle: string;
  displayName?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export type MessageAttachmentCapability = 'text' | 'image';

export type AgentSessionDeliveryMode = 'immediate' | 'next-message' | 'next-tool-call' | 'on-idle' | 'manual';

export type MessageDeliveryReason =
  | 'message'
  | 'mention'
  | 'dm'
  | 'thread-reply'
  | 'action-result'
  | 'notification';

export interface MessageContext {
  id: string;
  mode: AgentSessionDeliveryMode;
  reason: MessageDeliveryReason;
  priority?: 'normal' | 'urgent';
  deadline?: Date | string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export type MessageReceipt =
  | {
      status: 'accepted';
      deliveryId: string;
      retryable?: boolean;
      metadata?: Record<string, unknown>;
    }
  | {
      status: 'delivered';
      deliveryId: string;
      metadata?: Record<string, unknown>;
    }
  | {
      status: 'deferred';
      deliveryId?: string;
      availableAt: Date | string;
      reason?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      status: 'failed';
      deliveryId?: string;
      reason: string;
      retryable?: boolean;
      metadata?: Record<string, unknown>;
    };

export interface AgentSessionCapabilities {
  messaging: {
    receive: true;
    send?: boolean;
    attachments?: MessageAttachmentCapability[];
  };
  delivery: {
    modes: AgentSessionDeliveryMode[];
    queue?: boolean;
  };
  events: {
    emits: AgentSessionEventType[];
  };
  actions?: {
    invoke?: boolean;
    expose?: boolean;
  };
  lifecycle: {
    release: boolean;
    pause?: boolean;
    resume?: boolean;
    fork?: boolean;
    snapshot?: boolean;
  };
  /** Exact, inferred, and unavailable semantic signals for this runtime. */
  observability?: AgentObservabilityCapabilities;
}

export const MINIMAL_AGENT_SESSION_CAPABILITIES: AgentSessionCapabilities = {
  messaging: { receive: true },
  delivery: { modes: ['immediate'] },
  events: { emits: ['status.changed'] },
  lifecycle: { release: true },
};

export type AgentSessionEventType =
  | 'activity.changed'
  | 'observability.capabilities'
  | 'status.changed'
  | 'status.idle'
  | 'status.active'
  | 'status.blocked'
  | 'status.waiting'
  | 'status.offline'
  | 'message.received'
  | 'message.sent'
  | 'delivery.accepted'
  | 'delivery.delivered'
  | 'delivery.deferred'
  | 'delivery.failed'
  | 'tool.called'
  | 'tool.completed'
  | 'tool.failed'
  | 'tool.output'
  | 'tool.approval.requested'
  | 'tool.approval.resolved'
  | 'action.invoked'
  | 'action.completed'
  | 'action.failed'
  | 'action.denied'
  | 'transcript.chunk'
  | 'file.changed'
  | 'command.started'
  | 'command.completed'
  | 'command.failed'
  | 'terminal.output'
  | 'terminal.screen'
  | 'usage.updated'
  | 'session.starting'
  | 'session.started'
  | 'session.suspended'
  | 'session.detached'
  | 'session.stopped'
  | 'session.destroyed'
  | 'session.failed'
  | 'session.released'
  | 'session.resumed'
  | 'session.forked'
  | 'turn.started'
  | 'step.finished'
  | 'turn.finished'
  | 'turn.settled'
  | 'text.started'
  | 'text.delta'
  | 'text.finished'
  | 'reasoning.started'
  | 'reasoning.delta'
  | 'reasoning.finished'
  | 'context.compacted'
  | 'model.resolved'
  | 'warning'
  | 'diagnostic'
  | 'log'
  | 'error';

/** Selectors comprising Relay's runtime-neutral semantic observability vocabulary. */
export type AgentSemanticEventType =
  | 'observability.capabilities'
  | 'session.starting'
  | 'session.started'
  | 'session.resumed'
  | 'session.suspended'
  | 'session.detached'
  | 'session.stopped'
  | 'session.destroyed'
  | 'session.failed'
  | 'turn.started'
  | 'step.finished'
  | 'turn.finished'
  | 'turn.settled'
  | 'text.started'
  | 'text.delta'
  | 'text.finished'
  | 'reasoning.started'
  | 'reasoning.delta'
  | 'reasoning.finished'
  | 'tool.called'
  | 'tool.approval.requested'
  | 'tool.approval.resolved'
  | 'tool.completed'
  | 'tool.failed'
  | 'file.changed'
  | 'context.compacted'
  | 'model.resolved'
  | 'warning'
  | 'usage.updated'
  | 'diagnostic'
  | 'error';

export interface AgentSessionEventBase<TType extends AgentSessionEventType> {
  type: TType;
  at?: Date | string;
  agent?: AgentIdentity;
  metadata?: Record<string, unknown>;
  /** Present when this event participates in the canonical observability contract. */
  observability?: AgentObservabilityMetadata;
}

export type CanonicalAgentSessionEventBase<TType extends AgentSessionEventType> =
  AgentSessionEventBase<TType> & {
    observability: AgentObservabilityMetadata;
  };

export interface TranscriptChunk {
  id: string;
  at?: Date | string;
  role: 'agent' | 'user' | 'system' | 'tool';
  content: string;
  sequence?: number;
  metadata?: Record<string, unknown>;
}

export type AgentSessionEvent =
  | (CanonicalAgentSessionEventBase<'activity.changed'> & {
      activity: AgentActivity;
      previousActivity: AgentActivity;
      reason: string;
      tool?: { callId: string; name?: string };
      approval?: { approvalId: string; callId?: string };
    })
  | (CanonicalAgentSessionEventBase<'observability.capabilities'> & {
      capabilities: AgentObservabilityCapabilities;
    })
  | (AgentSessionEventBase<'status.changed'> & {
      status: AgentSessionStatus;
      previousStatus?: AgentSessionStatus;
      reason?: string;
    })
  | (AgentSessionEventBase<
      'status.idle' | 'status.active' | 'status.blocked' | 'status.waiting' | 'status.offline'
    > & { reason?: string })
  | (AgentSessionEventBase<'message.received' | 'message.sent'> & { message: RelayMessage })
  | (AgentSessionEventBase<'delivery.accepted' | 'delivery.delivered'> & {
      messageId: string;
      deliveryId?: string;
    })
  | (AgentSessionEventBase<'delivery.deferred'> & {
      messageId: string;
      deliveryId?: string;
      availableAt: Date | string;
      reason?: string;
    })
  | (AgentSessionEventBase<'delivery.failed'> & {
      messageId: string;
      deliveryId?: string;
      reason: string;
      retryable?: boolean;
    })
  | (AgentSessionEventBase<'tool.called'> & {
      run?: string;
      callId?: string;
      tool: string;
      input?: unknown;
    })
  | (AgentSessionEventBase<'tool.completed'> & {
      run?: string;
      callId?: string;
      tool: string;
      output?: unknown;
      durationMs?: number;
    })
  | (AgentSessionEventBase<'tool.failed'> & {
      run?: string;
      callId?: string;
      tool: string;
      error: string;
      durationMs?: number;
    })
  | (AgentSessionEventBase<'tool.output'> & {
      run?: string;
      callId?: string;
      tool?: string;
      output: unknown;
    })
  | (CanonicalAgentSessionEventBase<'tool.approval.requested'> & {
      approvalId: string;
      callId?: string;
      tool?: string;
      input?: unknown;
    })
  | (CanonicalAgentSessionEventBase<'tool.approval.resolved'> & {
      approvalId: string;
      callId?: string;
      approved: boolean;
      reason?: string;
    })
  | (AgentSessionEventBase<'action.invoked'> & {
      action: string;
      input?: unknown;
      caller?: AgentIdentity | { name: string; id?: string; type?: 'agent' | 'human' | 'system' };
    })
  | (AgentSessionEventBase<'action.completed'> & {
      action: string;
      output?: unknown;
      caller?: AgentIdentity | { name: string; id?: string; type?: 'agent' | 'human' | 'system' };
      durationMs?: number;
    })
  | (AgentSessionEventBase<'action.failed'> & {
      action: string;
      error: string;
      caller?: AgentIdentity | { name: string; id?: string; type?: 'agent' | 'human' | 'system' };
      durationMs?: number;
    })
  | (AgentSessionEventBase<'action.denied'> & {
      action: string;
      reason?: string;
      caller?: AgentIdentity | { name: string; id?: string; type?: 'agent' | 'human' | 'system' };
    })
  | (AgentSessionEventBase<'transcript.chunk'> & { chunk: TranscriptChunk })
  | (AgentSessionEventBase<'file.changed'> & {
      path: string;
      operation: 'create' | 'modify' | 'update' | 'delete';
      diff?: string;
    })
  | (AgentSessionEventBase<'command.started'> & {
      commandId?: string;
      command: string;
      cwd?: string;
    })
  | (AgentSessionEventBase<'command.completed'> & {
      commandId?: string;
      command?: string;
      exitCode?: number;
      durationMs?: number;
    })
  | (AgentSessionEventBase<'command.failed'> & {
      commandId?: string;
      command?: string;
      error: string;
      exitCode?: number;
      durationMs?: number;
    })
  | (AgentSessionEventBase<'terminal.output'> & {
      stream?: 'stdout' | 'stderr' | 'combined';
      text: string;
    })
  | (AgentSessionEventBase<'terminal.screen'> & {
      text: string;
      rows?: number;
      columns?: number;
    })
  | (AgentSessionEventBase<'usage.updated'> & {
      usage: Record<string, number | string | boolean | null>;
    })
  | (CanonicalAgentSessionEventBase<'session.starting'> & { reason?: string })
  | (AgentSessionEventBase<'session.started'> & { reason?: string })
  | (CanonicalAgentSessionEventBase<'session.suspended'> & { reason: string })
  | (CanonicalAgentSessionEventBase<'session.detached'> & { reason?: string })
  | (CanonicalAgentSessionEventBase<'session.stopped'> & { reason?: string })
  | (CanonicalAgentSessionEventBase<'session.destroyed'> & { reason?: string })
  | (CanonicalAgentSessionEventBase<'session.failed'> & {
      error: string;
      code?: string;
      retryable?: boolean;
    })
  | (AgentSessionEventBase<'session.released'> & { reason?: string })
  | (AgentSessionEventBase<'session.resumed'> & { reason?: string })
  | (AgentSessionEventBase<'session.forked'> & { child: AgentIdentity })
  | (CanonicalAgentSessionEventBase<'turn.started'> & { turnId: string })
  | (CanonicalAgentSessionEventBase<'step.finished'> & {
      turnId: string;
      finishReason?: string;
      usage?: Record<string, number | string | boolean | null>;
    })
  | (CanonicalAgentSessionEventBase<'turn.finished'> & {
      turnId: string;
      finishReason: string;
    })
  | (CanonicalAgentSessionEventBase<'turn.settled'> & { turnId: string })
  | (CanonicalAgentSessionEventBase<'text.started'> & { blockId: string })
  | (CanonicalAgentSessionEventBase<'text.delta'> & { blockId: string; delta: string })
  | (CanonicalAgentSessionEventBase<'text.finished'> & { blockId: string; text?: string })
  | (CanonicalAgentSessionEventBase<'reasoning.started'> & { blockId: string })
  | (CanonicalAgentSessionEventBase<'reasoning.delta'> & { blockId: string; delta: string })
  | (CanonicalAgentSessionEventBase<'reasoning.finished'> & { blockId: string; text?: string })
  | (CanonicalAgentSessionEventBase<'context.compacted'> & {
      trigger?: 'automatic' | 'manual';
      beforeTokens?: number;
      afterTokens?: number;
    })
  | (CanonicalAgentSessionEventBase<'model.resolved'> & {
      provider?: string;
      requestedModel?: string;
      model: string;
    })
  | (CanonicalAgentSessionEventBase<'warning'> & { message: string; code?: string })
  | (CanonicalAgentSessionEventBase<'diagnostic'> & {
      level: 'debug' | 'info' | 'warn' | 'error';
      message: string;
      subsystem?: string;
      data?: Record<string, unknown>;
    })
  | (AgentSessionEventBase<'log'> & {
      level?: 'debug' | 'info' | 'warn' | 'error';
      message: string;
    })
  | (AgentSessionEventBase<'error'> & {
      error: string;
      code?: string;
      retryable?: boolean;
    });

type RequireCanonicalObservation<TEvent> = TEvent extends { type: AgentSemanticEventType }
  ? TEvent extends { type: 'tool.called' | 'tool.completed' | 'tool.failed' }
    ? TEvent & { callId: string; observability: AgentObservabilityMetadata }
    : TEvent extends { type: 'file.changed' }
      ? Omit<TEvent, 'operation'> & {
          operation: 'create' | 'modify' | 'delete';
          observability: AgentObservabilityMetadata;
        }
      : TEvent & { observability: AgentObservabilityMetadata }
  : never;

/** A semantic event whose provenance is complete enough for observer-plane publication. */
export type CanonicalAgentSessionEvent = RequireCanonicalObservation<AgentSessionEvent>;

export interface AgentSession {
  identity: AgentIdentity;
  capabilities: AgentSessionCapabilities;
  receiveMessage(message: RelayMessage, context: MessageContext): Promise<MessageReceipt>;
  onEvent?(emit: (event: AgentSessionEvent) => void | Promise<void>): () => void;
  /**
   * Tear down the session. Provide this if and only if
   * `capabilities.lifecycle.release` is `true`; omit it for sessions that
   * declare `release: false`.
   */
  release?(reason?: string): Promise<void>;
}

export type HarnessCleanup = () => void | Promise<void>;

export interface HarnessWorkspaceContext {
  id: string;
  name?: string;
  cwd?: string;
  metadata?: Record<string, unknown>;
}

export interface HarnessInitContext {
  relay?: unknown;
  workspace?: HarnessWorkspaceContext;
  env?: Record<string, string>;
  secrets?: Record<string, string>;
  signal?: AbortSignal;
  log?: (event: AgentSessionEvent) => void | Promise<void>;
}

export interface HarnessCreateContext extends HarnessInitContext {
  agent: AgentIdentityInput;
}

export interface HarnessConfig<TCreateInput = void> {
  name: string;
  version?: string;
  description?: string;
  init?(context: HarnessInitContext): Promise<void | HarnessCleanup> | void | HarnessCleanup;
  create(input: TCreateInput, context: HarnessCreateContext): Promise<AgentSession>;
}

export interface AgentRelaySessionEvent {
  type: 'session.event';
  session: AgentIdentity;
  event: AgentSessionEvent;
  at: Date | string;
}

export type AgentRelayEvent = RelayMessagingEvent | ActionAuditEvent | AgentRelaySessionEvent;
