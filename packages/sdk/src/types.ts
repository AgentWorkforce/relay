/**
 * Shared input/output types for the broker SDK.
 */

import type { AgentRuntime, HeadlessProvider, MessageInjectionMode, RestartPolicy } from './protocol.js';

export interface SpawnPtyInput {
  name: string;
  cli: string;
  args?: string[];
  channels?: string[];
  task?: string;
  model?: string;
  cwd?: string;
  team?: string;
  shadowOf?: string;
  shadowMode?: string;
  idleThresholdSecs?: number;
  restartPolicy?: RestartPolicy;
  continueFrom?: string;
  skipRelayPrompt?: boolean;
  /** JWT token for relayauth/relayfile permissions. When set, the broker
   *  injects RELAY_AGENT_TOKEN into the agent's environment. */
  agentToken?: string;
}

export interface SpawnHeadlessInput {
  name: string;
  provider: HeadlessProvider;
  args?: string[];
  channels?: string[];
  task?: string;
  skipRelayPrompt?: boolean;
  /** JWT token for relayauth/relayfile permissions. When set, the broker
   *  injects RELAY_AGENT_TOKEN into the agent's environment. */
  agentToken?: string;
}

export type AgentTransport = 'pty' | 'headless';

export interface SpawnProviderInput {
  name: string;
  provider: string;
  transport?: AgentTransport;
  args?: string[];
  channels?: string[];
  task?: string;
  model?: string;
  cwd?: string;
  team?: string;
  shadowOf?: string;
  shadowMode?: string;
  idleThresholdSecs?: number;
  restartPolicy?: RestartPolicy;
  continueFrom?: string;
  skipRelayPrompt?: boolean;
  /** JWT token for relayauth/relayfile permissions. When set, the broker
   *  injects RELAY_AGENT_TOKEN into the agent's environment. */
  agentToken?: string;
}

export interface SendMessageInput {
  to: string;
  text: string;
  from?: string;
  threadId?: string;
  workspaceId?: string;
  workspaceAlias?: string;
  priority?: number;
  data?: Record<string, unknown>;
  mode?: MessageInjectionMode;
}

export interface ListAgent {
  name: string;
  runtime: AgentRuntime;
  provider?: HeadlessProvider;
  cli?: string;
  model?: string;
  team?: string;
  channels: string[];
  parent?: string;
  pid?: number;
}
