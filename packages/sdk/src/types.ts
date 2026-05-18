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
  /** Optional pre-minted relaycast agent token (`at_live_<hex>`, from
   *  `registerAgent(workspaceKey, name)` in `@agent-relay/sdk/http`). The
   *  broker plumbs this as `RELAY_AGENT_TOKEN`, which the relaycast MCP
   *  authenticates with. When omitted, the relaycast MCP auto-mints a token
   *  using `RELAY_API_KEY` + the spawn name; that is the recommended path.
   *  Note: this is a relaycast credential, NOT a relayfile/relayauth token —
   *  override `env.RELAYFILE_TOKEN` on the constructor for relayfile auth. */
  agentToken?: string;
}

export interface SpawnHeadlessInput {
  name: string;
  provider: HeadlessProvider;
  args?: string[];
  channels?: string[];
  task?: string;
  skipRelayPrompt?: boolean;
  /** Optional pre-minted relaycast agent token (`at_live_<hex>`, from
   *  `registerAgent(workspaceKey, name)` in `@agent-relay/sdk/http`). The
   *  broker plumbs this as `RELAY_AGENT_TOKEN`, which the relaycast MCP
   *  authenticates with. When omitted, the relaycast MCP auto-mints a token
   *  using `RELAY_API_KEY` + the spawn name; that is the recommended path.
   *  Note: this is a relaycast credential, NOT a relayfile/relayauth token —
   *  override `env.RELAYFILE_TOKEN` on the constructor for relayfile auth. */
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
  /** Optional pre-minted relaycast agent token (`at_live_<hex>`, from
   *  `registerAgent(workspaceKey, name)` in `@agent-relay/sdk/http`). The
   *  broker plumbs this as `RELAY_AGENT_TOKEN`, which the relaycast MCP
   *  authenticates with. When omitted, the relaycast MCP auto-mints a token
   *  using `RELAY_API_KEY` + the spawn name; that is the recommended path.
   *  Note: this is a relaycast credential, NOT a relayfile/relayauth token —
   *  override `env.RELAYFILE_TOKEN` on the constructor for relayfile auth. */
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
