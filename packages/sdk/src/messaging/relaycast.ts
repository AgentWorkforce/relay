import { RelayCast } from '@relaycast/sdk';
import type { AgentClientOptions, RelayCastOptions } from '@relaycast/sdk';

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
  RelayAgent,
  RelayAgentPresence,
  RelayAgentRegistration,
  RelayChannel,
  RelayChannelMember,
  RelayChannelReadStatus,
  RelayCreateChannelInput,
  RelayCreateGroupDirectMessageInput,
  RelayDeliveryUnsupportedResult,
  RelayGroupDirectConversation,
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

type RelaycastWorkspaceLike = {
  agents: {
    list(query?: Record<string, unknown>): Promise<unknown[]>;
    get(name: string): Promise<unknown>;
    register(input: unknown): Promise<unknown>;
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
  as?: (agentToken: string, options?: AgentClientOptions) => RelaycastAgentLike;
};

type RelaycastAgentLike = {
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
  reply(id: string, text: string, options?: { blocks?: RelayMessageBlock[]; idempotencyKey?: string }): Promise<unknown>;
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
    createGroup(options: { participants: string[]; name?: string }, idempotency?: { idempotencyKey?: string }): Promise<unknown>;
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
  on: {
    any(handler: (event: unknown) => void): () => void;
  };
};

export interface RelaycastMessagingOptions {
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

function createRelaycastClient(options: RelaycastMessagingOptions): RelaycastWorkspaceLike {
  if (options.relaycast) return options.relaycast;
  if (!options.apiKey) {
    throw new Error('RelaycastMessagingClient requires apiKey when relaycast is not provided.');
  }

  return new RelayCast(
    definedOptions({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      retryPolicy: options.retryPolicy,
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
  private readonly eventHandlers = new Map<keyof RelayMessagingEventMap, Set<(event: RelayMessagingEvent) => void | Promise<void>>>();
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
      const channels = await this.relaycast.channels.list(definedOptions({ includeArchived: options?.includeArchived }));
      return channels.map(normalizeChannel);
    },
    get: async (name: string): Promise<RelayChannel> => normalizeChannel(await this.relaycast.channels.get(normalizeChannelName(name))),
    create: async (input: RelayCreateChannelInput): Promise<RelayChannel> =>
      normalizeChannel(await this.requireAgentClient('channels.create').channels.create(input)),
    update: async (name: string, input: RelayUpdateChannelInput): Promise<RelayChannel> =>
      normalizeChannel(await this.requireAgentClient('channels.update').channels.update(normalizeChannelName(name), input)),
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
      const members = await this.requireAgentClient('channels.members').channels.members(normalizeChannelName(name));
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
          attachments: input.attachments,
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
      return normalizeMessage(message, { kind: 'thread_reply', parentId: input.messageId, threadId: input.messageId });
    },
    direct: async (input: RelaySendDirectMessageInput): Promise<RelayMessage> => {
      const response = await this.requireAgentClient('messages.direct').dm(
        input.to,
        input.text,
        definedOptions({ attachments: input.attachments, mode: input.mode, idempotencyKey: input.idempotencyKey })
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
        throw new Error('messages.groupDirect requires conversationId or participants that create a conversation.');
      }

      const response = await agent.dms.sendMessage(
        conversationId,
        input.text,
        definedOptions({ attachments: input.attachments, mode: input.mode, idempotencyKey: input.idempotencyKey })
      );
      return this.normalizeDirectResponse(response, 'group_dm', conversationId);
    },
    createGroupDirect: async (input: RelayCreateGroupDirectMessageInput): Promise<RelayGroupDirectConversation> =>
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
      return list.map((message) => normalizeMessage(message, { kind: 'dm', conversationId: input.conversationId }));
    },
    markRead: async (messageId: string): Promise<RelayReadReceipt> =>
      normalizeReadReceipt(await this.requireAgentClient('messages.markRead').markRead(messageId)),
    readers: async (messageId: string): Promise<RelayReadReceipt[]> => {
      const readers = await this.requireAgentClient('messages.readers').readers(messageId);
      return readers.map((reader) => normalizeReadReceipt({ ...((reader ?? {}) as Record<string, unknown>), messageId }));
    },
    readStatus: async (channel: string): Promise<RelayChannelReadStatus[]> => {
      const statuses = await this.requireAgentClient('messages.readStatus').readStatus(normalizeChannelName(channel));
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
      normalizeInbox(await this.requireAgentClient('inbox.get').inbox(definedOptions({ limit: options?.limit }))),
    list: async (_input?: InboxListInput): Promise<InboxListResult> => ({ items: [] }),
    subscribe: (_input?: InboxSubscribeInput): AsyncIterable<InboxItem> => this.emptyInboxSubscription(),
    ack: async (input: InboxAckInput): Promise<RelayDeliveryUnsupportedResult> => this.unsupportedInboxDelivery('ack', input.inboxItemId),
    fail: async (input: InboxFailInput): Promise<RelayDeliveryUnsupportedResult> =>
      this.unsupportedInboxDelivery('fail', input.inboxItemId, input.error),
    defer: async (input: InboxDeferInput): Promise<RelayDeliveryUnsupportedResult> =>
      this.unsupportedInboxDelivery('defer', input.inboxItemId, input.reason, input.availableAt),
    markRead: async (input: InboxMarkReadInput): Promise<RelayDeliveryUnsupportedResult> =>
      this.unsupportedInboxDelivery('ack', input.inboxItemId, 'Inbox read state updates require server delivery state.'),
  };

  readonly events = {
    connect: (): void => {
      const agent = this.requireAgentClient('events.connect');
      if (this.eventUnsubscribe) return;
      agent.connect();
      this.eventUnsubscribe = agent.on.any((event) => {
        this.emitEvent(normalizeMessagingEvent(event));
      });
    },
    disconnect: async (): Promise<void> => {
      this.eventUnsubscribe?.();
      this.eventUnsubscribe = undefined;
      if (this.agentClient) {
        await this.agentClient.disconnect();
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
      ...(reason ? { reason } : { reason: 'Durable failure reporting is not supported by the Relaycast messaging backend yet.' }),
    }),
    defer: async (messageId: string, deferUntil?: string): Promise<RelayDeliveryUnsupportedResult> => ({
      supported: false,
      action: 'defer',
      messageId,
      ...(deferUntil ? { deferUntil } : {}),
      reason: 'Durable deferral is not supported by the Relaycast messaging backend yet.',
    }),
  };

  private requireAgentClient(operation: string): RelaycastAgentLike {
    if (!this.agentClient) {
      throw new Error(`RelaycastMessagingClient.${operation} requires agentToken or agentClient.`);
    }
    return this.agentClient;
  }

  private requireWorkspaceDmMessages(): NonNullable<RelaycastWorkspaceLike['dmMessages']> {
    if (!this.relaycast.dmMessages) {
      throw new Error('RelaycastMessagingClient.messages.listDirect requires agentClient or relaycast.dmMessages.');
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
      ...(reason ? { reason } : { reason: 'Relaycast messaging does not expose durable inbox delivery state in this SDK surface yet.' }),
      ...(deferUntil ? { deferUntil } : {}),
    };
  }

  private normalizeDirectResponse(input: unknown, kind: 'dm' | 'group_dm', conversationId?: string): RelayMessage {
    const record = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    const resolvedConversationId =
      conversationId ??
      (typeof record.conversationId === 'string'
        ? record.conversationId
        : typeof record.conversation_id === 'string'
          ? record.conversation_id
          : undefined);
    const createdAt =
      typeof record.createdAt === 'string' ? record.createdAt : typeof record.created_at === 'string' ? record.created_at : undefined;

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
