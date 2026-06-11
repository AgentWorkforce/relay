/**
 * Shared input/output types for the broker SDK.
 */

import type { SafeParseSchema, ZodLikeSchema } from '@agent-relay/sdk/actions';
import type {
  AgentCurrentState,
  AgentRuntime,
  HeadlessProvider,
  MessageInjectionMode,
  RestartPolicy,
} from './protocol.js';
import type { ResolvedHarnessConfig } from './harness.js';

export type JsonSchema = Record<string, unknown> | boolean;

/**
 * Schema for the structured result a spawned agent submits via the
 * `submit_result` MCP tool. Accepts raw JSON Schema or a zod-style validator
 * (anything with `safeParse`) — validators are converted to JSON Schema before
 * the spawn request reaches the broker, matching the actions surface.
 */
export type AgentResultSchema = JsonSchema | ZodLikeSchema<unknown> | SafeParseSchema;

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
  harnessConfig?: ResolvedHarnessConfig;
  skipRelayPrompt?: boolean;
  agentResultSchema?: AgentResultSchema;
  /** Optional pre-minted relaycast agent token (`at_live_<hex>`, from
   *  Relaycast agent registration). The
   *  broker plumbs this as `RELAY_AGENT_TOKEN`, which the Agent Relay MCP
   *  authenticates with. When omitted, the Agent Relay MCP auto-mints a token
   *  using `RELAY_WORKSPACE_KEY` + the spawn name; that is the recommended path.
   *  Note: this is a relaycast credential, NOT a relayfile/relayauth token —
   *  override `env.RELAYFILE_TOKEN` on the constructor for relayfile auth. */
  agentToken?: string;
}

export interface SpawnHeadlessInput {
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
  harnessConfig?: ResolvedHarnessConfig;
  skipRelayPrompt?: boolean;
  agentResultSchema?: AgentResultSchema;
  /** Optional pre-minted relaycast agent token (`at_live_<hex>`, from
   *  Relaycast agent registration). The
   *  broker plumbs this as `RELAY_AGENT_TOKEN`, which the Agent Relay MCP
   *  authenticates with. When omitted, the Agent Relay MCP auto-mints a token
   *  using `RELAY_WORKSPACE_KEY` + the spawn name; that is the recommended path.
   *  Note: this is a relaycast credential, NOT a relayfile/relayauth token —
   *  override `env.RELAYFILE_TOKEN` on the constructor for relayfile auth. */
  agentToken?: string;
}

export type AgentTransport = 'pty' | 'headless';

export interface SpawnAgentResult {
  name: string;
  runtime: AgentRuntime;
  sessionId?: string;
  pid?: number;
}

export interface SpawnCliInput {
  name: string;
  cli: string;
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
  harnessConfig?: ResolvedHarnessConfig;
  skipRelayPrompt?: boolean;
  agentResultSchema?: AgentResultSchema;
  /** Optional pre-minted relaycast agent token (`at_live_<hex>`, from
   *  Relaycast agent registration). The
   *  broker plumbs this as `RELAY_AGENT_TOKEN`, which the Agent Relay MCP
   *  authenticates with. When omitted, the Agent Relay MCP auto-mints a token
   *  using `RELAY_WORKSPACE_KEY` + the spawn name; that is the recommended path.
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
  sessionId?: string;
  team?: string;
  channels: string[];
  parent?: string;
  pid?: number;
  last_activity_at?: string;
  last_activity_ms?: number;
  context_budget_pct?: number | null;
  current_state?: AgentCurrentState;
}
