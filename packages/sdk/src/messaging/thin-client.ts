/**
 * Thin Relaycast client factories.
 *
 * These factories give SDK consumers (the CLI MCP server in particular)
 * typed access to the hosted Relaycast engine without importing
 * `@relaycast/sdk` directly. Unlike {@link RelaycastMessagingClient}, the
 * thin clients are raw pass-throughs: requests and responses cross the wire
 * untouched, so payloads serialized back to callers (for example MCP tool
 * results) keep the exact upstream shape, and upstream errors propagate
 * unchanged for detectors like `isInvalidAgentTokenError`.
 *
 * Telemetry context (`originActor`, `agentRelayDistinctId`) is resolved from
 * explicit options first and the standard Agent Relay environment variables
 * second, matching every other Relaycast client built by this package.
 */

import { RelayCast, SDK_VERSION, WsClient } from '@relaycast/sdk';

import {
  relaycastTelemetryOptions,
  relaycastWorkspaceTelemetryOptions,
  type RelaycastTelemetryOptions,
} from '../relaycast-telemetry.js';
import type {
  RelayCreateChannelInput,
  RelayListAgentsOptions,
  RelayListChannelsOptions,
  RelayMessageListOptions,
  RelayMessageMode,
  RelayRegisterAgentInput,
  RelayReleaseAgentInput,
} from './types.js';

export type { RelaycastTelemetryOptions } from '../relaycast-telemetry.js';

/** Version of the underlying `@relaycast/sdk` engine client. */
export const RELAYCAST_SDK_VERSION: string = SDK_VERSION;

/** Raw registration payload returned by `agents.registerOrRotate`. */
export interface RelayRawAgentRegistration {
  /** Agent token (`at_live_...`) minted or rotated for this identity. */
  token: string;
  /** Canonical agent name the workspace bound the registration to. */
  name?: string;
  [key: string]: unknown;
}

/** Input for `agents.spawn` — ask the relay to launch a provider-backed worker. */
export interface RelaySpawnAgentInput {
  name: string;
  /** AI CLI to launch (for example `claude` or `codex`). */
  cli?: string;
  /** Task instructions handed to the spawned worker. */
  task?: string;
  /** Channel the worker should join. */
  channel?: string;
  persona?: string;
  /**
   * Free-form spawn metadata forwarded to the broker (for example `{ model,
   * worker_cwd }`, which the broker extracts into launch settings).
   */
  metadata?: Record<string, unknown>;
}

/** Raw payload returned by `agents.release`. */
export interface RelayRawReleasedAgent {
  name: string;
  released: boolean;
  deleted: boolean;
  reason: string | null;
  [key: string]: unknown;
}

/** Raw group DM conversation returned by `dms.createGroup`. */
export interface RelayRawGroupConversation {
  id: string;
  [key: string]: unknown;
}

/**
 * Workspace-key scoped operations: identity registration plus worker
 * lifecycle. Responses are raw upstream payloads.
 */
export interface RelayWorkspaceThinClient {
  readonly agents: {
    list(options?: RelayListAgentsOptions): Promise<unknown[]>;
    /** Register an agent, rotating its token when the name already exists. */
    registerOrRotate(input: RelayRegisterAgentInput): Promise<RelayRawAgentRegistration>;
    /** Ask the relay to spawn a provider-backed worker. */
    spawn(input: RelaySpawnAgentInput): Promise<Record<string, unknown>>;
    /** Release (or delete) a spawned worker. */
    release(input: RelayReleaseAgentInput): Promise<RelayRawReleasedAgent>;
  };
}

/**
 * Agent-token scoped operations: messaging, channels, reactions, inbox, and
 * the relay action surface. Responses are raw upstream payloads.
 */
export interface RelayAgentThinClient {
  send(
    channel: string,
    text: string,
    options?: { attachments?: string[]; mode?: RelayMessageMode }
  ): Promise<unknown>;
  messages(channel: string, options?: RelayMessageListOptions): Promise<unknown[]>;
  reply(messageId: string, text: string): Promise<unknown>;
  thread(messageId: string, options?: { limit?: number }): Promise<unknown>;
  dm(
    to: string,
    text: string,
    options?: { mode?: RelayMessageMode; attachments?: string[] }
  ): Promise<unknown>;
  readonly dms: {
    conversations(): Promise<unknown[]>;
    messages(conversationId: string, options?: RelayMessageListOptions): Promise<unknown[]>;
    createGroup(input: { participants: string[]; name?: string }): Promise<RelayRawGroupConversation>;
    sendMessage(
      conversationId: string,
      text: string,
      options?: { attachments?: string[]; mode?: RelayMessageMode }
    ): Promise<unknown>;
  };
  readonly channels: {
    create(input: RelayCreateChannelInput): Promise<unknown>;
    list(options?: RelayListChannelsOptions): Promise<unknown[]>;
    join(name: string): Promise<unknown>;
    leave(name: string): Promise<unknown>;
    invite(channel: string, agent: string): Promise<unknown>;
    setTopic(name: string, topic: string): Promise<unknown>;
    archive(name: string): Promise<unknown>;
  };
  react(messageId: string, emoji: string): Promise<unknown>;
  unreact(messageId: string, emoji: string): Promise<unknown>;
  search(query: string, options?: { channel?: string; from?: string; limit?: number }): Promise<unknown[]>;
  inbox(options?: { limit?: number }): Promise<unknown>;
  markRead(messageId: string): Promise<unknown>;
  readers(messageId: string): Promise<unknown[]>;
  /** Relay action surface; absent on backends without action support. */
  readonly actions?: {
    invoke(name: string, input?: Record<string, unknown>): Promise<unknown>;
  };
}

