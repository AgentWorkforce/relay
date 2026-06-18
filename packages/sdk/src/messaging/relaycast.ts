import { RelayCast } from '@relaycast/sdk';
import type { AgentClientOptions, RelayCastOptions } from '@relaycast/sdk';

import { relaycastTelemetryOptions, type RelaycastTelemetryOptions } from '../relaycast-telemetry.js';
import {
  normalizeAgent,
  normalizeAgentPresence,
  normalizeAgentRegistration,
  normalizeChannel,
  normalizeChannelMember,
  normalizeChannelName,
  normalizeChannelReadStatus,
  normalizeDeliveryTransition,
  normalizeGroupDirectConversation,
  normalizeInbox,
  normalizeInboxItem,
  normalizeMessage,
  normalizeMessagingEvent,
  normalizeReaction,
  normalizeReadReceipt,
  normalizeSearchResult,
  normalizeThread,
} from './normalize.js';
import type {
  RelayActionInvocation,
  RelayActionInvocationAck,
  RelayCompleteInvocationInput,
  RelayAgent,
  RelayAgentPresence,
  RelayAgentRegistration,
  RelayChannel,
  RelayChannelMember,
  RelayChannelReadStatus,
  RelayCapability,
  RelayCreateChannelInput,
  RelayCreateGroupDirectMessageInput,
  RelayCreateInboundWebhookInput,
  RelayCreateSubscriptionInput,
  RelayCreateWebhookInput,
  RelayDeliveryResult,
  RelayDeliveryUnsupportedResult,
  RelayEventSubscription,
  RelayInboundWebhook,
  RelaySubscribeInput,
  RelayWebhookSubscription,
  RelayGroupDirectConversation,
  RelayRegisterCapabilityInput,
  RelayWebhook,
  RelayWorkspaceInfo,
  RelayWorkspaceFleetNodesConfig,
  InboxAckInput,
  InboxDeferInput,
  InboxFailInput,
  InboxItem,
  InboxListInput,
  InboxListResult,
  InboxMarkReadInput,
  InboxSubscribeInput,
  RelayInbox,
  RelayListAgentsOptions,
  RelayListChannelsOptions,
  RelayListNodesOptions,
  RelayListDirectMessagesInput,
  RelayMessage,
  RelayMessageAttachmentInput,
  RelayMessageBlock,
  RelayMessageListOptions,
  RelayMessageReaction,
  RelayMessagingCapabilities,
  RelayMessagingClient,
  RelayMessagingEvent,
  RelayMessagingEventMap,
  RelayNode,
  RelayNodeCapability,
  RelayPlacementReconcileEvent,
  RelayReadReceipt,
  RelayRegisterAgentInput,
  RelayReplyMessageInput,
  RelaySearchResult,
  RelaySendChannelMessageInput,
  RelaySendDirectMessageInput,
  RelaySendGroupDirectMessageInput,
  RelaySpawnPlacementAck,
  RelaySpawnPlacementInput,
  RelayThread,
  RelayTrigger,
  RelayTriggerInput,
  RelayUpdateAgentInput,
  RelayUpdateChannelInput,
} from './types.js';

/**
 * Translate a relay capability registration into a relaycast `actions.register`
 * request. Relaycast 2.x replaced the `commands` registry with `actions`:
 * `command` → `name`, `parameters` → `inputSchema`.
 */
function toRegisterActionRequest(input: RelayRegisterCapabilityInput): Record<string, unknown> {
  // `inputSchema` (a converted JSON Schema) takes precedence over the legacy
  // `parameters` field when both are present.
  const inputSchema = input.inputSchema ?? input.parameters;
  return {
    name: input.command,
    description: input.description,
    handlerAgent: input.handlerAgent,
    ...(inputSchema === undefined ? {} : { inputSchema }),
    ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
    ...(input.availableTo === undefined ? {} : { availableTo: input.availableTo }),
  };
}

/**
 * Translate a relaycast `ActionDefinition` back into a relay `RelayCapability`,
 * preserving the relay-facing `command`/`parameters` vocabulary.
 */
function toRelayCapability(raw: unknown): RelayCapability {
  const action = (raw ?? {}) as Record<string, unknown>;
  const command = (action.name ?? action.command) as string;
  return {
    ...action,
    command,
    description: action.description as string | undefined,
    handlerAgent: action.handlerAgent as string | undefined,
    parameters: action.inputSchema ?? action.parameters,
  };
}

function toRelayNode(raw: unknown): RelayNode {
  const node = (raw ?? {}) as Record<string, unknown>;
  const rawStatus = readStr(node, 'status');
  return {
    id: readStr(node, 'id', 'node_id'),
    nodeId: readStr(node, 'nodeId', 'node_id'),
    name: readStr(node, 'name') ?? '',
    status: rawStatus === 'online' || rawStatus === 'offline' ? rawStatus : 'unknown',
    live: readBoolean(node, 'live'),
    capabilities: Array.isArray(node.capabilities) ? node.capabilities.map(toRelayNodeCapability) : [],
    repoKeys: readRepoKeys(node),
    maxAgents: readNumber(node, 'maxAgents', 'max_agents'),
    activeAgents: readNumber(node, 'activeAgents', 'active_agents'),
    handlersLive: readBoolean(node, 'handlersLive', 'handlers_live'),
    load: readNumber(node, 'load'),
    lastHeartbeatAt: readStr(node, 'lastHeartbeatAt', 'last_heartbeat_at'),
    createdAt: readStr(node, 'createdAt', 'created_at'),
    tags: readStringArray(node, 'tags'),
    version: readStr(node, 'version'),
  };
}

function readRepoKeys(node: Record<string, unknown>): string[] | undefined {
  const direct = readStringArray(node, 'repoKeys') ?? readStringArray(node, 'repo_keys');
  if (direct) return direct;
  const repoPaths = readRecord(node, 'repoPaths', 'repo_paths');
  return repoPaths ? Object.keys(repoPaths).filter(Boolean) : undefined;
}

function toRelayNodeCapability(raw: unknown): RelayNodeCapability {
  const capability = (raw ?? {}) as Record<string, unknown>;
  return {
    name: readStr(capability, 'name') ?? '',
    kind: readStr(capability, 'kind'),
    metadata: readRecord(capability, 'metadata'),
  };
}

function toRelayTrigger(raw: unknown): RelayTrigger {
  const trigger = (raw ?? {}) as Record<string, unknown>;
  return {
    id: readStr(trigger, 'id'),
    channel: readStr(trigger, 'channel'),
    pattern: readStr(trigger, 'pattern', 'match'),
    mention: readMention(trigger.mention),
    actionName: readStr(trigger, 'actionName', 'action_name') ?? '',
    enabled: readBoolean(trigger, 'enabled') ?? true,
  };
}

