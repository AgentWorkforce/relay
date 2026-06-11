import {
  AgentPresenceInfoSchema,
  AgentSchema,
  AgentStatusSchema,
  AgentTypeSchema,
  ChannelMemberInfoSchema,
  ChannelReadStatusSchema,
  ChannelSchema,
  CreateAgentResponseSchema,
  CreateGroupDmResponseSchema,
  DeliveryMessageSchema,
  DeliverySchema,
  DeliveryStatusSchema,
  InboxResponseSchema,
  MessageInjectionModeSchema,
  MessageSchema,
  MessageWithMetaSchema,
  ReactionGroupSchema,
  ReadReceiptSchema,
  ReaderInfoSchema,
  SearchMessageResultSchema,
  type DeliveryStatus,
} from '@relaycast/types';
import { z } from 'zod';

import type {
  InboxItem,
  InboxItemState,
  RelayAgent,
  RelayAgentChannel,
  RelayAgentPresence,
  RelayAgentRegistration,
  RelayChannel,
  RelayChannelMember,
  RelayChannelReadStatus,
  RelayDeliverySupportedResult,
  RelayGroupDirectConversation,
  RelayInbox,
  RelayInboxDirectSummary,
  RelayInboxLastMessage,
  RelayInboxReactionSummary,
  RelayMessage,
  RelayMessageAttachment,
  RelayMessageBlock,
  RelayMessageChannelRef,
  RelayMessageKind,
  RelayMessageReaction,
  RelayMessageSender,
  RelayMessagingEvent,
  RelayReadReceipt,
  RelaySearchResult,
  RelayThread,
} from './types.js';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ── Wire boundary ────────────────────────────────────────────────────────────
//
// `@relaycast/sdk` camelizes wire responses at runtime, while the canonical
// contract in `@relaycast/types` (and injected raw clients) is snake_case.
// Instead of probing both spellings field by field, every payload is folded
// back onto the canonical snake_case wire shape once, then validated with a
// schema derived from `@relaycast/types` and mapped deliberately.

/** Keys whose values are caller-defined payloads that must pass through untouched. */
const PASSTHROUGH_KEYS = new Set([
  'metadata',
  'blocks',
  'data',
  'value',
  'input',
  'output',
  'parameters',
  'headers',
]);

function toSnakeKey(key: string): string {
  return key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function toWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toWire);
  if (!isRecord(value)) return value;
  const out: UnknownRecord = {};
  for (const [key, val] of Object.entries(value)) {
    const snake = toSnakeKey(key);
    out[snake] = PASSTHROUGH_KEYS.has(snake) ? val : toWire(val);
  }
  return out;
}

/** Snake-case a payload's keys and validate it against a canonical-derived schema. */
function parseWire<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const wired = toWire(input);
  return schema.parse(isRecord(wired) ? wired : {}) as z.output<T>;
}

