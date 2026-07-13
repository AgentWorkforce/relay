/**
 * The structural adapter surface over the `@relaycast/sdk` client.
 *
 * `RelaycastWorkspaceLike` / `RelaycastAgentLike` describe only the slice of the
 * relaycast SDK that `RelaycastMessagingClient` depends on. Modeling them
 * structurally (rather than importing the SDK's concrete classes) keeps the
 * client testable with lightweight fakes and insulates relay from relaycast SDK
 * shape churn. `createRelaycastClient` is the single place that constructs a
 * real `RelayCast` instance from messaging options.
 */
import { RelayCast } from '@relaycast/sdk';
import type { AgentClientOptions, RelayCastOptions } from '@relaycast/sdk';

import { relaycastTelemetryOptions, type RelaycastTelemetryOptions } from '../relaycast-telemetry.js';
import { definedOptions } from './relaycast-translate.js';
import type {
  RelayCreateChannelInput,
  RelayListNodesOptions,
  RelayMessageBlock,
  RelayMessageListOptions,
  RelayUpdateChannelInput,
} from './types.js';

export type RelaycastWorkspaceLike = {
  agents: {
    list(query?: Record<string, unknown>): Promise<unknown[]>;
    get(name: string): Promise<unknown>;
    register(input: unknown): Promise<unknown>;
    /** Register an agent, rotating its token when the name already exists. */
    registerOrRotate?: (data: unknown) => Promise<unknown>;
    update(name: string, input: unknown): Promise<unknown>;
    delete(name: string): Promise<void>;
    presence(): Promise<unknown[]>;
  };
  channels: {
    list(options?: Record<string, unknown>): Promise<unknown[]>;
    get(name: string): Promise<unknown>;
  };
  messages: {
    list(channel: string, options?: RelayMessageListOptions): Promise<unknown[]>;
    get(id: string): Promise<unknown>;
    thread(id: string, options?: RelayMessageListOptions): Promise<unknown>;
    reactions(id: string): Promise<unknown[]>;
  };
  allDmConversations?: () => Promise<unknown[]>;
  dmMessages?: (conversationId: string, options?: RelayMessageListOptions) => Promise<unknown[]>;
  webhooks?: {
    create(data: unknown): Promise<unknown>;
    createInbound(data: unknown): Promise<unknown>;
    list(): Promise<unknown[]>;
    delete(id: string): Promise<void>;
    trigger(id: string, data: unknown, token?: string): Promise<unknown>;
  };
  subscriptions?: {
    create(data: unknown): Promise<unknown>;
    list(): Promise<unknown[]>;
    get(id: string): Promise<unknown>;
    delete(id: string): Promise<void>;
  };
  // Relaycast 2.x exposes the capability registry as `actions`
  // (formerly `commands`). Relay keeps the `commands`/`RelayCapability`
  // vocabulary on its own surface and binds it to this API.
  actions?: {
    register(data: unknown): Promise<unknown>;
    list(): Promise<unknown[]>;
    get(name: string): Promise<unknown>;
    delete(name: string): Promise<void>;
  };
  nodes?: {
    list(options?: RelayListNodesOptions): Promise<unknown[]>;
    get?(name: string): Promise<unknown>;
  };
  triggers?: {
    list(): Promise<unknown[]>;
    create(input: unknown): Promise<unknown>;
    update(id: string, input: unknown): Promise<unknown>;
    delete(id: string): Promise<void>;
  };
  workspace?: {
    info(): Promise<unknown>;
    fleetNodes?: {
      get(): Promise<unknown>;
      set(enabled: boolean): Promise<unknown>;
      inherit(): Promise<unknown>;
    };
  };
  as?: (agentToken: string, options?: AgentClientOptions) => RelaycastAgentLike;
  // Workspace-scoped realtime stream (relaycast 2.5+): lets a workspace-key
  // client receive all workspace-visible events without an agent identity.
  connect?: () => void;
  disconnect?: () => void;
  on?: { any(handler: (event: unknown) => void): () => void };
};

export type RelaycastDeliveryStatus = 'accepted' | 'delivered' | 'deferred' | 'failed';

/** The durable delivery methods an agent client must expose for server-backed inbox state. */
export type RelaycastAgentDeliverySurface = Required<
  Pick<RelaycastAgentLike, 'deliveries' | 'ackDelivery' | 'failDelivery' | 'deferDelivery'>
>;

