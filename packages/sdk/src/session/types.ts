import type { ActionAuditEvent } from '../actions/index.js';
import type { RelayMessage, RelayMessagingEvent } from '../messaging/index.js';

export type AgentSessionStatus = 'active' | 'idle' | 'blocked' | 'waiting' | 'offline';

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
    release: true;
    pause?: boolean;
    resume?: boolean;
    fork?: boolean;
    snapshot?: boolean;
  };
}

export const MINIMAL_AGENT_SESSION_CAPABILITIES: AgentSessionCapabilities = {
  messaging: { receive: true },
  delivery: { modes: ['immediate'] },
  events: { emits: ['status.changed'] },
  lifecycle: { release: true },
};

export type AgentSessionEventType =
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
  | 'session.started'
  | 'session.released'
  | 'session.resumed'
  | 'session.forked'
  | 'log'
  | 'error';

export interface AgentSessionEventBase<TType extends AgentSessionEventType> {
  type: TType;
  at?: Date | string;
  agent?: AgentIdentity;
  metadata?: Record<string, unknown>;
}

export interface TranscriptChunk {
  id: string;
  at?: Date | string;
  role: 'agent' | 'user' | 'system' | 'tool';
  content: string;
  sequence?: number;
  metadata?: Record<string, unknown>;
}

export type AgentSessionEvent =
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
      tool: string;
      input?: unknown;
    })
  | (AgentSessionEventBase<'tool.completed'> & {
      run?: string;
      tool: string;
      output?: unknown;
      durationMs?: number;
    })
  | (AgentSessionEventBase<'tool.failed'> & {
      run?: string;
      tool: string;
      error: string;
      durationMs?: number;
    })
  | (AgentSessionEventBase<'tool.output'> & {
      run?: string;
      tool?: string;
      output: unknown;
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
      operation: 'create' | 'update' | 'delete';
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
  | (AgentSessionEventBase<'session.started'> & { reason?: string })
  | (AgentSessionEventBase<'session.released'> & { reason?: string })
  | (AgentSessionEventBase<'session.resumed'> & { reason?: string })
  | (AgentSessionEventBase<'session.forked'> & { child: AgentIdentity })
  | (AgentSessionEventBase<'log'> & {
      level?: 'debug' | 'info' | 'warn' | 'error';
      message: string;
    })
  | (AgentSessionEventBase<'error'> & {
      error: string;
      code?: string;
      retryable?: boolean;
    });

export interface AgentSession {
  identity: AgentIdentity;
  capabilities: AgentSessionCapabilities;
  receiveMessage(message: RelayMessage, context: MessageContext): Promise<MessageReceipt>;
  onEvent?(emit: (event: AgentSessionEvent) => void | Promise<void>): () => void;
  release(reason?: string): Promise<void>;
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
