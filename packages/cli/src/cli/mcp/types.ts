import type { RelayAgentThinClient, RelayWorkspaceThinClient } from '@agent-relay/sdk';
import type { ActionAuditEvent, AgentRelayActions } from '@agent-relay/sdk/actions';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import type { RealtimeResourceBridge, SubscriptionManager } from './resources.js';
import type { SharedSessionsMcpClientLike } from './shared-sessions-client.js';

export type AgentType = 'agent' | 'human';
export type RelayCastLike = Pick<RelayWorkspaceThinClient, 'agents'>;
export type AgentClientLike = RelayAgentThinClient;

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
  /**
   * Redacted reason the stdio startup registration failed. When set, the
   * server still completes the MCP handshake and identity-scoped tools report
   * this reason instead of the process exiting before `initialize`.
   */
  startupRegistrationError?: string;
  /** Expose only hosted shared-session tools; used by the installable plugin. */
  sessionsOnly?: boolean;
  /** Test/embedding seam for the hosted MCP client. */
  sharedSessionsClient?: SharedSessionsMcpClientLike;
  /** Hosted definitions discovered before the stdio server starts. */
  sharedSessionTools?: Tool[];
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
