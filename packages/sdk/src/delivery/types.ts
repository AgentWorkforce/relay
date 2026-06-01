import type { RelayMessage } from '../messaging/index.js';
import type { Unsubscribe } from '../capabilities.js';
import type {
  AgentSession,
  AgentSessionDeliveryMode,
  MessageContext,
  MessageReceipt,
} from '../session/index.js';

export type AgentRuntimeStatus = 'idle' | 'busy' | 'offline' | 'unknown';
export type DeliveryMode = AgentSessionDeliveryMode;
export type DeliveryContext = MessageContext;
export type DeliveryResult = MessageReceipt;

export interface DeliveryCapabilities {
  push: boolean;
  interrupt: boolean;
  detectIdle: boolean;
  threads: boolean;
  attachments: boolean;
}

export interface InjectionContext {
  reason: 'dm' | 'channel' | 'mention' | 'thread_reply' | 'action_result' | 'message';
  priority?: 'normal' | 'urgent';
  mode?: 'append' | 'interrupt' | 'wait_until_idle';
}

export interface InjectionResult {
  status: 'accepted' | 'delivered' | 'deferred' | 'failed';
  injectionId?: string;
  availableAt?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentActivityEvent {
  status: AgentRuntimeStatus;
  at: string;
  metadata?: Record<string, unknown>;
}

export interface AgentDeliveryAdapter {
  readonly id: string;
  readonly kind?: string;
  readonly capabilities: DeliveryCapabilities;
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
  inject?(message: RelayMessage, context: InjectionContext): Promise<InjectionResult>;
  receiveMessage?(message: RelayMessage, context: MessageContext): Promise<MessageReceipt>;
  getStatus?(): Promise<AgentRuntimeStatus>;
  interrupt?(): Promise<void>;
  onActivity?(handler: (event: AgentActivityEvent) => void): Unsubscribe;
}

export type MessageDeliveryTarget = AgentDeliveryAdapter | AgentSession;
