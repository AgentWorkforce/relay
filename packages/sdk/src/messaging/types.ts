export type RelayAgentType = 'agent' | 'human' | 'system';
export type RelayAgentStatus = 'online' | 'offline' | 'away' | 'unknown';
export type RelayChannelMemberRole = 'owner' | 'member';
export type RelayMessageMode = 'wait' | 'steer';
export type RelayMessageKind = 'channel' | 'dm' | 'group_dm' | 'thread_reply' | 'unknown';

export interface RelayAgentChannel {
  id: string;
  name: string;
  role: RelayChannelMemberRole;
  joinedAt?: string;
}

export interface RelayAgent {
  id: string;
  name: string;
  type: RelayAgentType;
  status: RelayAgentStatus;
  persona?: string;
  metadata: Record<string, unknown>;
  lastSeenAt?: string;
  createdAt?: string;
  channels: RelayAgentChannel[];
}

export interface RelayAgentRegistration {
  id: string;
  name: string;
  token: string;
  status: RelayAgentStatus;
  createdAt?: string;
}

export interface RelayAgentPresence {
  agentId: string;
  agentName: string;
  status: Extract<RelayAgentStatus, 'online' | 'offline'>;
}

export interface RelayChannelMember {
  agentId: string;
  agentName: string;
  role: RelayChannelMemberRole;
  joinedAt?: string;
  muted: boolean;
}

export interface RelayChannel {
  id: string;
  name: string;
  topic?: string;
  metadata: Record<string, unknown>;
  createdBy?: string;
  createdAt?: string;
  archived: boolean;
  memberCount?: number;
  members: RelayChannelMember[];
}

export interface RelayMessageAttachment {
  id: string;
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
}

export type RelayMessageBlock = Record<string, unknown>;

export interface RelayMessageReaction {
  emoji: string;
  count: number;
  agents: string[];
}

export interface RelayMessageSender {
  id?: string;
  name?: string;
}

export interface RelayMessageChannelRef {
  id?: string;
  name?: string;
}

export type RelayMessageTarget =
  | { kind: 'agent'; agentName: string; agentId?: string }
  | { kind: 'channel'; channelName: string; channelId?: string }
  | { kind: 'dm'; conversationId: string }
  | { kind: 'group_dm'; conversationId: string }
  | { kind: string; [key: string]: unknown };

export interface RelayMessage {
  id: string;
  kind?: RelayMessageKind;
  text: string;
  from: RelayMessageSender;
  target?: RelayMessageTarget;
  channel?: RelayMessageChannelRef;
  conversationId?: string;
  threadId?: string;
  parentId?: string;
  mode?: RelayMessageMode;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
  blocks?: RelayMessageBlock[];
  attachments?: RelayMessageAttachment[];
  replyCount?: number;
  reactions?: RelayMessageReaction[];
  readByCount?: number;
  mentions?: string[];
}

export interface RelayThread {
  parent: RelayMessage;
  replies: RelayMessage[];
}

export interface RelayInboxChannelSummary {
  channelName: string;
  unreadCount: number;
}

export interface RelayInboxLastMessage {
  id: string;
  text: string;
  createdAt?: string;
}

export interface RelayInboxDirectSummary {
  conversationId: string;
  from: string;
  unreadCount: number;
  lastMessage?: RelayInboxLastMessage;
}

export interface RelayInboxReactionSummary {
  messageId: string;
  channelName: string;
  emoji: string;
  agentName: string;
  createdAt?: string;
}

export interface RelayInbox {
  unreadChannels: RelayInboxChannelSummary[];
  mentions: RelayMessage[];
  unreadDms: RelayInboxDirectSummary[];
  recentReactions: RelayInboxReactionSummary[];
}

export interface RelayReadReceipt {
  messageId: string;
  agentId?: string;
  agentName?: string;
  readAt?: string;
}

export interface RelayChannelReadStatus {
  agentName: string;
  lastReadId?: string;
  lastReadAt?: string;
}

export interface RelaySearchResult {
  id: string;
  channelName: string;
  agentName: string;
  text: string;
  createdAt?: string;
  relevanceScore: number;
}

export interface RelayListAgentsOptions {
  status?: Exclude<RelayAgentStatus, 'unknown'> | 'all';
}

export interface RelayRegisterAgentInput {
  name: string;
  type?: RelayAgentType;
  persona?: string;
  metadata?: Record<string, unknown>;
}

