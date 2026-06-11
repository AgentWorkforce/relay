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
  normalizeGroupDirectConversation,
  normalizeInbox,
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
  RelayDeliveryUnsupportedResult,
  RelayEventSubscription,
  RelayInboundWebhook,
  RelaySubscribeInput,
  RelayWebhookSubscription,
  RelayGroupDirectConversation,
  RelayRegisterCapabilityInput,
  RelayWebhook,
  RelayWorkspaceInfo,
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
  RelayReadReceipt,
  RelayRegisterAgentInput,
  RelayReplyMessageInput,
  RelaySearchResult,
  RelaySendChannelMessageInput,
  RelaySendDirectMessageInput,
  RelaySendGroupDirectMessageInput,
  RelayThread,
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

/** Normalize a relaycast invoke ack (camelized) into the relay `RelayActionInvocationAck`. */
function normalizeActionInvocationAck(raw: unknown): RelayActionInvocationAck {
  const record = asRecord(raw);
  return {
    invocationId: readStr(record, 'invocationId', 'invocation_id') ?? '',
    actionName: readStr(record, 'actionName', 'action_name') ?? '',
    ...(readStr(record, 'handlerAgentId', 'handler_agent_id')
      ? { handlerAgentId: readStr(record, 'handlerAgentId', 'handler_agent_id') }
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
  workspace?: {
    info(): Promise<unknown>;
  };
  as?: (agentToken: string, options?: AgentClientOptions) => RelaycastAgentLike;
  // Workspace-scoped realtime stream (relaycast 2.5+): lets a workspace-key
  // client receive all workspace-visible events without an agent identity.
  connect?: () => void;
  disconnect?: () => void;
  on?: { any(handler: (event: unknown) => void): () => void };
};

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
  readonly capabilities: RelayMessagingCapabilities = {
    serverDeliveryState: false,
    durableDelivery: false,
    durableAck: false,
    durableFail: false,
    durableDefer: false,
  };

  private readonly relaycast: RelaycastWorkspaceLike;
  private readonly agentClient?: RelaycastAgentLike;
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
    list: async (_input?: InboxListInput): Promise<InboxListResult> => ({ items: [] }),
    subscribe: (_input?: InboxSubscribeInput): AsyncIterable<InboxItem> => this.emptyInboxSubscription(),
    ack: async (input: InboxAckInput): Promise<RelayDeliveryUnsupportedResult> =>
      this.unsupportedInboxDelivery('ack', input.inboxItemId),
    fail: async (input: InboxFailInput): Promise<RelayDeliveryUnsupportedResult> =>
      this.unsupportedInboxDelivery('fail', input.inboxItemId, input.error),
    defer: async (input: InboxDeferInput): Promise<RelayDeliveryUnsupportedResult> =>
      this.unsupportedInboxDelivery('defer', input.inboxItemId, input.reason, input.availableAt),
    markRead: async (input: InboxMarkReadInput): Promise<RelayDeliveryUnsupportedResult> =>
      this.unsupportedInboxDelivery(
        'ack',
        input.inboxItemId,
        'Inbox read state updates require server delivery state.'
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

  readonly deliveries = {
    ack: async (messageId: string): Promise<RelayDeliveryUnsupportedResult> => ({
      supported: false,
      action: 'ack',
      messageId,
      reason: 'Durable acknowledgements are not supported by the Relaycast messaging backend yet.',
    }),
    fail: async (messageId: string, reason?: string): Promise<RelayDeliveryUnsupportedResult> => ({
      supported: false,
      action: 'fail',
      messageId,
      ...(reason
        ? { reason }
        : { reason: 'Durable failure reporting is not supported by the Relaycast messaging backend yet.' }),
    }),
    defer: async (messageId: string, deferUntil?: string): Promise<RelayDeliveryUnsupportedResult> => ({
      supported: false,
      action: 'defer',
      messageId,
      ...(deferUntil ? { deferUntil } : {}),
      reason: 'Durable deferral is not supported by the Relaycast messaging backend yet.',
    }),
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

  readonly workspace = {
    info: async (): Promise<RelayWorkspaceInfo> => {
      if (!this.relaycast.workspace) {
        throw new Error('RelaycastMessagingClient.workspace.info requires the relaycast workspace API.');
      }
      return (await this.relaycast.workspace.info()) as RelayWorkspaceInfo;
    },
  };

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
              'Relaycast messaging does not expose durable inbox delivery state in this SDK surface yet.',
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
