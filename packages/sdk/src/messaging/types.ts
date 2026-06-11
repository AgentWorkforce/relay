import type * as wire from '@relaycast/types';

// The `Relay*` types below are derived from the canonical wire contract in
// `@relaycast/types` (snake_case zod schemas shared with the Relaycast
// engine). Where the relay surface deliberately reshapes a wire type
// (camelCase fields, renames, optional-instead-of-null, enrichment), the
// reshaped fields still index into the canonical type so a wire-contract
// change surfaces as a compile error here instead of silent drift.

type WireAgentChannel = NonNullable<wire.Agent['channels']>[number];
type WireInboxChannelSummary = wire.InboxResponse['unread_channels'][number];
type WireInboxDirectSummary = wire.InboxResponse['unread_dms'][number];
type WireInboxLastMessage = NonNullable<WireInboxDirectSummary['last_message']>;
type WireInboxReactionSummary = wire.InboxResponse['recent_reactions'][number];

export type RelayAgentType = wire.AgentType;
/** Canonical agent statuses plus the relay-only `unknown` fallback. */
export type RelayAgentStatus = wire.AgentStatus | 'unknown';
export type RelayChannelMemberRole = wire.ChannelMemberInfo['role'];
export type RelayMessageMode = wire.MessageInjectionMode;
export type RelayMessageKind = 'channel' | 'dm' | 'group_dm' | 'thread_reply' | 'unknown';

export interface RelayAgentChannel {
  id: WireAgentChannel['id'];
  name: WireAgentChannel['name'];
  role: WireAgentChannel['role'];
  joinedAt?: WireAgentChannel['joined_at'];
}

export interface RelayAgent {
  id: wire.Agent['id'];
  name: wire.Agent['name'];
  type: RelayAgentType;
  status: RelayAgentStatus;
  persona?: NonNullable<wire.Agent['persona']>;
  metadata: wire.Agent['metadata'];
  lastSeenAt?: wire.Agent['last_seen'];
  createdAt?: NonNullable<wire.Agent['created_at']>;
  channels: RelayAgentChannel[];
}

export interface RelayAgentRegistration {
  id: wire.CreateAgentResponse['id'];
  name: wire.CreateAgentResponse['name'];
  token: wire.CreateAgentResponse['token'];
  status: RelayAgentStatus;
  createdAt?: wire.CreateAgentResponse['created_at'];
}

export interface RelayAgentPresence {
  agentId: wire.AgentPresenceInfo['agent_id'];
  agentName: wire.AgentPresenceInfo['agent_name'];
  status: wire.AgentPresenceInfo['status'];
}

export interface RelayChannelMember {
  agentId: wire.ChannelMemberInfo['agent_id'];
  agentName: wire.ChannelMemberInfo['agent_name'];
  role: wire.ChannelMemberInfo['role'];
  joinedAt?: wire.ChannelMemberInfo['joined_at'];
  muted: NonNullable<wire.ChannelMemberInfo['is_muted']>;
}

export interface RelayChannel {
  id: wire.Channel['id'];
  name: wire.Channel['name'];
  topic?: NonNullable<wire.Channel['topic']>;
  metadata: NonNullable<wire.Channel['metadata']>;
  createdBy?: NonNullable<wire.Channel['created_by']>;
  createdAt?: wire.Channel['created_at'];
  archived: NonNullable<wire.Channel['is_archived']>;
  memberCount?: wire.Channel['member_count'];
  members: RelayChannelMember[];
}

/** A stored file attachment; mirrors the canonical `FileAttachment` with `file_id` exposed as `id`. */
export interface RelayStoredAttachment {
  id: wire.FileAttachment['file_id'];
  type?: 'stored';
  filename?: wire.FileAttachment['filename'];
  contentType?: wire.FileAttachment['content_type'];
  sizeBytes?: wire.FileAttachment['size_bytes'];
}

export interface RelayTextAttachment {
  type: 'text';
  text: string;
  label?: string;
}

export interface RelayImageAttachment {
  type: 'image';
  url?: string;
  data?: string;
  mimeType?: string;
  alt?: string;
  label?: string;
}