/**
 * Agent-token scoped realtime event stream. Events arrive as raw upstream
 * payloads with dotted `type` fields (for example `message.created`).
 */
export interface RelayRealtimeThinClient {
  connect(): void;
  disconnect(): void;
  /** Subscribe to an event type (`'*'` for all); returns an unsubscribe function. */
  on(event: string, handler: (event: unknown) => void): () => void;
}

export interface RelayWorkspaceClientOptions extends RelaycastTelemetryOptions {
  /** Workspace key (`rk_live_...`). */
  workspaceKey: string;
  baseUrl?: string;
}

export interface RelayAgentClientOptions extends RelaycastTelemetryOptions {
  /** Agent token (`at_live_...`). */
  agentToken: string;
  baseUrl?: string;
  /**
   * Presence heartbeat interval forwarded to the underlying client.
   * Disabled by default so request-scoped clients spawn no background timers.
   */
  autoHeartbeatMs?: number | false;
}

export interface RelayRealtimeClientOptions extends RelaycastTelemetryOptions {
  /** Agent token (`at_live_...`). */
  agentToken: string;
  baseUrl?: string;
}

export interface RelayCreateWorkspaceOptions extends Omit<RelaycastTelemetryOptions, 'originActor'> {
  baseUrl?: string;
}

/**
 * Forward only the telemetry-override keys to `relaycastTelemetryOptions`, so
 * unset ones fall through to env resolution instead of being pinned to
 * `undefined` by an object spread.
 */
function pickTelemetryOverrides(options: RelaycastTelemetryOptions): RelaycastTelemetryOptions {
  return {
    ...(options.originActor === undefined ? {} : { originActor: options.originActor }),
    ...(options.agentRelayDistinctId === undefined
      ? {}
      : { agentRelayDistinctId: options.agentRelayDistinctId }),
    ...(options.agentRelayUserId === undefined ? {} : { agentRelayUserId: options.agentRelayUserId }),
    ...(options.agentRelayMachineId === undefined
      ? {}
      : { agentRelayMachineId: options.agentRelayMachineId }),
    ...(options.agentRelayOrgId === undefined ? {} : { agentRelayOrgId: options.agentRelayOrgId }),
    ...(options.agentRelayOrgSlug === undefined ? {} : { agentRelayOrgSlug: options.agentRelayOrgSlug }),
  };
}

function clientConfig(
  apiKey: string,
  options: { baseUrl?: string } & RelaycastTelemetryOptions
): { apiKey: string; baseUrl?: string } & RelaycastTelemetryOptions {
  return {
    apiKey,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...relaycastTelemetryOptions(pickTelemetryOverrides(options)),
  };
}

/**
 * Create a workspace-key scoped thin client.
 * @param options - Workspace key, optional base URL, and telemetry overrides
 * @returns Raw pass-through client for workspace-scoped operations
 */
export function createWorkspaceClient(options: RelayWorkspaceClientOptions): RelayWorkspaceThinClient {
  // The raw client is returned as-is; the thin interface narrows the surface
  // to the workspace operations this package supports.
  return new RelayCast(clientConfig(options.workspaceKey, options)) as unknown as RelayWorkspaceThinClient;
}

/**
 * Create an agent-token scoped thin client.
 * @param options - Agent token, optional base URL, heartbeat, and telemetry overrides
 * @returns Raw pass-through client for agent-scoped operations
 */
export function createAgentClient(options: RelayAgentClientOptions): RelayAgentThinClient {
  const relay = new RelayCast(clientConfig(options.agentToken, options));
  return relay.as(options.agentToken, {
    autoHeartbeatMs: options.autoHeartbeatMs ?? false,
  }) as unknown as RelayAgentThinClient;
}

/**
 * Create an agent-token scoped realtime event client.
 * @param options - Agent token, optional base URL, and telemetry overrides
 * @returns Realtime client streaming raw workspace events
 */
export function createRealtimeClient(options: RelayRealtimeClientOptions): RelayRealtimeThinClient {
  return new WsClient({
    token: options.agentToken,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...relaycastTelemetryOptions(pickTelemetryOverrides(options)),
  }) as unknown as RelayRealtimeThinClient;
}

/**
 * Create a new Relaycast workspace.
 * @param name - Human-readable workspace name
 * @param options - Optional base URL and telemetry overrides
 * @returns Raw workspace payload, including the workspace key
 */
export async function createWorkspace(
  name: string,
  options: RelayCreateWorkspaceOptions = {}
): Promise<Record<string, unknown>> {
  return (await RelayCast.createWorkspace(name, {
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...relaycastWorkspaceTelemetryOptions(pickTelemetryOverrides(options)),
  })) as Record<string, unknown>;
}