export type RelaycastAgentLike = {
  me(): Promise<unknown>;
  connect(): void;
  disconnect(): Promise<void>;
  subscribe(channels: string[]): void;
  unsubscribe(channels: string[]): void;
  send(
    channel: string,
    text: string,
    options?: {
      attachments?: string[];
      blocks?: RelayMessageBlock[];
      mode?: 'wait' | 'steer';
      idempotencyKey?: string;
    }
  ): Promise<unknown>;
  messages(channel: string, options?: RelayMessageListOptions): Promise<unknown[]>;
  message(id: string): Promise<unknown>;
  reply(
    id: string,
    text: string,
    options?: { blocks?: RelayMessageBlock[]; idempotencyKey?: string }
  ): Promise<unknown>;
  thread(id: string, options?: RelayMessageListOptions): Promise<unknown>;
  dm(
    agent: string,
    text: string,
    options?: {
      mode?: 'wait' | 'steer';
      attachments?: string[];
      idempotencyKey?: string;
    }
  ): Promise<unknown>;
  dms: {
    conversations(): Promise<unknown[]>;
    messages(conversationId: string, options?: RelayMessageListOptions): Promise<unknown[]>;
    createGroup(
      options: { participants: string[]; name?: string },
      idempotency?: { idempotencyKey?: string }
    ): Promise<unknown>;
    sendMessage(
      conversationId: string,
      text: string,
      options?: {
        attachments?: string[];
        mode?: 'wait' | 'steer';
        idempotencyKey?: string;
      }
    ): Promise<unknown>;
  };
  channels: {
    create(input: RelayCreateChannelInput): Promise<unknown>;
    get(name: string): Promise<unknown>;
    join(name: string): Promise<unknown>;
    leave(name: string): Promise<void>;
    setTopic(name: string, topic: string): Promise<unknown>;
    archive(name: string): Promise<void>;
    invite(channel: string, agent: string): Promise<unknown>;
    members(name: string): Promise<unknown[]>;
    update(name: string, input: RelayUpdateChannelInput): Promise<unknown>;
    mute(name: string): Promise<void>;
    unmute(name: string): Promise<void>;
  };
  inbox(options?: { limit?: number }): Promise<unknown>;
  // Durable delivery ledger (relaycast 2.5+): per-recipient delivery rows with
  // FIFO replay of non-terminal items and idempotent ack/fail/defer transitions.
  deliveries?(options?: { status?: RelaycastDeliveryStatus; limit?: number }): Promise<unknown[]>;
  ackDelivery?(deliveryId: string): Promise<unknown>;
  failDelivery?(deliveryId: string, options?: { error?: string; retryable?: boolean }): Promise<unknown>;
  deferDelivery?(deliveryId: string, options: { availableAt: string; reason?: string }): Promise<unknown>;
  markRead(messageId: string): Promise<unknown>;
  readers(messageId: string): Promise<unknown[]>;
  readStatus(channel: string): Promise<unknown[]>;
  reactions(messageId: string): Promise<unknown[]>;
  react(messageId: string, emoji: string): Promise<unknown>;
  unreact(messageId: string, emoji: string): Promise<void>;
  search(
    query: string,
    options?: { channel?: string; from?: string; limit?: number; before?: string; after?: string }
  ): Promise<unknown[]>;
  actions?: {
    invoke(name: string, input?: Record<string, unknown>): Promise<unknown>;
    getInvocation(name: string, invocationId: string): Promise<unknown>;
    completeInvocation(name: string, invocationId: string, data: unknown): Promise<unknown>;
  };
  on: {
    any(handler: (event: unknown) => void): () => void;
    actionInvoked?(handler: (event: unknown) => void): () => void;
  };
};

export interface RelaycastMessagingOptions extends RelaycastTelemetryOptions {
  /** Workspace key returned when creating or joining an Agent Relay workspace. */
  workspaceKey?: string;
  /** @deprecated Use workspaceKey for public Agent Relay flows. */
  apiKey?: string;
  baseUrl?: string;
  retryPolicy?: RelayCastOptions['retryPolicy'];
  relaycast?: RelaycastWorkspaceLike;
  agentToken?: string;
  agentClient?: RelaycastAgentLike;
  agentClientOptions?: AgentClientOptions;
  /** Local node name used to resolve placement requests with `node: "self"`. */
  selfNodeName?: string;
  /** Default bounded placement queue TTL. RFC placeholder default is one hour. */
  placementTtlMs?: number;
  /** Max in-process placement requests allowed to wait for an eligible node. */
  maxQueuedPlacements?: number;
  /** Receives placement queue/reject/fail log lines. */
  placementLog?: (message: string) => void;
}

export function createRelaycastClient(options: RelaycastMessagingOptions): RelaycastWorkspaceLike {
  if (options.relaycast) return options.relaycast;
  const workspaceKey = options.workspaceKey ?? options.apiKey;
  if (!workspaceKey) {
    throw new Error('RelaycastMessagingClient requires workspaceKey when relaycast is not provided.');
  }

  return new RelayCast(
    definedOptions({
      apiKey: workspaceKey,
      baseUrl: options.baseUrl,
      retryPolicy: options.retryPolicy,
      ...relaycastTelemetryOptions({
        originActor: options.originActor,
        agentRelayDistinctId: options.agentRelayDistinctId,
      }),
    }) as RelayCastOptions
  ) as unknown as RelaycastWorkspaceLike;
}
