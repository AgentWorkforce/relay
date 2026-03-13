import { registerHooks } from './hooks.js';
import { registerTools, type ToolContext } from './tools.js';

export const DEFAULT_RELAYCAST_API_BASE_URL =
  'https://www.relaycast.dev/api/v1';
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
  connected = false;
}
export default async function relayPlugin(
  ctx: PluginContext
): Promise<RelayState> {
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
  registerTools,
  relaycastAPI,
} from './tools.js';
export type {
  EmptyInput,
  Message,
  RelayAPIResponse,
  RelayConnectInput,
  RelayDismissInput,
  RelayPostInput,
  RelaySendInput,
  RelaySpawnInput,
  SpawnLike,
  ToolDefinition,
  ToolDependencies,
  ToolSchema,
  ToolSchemaProperty,
} from './tools.js';