export interface RelayUpdateAgentInput {
  status?: Exclude<RelayAgentStatus, 'unknown'>;
  persona?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RelayListChannelsOptions {
  includeArchived?: boolean;
}

export interface RelayCreateChannelInput {
  name: string;
  topic?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RelayUpdateChannelInput {
  topic?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RelayMessageListOptions {
  limit?: number;
  before?: string;
  after?: string;
}

export interface RelaySendChannelMessageInput {
  channel: string;
  text: string;
  blocks?: RelayMessageBlock[];
  attachments?: string[];
  mode?: RelayMessageMode;
  idempotencyKey?: string;
}

export interface RelayReplyMessageInput {
  messageId: string;
  text: string;
  blocks?: RelayMessageBlock[];
  idempotencyKey?: string;
}

export interface RelaySendDirectMessageInput {
  to: string;
  text: string;
  attachments?: string[];
  mode?: RelayMessageMode;
  idempotencyKey?: string;
}

export interface RelaySendGroupDirectMessageInput {
  conversationId?: string;
  participants?: string[];
  name?: string;
  text: string;
  attachments?: string[];
  mode?: RelayMessageMode;
  idempotencyKey?: string;
}

export interface RelayListDirectMessagesInput extends RelayMessageListOptions {
  conversationId: string;
}

export interface RelayCreateGroupDirectMessageInput {
  participants: string[];
  name?: string;
  idempotencyKey?: string;
}

export interface RelayGroupDirectConversation {
  id: string;
  channelId?: string;
  name?: string;
  participants: string[];
  createdAt?: string;
}

export interface RelayDeliveryUnsupportedResult {
  supported: false;
  action: 'ack' | 'fail' | 'defer';
  messageId: string;
  reason?: string;
  deferUntil?: string;
}

export interface RelayMessagingCapabilities {
  serverDeliveryState: boolean;
  durableDelivery: false;
  durableAck: false;
  durableFail: false;
  durableDefer: false;
}

export type InboxItemState = 'queued' | 'delivered' | 'failed' | 'deferred' | 'read';

export interface InboxItem {
  id: string;
  recipient: {
    name: string;
    id?: string;
    type?: RelayAgentType;
  };
  state: InboxItemState;
  attempts: number;
  availableAt?: string;
  message: RelayMessage;
  metadata?: Record<string, unknown>;
}

export interface InboxListInput {
  agentName?: string;
  limit?: number;
  before?: string;
  after?: string;
}

export interface InboxListResult {
  items: InboxItem[];
  nextCursor?: string;
}

export interface InboxSubscribeInput {
  agentName?: string;
  signal?: AbortSignal;
}

export interface InboxAckInput {
  inboxItemId: string;
  state?: 'delivered' | 'read';
  metadata?: Record<string, unknown>;
}

export interface InboxFailInput {
  inboxItemId: string;
  error: string;
  retry?: boolean;
  metadata?: Record<string, unknown>;
}

export interface InboxDeferInput {
  inboxItemId: string;
  availableAt: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface InboxMarkReadInput {
  inboxItemId: string;
  metadata?: Record<string, unknown>;
}

export interface RelayMessageCreatedEvent {
  type: 'messageCreated';
  channel: string;
  message: RelayMessage;
}

export interface RelayMessageUpdatedEvent {
  type: 'messageUpdated';
  channel: string;
  message: RelayMessage;
}

export interface RelayThreadReplyEvent {
  type: 'threadReply';
  channel: string;
  parentId: string;
  message: RelayMessage;
}

export interface RelayDirectMessageEvent {
  type: 'dmReceived' | 'groupDmReceived';
  conversationId: string;
  message: RelayMessage;
}

export interface RelayAgentPresenceEvent {
  type: 'agentOnline' | 'agentOffline';
  agent: { name: string };
}

export interface RelayAgentSpawnRequestedEvent {
  type: 'agentSpawnRequested';
  agent: {
    name: string;
    cli?: string;
    task?: string;
    channel?: string;
    alreadyExisted: boolean;
  };
}

export interface RelayAgentReleaseRequestedEvent {
  type: 'agentReleaseRequested';
  agent: { name: string };
  reason?: string;
  deleted: boolean;
}

export interface RelayChannelChangedEvent {
  type: 'channelCreated' | 'channelUpdated';
  channel: { name: string; topic?: string };
}

export interface RelayChannelArchivedEvent {
  type: 'channelArchived';
  channel: { name: string };
}

export interface RelayChannelMembershipEvent {
  type: 'memberJoined' | 'memberLeft' | 'channelMuted' | 'channelUnmuted';
  channel: string;
  agentName: string;
}

export interface RelayMessageReadEvent {
  type: 'messageRead';
  messageId: string;
  agentName: string;
  readAt?: string;
}

export interface RelayReactionEvent {
  type: 'reactionAdded' | 'reactionRemoved';
  messageId: string;
  emoji: string;
  agentName: string;
}

export interface RelayConnectionEvent {
  type: 'connected' | 'disconnected' | 'error';
}

export interface RelayReconnectEvent {
  type: 'reconnecting' | 'permanentlyDisconnected';
  attempt: number;
}

export interface RelayUnknownEvent {
  type: 'unknown';
  sourceType?: string;
  raw: unknown;
}

export type RelayMessagingEvent =
  | RelayMessageCreatedEvent
  | RelayMessageUpdatedEvent
  | RelayThreadReplyEvent
  | RelayDirectMessageEvent
  | RelayAgentPresenceEvent
  | RelayAgentSpawnRequestedEvent
  | RelayAgentReleaseRequestedEvent
  | RelayChannelChangedEvent
  | RelayChannelArchivedEvent
  | RelayChannelMembershipEvent
  | RelayMessageReadEvent
  | RelayReactionEvent
  | RelayConnectionEvent
  | RelayReconnectEvent
  | RelayUnknownEvent;

export type RelayMessagingEventMap = {
  [K in RelayMessagingEvent['type']]: [Extract<RelayMessagingEvent, { type: K }>];
} & {
  any: [RelayMessagingEvent];
};

export interface RelayMessagingEventsSurface {
  connect(): void;
  disconnect(): Promise<void>;
  subscribe(channels: string[]): void;
  unsubscribe(channels: string[]): void;
  on<K extends keyof RelayMessagingEventMap>(
    event: K,
    handler: (...args: RelayMessagingEventMap[K]) => void | Promise<void>
  ): () => void;
}

export interface RelayMessagingClient {
  readonly capabilities: RelayMessagingCapabilities;
  readonly agents: {
    list(options?: RelayListAgentsOptions): Promise<RelayAgent[]>;
    get(name: string): Promise<RelayAgent>;
    register(input: RelayRegisterAgentInput): Promise<RelayAgentRegistration>;
    update(name: string, input: RelayUpdateAgentInput): Promise<RelayAgent>;
    delete(name: string): Promise<void>;
    presence(): Promise<RelayAgentPresence[]>;
  };
  readonly channels: {
    list(options?: RelayListChannelsOptions): Promise<RelayChannel[]>;
    get(name: string): Promise<RelayChannel>;
    create(input: RelayCreateChannelInput): Promise<RelayChannel>;
    update(name: string, input: RelayUpdateChannelInput): Promise<RelayChannel>;
    archive(name: string): Promise<void>;
    join(name: string): Promise<void>;
    leave(name: string): Promise<void>;
    invite(channel: string, agent: string): Promise<void>;
    members(name: string): Promise<RelayChannelMember[]>;
    mute(name: string): Promise<void>;
    unmute(name: string): Promise<void>;
  };
  readonly messages: {
    send(input: RelaySendChannelMessageInput): Promise<RelayMessage>;
    list(channel: string, options?: RelayMessageListOptions): Promise<RelayMessage[]>;
    get(id: string): Promise<RelayMessage>;
    reply(input: RelayReplyMessageInput): Promise<RelayMessage>;
    direct(input: RelaySendDirectMessageInput): Promise<RelayMessage>;
    groupDirect(input: RelaySendGroupDirectMessageInput): Promise<RelayMessage>;
    createGroupDirect(input: RelayCreateGroupDirectMessageInput): Promise<RelayGroupDirectConversation>;
    listDirect(input: RelayListDirectMessagesInput): Promise<RelayMessage[]>;
    markRead(messageId: string): Promise<RelayReadReceipt>;
    readers(messageId: string): Promise<RelayReadReceipt[]>;
    readStatus(channel: string): Promise<RelayChannelReadStatus[]>;
    reactions(messageId: string): Promise<RelayMessageReaction[]>;
    react(messageId: string, emoji: string): Promise<RelayMessageReaction>;
    unreact(messageId: string, emoji: string): Promise<void>;
    search(query: string, options?: { channel?: string; from?: string; limit?: number; before?: string; after?: string }): Promise<RelaySearchResult[]>;
  };
  readonly threads: {
    get(messageId: string, options?: RelayMessageListOptions): Promise<RelayThread>;
    reply(input: RelayReplyMessageInput): Promise<RelayMessage>;
  };
  readonly inbox: {
    get(options?: { limit?: number }): Promise<RelayInbox>;
    list(input?: InboxListInput): Promise<InboxListResult>;
    subscribe(input?: InboxSubscribeInput): AsyncIterable<InboxItem>;
    ack(input: InboxAckInput): Promise<RelayDeliveryUnsupportedResult>;
    fail(input: InboxFailInput): Promise<RelayDeliveryUnsupportedResult>;
    defer(input: InboxDeferInput): Promise<RelayDeliveryUnsupportedResult>;
    markRead(input: InboxMarkReadInput): Promise<RelayDeliveryUnsupportedResult>;
  };
  readonly events: RelayMessagingEventsSurface;
  readonly deliveries: {
    ack(messageId: string): Promise<RelayDeliveryUnsupportedResult>;
    fail(messageId: string, reason?: string): Promise<RelayDeliveryUnsupportedResult>;
    defer(messageId: string, deferUntil?: string): Promise<RelayDeliveryUnsupportedResult>;
  };
}

export type RelayMessaging = RelayMessagingClient;