export interface RelayLinkAttachment {
  type: 'link';
  url: string;
  title?: string;
  label?: string;
}

export interface RelayFileAttachment {
  type: 'file';
  path: string;
  line?: number;
  label?: string;
}

export interface RelayJsonAttachment {
  type: 'json';
  value: unknown;
  label?: string;
}

export interface RelayDiffAttachment {
  type: 'diff';
  patch: string;
  label?: string;
}

export interface RelayArtifactAttachment {
  type: 'artifact';
  id: string;
  url?: string;
  label?: string;
}

export type RelayMessageAttachment =
  | RelayStoredAttachment
  | RelayTextAttachment
  | RelayImageAttachment
  | RelayLinkAttachment
  | RelayFileAttachment
  | RelayJsonAttachment
  | RelayDiffAttachment
  | RelayArtifactAttachment;

export type RelayMessageAttachmentInput = string | RelayMessageAttachment;

export type RelayMessageBlock = Record<string, unknown>;

export type RelayMessageReaction = wire.ReactionGroup;

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
  id: wire.MessageWithMeta['id'];
  /** Public identifier for the message; mirrors `id`. */
  messageId: wire.MessageWithMeta['id'];
  kind?: RelayMessageKind;
  text: wire.MessageWithMeta['text'];
  from: RelayMessageSender;
  target?: RelayMessageTarget;
  channel?: RelayMessageChannelRef;
  conversationId?: string;
  threadId?: NonNullable<wire.MessageWithMeta['thread_id']>;
  parentId?: string;
  mode?: RelayMessageMode;
  createdAt?: wire.MessageWithMeta['created_at'];
  updatedAt?: NonNullable<wire.Message['updated_at']>;
  metadata?: NonNullable<wire.MessageWithMeta['metadata']>;
  blocks?: RelayMessageBlock[];
  attachments?: RelayMessageAttachment[];
  replyCount?: wire.MessageWithMeta['reply_count'];
  reactions?: RelayMessageReaction[];
  readByCount?: wire.MessageWithMeta['read_by_count'];
  mentions?: NonNullable<wire.MessageWithMeta['mentions']>;
}

export interface RelayThread {
  parent: RelayMessage;
  replies: RelayMessage[];
}

export interface RelayInboxChannelSummary {
  channelName: WireInboxChannelSummary['channel_name'];
  unreadCount: WireInboxChannelSummary['unread_count'];
}

export interface RelayInboxLastMessage {
  id: WireInboxLastMessage['id'];
  text: WireInboxLastMessage['text'];
  createdAt?: WireInboxLastMessage['created_at'];
}

export interface RelayInboxDirectSummary {
  conversationId: WireInboxDirectSummary['conversation_id'];
  from: WireInboxDirectSummary['from'];
  unreadCount: WireInboxDirectSummary['unread_count'];
  lastMessage?: RelayInboxLastMessage;
}

export interface RelayInboxReactionSummary {
  messageId: WireInboxReactionSummary['message_id'];
  channelName: WireInboxReactionSummary['channel_name'];
  emoji: WireInboxReactionSummary['emoji'];
  agentName: WireInboxReactionSummary['agent_name'];
  createdAt?: WireInboxReactionSummary['created_at'];
}

export interface RelayInbox {
  unreadChannels: RelayInboxChannelSummary[];
  mentions: RelayMessage[];
  unreadDms: RelayInboxDirectSummary[];
  recentReactions: RelayInboxReactionSummary[];
}

export interface RelayReadReceipt {
  messageId: wire.ReadReceipt['message_id'];
  agentId?: wire.ReadReceipt['agent_id'];
  agentName?: wire.ReaderInfo['agent_name'];
  readAt?: wire.ReadReceipt['read_at'];
}

export interface RelayChannelReadStatus {
  agentName: wire.ChannelReadStatus['agent_name'];
  lastReadId?: NonNullable<wire.ChannelReadStatus['last_read_id']>;
  lastReadAt?: NonNullable<wire.ChannelReadStatus['last_read_at']>;
}

