import type { RelayCast, AgentClient } from '@relaycast/sdk';
import type { ActionAuditEvent, AgentRelayActions } from '@agent-relay/sdk/actions';

import type { RealtimeResourceBridge, SubscriptionManager } from './resources.js';

export type AgentType = 'agent' | 'human';
export type RelayCastLike = Pick<RelayCast, 'agents'>;
export type AgentClientLike = AgentClient;

export interface AgentRelayMcpServerOptions {
  workspaceKey?: string;
  /** @deprecated Use workspaceKey. */
  apiKey?: string;
  baseUrl?: string;
  agentToken?: string;
  agentName?: string;
  agentType?: AgentType;
  strictAgentName?: boolean;
  telemetryTransport?: 'stdio' | 'http';
  skipBootstrap?: boolean;
  actions?: AgentRelayActions;
  onActionAuditEvent?: (event: ActionAuditEvent) => Promise<void> | void;
}

export interface RegisteredAgent {
  agentName: string;
  agentToken: string;
}

export interface SessionState {
  workspaceKey: string | null;
  agentToken: string | null;
  agentName: string | null;
  agents: Map<string, RegisteredAgent>;
  wsBridge: RealtimeResourceBridge | null;
  subscriptions: SubscriptionManager | null;
  wsInitAttempted: boolean;
}

export type RegistrationSession = Pick<SessionState, 'workspaceKey' | 'agentToken' | 'agentName'> & {
  agents?: Map<string, RegisteredAgent>;
};

export type SessionSetter = (partial: Partial<SessionState>) => void;