/** Drop undefined values so optional fields stay absent instead of present-but-undefined. */
function compact<T extends object>(value: { [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** Collapse empty/null strings to undefined (absent). */
function opt(value: string | null | undefined): string | undefined {
  return value ? value : undefined;
}

function str(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function num(record: UnknownRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function bool(record: UnknownRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function rec(record: UnknownRecord, key: string): UnknownRecord {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function normalizeOptionalChannelName(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  return value.startsWith('#') ? value.slice(1) : value;
}

export function normalizeChannelName(value: string): string {
  return normalizeOptionalChannelName(value) ?? value;
}

function normalizeBlocks(value: unknown): RelayMessageBlock[] {
  return Array.isArray(value) ? value.filter(isRecord).map((block) => ({ ...block })) : [];
}

// ── Boundary schemas ─────────────────────────────────────────────────────────
//
// Canonical wire schemas made tolerant of partial rows (older engines and
// trimmed payloads omit fields); every field that is present is validated
// against the canonical contract, and enum fields degrade to the relay
// fallback instead of failing the whole payload.

const WireAgentChannelSchema = AgentSchema.shape.channels
  .unwrap()
  .element.partial()
  .extend({ role: ChannelMemberInfoSchema.shape.role.optional().catch(undefined) });

const WireAgentSchema = AgentSchema.omit({ channels: true })
  .partial()
  .extend({
    type: AgentTypeSchema.optional().catch(undefined),
    status: AgentStatusSchema.optional().catch(undefined),
    metadata: AgentSchema.shape.metadata.nullable().optional(),
    channels: z.array(z.unknown()).optional(),
  });

const WireRegistrationSchema = CreateAgentResponseSchema.partial().extend({
  status: AgentStatusSchema.optional().catch(undefined),
});

const WirePresenceSchema = AgentPresenceInfoSchema.partial().extend({
  status: AgentPresenceInfoSchema.shape.status.optional().catch(undefined),
});

const WireChannelMemberSchema = ChannelMemberInfoSchema.partial().extend({
  role: ChannelMemberInfoSchema.shape.role.optional().catch(undefined),
});

const WireChannelSchema = ChannelSchema.omit({ members: true })
  .partial()
  .extend({
    metadata: ChannelSchema.shape.metadata.unwrap().nullable().optional(),
    members: z.array(z.unknown()).optional(),
  });

// Accepts the union of canonical message rows: `MessageWithMeta` (channel
// listings), `Message` (raw rows, where the text is `body`), the core message
// payload carried by WebSocket events, and the nullable-sender message
// embedded in delivery ledger rows.
const WireMessageSchema = MessageWithMetaSchema.omit({
  agent_id: true,
  agent_name: true,
  attachments: true,
  blocks: true,
  has_attachments: true,
  injection_mode: true,
  reactions: true,
})
  .partial()
  .extend({
    agent_id: DeliveryMessageSchema.shape.agent_id.optional(),
    agent_name: DeliveryMessageSchema.shape.agent_name.optional(),
    body: MessageSchema.shape.body.optional(),
    updated_at: MessageSchema.shape.updated_at.optional(),
    channel_name: z.string().optional(),
    conversation_id: z.string().optional(),
    parent_id: z.string().optional(),
    mode: MessageInjectionModeSchema.optional().catch(undefined),
    injection_mode: MessageInjectionModeSchema.optional().catch(undefined),
    metadata: MessageWithMetaSchema.shape.metadata.unwrap().nullable().optional(),
    // Legacy alias for `metadata` on older message rows.
    data: z.record(z.string(), z.unknown()).nullable().optional(),
    attachments: z.array(z.unknown()).optional(),
    blocks: z.unknown().optional(),
    reactions: z.array(z.unknown()).optional(),
  });

const WireInboxChannelSchema = InboxResponseSchema.shape.unread_channels.element.partial();

const WireInboxReactionSchema = InboxResponseSchema.shape.recent_reactions.element.partial();

const WireInboxDmSchema = InboxResponseSchema.shape.unread_dms.element
  .omit({ last_message: true })
  .partial()
  .extend({ last_message: z.unknown().optional() });

const WireInboxLastMessageSchema = InboxResponseSchema.shape.unread_dms.element.shape.last_message
  .unwrap()
  .partial();

const WireInboxSchema = z.object({
  unread_channels: z.array(WireInboxChannelSchema).optional(),
  mentions: z.array(z.unknown()).optional(),
  unread_dms: z.array(z.unknown()).optional(),
  recent_reactions: z.array(z.unknown()).optional(),
});

const WireReadReceiptSchema = ReadReceiptSchema.extend(ReaderInfoSchema.shape).partial();

const WireChannelReadStatusSchema = ChannelReadStatusSchema.partial();

const WireSearchResultSchema = SearchMessageResultSchema.partial();

// A delivery ledger row, optionally carrying its embedded message payload
// (`DeliveryItem`) — transitions return the bare row.
const WireDeliverySchema = DeliverySchema.partial().extend({
  status: DeliveryStatusSchema.optional().catch(undefined),
  message: DeliveryMessageSchema.partial().nullable().optional(),
});

const WireGroupDmSchema = CreateGroupDmResponseSchema.omit({ dm_type: true, participants: true })
  .partial()
  .extend({
    conversation_id: z.string().optional(),
    participants: z.array(z.unknown()).optional(),
  });

// ── Normalizers ──────────────────────────────────────────────────────────────

export function normalizeAgentChannel(input: unknown): RelayAgentChannel {
  const channel = parseWire(WireAgentChannelSchema, input);
  const name = normalizeOptionalChannelName(channel.name) ?? '';
  return compact<RelayAgentChannel>({
    id: channel.id ?? name,
    name,
    role: channel.role ?? 'member',
    joinedAt: opt(channel.joined_at),
  });
}

export function normalizeAgent(input: unknown): RelayAgent {
  const agent = parseWire(WireAgentSchema, input);
  const id = agent.id ?? agent.name ?? '';
  return compact<RelayAgent>({
    id,
    name: agent.name ?? id,
    type: agent.type ?? 'agent',
    status: agent.status ?? 'unknown',
    persona: opt(agent.persona),
    metadata: agent.metadata ?? {},
    lastSeenAt: opt(agent.last_seen),
    createdAt: opt(agent.created_at),
    channels: (agent.channels ?? []).map(normalizeAgentChannel),
  });
}

export function normalizeAgentRegistration(input: unknown): RelayAgentRegistration {
  const registration = parseWire(WireRegistrationSchema, input);
  const id = registration.id ?? registration.name ?? '';
  return compact<RelayAgentRegistration>({
    id,
    name: registration.name ?? id,
    token: registration.token ?? '',
    status: registration.status ?? 'unknown',
    createdAt: opt(registration.created_at),
  });
}

export function normalizeAgentPresence(input: unknown): RelayAgentPresence {
  const presence = parseWire(WirePresenceSchema, input);
  const agentId = presence.agent_id ?? '';
  return {
    agentId,
    agentName: presence.agent_name ?? agentId,
    status: presence.status === 'online' ? 'online' : 'offline',
  };
}

export function normalizeChannelMember(input: unknown): RelayChannelMember {
  const member = parseWire(WireChannelMemberSchema, input);
  const agentId = member.agent_id ?? '';
  return compact<RelayChannelMember>({
    agentId,
    agentName: member.agent_name ?? agentId,
    role: member.role ?? 'member',
    joinedAt: opt(member.joined_at),
    muted: member.is_muted ?? false,
  });
}

export function normalizeChannel(input: unknown): RelayChannel {
  const channel = parseWire(WireChannelSchema, input);
  const name = normalizeOptionalChannelName(channel.name) ?? '';
  return compact<RelayChannel>({
    id: channel.id ?? name,
    name,
    topic: opt(channel.topic),
    metadata: channel.metadata ?? {},
    createdBy: opt(channel.created_by),
    createdAt: opt(channel.created_at),
    archived: channel.is_archived ?? false,
    memberCount: channel.member_count,
    members: (channel.members ?? []).map(normalizeChannelMember),
  });
}

export function normalizeAttachment(input: unknown): RelayMessageAttachment {
  const wired = toWire(input);
  const record = isRecord(wired) ? wired : {};
  const type = str(record, 'type');
  const label = opt(str(record, 'label'));
  switch (type) {
    case 'text':
      return compact({ type, text: str(record, 'text') ?? str(record, 'content') ?? '', label });
    case 'image':
      return compact({
        type,
        url: opt(str(record, 'url')),
        data: opt(str(record, 'data')),
        mimeType: opt(str(record, 'mime_type')),
        alt: opt(str(record, 'alt')),
        label,
      });
    case 'link':
      return compact({ type, url: str(record, 'url') ?? '', title: opt(str(record, 'title')), label });
    case 'file':
      return compact({
        type,
        path: str(record, 'path') ?? str(record, 'filename') ?? '',
        line: num(record, 'line'),
        label,
      });
    case 'json':
      return compact({ type, value: record.value as unknown, label });
    case 'diff':
      return compact({ type, patch: str(record, 'patch') ?? str(record, 'diff') ?? '', label });
    case 'artifact':
      return compact({
        type,
        id: str(record, 'id') ?? str(record, 'artifact_id') ?? '',
        url: opt(str(record, 'url')),
        label,
      });
    default: {
      // Canonical stored file attachment (`FileAttachment`).
      const filename = str(record, 'filename');
      return compact<RelayMessageAttachment>({
        id: str(record, 'id') ?? str(record, 'file_id') ?? filename ?? '',
        filename: opt(filename),
        contentType: opt(str(record, 'content_type')),
        sizeBytes: num(record, 'size_bytes'),
      });
    }
  }
}

export function normalizeReaction(input: unknown): RelayMessageReaction {
  const reaction = parseWire(ReactionGroupSchema.partial(), input);
  return {
    emoji: reaction.emoji ?? '',
    count: reaction.count ?? 0,
    agents: reaction.agents ?? [],
  };
}

interface MessageContext {
  kind?: RelayMessageKind;
  channelId?: string;
  channelName?: string;
  conversationId?: string;
  threadId?: string;
  parentId?: string;
  createdAt?: string;
}

export function normalizeMessage(input: unknown, context: MessageContext = {}): RelayMessage {
  const message = parseWire(WireMessageSchema, input);
  const channelName = context.channelName ?? normalizeOptionalChannelName(message.channel_name);
  const channelId = context.channelId ?? message.channel_id;
  const conversationId = context.conversationId ?? message.conversation_id;
  const parentId = context.parentId ?? message.parent_id;
  const kind =
    context.kind ??
    (parentId ? 'thread_reply' : conversationId ? 'dm' : channelId || channelName ? 'channel' : 'unknown');
  const id = message.id ?? '';

  return compact<RelayMessage>({
    id,
    messageId: id,
    kind,
    text: message.text ?? message.body ?? '',
    from: compact<RelayMessageSender>({ id: opt(message.agent_id), name: opt(message.agent_name) }),
    channel:
      channelId || channelName
        ? compact<RelayMessageChannelRef>({ id: opt(channelId), name: opt(channelName) })
        : undefined,
    conversationId: opt(conversationId),
    threadId: opt(context.threadId ?? message.thread_id),
    parentId: opt(parentId),
    mode: message.mode ?? message.injection_mode,
    createdAt: opt(message.created_at ?? context.createdAt),
    updatedAt: opt(message.updated_at),
    metadata: message.metadata ?? message.data ?? undefined,
    blocks: normalizeBlocks(message.blocks),
    attachments: (message.attachments ?? []).map(normalizeAttachment),
    replyCount: message.reply_count,
    reactions: (message.reactions ?? []).map(normalizeReaction),
    readByCount: message.read_by_count,
    mentions: message.mentions ?? [],
  });
}

export function normalizeThread(input: unknown): RelayThread {
  const record = isRecord(input) ? input : {};
  const parent = normalizeMessage(record.parent, { kind: 'channel' });
  const replies = Array.isArray(record.replies) ? record.replies : [];
  return {
    parent,
    replies: replies.map((reply) =>
      normalizeMessage(reply, {
        kind: 'thread_reply',
        channelId: parent.channel?.id,
        channelName: parent.channel?.name,
        threadId: parent.threadId ?? parent.id,
        parentId: parent.id,
      })
    ),
  };
}

function normalizeInboxLastMessage(input: unknown): RelayInboxLastMessage | undefined {
  if (!isRecord(input)) return undefined;
  const last = parseWire(WireInboxLastMessageSchema, input);
  return compact<RelayInboxLastMessage>({
    id: last.id ?? '',
    text: last.text ?? '',
    createdAt: opt(last.created_at),
  });
}

function normalizeInboxDirect(input: unknown): RelayInboxDirectSummary {
  const dm = parseWire(WireInboxDmSchema, input);
  return compact<RelayInboxDirectSummary>({
    conversationId: dm.conversation_id ?? '',
    from: dm.from ?? '',
    unreadCount: dm.unread_count ?? 0,
    lastMessage: normalizeInboxLastMessage(dm.last_message),
  });
}

function normalizeInboxReaction(input: unknown): RelayInboxReactionSummary {
  const reaction = parseWire(WireInboxReactionSchema, input);
  return compact<RelayInboxReactionSummary>({
    messageId: reaction.message_id ?? '',
    channelName: normalizeOptionalChannelName(reaction.channel_name) ?? '',
    emoji: reaction.emoji ?? '',
    agentName: reaction.agent_name ?? '',
    createdAt: opt(reaction.created_at),
  });
}

export function normalizeInbox(input: unknown): RelayInbox {
  const inbox = parseWire(WireInboxSchema, input);
  return {
    unreadChannels: (inbox.unread_channels ?? []).map((channel) => ({
      channelName: normalizeOptionalChannelName(channel.channel_name) ?? '',
      unreadCount: channel.unread_count ?? 0,
    })),
    mentions: (inbox.mentions ?? []).map((mention) => normalizeMessage(mention, { kind: 'channel' })),
    unreadDms: (inbox.unread_dms ?? []).map(normalizeInboxDirect),
    recentReactions: (inbox.recent_reactions ?? []).map(normalizeInboxReaction),
  };
}

export function normalizeReadReceipt(input: unknown): RelayReadReceipt {
  const receipt = parseWire(WireReadReceiptSchema, input);
  return compact<RelayReadReceipt>({
    messageId: receipt.message_id ?? '',
    agentId: opt(receipt.agent_id),
    agentName: opt(receipt.agent_name),
    readAt: opt(receipt.read_at),
  });
}

export function normalizeChannelReadStatus(input: unknown): RelayChannelReadStatus {
  const status = parseWire(WireChannelReadStatusSchema, input);
  return compact<RelayChannelReadStatus>({
    agentName: status.agent_name ?? '',
    lastReadId: opt(status.last_read_id),
    lastReadAt: opt(status.last_read_at),
  });
}

// Canonical durable delivery statuses mapped onto relay inbox states:
// `accepted` means queued for the recipient; the ledger has no `read` state.
// Typed against `DeliveryStatus` so a new canonical status fails to compile
// here until it is mapped.
const INBOX_STATE_BY_DELIVERY_STATUS: Record<DeliveryStatus, InboxItemState> = {
  accepted: 'queued',
  delivered: 'delivered',
  deferred: 'deferred',
  failed: 'failed',
};

export function normalizeInboxItemState(value: string | undefined): InboxItemState {
  const status = DeliveryStatusSchema.safeParse(value);
  return status.success ? INBOX_STATE_BY_DELIVERY_STATUS[status.data] : 'queued';
}

type WireDelivery = z.output<typeof WireDeliverySchema>;

function normalizeDeliveryMetadata(delivery: WireDelivery): Record<string, unknown> | undefined {
  const metadata = compact<Record<string, unknown>>({
    mode: opt(delivery.mode),
    reason: opt(delivery.reason),
    priority: opt(delivery.priority),
    retryable: delivery.retryable ?? undefined,
    error: opt(delivery.error),
    deadline: opt(delivery.deadline),
  });
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * Normalize a relaycast durable delivery item (a `deliveries` ledger row with
 * its embedded message payload) into a relay `InboxItem`.
 */
export function normalizeInboxItem(input: unknown, context: { recipientName?: string } = {}): InboxItem {
  const delivery = parseWire(WireDeliverySchema, input);
  return compact<InboxItem>({
    id: delivery.id ?? '',
    recipient: compact<InboxItem['recipient']>({
      name: context.recipientName ?? delivery.agent_id ?? '',
      id: opt(delivery.agent_id),
    }),
    state: delivery.status ? INBOX_STATE_BY_DELIVERY_STATUS[delivery.status] : 'queued',
    // The relaycast ledger does not expose attempt counts.
    attempts: 0,
    availableAt: opt(delivery.available_at),
    message: normalizeMessage(
      delivery.message ??
        compact<UnknownRecord>({ id: opt(delivery.message_id), channel_id: opt(delivery.channel_id) })
    ),
    metadata: normalizeDeliveryMetadata(delivery),
  });
}

/**
 * Normalize the delivery row returned by a relaycast ack/fail/defer transition
 * into the relay delivery result contract.
 */
export function normalizeDeliveryTransition(
  action: RelayDeliverySupportedResult['action'],
  input: unknown
): RelayDeliverySupportedResult {
  const delivery = parseWire(WireDeliverySchema, input);
  return compact<RelayDeliverySupportedResult>({
    supported: true,
    action,
    deliveryId: delivery.id ?? '',
    messageId: delivery.message_id ?? '',
    state: delivery.status ? INBOX_STATE_BY_DELIVERY_STATUS[delivery.status] : 'queued',
    deferUntil: action === 'defer' ? opt(delivery.available_at) : undefined,
  });
}

export function normalizeSearchResult(input: unknown): RelaySearchResult {
  const result = parseWire(WireSearchResultSchema, input);
  return compact<RelaySearchResult>({
    id: result.id ?? '',
    channelName: normalizeOptionalChannelName(result.channel_name) ?? '',
    agentName: result.agent_name ?? '',
    text: result.text ?? '',
    createdAt: opt(result.created_at),
    relevanceScore: result.relevance_score ?? 0,
  });
}

export function normalizeGroupDirectConversation(input: unknown): RelayGroupDirectConversation {
  const conversation = parseWire(WireGroupDmSchema, input);
  return compact<RelayGroupDirectConversation>({
    id: conversation.id ?? conversation.conversation_id ?? '',
    channelId: opt(conversation.channel_id),
    name: opt(conversation.name),
    participants: (conversation.participants ?? [])
      .map((participant) =>
        typeof participant === 'string'
          ? participant
          : isRecord(participant)
            ? (str(participant, 'agent_name') ?? str(participant, 'agent_id'))
            : undefined
      )
      .filter((participant): participant is string => typeof participant === 'string'),
    createdAt: opt(conversation.created_at),
  });
}

const MEMBERSHIP_EVENT_TYPES = {
  'member.joined': 'memberJoined',
  'member.left': 'memberLeft',
  'member.channel_muted': 'channelMuted',
  'member.channel_unmuted': 'channelUnmuted',
} as const;

export function normalizeMessagingEvent(input: unknown): RelayMessagingEvent {
  const wired = toWire(input);
  const record = isRecord(wired) ? wired : {};
  const sourceType = str(record, 'type');

  switch (sourceType) {
    case 'message.created':
    case 'message.updated': {
      const channel = normalizeOptionalChannelName(str(record, 'channel')) ?? '';
      return {
        type: sourceType === 'message.created' ? 'messageCreated' : 'messageUpdated',
        channel,
        message: normalizeMessage(record.message, { kind: 'channel', channelName: channel }),
      };
    }
    case 'thread.reply': {
      const channel = normalizeOptionalChannelName(str(record, 'channel')) ?? '';
      const parentId = str(record, 'parent_id') ?? '';
      return {
        type: 'threadReply',
        channel,
        parentId,
        message: normalizeMessage(record.message, {
          kind: 'thread_reply',
          channelName: channel,
          parentId,
          threadId: parentId,
        }),
      };
    }
    case 'dm.received':
    case 'group_dm.received': {
      const conversationId = str(record, 'conversation_id') ?? '';
      const kind = sourceType === 'dm.received' ? 'dm' : 'group_dm';
      return {
        type: kind === 'dm' ? 'dmReceived' : 'groupDmReceived',
        conversationId,
        message: normalizeMessage(record.message, { kind, conversationId }),
      };
    }
    // Legacy presence events emitted by older engines; current engines emit
    // `agent.status.*` (surfaced as `unknown` events).
    case 'agent.online':
    case 'agent.offline':
      return {
        type: sourceType === 'agent.online' ? 'agentOnline' : 'agentOffline',
        agent: { name: str(rec(record, 'agent'), 'name') ?? '' },
      };
    case 'agent.spawn_requested': {
      const agent = rec(record, 'agent');
      return {
        type: 'agentSpawnRequested',
        agent: compact({
          name: str(agent, 'name') ?? '',
          cli: opt(str(agent, 'cli')),
          task: opt(str(agent, 'task')),
          channel: normalizeOptionalChannelName(str(agent, 'channel')),
          model: opt(str(agent, 'model')),
          alreadyExisted: bool(agent, 'already_existed') ?? false,
        }),
      };
    }
    case 'agent.release_requested':
      return compact({
        type: 'agentReleaseRequested' as const,
        agent: { name: str(rec(record, 'agent'), 'name') ?? '' },
        reason: opt(str(record, 'reason')),
        deleted: bool(record, 'deleted') ?? false,
      });
    case 'channel.created':
    case 'channel.updated': {
      const channel = rec(record, 'channel');
      return {
        type: sourceType === 'channel.created' ? 'channelCreated' : 'channelUpdated',
        channel: compact({
          name: normalizeOptionalChannelName(str(channel, 'name')) ?? '',
          topic: opt(str(channel, 'topic')),
        }),
      };
    }
    case 'channel.archived':
      return {
        type: 'channelArchived',
        channel: { name: normalizeOptionalChannelName(str(rec(record, 'channel'), 'name')) ?? '' },
      };
    case 'member.joined':
    case 'member.left':
    case 'member.channel_muted':
    case 'member.channel_unmuted':
      return {
        type: MEMBERSHIP_EVENT_TYPES[sourceType],
        channel: normalizeOptionalChannelName(str(record, 'channel')) ?? '',
        agentName: str(record, 'agent_name') ?? '',
      };
    case 'message.read':
      return compact({
        type: 'messageRead' as const,
        messageId: str(record, 'message_id') ?? '',
        agentName: str(record, 'agent_name') ?? '',
        readAt: opt(str(record, 'read_at')),
      });
    // Canonical reaction event plus the legacy split pair.
    case 'message.reacted':
    case 'reaction.added':
    case 'reaction.removed':
      return {
        type:
          sourceType === 'reaction.removed' || str(record, 'action') === 'removed'
            ? 'reactionRemoved'
            : 'reactionAdded',
        messageId: str(record, 'message_id') ?? '',
        emoji: str(record, 'emoji') ?? '',
        agentName: str(record, 'agent_name') ?? '',
      };
    case 'action.invoked':
      return {
        type: 'actionInvoked',
        invocationId: str(record, 'invocation_id') ?? '',
        actionName: str(record, 'action_name') ?? '',
        callerName: str(record, 'caller_name') ?? '',
        handlerAgentId: str(record, 'handler_agent_id') ?? '',
      };
    case 'open':
      return { type: 'connected' };
    case 'close':
      return { type: 'disconnected' };
    case 'error':
      return { type: 'error' };
    case 'reconnecting':
      return { type: 'reconnecting', attempt: num(record, 'attempt') ?? 0 };
    case 'permanently_disconnected':
      return { type: 'permanentlyDisconnected', attempt: num(record, 'attempt') ?? 0 };
    default:
      return { type: 'unknown', ...(sourceType ? { sourceType } : {}), raw: input };
  }
}