export interface RelaySearchResult {
  id: wire.SearchMessageResult['id'];
  channelName: wire.SearchMessageResult['channel_name'];
  agentName: wire.SearchMessageResult['agent_name'];
  text: wire.SearchMessageResult['text'];
  createdAt?: wire.SearchMessageResult['created_at'];
  relevanceScore: wire.SearchMessageResult['relevance_score'];
}

export interface RelayListAgentsOptions {
  status?: NonNullable<wire.AgentListQuery['status']>;
}

export interface RelayRegisterAgentInput {
  name: wire.CreateAgentRequest['name'];
  type?: RelayAgentType;
  persona?: NonNullable<wire.CreateAgentRequest['persona']>;
  metadata?: wire.CreateAgentRequest['metadata'];
}

export interface RelayUpdateAgentInput {
  status?: wire.UpdateAgentRequest['status'];
  persona?: wire.UpdateAgentRequest['persona'];
  metadata?: wire.UpdateAgentRequest['metadata'];
}

export interface RelayListChannelsOptions {
  includeArchived?: boolean;
}

export interface RelayCreateChannelInput {
  name: wire.CreateChannelRequest['name'];
  topic?: wire.CreateChannelRequest['topic'];
  metadata?: wire.CreateChannelRequest['metadata'];
}

export interface RelayUpdateChannelInput {
  topic?: wire.UpdateChannelRequest['topic'];
  metadata?: wire.UpdateChannelRequest['metadata'];
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
  attachments?: RelayMessageAttachmentInput[];
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
  attachments?: RelayMessageAttachmentInput[];
  mode?: RelayMessageMode;
  idempotencyKey?: string;
}

export interface RelaySendGroupDirectMessageInput {
  conversationId?: string;
  participants?: string[];
  name?: string;
  text: string;
  attachments?: RelayMessageAttachmentInput[];
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
  id: wire.CreateGroupDmResponse['id'];
  channelId?: wire.CreateGroupDmResponse['channel_id'];
  name?: NonNullable<wire.CreateGroupDmResponse['name']>;
  /** Participant agent ids, flattened from the canonical `{ agent_id }` rows. */
  participants: Array<wire.CreateGroupDmResponse['participants'][number]['agent_id']>;
  createdAt?: wire.CreateGroupDmResponse['created_at'];
}

export interface RelayDeliveryUnsupportedResult {
  supported: false;
  action: 'ack' | 'fail' | 'defer';
  messageId: string;
  reason?: string;
  deferUntil?: string;
}

/** A durable delivery transition (ack/fail/defer) applied by the server. */
export interface RelayDeliverySupportedResult {
  supported: true;
  action: 'ack' | 'fail' | 'defer';
  /** Durable delivery ledger row the transition applied to. */
  deliveryId: string;
  /** Message the delivery carries. */
  messageId: string;
  /** Inbox state after the transition. */
  state: InboxItemState;
  /** When the delivery becomes available again (defer transitions). */
  deferUntil?: string;
}

export type RelayDeliveryResult = RelayDeliverySupportedResult | RelayDeliveryUnsupportedResult;

export interface RelayMessagingCapabilities {
  /** Server tracks per-recipient delivery state with ack/fail/defer transitions. */
  serverDeliveryState: boolean;
  /** Per-recipient delivery ledger with replay of non-terminal items. */
  durableDelivery: boolean;
  durableAck: boolean;
  durableFail: boolean;
  durableDefer: boolean;
}

// ── Integrations (webhooks + event subscriptions) ───────────────────────────