function toTriggerRequest(input: RelayTriggerInput | Partial<RelayTriggerInput>): Record<string, unknown> {
  return {
    ...(input.channel !== undefined ? { channel: input.channel } : {}),
    ...(input.pattern !== undefined ? { pattern: input.pattern } : {}),
    ...(input.mention !== undefined ? { mention: input.mention } : {}),
    ...(input.actionName !== undefined
      ? { actionName: input.actionName, action_name: input.actionName }
      : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  };
}

function readNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readBoolean(record: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

function readMention(value: unknown): boolean | string | undefined {
  return typeof value === 'boolean' || typeof value === 'string' ? value : undefined;
}

/** Translate a relay completion result into the relaycast `CompleteInvocationRequest` shape. */
function toCompleteInvocationRequest(data: RelayCompleteInvocationInput): Record<string, unknown> {
  return {
    ...(data.output === undefined ? {} : { output: data.output }),
    ...(data.error === undefined ? {} : { error: data.error }),
    ...(data.durationMs === undefined ? {} : { durationMs: data.durationMs }),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readStr(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function readRecord(record: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

function toRelayWorkspaceFleetNodesConfig(raw: unknown): RelayWorkspaceFleetNodesConfig {
  const record = asRecord(raw);
  return {
    enabled: readBoolean(record, 'enabled') ?? false,
    defaultEnabled: readBoolean(record, 'defaultEnabled', 'default_enabled') ?? false,
    override: readBoolean(record, 'override') ?? null,
  };
}

type PlacementReconcileReason = 'no_eligible_node' | 'target_offline' | 'unmapped_repo';

type PlacementSelection =
  | { node: RelayNode; message?: never; hardFail?: never; reason?: never; reconcileReason?: never }
  | {
      // Hard failure — thrown before any side effect; `reason` is the error code.
      node?: never;
      message: string;
      hardFail: true;
      reason: 'capability_mismatch';
      reconcileReason: PlacementReconcileReason;
    }
  | {
      // Retryable — queued and reconciled; only `reconcileReason` is consumed.
      node?: never;
      message: string;
      hardFail?: false;
      reason?: never;
      reconcileReason: PlacementReconcileReason;
    };

export class RelayPlacementError extends Error {
  readonly code: 'capability_mismatch' | 'placement_queue_full' | 'placement_ttl_expired' | 'unmapped_repo';
  readonly capability: string;
  readonly node?: string;
  readonly repo?: string;
  readonly attempts: number;

  constructor(
    code: RelayPlacementError['code'],
    message: string,
    context: { capability: string; node?: string; repo?: string; attempts: number }
  ) {
    super(message);
    this.name = 'RelayPlacementError';
    this.code = code;
    this.capability = context.capability;
    this.node = context.node;
    this.repo = context.repo;
    this.attempts = context.attempts;
  }
}

function nonEmptyPlacement(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}

function placementActionName(capability: string): string {
  return capability.startsWith('spawn:') ? 'spawn' : capability;
}

function placementActionInput(
  input: Record<string, unknown> | undefined,
  placement: { capability: string; node: string; repo?: string; ttlMs: number }
): Record<string, unknown> {
  const payload = { ...(input ?? {}) };
  payload.capability = placement.capability;
  payload.node = placement.node;
  payload.target_node = placement.node;
  if (placement.repo) payload.repo = placement.repo;
  if (placement.ttlMs > 0) {
    payload.ttl_override_ms = placement.ttlMs;
  }
  if (placement.capability.startsWith('spawn:')) {
    // The broker picks the harness from `cli`, but node eligibility was gated on
    // the `spawn:<cli>` capability. An explicit, mismatched `cli` would select a
    // harness the chosen node never advertised — reject it instead of silently
    // dispatching the wrong harness.
    const capabilityCli = placement.capability.slice('spawn:'.length);
    if (typeof payload.cli === 'string' && payload.cli !== capabilityCli) {
      throw new RelayPlacementError(
        'capability_mismatch',
        `Placement rejected: input cli "${payload.cli}" does not match capability "${placement.capability}"`,
        { capability: placement.capability, node: placement.node, repo: placement.repo, attempts: 0 }
      );
    }
    payload.cli = capabilityCli;
  }
  return payload;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Normalize a relaycast invoke ack (camelized) into the relay `RelayActionInvocationAck`. */
function normalizeActionInvocationAck(raw: unknown): RelayActionInvocationAck {
  const record = asRecord(raw);
  return {
    invocationId: readStr(record, 'invocationId', 'invocation_id') ?? '',
    actionName: readStr(record, 'actionName', 'action_name') ?? '',
    ...(readStr(record, 'handlerAgentId', 'handler_agent_id')
      ? { handlerAgentId: readStr(record, 'handlerAgentId', 'handler_agent_id') }
      : {}),
    ...(readStr(record, 'handlerNodeId', 'handler_node_id')
      ? { handlerNodeId: readStr(record, 'handlerNodeId', 'handler_node_id') }
      : {}),
    ...(readStr(record, 'dispatchedNodeId', 'dispatched_node_id')
      ? { dispatchedNodeId: readStr(record, 'dispatchedNodeId', 'dispatched_node_id') }
      : {}),
    ...(readRecord(record, 'input') ? { input: readRecord(record, 'input') } : {}),
    ...(readStr(record, 'status') ? { status: readStr(record, 'status') } : {}),
    ...(readStr(record, 'createdAt', 'created_at')
      ? { createdAt: readStr(record, 'createdAt', 'created_at') }
      : {}),
  };
}

/** Normalize a relaycast invocation record (camelized) into `RelayActionInvocation`. */
function normalizeActionInvocation(raw: unknown): RelayActionInvocation {
  const record = asRecord(raw);
  return {
    invocationId: readStr(record, 'invocationId', 'invocation_id') ?? '',
    actionName: readStr(record, 'actionName', 'action_name') ?? '',
    callerId: (readStr(record, 'callerId', 'caller_id') ?? null) as string | null,
    callerName: (readStr(record, 'callerName', 'caller_name') ?? null) as string | null,
    input: readRecord(record, 'input') ?? {},
    output: readRecord(record, 'output') ?? null,
    status: readStr(record, 'status') ?? 'invoked',
    error: (readStr(record, 'error') ?? null) as string | null,
    durationMs:
      typeof record.durationMs === 'number'
        ? record.durationMs
        : typeof record.duration_ms === 'number'
          ? (record.duration_ms as number)
          : null,
    ...(readStr(record, 'createdAt', 'created_at')
      ? { createdAt: readStr(record, 'createdAt', 'created_at') }
      : {}),
    completedAt: (readStr(record, 'completedAt', 'completed_at') ?? null) as string | null,
  };
}

/** Normalize a relaycast inbound webhook (snake_case) into `RelayInboundWebhook`. */
function normalizeInboundWebhook(raw: unknown): RelayInboundWebhook {
  const record = asRecord(raw);
  return {
    webhookId: readStr(record, 'webhookId', 'webhook_id', 'id') ?? '',
    url: readStr(record, 'url') ?? '',
    token: readStr(record, 'token') ?? '',
    channel: readStr(record, 'channel') ?? '',
    ...(readStr(record, 'name') ? { name: readStr(record, 'name') } : {}),
    ...(readStr(record, 'createdAt', 'created_at')
      ? { createdAt: readStr(record, 'createdAt', 'created_at') }
      : {}),
  };
}

/** Normalize a relaycast event subscription into `RelayWebhookSubscription`. */
function normalizeWebhookSubscription(raw: unknown): RelayWebhookSubscription {
  const record = asRecord(raw);
  const events = Array.isArray(record.events)
    ? record.events.filter((event): event is string => typeof event === 'string')
    : undefined;
  return {
    id: readStr(record, 'id') ?? '',
    ...(readStr(record, 'url') ? { url: readStr(record, 'url') } : {}),
    ...(events ? { events } : {}),
    ...(readStr(record, 'createdAt', 'created_at')
      ? { createdAt: readStr(record, 'createdAt', 'created_at') }
      : {}),
  };
}

type RelaycastWorkspaceLike = {
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

type RelaycastDeliveryStatus = 'accepted' | 'delivered' | 'deferred' | 'failed';

/** The durable delivery methods an agent client must expose for server-backed inbox state. */
type RelaycastAgentDeliverySurface = Required<
  Pick<RelaycastAgentLike, 'deliveries' | 'ackDelivery' | 'failDelivery' | 'deferDelivery'>
>;

type RelaycastAgentLike = {
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

function definedOptions<T extends Record<string, unknown>>(options: T): Partial<T> {
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function toMessageListOptions(options?: RelayMessageListOptions): RelayMessageListOptions | undefined {
  if (!options) return undefined;
  return definedOptions({
    limit: options.limit,
    before: options.before,
    after: options.after,
  });
}

function serializeAttachmentInputs(input?: RelayMessageAttachmentInput[]): string[] | undefined {
  if (!input) return undefined;
  return input.map((attachment) =>
    typeof attachment === 'string' ? attachment : JSON.stringify(attachment)
  );
}

function createRelaycastClient(options: RelaycastMessagingOptions): RelaycastWorkspaceLike {
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

export class RelaycastMessagingClient implements RelayMessagingClient {
  readonly capabilities: RelayMessagingCapabilities;

  private readonly relaycast: RelaycastWorkspaceLike;
  private readonly agentClient?: RelaycastAgentLike;
  private readonly selfNodeName?: string;
  private readonly placementTtlMs: number;
  private readonly maxQueuedPlacements: number;
  private readonly placementLog?: (message: string) => void;
  private queuedPlacements = 0;
  private readonly eventHandlers = new Map<
    keyof RelayMessagingEventMap,
    Set<(event: RelayMessagingEvent) => void | Promise<void>>
  >();
  private eventUnsubscribe?: () => void;

  constructor(options: RelaycastMessagingOptions) {
    this.relaycast = createRelaycastClient(options);
    this.agentClient =
      options.agentClient ??
      (options.agentToken ? this.relaycast.as?.(options.agentToken, options.agentClientOptions) : undefined);
    this.selfNodeName = options.selfNodeName;
    this.placementTtlMs = options.placementTtlMs ?? 60 * 60 * 1000;
    this.maxQueuedPlacements = options.maxQueuedPlacements ?? 100;
    this.placementLog = options.placementLog;
    // Durable delivery state is agent-scoped: it requires an agent client that
    // exposes the relaycast delivery ledger (deliveries list + transitions).
    const durable = this.deliverySurface() !== undefined;
    this.capabilities = {
      serverDeliveryState: durable,
      durableDelivery: durable,
      durableAck: durable,
      durableFail: durable,
      durableDefer: durable,
    };
  }

  readonly agents = {
    list: async (options?: RelayListAgentsOptions): Promise<RelayAgent[]> => {
      const agents = await this.relaycast.agents.list(definedOptions({ status: options?.status }));
      return agents.map(normalizeAgent);
    },
    get: async (name: string): Promise<RelayAgent> => normalizeAgent(await this.relaycast.agents.get(name)),
    register: async (input: RelayRegisterAgentInput): Promise<RelayAgentRegistration> =>
      normalizeAgentRegistration(await this.relaycast.agents.register(input)),
    registerOrRotate: async (input: RelayRegisterAgentInput): Promise<RelayAgentRegistration> =>
      normalizeAgentRegistration(
        this.relaycast.agents.registerOrRotate
          ? await this.relaycast.agents.registerOrRotate(input)
          : await this.relaycast.agents.register(input)
      ),
    me: async (): Promise<RelayAgent> => normalizeAgent(await this.requireAgentClient('agents.me').me()),
    update: async (name: string, input: RelayUpdateAgentInput): Promise<RelayAgent> =>
      normalizeAgent(await this.relaycast.agents.update(name, input)),
    delete: async (name: string): Promise<void> => {
      await this.relaycast.agents.delete(name);
    },
    presence: async (): Promise<RelayAgentPresence[]> => {
      const presence = await this.relaycast.agents.presence();
      return presence.map(normalizeAgentPresence);
    },
  };

  readonly channels = {
    list: async (options?: RelayListChannelsOptions): Promise<RelayChannel[]> => {
      const channels = await this.relaycast.channels.list(
        definedOptions({ includeArchived: options?.includeArchived })
      );
      return channels.map(normalizeChannel);
    },
    get: async (name: string): Promise<RelayChannel> =>
      normalizeChannel(await this.relaycast.channels.get(normalizeChannelName(name))),
    create: async (input: RelayCreateChannelInput): Promise<RelayChannel> =>
      normalizeChannel(await this.requireAgentClient('channels.create').channels.create(input)),
    update: async (name: string, input: RelayUpdateChannelInput): Promise<RelayChannel> =>
      normalizeChannel(
        await this.requireAgentClient('channels.update').channels.update(normalizeChannelName(name), input)
      ),
    archive: async (name: string): Promise<void> => {
      await this.requireAgentClient('channels.archive').channels.archive(normalizeChannelName(name));
    },
    join: async (name: string): Promise<void> => {
      await this.requireAgentClient('channels.join').channels.join(normalizeChannelName(name));
    },
    leave: async (name: string): Promise<void> => {
      await this.requireAgentClient('channels.leave').channels.leave(normalizeChannelName(name));
    },
    invite: async (channel: string, agent: string): Promise<void> => {
      await this.requireAgentClient('channels.invite').channels.invite(normalizeChannelName(channel), agent);
    },
    members: async (name: string): Promise<RelayChannelMember[]> => {
      const members = await this.requireAgentClient('channels.members').channels.members(
        normalizeChannelName(name)
      );
      return members.map(normalizeChannelMember);
    },
    mute: async (name: string): Promise<void> => {
      await this.requireAgentClient('channels.mute').channels.mute(normalizeChannelName(name));
    },
    unmute: async (name: string): Promise<void> => {
      await this.requireAgentClient('channels.unmute').channels.unmute(normalizeChannelName(name));
    },
  };

  readonly messages = {
    send: async (input: RelaySendChannelMessageInput): Promise<RelayMessage> => {
      const message = await this.requireAgentClient('messages.send').send(
        input.channel,
        input.text,
        definedOptions({
          attachments: serializeAttachmentInputs(input.attachments),
          blocks: input.blocks,
          mode: input.mode,
          idempotencyKey: input.idempotencyKey,
        })
      );
      return normalizeMessage(message, { kind: 'channel', channelName: normalizeChannelName(input.channel) });
    },
    list: async (channel: string, options?: RelayMessageListOptions): Promise<RelayMessage[]> => {
      const channelName = normalizeChannelName(channel);
      const messages = await this.relaycast.messages.list(channelName, toMessageListOptions(options));
      return messages.map((message) => normalizeMessage(message, { kind: 'channel', channelName }));
    },
    get: async (id: string): Promise<RelayMessage> => normalizeMessage(await this.relaycast.messages.get(id)),
    reply: async (input: RelayReplyMessageInput): Promise<RelayMessage> => {
      const message = await this.requireAgentClient('messages.reply').reply(
        input.messageId,
        input.text,
        definedOptions({ blocks: input.blocks, idempotencyKey: input.idempotencyKey })
      );
      return normalizeMessage(message, {
        kind: 'thread_reply',
        parentId: input.messageId,
        threadId: input.messageId,
      });
    },
    direct: async (input: RelaySendDirectMessageInput): Promise<RelayMessage> => {
      const response = await this.requireAgentClient('messages.direct').dm(
        input.to,
        input.text,
        definedOptions({
          attachments: serializeAttachmentInputs(input.attachments),
          mode: input.mode,
          idempotencyKey: input.idempotencyKey,
        })
      );
      return this.normalizeDirectResponse(response, 'dm');
    },
    groupDirect: async (input: RelaySendGroupDirectMessageInput): Promise<RelayMessage> => {
      const agent = this.requireAgentClient('messages.groupDirect');
      const conversationId =
        input.conversationId ??
        normalizeGroupDirectConversation(
          await agent.dms.createGroup(
            { participants: input.participants ?? [], ...(input.name ? { name: input.name } : {}) },
            definedOptions({ idempotencyKey: input.idempotencyKey })
          )
        ).id;

      if (!conversationId) {
        throw new Error(
          'messages.groupDirect requires conversationId or participants that create a conversation.'
        );
      }

      const response = await agent.dms.sendMessage(
        conversationId,
        input.text,
        definedOptions({
          attachments: serializeAttachmentInputs(input.attachments),
          mode: input.mode,
          idempotencyKey: input.idempotencyKey,
        })
      );
      return this.normalizeDirectResponse(response, 'group_dm', conversationId);
    },
    createGroupDirect: async (
      input: RelayCreateGroupDirectMessageInput
    ): Promise<RelayGroupDirectConversation> =>
      normalizeGroupDirectConversation(
        await this.requireAgentClient('messages.createGroupDirect').dms.createGroup(
          { participants: input.participants, ...(input.name ? { name: input.name } : {}) },
          definedOptions({ idempotencyKey: input.idempotencyKey })
        )
      ),
    listDirect: async (input: RelayListDirectMessagesInput): Promise<RelayMessage[]> => {
      const options = toMessageListOptions(input);
      const list = this.agentClient
        ? await this.agentClient.dms.messages(input.conversationId, options)
        : await this.requireWorkspaceDmMessages()(input.conversationId, options);
      return list.map((message) =>
        normalizeMessage(message, { kind: 'dm', conversationId: input.conversationId })
      );
    },
    markRead: async (messageId: string): Promise<RelayReadReceipt> =>
      normalizeReadReceipt(await this.requireAgentClient('messages.markRead').markRead(messageId)),
    readers: async (messageId: string): Promise<RelayReadReceipt[]> => {
      const readers = await this.requireAgentClient('messages.readers').readers(messageId);
      return readers.map((reader) =>
        normalizeReadReceipt({ ...((reader ?? {}) as Record<string, unknown>), messageId })
      );
    },
    readStatus: async (channel: string): Promise<RelayChannelReadStatus[]> => {
      const statuses = await this.requireAgentClient('messages.readStatus').readStatus(
        normalizeChannelName(channel)
      );
      return statuses.map(normalizeChannelReadStatus);
    },
    reactions: async (messageId: string): Promise<RelayMessageReaction[]> => {
      const reactions = this.agentClient
        ? await this.agentClient.reactions(messageId)
        : await this.relaycast.messages.reactions(messageId);
      return reactions.map(normalizeReaction);
    },
    react: async (messageId: string, emoji: string): Promise<RelayMessageReaction> =>
      normalizeReaction(await this.requireAgentClient('messages.react').react(messageId, emoji)),
    unreact: async (messageId: string, emoji: string): Promise<void> => {
      await this.requireAgentClient('messages.unreact').unreact(messageId, emoji);
    },
    search: async (
      query: string,
      options?: { channel?: string; from?: string; limit?: number; before?: string; after?: string }
    ): Promise<RelaySearchResult[]> => {
      const results = await this.requireAgentClient('messages.search').search(
        query,
        definedOptions({
          channel: options?.channel ? normalizeChannelName(options.channel) : undefined,
          from: options?.from,
          limit: options?.limit,
          before: options?.before,
          after: options?.after,
        })
      );
      return results.map(normalizeSearchResult);
    },
  };

  readonly threads = {
    get: async (messageId: string, options?: RelayMessageListOptions): Promise<RelayThread> =>
      normalizeThread(await this.relaycast.messages.thread(messageId, toMessageListOptions(options))),
    reply: async (input: RelayReplyMessageInput): Promise<RelayMessage> => this.messages.reply(input),
  };

  readonly inbox = {
    get: async (options?: { limit?: number }): Promise<RelayInbox> =>
      normalizeInbox(
        await this.requireAgentClient('inbox.get').inbox(definedOptions({ limit: options?.limit }))
      ),
    /**
     * List durable deliveries queued for the authenticated agent. The
     * relaycast ledger replays non-terminal items (accepted + deferred) in
     * FIFO order with the message payload embedded. The underlying API has no
     * cursor, so `nextCursor` is never set and `before`/`after` are ignored.
     */
    list: async (input?: InboxListInput): Promise<InboxListResult> => {
      const surface = this.deliverySurface();
      if (!surface) return { items: [] };
      const deliveries = await surface.deliveries(definedOptions({ limit: input?.limit }));
      return {
        items: deliveries.map((delivery) =>
          normalizeInboxItem(delivery, definedOptions({ recipientName: input?.agentName }))
        ),
      };
    },
    /**
     * Stream durable deliveries: seed from the non-terminal queue, then push
     * items announced by `delivery.accepted` WebSocket events, deduplicated by
     * delivery id. Falls back to an empty stream without an agent client.
     */
    subscribe: (input?: InboxSubscribeInput): AsyncIterable<InboxItem> => {
      const surface = this.deliverySurface();
      if (!surface) return this.emptyInboxSubscription();
      return this.createInboxSubscription(surface, input);
    },
    ack: async (input: InboxAckInput): Promise<RelayDeliveryResult> => {
      const surface = this.deliverySurface();
      if (!surface) return this.unsupportedInboxDelivery('ack', input.inboxItemId);
      return normalizeDeliveryTransition('ack', await surface.ackDelivery(input.inboxItemId));
    },
    fail: async (input: InboxFailInput): Promise<RelayDeliveryResult> => {
      const surface = this.deliverySurface();
      if (!surface) return this.unsupportedInboxDelivery('fail', input.inboxItemId, input.error);
      return normalizeDeliveryTransition(
        'fail',
        await surface.failDelivery(
          input.inboxItemId,
          definedOptions({ error: input.error, retryable: input.retry })
        )
      );
    },
    defer: async (input: InboxDeferInput): Promise<RelayDeliveryResult> => {
      const surface = this.deliverySurface();
      if (!surface) {
        return this.unsupportedInboxDelivery('defer', input.inboxItemId, input.reason, input.availableAt);
      }
      return normalizeDeliveryTransition(
        'defer',
        await surface.deferDelivery(input.inboxItemId, {
          availableAt: input.availableAt,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        })
      );
    },
    markRead: async (input: InboxMarkReadInput): Promise<RelayDeliveryResult> =>
      this.unsupportedInboxDelivery(
        'ack',
        input.inboxItemId,
        'The Relaycast delivery ledger has no read state; use inbox.ack to mark a delivery handled.'
      ),
  };

  readonly events = {
    connect: (): void => {
      if (this.eventUnsubscribe) return;
      const forward = (event: unknown): void => this.emitEvent(normalizeMessagingEvent(event));
      // Agent-scoped clients stream through their own connection; a workspace-key
      // client streams all workspace-visible events through the workspace stream.
      if (this.agentClient) {
        this.agentClient.connect();
        this.eventUnsubscribe = this.agentClient.on.any(forward);
        return;
      }
      if (typeof this.relaycast.connect === 'function' && this.relaycast.on) {
        this.relaycast.connect();
        this.eventUnsubscribe = this.relaycast.on.any(forward);
        return;
      }
      // No agent client and no workspace stream available: preserve the
      // explicit "needs an agent token" error.
      this.requireAgentClient('events.connect');
    },
    disconnect: async (): Promise<void> => {
      this.eventUnsubscribe?.();
      this.eventUnsubscribe = undefined;
      if (this.agentClient) {
        await this.agentClient.disconnect();
      } else if (typeof this.relaycast.disconnect === 'function') {
        this.relaycast.disconnect();
      }
    },
    subscribe: (channels: string[]): void => {
      this.requireAgentClient('events.subscribe').subscribe(channels.map(normalizeChannelName));
    },
    unsubscribe: (channels: string[]): void => {
      this.requireAgentClient('events.unsubscribe').unsubscribe(channels.map(normalizeChannelName));
    },
    on: <K extends keyof RelayMessagingEventMap>(
      event: K,
      handler: (...args: RelayMessagingEventMap[K]) => void | Promise<void>
    ): (() => void) => this.addEventListener(event, handler),
  };

  /**
   * Durable delivery transitions keyed by the relaycast delivery id (the
   * `InboxItem.id` returned by `inbox.list`/`inbox.subscribe`). Transitions
   * are idempotent on the server.
   */
  readonly deliveries = {
    ack: async (deliveryId: string): Promise<RelayDeliveryResult> => {
      const surface = this.deliverySurface();
      if (!surface) return this.unsupportedInboxDelivery('ack', deliveryId);
      return normalizeDeliveryTransition('ack', await surface.ackDelivery(deliveryId));
    },
    fail: async (deliveryId: string, reason?: string): Promise<RelayDeliveryResult> => {
      const surface = this.deliverySurface();
      if (!surface) return this.unsupportedInboxDelivery('fail', deliveryId, reason);
      return normalizeDeliveryTransition(
        'fail',
        await surface.failDelivery(deliveryId, definedOptions({ error: reason }))
      );
    },
    defer: async (deliveryId: string, deferUntil?: string): Promise<RelayDeliveryResult> => {
      const surface = this.deliverySurface();
      if (!surface) return this.unsupportedInboxDelivery('defer', deliveryId, undefined, deferUntil);
      return normalizeDeliveryTransition(
        'defer',
        await surface.deferDelivery(deliveryId, {
          // The relaycast defer transition requires an explicit availability
          // time; default to a short retry window when none is given.
          availableAt: deferUntil ?? new Date(Date.now() + 30_000).toISOString(),
        })
      );
    },
  };

  readonly integrations = {
    webhooks: {
      create: async (input: RelayCreateWebhookInput): Promise<RelayWebhook> =>
        (await this.requireWebhooks().create(input)) as RelayWebhook,
      list: async (): Promise<RelayWebhook[]> => (await this.requireWebhooks().list()) as RelayWebhook[],
      delete: async (id: string): Promise<void> => {
        await this.requireWebhooks().delete(id);
      },
      trigger: async (id: string, payload?: Record<string, unknown>): Promise<unknown> =>
        this.requireWebhooks().trigger(id, payload ?? {}),
    },
    subscriptions: {
      create: async (input: RelayCreateSubscriptionInput): Promise<RelayEventSubscription> =>
        (await this.requireSubscriptions().create(input)) as RelayEventSubscription,
      list: async (): Promise<RelayEventSubscription[]> =>
        (await this.requireSubscriptions().list()) as RelayEventSubscription[],
      get: async (id: string): Promise<RelayEventSubscription> =>
        (await this.requireSubscriptions().get(id)) as RelayEventSubscription,
      delete: async (id: string): Promise<void> => {
        await this.requireSubscriptions().delete(id);
      },
    },
  };

  readonly webhooks = {
    createInbound: async (input: RelayCreateInboundWebhookInput): Promise<RelayInboundWebhook> =>
      normalizeInboundWebhook(
        await this.requireWebhooks().createInbound({
          channel: normalizeChannelName(input.channel),
          ...(input.name === undefined ? {} : { name: input.name }),
        })
      ),
    subscribe: async (input: RelaySubscribeInput): Promise<RelayWebhookSubscription> =>
      normalizeWebhookSubscription(
        await this.requireSubscriptions().create(
          definedOptions({
            url: input.url,
            events: input.events,
            secret: input.secret,
            headers: input.headers,
          })
        )
      ),
    list: async (): Promise<RelayInboundWebhook[]> =>
      (await this.requireWebhooks().list()).map(normalizeInboundWebhook),
    delete: async (webhookId: string): Promise<void> => {
      await this.requireWebhooks().delete(webhookId);
    },
    subscriptions: async (): Promise<RelayWebhookSubscription[]> =>
      (await this.requireSubscriptions().list()).map(normalizeWebhookSubscription),
    unsubscribe: async (id: string): Promise<void> => {
      await this.requireSubscriptions().delete(id);
    },
  };

  readonly commands = {
    register: async (input: RelayRegisterCapabilityInput): Promise<RelayCapability> =>
      toRelayCapability(await this.requireActions().register(toRegisterActionRequest(input))),
    list: async (): Promise<RelayCapability[]> => (await this.requireActions().list()).map(toRelayCapability),
    delete: async (command: string): Promise<void> => {
      await this.requireActions().delete(command);
    },
    available: (): boolean => Boolean(this.relaycast.actions),
    agentScoped: (): boolean => Boolean(this.agentClient?.actions),
    invoke: async (name: string, input?: Record<string, unknown>): Promise<RelayActionInvocationAck> =>
      normalizeActionInvocationAck(await this.requireAgentActions('commands.invoke').invoke(name, input)),
    getInvocation: async (name: string, invocationId: string): Promise<RelayActionInvocation> =>
      normalizeActionInvocation(
        await this.requireAgentActions('commands.getInvocation').getInvocation(name, invocationId)
      ),
    completeInvocation: async (
      name: string,
      invocationId: string,
      data: RelayCompleteInvocationInput
    ): Promise<RelayActionInvocation> =>
      normalizeActionInvocation(
        await this.requireAgentActions('commands.completeInvocation').completeInvocation(
          name,
          invocationId,
          toCompleteInvocationRequest(data)
        )
      ),
  };

  readonly nodes = {
    list: async (options?: RelayListNodesOptions): Promise<RelayNode[]> =>
      (await this.requireNodes().list(options)).map(toRelayNode),
    get: async (name: string): Promise<RelayNode | null> => {
      const nodes = this.requireNodes();
      if (nodes.get) {
        const raw = await nodes.get(name);
        return raw ? toRelayNode(raw) : null;
      }
      const [node] = (await nodes.list({ name })).map(toRelayNode);
      return node ?? null;
    },
  };

  readonly placement = {
    spawn: async (input: RelaySpawnPlacementInput): Promise<RelaySpawnPlacementAck> => {
      const capability = nonEmptyPlacement(input.capability, 'placement capability');
      const repo = input.repo?.trim() || undefined;
      const targetNode = this.resolvePlacementNode(input.node, input.selfNodeName);
      const ttlMs = Math.max(0, input.ttlMs ?? input.ttlOverrideMs ?? this.placementTtlMs);
      const pollIntervalMs = Math.max(25, input.pollIntervalMs ?? 1_000);
      const startedAt = Date.now();
      let queued = false;
      let attempts = 0;

      try {
        while (true) {
          attempts += 1;
          const decision = await this.selectPlacementNode({ capability, repo, targetNode });
          if (decision.node) {
            const actionName = input.actionName ?? placementActionName(capability);
            const actionInput = placementActionInput(input.input, {
              capability,
              node: decision.node.name,
              repo,
              ttlMs,
            });
            const ack = await this.commands.invoke(actionName, actionInput);
            return {
              ...ack,
              node: decision.node,
              placement: {
                capability,
                node: decision.node.name,
                ...(repo ? { repo } : {}),
                attempts,
                queued,
              },
            };
          }

          if (decision.hardFail) {
            this.logPlacement(input, decision.message);
            throw new RelayPlacementError(decision.reason, decision.message, {
              capability,
              node: targetNode,
              repo,
              attempts,
            });
          }

          if (input.failFast || Date.now() - startedAt >= ttlMs) {
            // A repo that no live, capable node maps will never drain by waiting,
            // so report it as `unmapped_repo` rather than a generic TTL expiry.
            const code: RelayPlacementError['code'] =
              decision.reconcileReason === 'unmapped_repo' ? 'unmapped_repo' : 'placement_ttl_expired';
            const message =
              code === 'unmapped_repo'
                ? `${decision.message}; no node maps the requested repo`
                : `${decision.message}; placement TTL expired`;
            await this.reconcilePlacement(input, {
              action: 'failed',
              reason: decision.reconcileReason,
              capability,
              ...(targetNode ? { node: targetNode } : {}),
              ...(repo ? { repo } : {}),
              attempts,
              message,
            });
            throw new RelayPlacementError(code, message, {
              capability,
              node: targetNode,
              repo,
              attempts,
            });
          }

          if (!queued) {
            if (this.queuedPlacements >= this.maxQueuedPlacements) {
              const message = `${decision.message}; placement queue full`;
              await this.reconcilePlacement(input, {
                action: 'failed',
                reason: decision.reconcileReason,
                capability,
                ...(targetNode ? { node: targetNode } : {}),
                ...(repo ? { repo } : {}),
                attempts,
                message,
              });
              throw new RelayPlacementError('placement_queue_full', message, {
                capability,
                node: targetNode,
                repo,
                attempts,
              });
            }
            this.queuedPlacements += 1;
            queued = true;
            await this.reconcilePlacement(input, {
              action: 'queued',
              reason: decision.reconcileReason,
              capability,
              ...(targetNode ? { node: targetNode } : {}),
              ...(repo ? { repo } : {}),
              attempts,
              message: decision.message,
            });
          }

          // Floor the queued delay at a small minimum so a near-zero remaining
          // TTL cannot busy-spin the poll loop before the next expiry check.
          await delay(Math.max(5, Math.min(pollIntervalMs, ttlMs - (Date.now() - startedAt))));
        }
      } finally {
        if (queued) this.queuedPlacements = Math.max(0, this.queuedPlacements - 1);
      }
    },
  };

  readonly triggers = {
    list: async (): Promise<RelayTrigger[]> => (await this.requireTriggers().list()).map(toRelayTrigger),
    create: async (input: RelayTriggerInput): Promise<RelayTrigger> =>
      toRelayTrigger(await this.requireTriggers().create(toTriggerRequest(input))),
    update: async (id: string, input: Partial<RelayTriggerInput>): Promise<RelayTrigger> =>
      toRelayTrigger(await this.requireTriggers().update(id, toTriggerRequest(input))),
    delete: async (id: string): Promise<void> => {
      await this.requireTriggers().delete(id);
    },
  };

  readonly workspace = {
    info: async (): Promise<RelayWorkspaceInfo> => {
      if (!this.relaycast.workspace) {
        throw new Error('RelaycastMessagingClient.workspace.info requires the relaycast workspace API.');
      }
      return (await this.relaycast.workspace.info()) as RelayWorkspaceInfo;
    },
    fleetNodes: {
      get: async (): Promise<RelayWorkspaceFleetNodesConfig> => {
        return toRelayWorkspaceFleetNodesConfig(await this.requireWorkspaceFleetNodes().get());
      },
      set: async (enabled: boolean): Promise<RelayWorkspaceFleetNodesConfig> => {
        return toRelayWorkspaceFleetNodesConfig(await this.requireWorkspaceFleetNodes().set(enabled));
      },
      inherit: async (): Promise<RelayWorkspaceFleetNodesConfig> => {
        return toRelayWorkspaceFleetNodesConfig(await this.requireWorkspaceFleetNodes().inherit());
      },
    },
  };

  private resolvePlacementNode(node: string | 'self' | undefined, selfNodeName?: string): string | undefined {
    if (!node) return undefined;
    if (node !== 'self') return nonEmptyPlacement(node, 'placement node');
    const resolved = selfNodeName ?? this.selfNodeName;
    if (!resolved) {
      throw new Error('placement node "self" requires selfNodeName on the request or client.');
    }
    return nonEmptyPlacement(resolved, 'placement self node');
  }

  private async selectPlacementNode(input: {
    capability: string;
    repo?: string;
    targetNode?: string;
  }): Promise<PlacementSelection> {
    if (input.targetNode) {
      const node = await this.nodes.get(input.targetNode);
      if (!node) {
        return {
          message: `Placement queued: target node "${input.targetNode}" is not registered`,
          reconcileReason: 'target_offline',
        };
      }
      if (!this.nodeHasCapability(node, input.capability)) {
        return {
          message: `Placement rejected: node "${node.name}" does not advertise capability "${input.capability}"`,
          hardFail: true,
          reason: 'capability_mismatch',
          reconcileReason: 'no_eligible_node',
        };
      }
      if (!node.live) {
        return {
          message: `Placement queued: target node "${node.name}" is offline`,
          reconcileReason: 'target_offline',
        };
      }
      if (!this.nodeMapsRepo(node, input.repo)) {
        return {
          message: `Placement queued: node "${node.name}" does not map repo "${input.repo}"`,
          reconcileReason: 'unmapped_repo',
        };
      }
      return { node };
    }

    const nodes = await this.nodes.list({ capability: input.capability });
    const capable = nodes.filter((node) => this.nodeHasCapability(node, input.capability));
    const live = capable.filter((node) => node.live);
    const eligible = live.filter((node) => this.nodeMapsRepo(node, input.repo));
    if (eligible[0]) return { node: eligible[0] };

    if (input.repo && live.length > 0) {
      return {
        message: `Placement queued: no live node advertising "${input.capability}" maps repo "${input.repo}"`,
        reconcileReason: 'unmapped_repo',
      };
    }
    return {
      message: `Placement queued: no live node advertises capability "${input.capability}"`,
      reconcileReason: 'no_eligible_node',
    };
  }

  private nodeHasCapability(node: RelayNode, capability: string): boolean {
    return node.capabilities.some((item) => item.name === capability);
  }

  private nodeMapsRepo(node: RelayNode, repo: string | undefined): boolean {
    if (!repo) return true;
    return Boolean(node.repoKeys?.includes(repo));
  }

  private async reconcilePlacement(
    input: RelaySpawnPlacementInput,
    event: RelayPlacementReconcileEvent
  ): Promise<void> {
    this.logPlacement(input, event.message);
    // A throwing/rejecting reconcile hook (e.g. a Slack/log sink outage) must not
    // break an otherwise valid placement — isolate it and log the failure.
    try {
      await input.onReconcile?.(event);
    } catch (error) {
      this.placementLog?.(
        `[agent-relay] placement reconcile hook threw: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private logPlacement(input: RelaySpawnPlacementInput, message: string): void {
    const line = `[agent-relay] ${message}`;
    // Observability log sinks are caller-provided; never let them break placement.
    try {
      input.log?.(line);
    } catch (error) {
      this.placementLog?.(
        `[agent-relay] placement log hook threw: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (input.log !== this.placementLog) {
      try {
        this.placementLog?.(line);
      } catch {
        // Intentionally swallow the client log-sink failure; nothing else to report to.
      }
    }
  }

  private requireWebhooks(): NonNullable<RelaycastWorkspaceLike['webhooks']> {
    if (!this.relaycast.webhooks) {
      throw new Error('RelaycastMessagingClient.integrations.webhooks requires the relaycast webhooks API.');
    }
    return this.relaycast.webhooks;
  }

  private requireSubscriptions(): NonNullable<RelaycastWorkspaceLike['subscriptions']> {
    if (!this.relaycast.subscriptions) {
      throw new Error(
        'RelaycastMessagingClient.integrations.subscriptions requires the relaycast subscriptions API.'
      );
    }
    return this.relaycast.subscriptions;
  }

  private requireActions(): NonNullable<RelaycastWorkspaceLike['actions']> {
    if (!this.relaycast.actions) {
      throw new Error('RelaycastMessagingClient.commands requires the relaycast actions API.');
    }
    return this.relaycast.actions;
  }

  private requireNodes(): NonNullable<RelaycastWorkspaceLike['nodes']> {
    if (!this.relaycast.nodes) {
      throw new Error('RelaycastMessagingClient.nodes requires the relaycast nodes API.');
    }
    return this.relaycast.nodes;
  }

  private requireTriggers(): NonNullable<RelaycastWorkspaceLike['triggers']> {
    if (!this.relaycast.triggers) {
      throw new Error('RelaycastMessagingClient.triggers requires the relaycast triggers API.');
    }
    return this.relaycast.triggers;
  }

  private requireWorkspaceFleetNodes(): NonNullable<
    NonNullable<RelaycastWorkspaceLike['workspace']>['fleetNodes']
  > {
    if (!this.relaycast.workspace?.fleetNodes) {
      throw new Error(
        'RelaycastMessagingClient.workspace.fleetNodes requires @relaycast/sdk with the workspace fleet nodes API.'
      );
    }
    return this.relaycast.workspace.fleetNodes;
  }

  private requireAgentActions(operation: string): NonNullable<RelaycastAgentLike['actions']> {
    const actions = this.agentClient?.actions;
    if (!actions) {
      throw new Error(
        `RelaycastMessagingClient.${operation} requires an agent-scoped client with the actions API.`
      );
    }
    return actions;
  }

  private requireAgentClient(operation: string): RelaycastAgentLike {
    if (!this.agentClient) {
      throw new Error(`RelaycastMessagingClient.${operation} requires agentToken or agentClient.`);
    }
    return this.agentClient;
  }

  private requireWorkspaceDmMessages(): NonNullable<RelaycastWorkspaceLike['dmMessages']> {
    if (!this.relaycast.dmMessages) {
      throw new Error(
        'RelaycastMessagingClient.messages.listDirect requires agentClient or relaycast.dmMessages.'
      );
    }
    return this.relaycast.dmMessages;
  }

  /**
   * The durable delivery API of the agent client, when present. Requires an
   * agent-scoped client built from `@relaycast/sdk` 2.5+ (or a compatible
   * injected `agentClient`).
   */
  private deliverySurface(): (RelaycastAgentLike & RelaycastAgentDeliverySurface) | undefined {
    const agent = this.agentClient;
    if (
      !agent ||
      typeof agent.deliveries !== 'function' ||
      typeof agent.ackDelivery !== 'function' ||
      typeof agent.failDelivery !== 'function' ||
      typeof agent.deferDelivery !== 'function'
    ) {
      return undefined;
    }
    return agent as RelaycastAgentLike & RelaycastAgentDeliverySurface;
  }

  private async *createInboxSubscription(
    agent: RelaycastAgentLike & RelaycastAgentDeliverySurface,
    input?: InboxSubscribeInput
  ): AsyncGenerator<InboxItem, void, undefined> {
    const signal = input?.signal;
    if (signal?.aborted) return;
    const recipient = definedOptions({ recipientName: input?.agentName });

    const seen = new Set<string>();
    const queue: InboxItem[] = [];
    let stopped = false;
    let notify: (() => void) | undefined;

    const wake = (): void => {
      const resolve = notify;
      notify = undefined;
      resolve?.();
    };
    const push = (item: InboxItem): void => {
      if (!item.id || seen.has(item.id)) return;
      seen.add(item.id);
      queue.push(item);
      wake();
    };
    const stop = (): void => {
      stopped = true;
      wake();
    };

    // Register the event listener before seeding so accepted deliveries that
    // land mid-seed are not missed; `seen` deduplicates the overlap.
    const inFlight = new Set<string>();
    agent.connect();
    const unsubscribe = agent.on.any((event) => {
      const record = asRecord(event);
      if (record.type !== 'delivery.accepted') return;
      const deliveryId = readStr(record, 'deliveryId', 'delivery_id');
      if (!deliveryId || seen.has(deliveryId) || inFlight.has(deliveryId)) return;
      inFlight.add(deliveryId);
      // The accepted event carries ids only; re-list the non-terminal queue
      // to pick up the delivery row with its embedded message payload.
      void agent
        .deliveries()
        .then((deliveries) => {
          const match = deliveries.find((raw) => readStr(asRecord(raw), 'id') === deliveryId);
          if (match) push(normalizeInboxItem(match, recipient));
        })
        .catch(() => {
          // The delivery already transitioned or the list failed transiently;
          // it will be replayed by the next non-terminal listing.
        })
        .finally(() => {
          inFlight.delete(deliveryId);
        });
    });
    signal?.addEventListener('abort', stop, { once: true });

    try {
      for (const raw of await agent.deliveries()) {
        push(normalizeInboxItem(raw, recipient));
      }
      while (!stopped) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    } finally {
      stopped = true;
      unsubscribe();
      signal?.removeEventListener('abort', stop);
    }
  }

  private async *emptyInboxSubscription(): AsyncIterable<InboxItem> {
    return;
  }

  private unsupportedInboxDelivery(
    action: RelayDeliveryUnsupportedResult['action'],
    messageId: string,
    reason?: string,
    deferUntil?: string
  ): RelayDeliveryUnsupportedResult {
    return {
      supported: false,
      action,
      messageId,
      ...(reason
        ? { reason }
        : {
            reason:
              'Durable delivery transitions require an agent-scoped client with the Relaycast delivery API.',
          }),
      ...(deferUntil ? { deferUntil } : {}),
    };
  }

  private normalizeDirectResponse(
    input: unknown,
    kind: 'dm' | 'group_dm',
    conversationId?: string
  ): RelayMessage {
    const record =
      input !== null && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const resolvedConversationId =
      conversationId ??
      (typeof record.conversationId === 'string'
        ? record.conversationId
        : typeof record.conversation_id === 'string'
          ? record.conversation_id
          : undefined);
    const createdAt =
      typeof record.createdAt === 'string'
        ? record.createdAt
        : typeof record.created_at === 'string'
          ? record.created_at
          : undefined;

    return normalizeMessage(record.message, {
      kind,
      conversationId: resolvedConversationId,
      createdAt,
    });
  }

  private addEventListener<K extends keyof RelayMessagingEventMap>(
    event: K,
    handler: (...args: RelayMessagingEventMap[K]) => void | Promise<void>
  ): () => void {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(event, handlers);
    }
    const typedHandler = handler as unknown as (event: RelayMessagingEvent) => void | Promise<void>;
    handlers.add(typedHandler);
    return () => {
      const current = this.eventHandlers.get(event);
      if (current !== handlers) return;
      current.delete(typedHandler);
      if (current.size === 0) {
        this.eventHandlers.delete(event);
      }
    };
  }

  private emitEvent(event: RelayMessagingEvent): void {
    const handlers = [
      ...(this.eventHandlers.get(event.type as keyof RelayMessagingEventMap) ?? []),
      ...(this.eventHandlers.get('any') ?? []),
    ];

    for (const handler of handlers) {
      try {
        const result = handler(event);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          void (result as Promise<void>).catch((error) => {
            console.error(`[agent-relay] messaging listener for "${event.type}" threw:`, error);
          });
        }
      } catch (error) {
        console.error(`[agent-relay] messaging listener for "${event.type}" threw:`, error);
      }
    }
  }
}
