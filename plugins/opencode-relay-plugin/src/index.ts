import type { AgentClient, RelayCast } from '@relaycast/sdk';

import { registerHooks } from './hooks.js';
import { registerTools, type ToolContext } from './tools.js';

export const DEFAULT_RELAYCAST_API_BASE_URL = 'https://cast.agentrelay.com';
export const DEFAULT_IDLE_POLL_INTERVAL_MS = 3_000;

export interface SessionIdleResult {
  inject: string;
  continue: boolean;
}

export interface SessionCompactingResult {
  preserve: string;
}

export type HookResult = SessionIdleResult | SessionCompactingResult | void;
export type HookHandler = () => HookResult | Promise<HookResult>;

export interface HookContext {
  hook(name: string, handler: HookHandler): void;
}

export interface PluginContext {
  tool?: ToolContext['tool'];
  hook?: HookContext['hook'];
}

export interface RelayMessage {
  id: string;
  from: string;
  text: string;
  channel?: string;
  thread?: string;
  ts: string;
}

export interface SpawnedProcessLike {
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface SpawnedAgent {
  name: string;
  process: SpawnedProcessLike;
  task: string;
  status: 'running' | 'done' | 'error';
}

export class RelayState {
  agentName: string | null = null;
  workspace: string | null = null;
  token: string | null = null;
  apiBaseUrl = DEFAULT_RELAYCAST_API_BASE_URL;
  idlePollIntervalMs = DEFAULT_IDLE_POLL_INTERVAL_MS;
  lastIdlePollAt = 0;
  spawned = new Map<string, SpawnedAgent>();
  /**
   * IDs of messages already surfaced to the agent. The engine `inbox()` is
   * read-only, so the durable drain happens on the delivery ledger
   * (`ackDelivery`); this local watermark is the in-session backstop that keeps
   * the same message from being re-injected even if a ledger ack lags or fails.
   * Bounded via FIFO eviction (see `MAX_SEEN_MESSAGE_IDS` / `rememberSeen`) so
   * it cannot grow unboundedly over a long session.
   */
  seenMessageIds = new Set<string>();
  connected = false;
  /** Workspace-scoped client (apiKey = workspace key). Owns agent registry calls. */
  relay: RelayCast | null = null;
  /** Agent-scoped client (token = registered agent token). Owns messaging calls. */
  agent: AgentClient | null = null;
}
export default async function relayPlugin(ctx: PluginContext): Promise<RelayState> {
  const state = new RelayState();

  if (ctx.tool) {
    registerTools({ tool: ctx.tool }, state);
  }

  if (ctx.hook) {
    registerHooks({ hook: ctx.hook }, state);
  }

  return state;
}

export { registerHooks } from './hooks.js';
export {
  assertConnected,
  createRelayAgentsTool,
  createRelayConnectTool,
  createRelayDismissTool,
  createRelayInboxTool,
  createRelayPostTool,
  createRelaySendTool,
  createRelaySpawnTool,
  createRelayTools,
  collectInboxMessages,
  inboxToMessages,
  rememberSeen,
  registerTools,
  MAX_SEEN_MESSAGE_IDS,
} from './tools.js';
export type {
  EmptyInput,
  Message,
  RelayConnectInput,
  RelayDismissInput,
  RelayPostInput,
  RelaySendInput,
  RelaySpawnInput,
  RelayCastFactory,
  SpawnLike,
  ToolDefinition,
  ToolDependencies,
  ToolSchema,
  ToolSchemaProperty,
} from './tools.js';