export interface RelayWebhook {
  id: string;
  url?: string;
  event?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface RelayCreateWebhookInput {
  url: string;
  event?: string;
  [key: string]: unknown;
}

export interface RelayEventSubscription {
  id: string;
  event?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface RelayCreateSubscriptionInput {
  event: string;
  [key: string]: unknown;
}

// ── Webhooks (inbound triggers + outbound subscriptions) ─────────────────────

export interface RelayCreateInboundWebhookInput {
  /** Channel the inbound webhook posts into. A leading `#` is stripped. */
  channel: string;
  name?: string;
}

export interface RelayInboundWebhook {
  webhookId: string;
  url: string;
  token: string;
  channel: string;
  name?: string;
  createdAt?: string;
}

export interface RelaySubscribeInput {
  url: string;
  /** Canonical dotted event names, e.g. `'message.created'`, `'action.completed'`. */
  events: string[];
  secret?: string;
  headers?: Record<string, string>;
}

export interface RelayWebhookSubscription {
  id: string;
  url?: string;
  events?: string[];
  createdAt?: string;
}

// ── Capabilities (agent commands) ───────────────────────────────────────────

export interface RelayCapability {
  command: string;
  description?: string;
  handlerAgent?: string;
  parameters?: unknown;
  [key: string]: unknown;
}

export interface RelayRegisterCapabilityInput {
  command: string;
  description: string;
  handlerAgent: string;
  parameters?: unknown;
  /** JSON Schema describing the action input, sent as the descriptor `input_schema`. */
  inputSchema?: Record<string, unknown>;
  /** JSON Schema describing the action output, sent as the descriptor `output_schema`. */
  outputSchema?: Record<string, unknown>;
  /** Resolved agent names allowed to invoke. Omit to allow everyone. */
  availableTo?: string[];
}

// ── Actions (agent-to-agent RPC) ────────────────────────────────────────────

/** Async invocation handle returned by the relay when an agent invokes an action. */
export interface RelayActionInvocationAck {
  invocationId: string;
  actionName: string;
  handlerAgentId?: string;
  input?: Record<string, unknown>;
  status?: string;
  createdAt?: string;
}

/** A single action invocation record, including its input and (once complete) result. */
export interface RelayActionInvocation {
  invocationId: string;
  actionName: string;
  callerId?: string | null;
  callerName?: string | null;
  input?: Record<string, unknown>;
  output?: Record<string, unknown> | null;
  status: string;
  error?: string | null;
  durationMs?: number | null;
  createdAt?: string;
  completedAt?: string | null;
}

/** Result payload the handler agent reports for a completed invocation. */
export interface RelayCompleteInvocationInput {
  output?: Record<string, unknown>;
  error?: string;
  durationMs?: number;
}

// ── Workspace ───────────────────────────────────────────────────────────────

export interface RelayWorkspaceInfo {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Relay inbox states built on the canonical delivery-status lifecycle:
 * the ledger's `accepted` surfaces as `queued`, and `read` is a relay-only
 * extension (the ledger itself has no read state).
 */
export type InboxItemState = Exclude<wire.DeliveryStatus, 'accepted'> | 'queued' | 'read';

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
    name: wire.AgentSpawnRequestedEvent['agent']['name'];
    cli?: wire.AgentSpawnRequestedEvent['agent']['cli'];
    task?: wire.AgentSpawnRequestedEvent['agent']['task'];
    channel?: NonNullable<wire.AgentSpawnRequestedEvent['agent']['channel']>;
    model?: NonNullable<wire.AgentSpawnRequestedEvent['agent']['model']>;
    alreadyExisted: wire.AgentSpawnRequestedEvent['agent']['already_existed'];
  };
}

export interface RelayAgentReleaseRequestedEvent {
  type: 'agentReleaseRequested';
  agent: { name: wire.AgentReleaseRequestedEvent['agent']['name'] };
  reason?: NonNullable<wire.AgentReleaseRequestedEvent['reason']>;
  deleted: wire.AgentReleaseRequestedEvent['deleted'];
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
  messageId: wire.MessageReadEvent['message_id'];
  agentName: wire.MessageReadEvent['agent_name'];
  readAt?: wire.MessageReadEvent['read_at'];
}

export interface RelayReactionEvent {
  type: 'reactionAdded' | 'reactionRemoved';
  messageId: wire.MessageReactedEvent['message_id'];
  emoji: wire.MessageReactedEvent['emoji'];
  agentName: wire.MessageReactedEvent['agent_name'];
}

export interface RelayActionInvokedEvent {
  type: 'actionInvoked';
  invocationId: wire.ActionInvokedEvent['invocation_id'];
  actionName: wire.ActionInvokedEvent['action_name'];
  callerName: wire.ActionInvokedEvent['caller_name'];
  handlerAgentId: wire.ActionInvokedEvent['handler_agent_id'];
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
  | RelayActionInvokedEvent
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
    /**
     * Register an agent, adopting the existing identity (with a rotated
     * token) when the name is already taken. Optional: backends without
     * rotation support fall back to plain `register`.
     */
    registerOrRotate?(input: RelayRegisterAgentInput): Promise<RelayAgentRegistration>;
    /** Resolve the identity of the agent the client is authenticated as. */
    me(): Promise<RelayAgent>;
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
    search(
      query: string,
      options?: { channel?: string; from?: string; limit?: number; before?: string; after?: string }
    ): Promise<RelaySearchResult[]>;
  };
  readonly threads: {
    get(messageId: string, options?: RelayMessageListOptions): Promise<RelayThread>;
    reply(input: RelayReplyMessageInput): Promise<RelayMessage>;
  };
  readonly inbox: {
    get(options?: { limit?: number }): Promise<RelayInbox>;
    list(input?: InboxListInput): Promise<InboxListResult>;
    subscribe(input?: InboxSubscribeInput): AsyncIterable<InboxItem>;
    ack(input: InboxAckInput): Promise<RelayDeliveryResult>;
    fail(input: InboxFailInput): Promise<RelayDeliveryResult>;
    defer(input: InboxDeferInput): Promise<RelayDeliveryResult>;
    markRead(input: InboxMarkReadInput): Promise<RelayDeliveryResult>;
  };
  readonly events: RelayMessagingEventsSurface;
  readonly deliveries: {
    ack(messageId: string): Promise<RelayDeliveryResult>;
    fail(messageId: string, reason?: string): Promise<RelayDeliveryResult>;
    defer(messageId: string, deferUntil?: string): Promise<RelayDeliveryResult>;
  };
  readonly integrations: {
    webhooks: {
      create(input: RelayCreateWebhookInput): Promise<RelayWebhook>;
      list(): Promise<RelayWebhook[]>;
      delete(id: string): Promise<void>;
      trigger(id: string, payload?: Record<string, unknown>): Promise<unknown>;
    };
    subscriptions: {
      create(input: RelayCreateSubscriptionInput): Promise<RelayEventSubscription>;
      list(): Promise<RelayEventSubscription[]>;
      get(id: string): Promise<RelayEventSubscription>;
      delete(id: string): Promise<void>;
    };
  };
  readonly webhooks: {
    createInbound(input: RelayCreateInboundWebhookInput): Promise<RelayInboundWebhook>;
    subscribe(input: RelaySubscribeInput): Promise<RelayWebhookSubscription>;
    list(): Promise<RelayInboundWebhook[]>;
    delete(webhookId: string): Promise<void>;
    subscriptions(): Promise<RelayWebhookSubscription[]>;
    unsubscribe(id: string): Promise<void>;
  };
  readonly commands: {
    register(input: RelayRegisterCapabilityInput): Promise<RelayCapability>;
    list(): Promise<RelayCapability[]>;
    delete(command: string): Promise<void>;
    /** True when the relay action surface (descriptor registry) is available. */
    available(): boolean;
    /**
     * Fire-and-forget invoke of a registered action. Requires an agent-scoped
     * connection; returns an immediate ack with the invocation id.
     */
    invoke(name: string, input?: Record<string, unknown>): Promise<RelayActionInvocationAck>;
    /** Read an action invocation (including its input) by id. Agent-scoped. */
    getInvocation(name: string, invocationId: string): Promise<RelayActionInvocation>;
    /** Report a handler result for an invocation. Agent-scoped (handler agent). */
    completeInvocation(
      name: string,
      invocationId: string,
      data: RelayCompleteInvocationInput
    ): Promise<RelayActionInvocation>;
    /** True when this client carries an agent-scoped connection (can invoke/complete/subscribe). */
    agentScoped(): boolean;
  };
  readonly workspace: {
    info(): Promise<RelayWorkspaceInfo>;
  };
}

export type RelayMessaging = RelayMessagingClient;
