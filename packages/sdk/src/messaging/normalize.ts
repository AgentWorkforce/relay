import type {
  RelayAgent,
  RelayAgentChannel,
  RelayAgentPresence,
  RelayAgentRegistration,
  RelayAgentStatus,
  RelayAgentType,
  RelayChannel,
  RelayChannelMember,
  RelayChannelMemberRole,
  RelayChannelReadStatus,
  RelayGroupDirectConversation,
  RelayInbox,
  RelayInboxDirectSummary,
  RelayInboxLastMessage,
  RelayInboxReactionSummary,
  RelayMessage,
  RelayMessageAttachment,
  RelayMessageBlock,
  RelayMessageKind,
  RelayMessageMode,
  RelayMessageReaction,
  RelayMessagingEvent,
  RelayReadReceipt,
  RelaySearchResult,
  RelayThread,
} from './types.js';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readValue(record: UnknownRecord | undefined, ...keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (Object.hasOwn(record, key)) return record[key];
  }
  return undefined;
}

function readString(record: UnknownRecord | undefined, ...keys: string[]): string | undefined {
  const value = readValue(record, ...keys);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return undefined;
}

function readNullableString(record: UnknownRecord | undefined, ...keys: string[]): string | undefined {
  const value = readValue(record, ...keys);
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(record: UnknownRecord | undefined, ...keys: string[]): boolean | undefined {
  const value = readValue(record, ...keys);
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(record: UnknownRecord | undefined, ...keys: string[]): number | undefined {
  const value = readValue(record, ...keys);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readArray(record: UnknownRecord | undefined, ...keys: string[]): unknown[] {
  const value = readValue(record, ...keys);
  return Array.isArray(value) ? value : [];
}

function readRecord(
  record: UnknownRecord | undefined,
  ...keys: string[]
): Record<string, unknown> | undefined {
  const value = readValue(record, ...keys);
  return isRecord(value) ? { ...value } : undefined;
}

function normalizeOptionalChannelName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith('#') ? value.slice(1) : value;
}

export function normalizeChannelName(value: string): string {
  return normalizeOptionalChannelName(value) ?? value;
}

function normalizeAgentType(value: string | undefined): RelayAgentType {
  return value === 'human' || value === 'system' ? value : 'agent';
}

function normalizeAgentStatus(value: string | undefined): RelayAgentStatus {
  if (value === 'online' || value === 'offline' || value === 'away') return value;
  return 'unknown';
}

function normalizeOnlineStatus(value: string | undefined): Extract<RelayAgentStatus, 'online' | 'offline'> {
  return value === 'online' ? 'online' : 'offline';
}

function normalizeRole(value: string | undefined): RelayChannelMemberRole {
  return value === 'owner' ? 'owner' : 'member';
}

function normalizeMode(value: string | undefined): RelayMessageMode | undefined {
  return value === 'wait' || value === 'steer' ? value : undefined;
}

function normalizeBlocks(value: unknown): RelayMessageBlock[] {
  return Array.isArray(value) ? value.filter(isRecord).map((block) => ({ ...block })) : [];
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function normalizeAgentChannel(input: unknown): RelayAgentChannel {
  const record = isRecord(input) ? input : {};
  const name = normalizeOptionalChannelName(readString(record, 'name', 'channelName', 'channel_name')) ?? '';
  return {
    id: readString(record, 'id', 'channelId', 'channel_id') ?? name,
    name,
    role: normalizeRole(readString(record, 'role')),
    ...(readString(record, 'joinedAt', 'joined_at')
      ? { joinedAt: readString(record, 'joinedAt', 'joined_at') }
      : {}),
  };
}

export function normalizeAgent(input: unknown): RelayAgent {
  const record = isRecord(input) ? input : {};
  const id =
    readString(record, 'id', 'agentId', 'agent_id') ??
    readString(record, 'name', 'agentName', 'agent_name') ??
    '';
  const name = readString(record, 'name', 'agentName', 'agent_name') ?? id;
  const lastSeenAt = readString(record, 'lastSeenAt', 'last_seen', 'lastSeen');
  const createdAt = readString(record, 'createdAt', 'created_at');
  const persona = readNullableString(record, 'persona');

  return {
    id,
    name,
    type: normalizeAgentType(readString(record, 'type')),
    status: normalizeAgentStatus(readString(record, 'status')),
    ...(persona ? { persona } : {}),
    metadata: readRecord(record, 'metadata') ?? {},
    ...(lastSeenAt ? { lastSeenAt } : {}),
    ...(createdAt ? { createdAt } : {}),
    channels: readArray(record, 'channels').map(normalizeAgentChannel),
  };
}

export function normalizeAgentRegistration(input: unknown): RelayAgentRegistration {
  const record = isRecord(input) ? input : {};
  const id = readString(record, 'id', 'agentId', 'agent_id') ?? readString(record, 'name') ?? '';
  const name = readString(record, 'name', 'agentName', 'agent_name') ?? id;
  const createdAt = readString(record, 'createdAt', 'created_at');
  return {
    id,
    name,
    token: readString(record, 'token') ?? '',
    status: normalizeAgentStatus(readString(record, 'status')),
    ...(createdAt ? { createdAt } : {}),
  };
}

export function normalizeAgentPresence(input: unknown): RelayAgentPresence {
  const record = isRecord(input) ? input : {};
  const agentId = readString(record, 'agentId', 'agent_id', 'id') ?? '';
  const agentName = readString(record, 'agentName', 'agent_name', 'name') ?? agentId;
  return {
    agentId,
    agentName,
    status: normalizeOnlineStatus(readString(record, 'status')),
  };
}

export function normalizeChannelMember(input: unknown): RelayChannelMember {
  const record = isRecord(input) ? input : {};
  const agentId = readString(record, 'agentId', 'agent_id', 'id') ?? '';
  const agentName = readString(record, 'agentName', 'agent_name', 'name') ?? agentId;
  return {
    agentId,
    agentName,
    role: normalizeRole(readString(record, 'role')),
    ...(readString(record, 'joinedAt', 'joined_at')
      ? { joinedAt: readString(record, 'joinedAt', 'joined_at') }
      : {}),
    muted: readBoolean(record, 'muted', 'isMuted', 'is_muted') ?? false,
  };
}

export function normalizeChannel(input: unknown): RelayChannel {
  const record = isRecord(input) ? input : {};
  const name = normalizeOptionalChannelName(readString(record, 'name', 'channelName', 'channel_name')) ?? '';
  const topic = readNullableString(record, 'topic');
  const createdBy = readString(record, 'createdBy', 'created_by');
  const createdAt = readString(record, 'createdAt', 'created_at');
  const memberCount = readNumber(record, 'memberCount', 'member_count');

  return {
    id: readString(record, 'id', 'channelId', 'channel_id') ?? name,
    name,
    ...(topic ? { topic } : {}),
    metadata: readRecord(record, 'metadata') ?? {},
    ...(createdBy ? { createdBy } : {}),
    ...(createdAt ? { createdAt } : {}),
    archived: readBoolean(record, 'archived', 'isArchived', 'is_archived') ?? false,
    ...(memberCount !== undefined ? { memberCount } : {}),
    members: readArray(record, 'members').map(normalizeChannelMember),
  };
}

export function normalizeAttachment(input: unknown): RelayMessageAttachment {
  const record = isRecord(input) ? input : {};
  const type = readString(record, 'type');
  if (type === 'text') {
    return {
      type,
      text: readString(record, 'text', 'content') ?? '',
      ...(readString(record, 'label') ? { label: readString(record, 'label') } : {}),
    };
  }
  if (type === 'image') {
    return {
      type,
      ...(readString(record, 'url') ? { url: readString(record, 'url') } : {}),
      ...(readString(record, 'data') ? { data: readString(record, 'data') } : {}),
      ...(readString(record, 'mimeType', 'mime_type')
        ? { mimeType: readString(record, 'mimeType', 'mime_type') }
        : {}),
      ...(readString(record, 'alt') ? { alt: readString(record, 'alt') } : {}),
      ...(readString(record, 'label') ? { label: readString(record, 'label') } : {}),
    };
  }
  if (type === 'link') {
    return {
      type,
      url: readString(record, 'url') ?? '',
      ...(readString(record, 'title') ? { title: readString(record, 'title') } : {}),
      ...(readString(record, 'label') ? { label: readString(record, 'label') } : {}),
    };
  }
  if (type === 'file') {
    return {
      type,
      path: readString(record, 'path') ?? readString(record, 'filename', 'name') ?? '',
      ...(readNumber(record, 'line') !== undefined ? { line: readNumber(record, 'line') } : {}),
      ...(readString(record, 'label') ? { label: readString(record, 'label') } : {}),
    };
  }
  if (type === 'json') {
    return {
      type,
      value: readValue(record, 'value'),
      ...(readString(record, 'label') ? { label: readString(record, 'label') } : {}),
    };
  }
  if (type === 'diff') {
    return {
      type,
      patch: readString(record, 'patch', 'diff') ?? '',
      ...(readString(record, 'label') ? { label: readString(record, 'label') } : {}),
    };
  }
  if (type === 'artifact') {
    return {
      type,
      id: readString(record, 'id', 'artifactId', 'artifact_id') ?? '',
      ...(readString(record, 'url') ? { url: readString(record, 'url') } : {}),
      ...(readString(record, 'label') ? { label: readString(record, 'label') } : {}),
    };
  }

  const filename = readString(record, 'filename', 'name');
  const contentType = readString(record, 'contentType', 'content_type');
  const sizeBytes = readNumber(record, 'sizeBytes', 'size_bytes');

  return {
    id: readString(record, 'id', 'fileId', 'file_id') ?? filename ?? '',
    ...(filename ? { filename } : {}),
    ...(contentType ? { contentType } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
  };
}

export function normalizeReaction(input: unknown): RelayMessageReaction {
  const record = isRecord(input) ? input : {};
  return {
    emoji: readString(record, 'emoji') ?? '',
    count: readNumber(record, 'count') ?? 0,
    agents: normalizeStringArray(readValue(record, 'agents', 'agentNames', 'agent_names')),
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
  const record = isRecord(input) ? input : {};
  const fromRecord = isRecord(readValue(record, 'from', 'sender', 'agent'))
    ? (readValue(record, 'from', 'sender', 'agent') as UnknownRecord)
    : undefined;
  const channelName =
    context.channelName ??
    normalizeOptionalChannelName(readString(record, 'channelName', 'channel_name', 'channel'));
  const channelId = context.channelId ?? readString(record, 'channelId', 'channel_id');
  const conversationId = context.conversationId ?? readString(record, 'conversationId', 'conversation_id');
  const parentId = context.parentId ?? readString(record, 'parentId', 'parent_id');
  const threadId = context.threadId ?? readNullableString(record, 'threadId', 'thread_id');
  const createdAt = readString(record, 'createdAt', 'created_at') ?? context.createdAt;
  const updatedAt = readNullableString(record, 'updatedAt', 'updated_at');
  const metadata = readRecord(record, 'metadata') ?? readRecord(record, 'data');
  const replyCount = readNumber(record, 'replyCount', 'reply_count');
  const readByCount = readNumber(record, 'readByCount', 'read_by_count');
  const kind =
    context.kind ??
    (parentId ? 'thread_reply' : conversationId ? 'dm' : channelId || channelName ? 'channel' : 'unknown');

  return {
    id: readString(record, 'id', 'messageId', 'message_id') ?? '',
    kind,
    text: readString(record, 'text', 'body') ?? '',
    from: {
      ...((readString(record, 'agentId', 'agent_id', 'fromId', 'from_id') ??
      readString(fromRecord, 'id', 'agentId', 'agent_id'))
        ? {
            id:
              readString(record, 'agentId', 'agent_id', 'fromId', 'from_id') ??
              readString(fromRecord, 'id', 'agentId', 'agent_id'),
          }
        : {}),
      ...((readString(record, 'agentName', 'agent_name', 'fromName', 'from_name', 'from') ??
      readString(fromRecord, 'name', 'agentName', 'agent_name'))
        ? {
            name:
              readString(record, 'agentName', 'agent_name', 'fromName', 'from_name', 'from') ??
              readString(fromRecord, 'name', 'agentName', 'agent_name'),
          }
        : {}),
    },
    ...(channelId || channelName
      ? {
          channel: {
            ...(channelId ? { id: channelId } : {}),
            ...(channelName ? { name: channelName } : {}),
          },
        }
      : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(parentId ? { parentId } : {}),
    ...(normalizeMode(readString(record, 'mode', 'injectionMode', 'injection_mode'))
      ? {
          mode: normalizeMode(readString(record, 'mode', 'injectionMode', 'injection_mode')),
        }
      : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(metadata ? { metadata } : {}),
    blocks: normalizeBlocks(readValue(record, 'blocks')),
    attachments: readArray(record, 'attachments').map(normalizeAttachment),
    ...(replyCount !== undefined ? { replyCount } : {}),
    reactions: readArray(record, 'reactions').map(normalizeReaction),
    ...(readByCount !== undefined ? { readByCount } : {}),
    mentions: normalizeStringArray(readValue(record, 'mentions')),
  };
}

export function normalizeThread(input: unknown): RelayThread {
  const record = isRecord(input) ? input : {};
  const parent = normalizeMessage(readValue(record, 'parent'), { kind: 'channel' });
  const replies = readArray(record, 'replies').map((reply) =>
    normalizeMessage(reply, {
      kind: 'thread_reply',
      channelId: parent.channel?.id,
      channelName: parent.channel?.name,
      threadId: parent.threadId ?? parent.id,
      parentId: parent.id,
    })
  );
  return { parent, replies };
}

function normalizeInboxLastMessage(input: unknown): RelayInboxLastMessage | undefined {
  const record = isRecord(input) ? input : undefined;
  if (!record) return undefined;
  const createdAt = readString(record, 'createdAt', 'created_at');
  return {
    id: readString(record, 'id', 'messageId', 'message_id') ?? '',
    text: readString(record, 'text', 'body') ?? '',
    ...(createdAt ? { createdAt } : {}),
  };
}

function normalizeInboxDirect(input: unknown): RelayInboxDirectSummary {
  const record = isRecord(input) ? input : {};
  const lastMessage = normalizeInboxLastMessage(readValue(record, 'lastMessage', 'last_message'));
  return {
    conversationId: readString(record, 'conversationId', 'conversation_id') ?? '',
    from: readString(record, 'from', 'agentName', 'agent_name') ?? '',
    unreadCount: readNumber(record, 'unreadCount', 'unread_count') ?? 0,
    ...(lastMessage ? { lastMessage } : {}),
  };
}

function normalizeInboxReaction(input: unknown): RelayInboxReactionSummary {
  const record = isRecord(input) ? input : {};
  const createdAt = readString(record, 'createdAt', 'created_at');
  return {
    messageId: readString(record, 'messageId', 'message_id') ?? '',
    channelName:
      normalizeOptionalChannelName(readString(record, 'channelName', 'channel_name', 'channel')) ?? '',
    emoji: readString(record, 'emoji') ?? '',
    agentName: readString(record, 'agentName', 'agent_name') ?? '',
    ...(createdAt ? { createdAt } : {}),
  };
}

export function normalizeInbox(input: unknown): RelayInbox {
  const record = isRecord(input) ? input : {};
  return {
    unreadChannels: readArray(record, 'unreadChannels', 'unread_channels').map((item) => {
      const itemRecord = isRecord(item) ? item : {};
      return {
        channelName:
          normalizeOptionalChannelName(readString(itemRecord, 'channelName', 'channel_name', 'channel')) ??
          '',
        unreadCount: readNumber(itemRecord, 'unreadCount', 'unread_count') ?? 0,
      };
    }),
    mentions: readArray(record, 'mentions').map((item) => {
      const itemRecord = isRecord(item) ? item : {};
      return normalizeMessage(itemRecord, {
        kind: 'channel',
        channelName: normalizeOptionalChannelName(
          readString(itemRecord, 'channelName', 'channel_name', 'channel')
        ),
      });
    }),
    unreadDms: readArray(record, 'unreadDms', 'unread_dms').map(normalizeInboxDirect),
    recentReactions: readArray(record, 'recentReactions', 'recent_reactions').map(normalizeInboxReaction),
  };
}

export function normalizeReadReceipt(input: unknown): RelayReadReceipt {
  const record = isRecord(input) ? input : {};
  const readAt = readString(record, 'readAt', 'read_at');
  return {
    messageId: readString(record, 'messageId', 'message_id') ?? '',
    ...(readString(record, 'agentId', 'agent_id')
      ? { agentId: readString(record, 'agentId', 'agent_id') }
      : {}),
    ...(readString(record, 'agentName', 'agent_name')
      ? { agentName: readString(record, 'agentName', 'agent_name') }
      : {}),
    ...(readAt ? { readAt } : {}),
  };
}

export function normalizeChannelReadStatus(input: unknown): RelayChannelReadStatus {
  const record = isRecord(input) ? input : {};
  const lastReadId = readNullableString(record, 'lastReadId', 'last_read_id');
  const lastReadAt = readNullableString(record, 'lastReadAt', 'last_read_at');
  return {
    agentName: readString(record, 'agentName', 'agent_name') ?? '',
    ...(lastReadId ? { lastReadId } : {}),
    ...(lastReadAt ? { lastReadAt } : {}),
  };
}

export function normalizeSearchResult(input: unknown): RelaySearchResult {
  const record = isRecord(input) ? input : {};
  const createdAt = readString(record, 'createdAt', 'created_at');
  return {
    id: readString(record, 'id', 'messageId', 'message_id') ?? '',
    channelName:
      normalizeOptionalChannelName(readString(record, 'channelName', 'channel_name', 'channel')) ?? '',
    agentName: readString(record, 'agentName', 'agent_name') ?? '',
    text: readString(record, 'text', 'body') ?? '',
    ...(createdAt ? { createdAt } : {}),
    relevanceScore: readNumber(record, 'relevanceScore', 'relevance_score') ?? 0,
  };
}

export function normalizeGroupDirectConversation(input: unknown): RelayGroupDirectConversation {
  const record = isRecord(input) ? input : {};
  const name = readNullableString(record, 'name');
  const createdAt = readString(record, 'createdAt', 'created_at');
  return {
    id: readString(record, 'id', 'conversationId', 'conversation_id') ?? '',
    ...(readString(record, 'channelId', 'channel_id')
      ? { channelId: readString(record, 'channelId', 'channel_id') }
      : {}),
    ...(name ? { name } : {}),
    participants: readArray(record, 'participants')
      .map((participant) => {
        const participantRecord = isRecord(participant) ? participant : undefined;
        return typeof participant === 'string'
          ? participant
          : readString(participantRecord, 'agentName', 'agent_name', 'agentId', 'agent_id');
      })
      .filter((participant): participant is string => typeof participant === 'string'),
    ...(createdAt ? { createdAt } : {}),
  };
}

export function normalizeMessagingEvent(input: unknown): RelayMessagingEvent {
  const record = isRecord(input) ? input : {};
  const sourceType = readString(record, 'type');

  switch (sourceType) {
    case 'message.created': {
      const channel = normalizeOptionalChannelName(readString(record, 'channel')) ?? '';
      return {
        type: 'messageCreated',
        channel,
        message: normalizeMessage(readValue(record, 'message'), { kind: 'channel', channelName: channel }),
      };
    }
    case 'message.updated': {
      const channel = normalizeOptionalChannelName(readString(record, 'channel')) ?? '';
      return {
        type: 'messageUpdated',
        channel,
        message: normalizeMessage(readValue(record, 'message'), { kind: 'channel', channelName: channel }),
      };
    }
    case 'thread.reply': {
      const channel = normalizeOptionalChannelName(readString(record, 'channel')) ?? '';
      const parentId = readString(record, 'parentId', 'parent_id') ?? '';
      return {
        type: 'threadReply',
        channel,
        parentId,
        message: normalizeMessage(readValue(record, 'message'), {
          kind: 'thread_reply',
          channelName: channel,
          parentId,
          threadId: parentId,
        }),
      };
    }
    case 'dm.received': {
      const conversationId = readString(record, 'conversationId', 'conversation_id') ?? '';
      return {
        type: 'dmReceived',
        conversationId,
        message: normalizeMessage(readValue(record, 'message'), { kind: 'dm', conversationId }),
      };
    }
    case 'group_dm.received': {
      const conversationId = readString(record, 'conversationId', 'conversation_id') ?? '';
      return {
        type: 'groupDmReceived',
        conversationId,
        message: normalizeMessage(readValue(record, 'message'), { kind: 'group_dm', conversationId }),
      };
    }
    case 'agent.online':
      return {
        type: 'agentOnline',
        agent: {
          name:
            readString(
              isRecord(readValue(record, 'agent'))
                ? (readValue(record, 'agent') as UnknownRecord)
                : undefined,
              'name'
            ) ?? '',
        },
      };
    case 'agent.offline':
      return {
        type: 'agentOffline',
        agent: {
          name:
            readString(
              isRecord(readValue(record, 'agent'))
                ? (readValue(record, 'agent') as UnknownRecord)
                : undefined,
              'name'
            ) ?? '',
        },
      };
    case 'agent.spawn_requested': {
      const agent = isRecord(readValue(record, 'agent')) ? (readValue(record, 'agent') as UnknownRecord) : {};
      return {
        type: 'agentSpawnRequested',
        agent: {
          name: readString(agent, 'name') ?? '',
          ...(readString(agent, 'cli') ? { cli: readString(agent, 'cli') } : {}),
          ...(readString(agent, 'task') ? { task: readString(agent, 'task') } : {}),
          ...(normalizeOptionalChannelName(readNullableString(agent, 'channel') ?? undefined)
            ? { channel: normalizeOptionalChannelName(readNullableString(agent, 'channel') ?? undefined) }
            : {}),
          alreadyExisted: readBoolean(agent, 'alreadyExisted', 'already_existed') ?? false,
        },
      };
    }
    case 'agent.release_requested': {
      const agent = isRecord(readValue(record, 'agent')) ? (readValue(record, 'agent') as UnknownRecord) : {};
      const reason = readNullableString(record, 'reason');
      return {
        type: 'agentReleaseRequested',
        agent: { name: readString(agent, 'name') ?? '' },
        ...(reason ? { reason } : {}),
        deleted: readBoolean(record, 'deleted') ?? false,
      };
    }
    case 'channel.created':
    case 'channel.updated': {
      const channel = isRecord(readValue(record, 'channel'))
        ? (readValue(record, 'channel') as UnknownRecord)
        : {};
      const topic = readNullableString(channel, 'topic');
      return {
        type: sourceType === 'channel.created' ? 'channelCreated' : 'channelUpdated',
        channel: {
          name: normalizeOptionalChannelName(readString(channel, 'name')) ?? '',
          ...(topic ? { topic } : {}),
        },
      };
    }
    case 'channel.archived': {
      const channel = isRecord(readValue(record, 'channel'))
        ? (readValue(record, 'channel') as UnknownRecord)
        : {};
      return {
        type: 'channelArchived',
        channel: { name: normalizeOptionalChannelName(readString(channel, 'name')) ?? '' },
      };
    }
    case 'member.joined':
    case 'member.left':
    case 'member.channel_muted':
    case 'member.channel_unmuted': {
      const type =
        sourceType === 'member.joined'
          ? 'memberJoined'
          : sourceType === 'member.left'
            ? 'memberLeft'
            : sourceType === 'member.channel_muted'
              ? 'channelMuted'
              : 'channelUnmuted';
      return {
        type,
        channel: normalizeOptionalChannelName(readString(record, 'channel')) ?? '',
        agentName: readString(record, 'agentName', 'agent_name') ?? '',
      };
    }
    case 'message.read':
      return {
        type: 'messageRead',
        messageId: readString(record, 'messageId', 'message_id') ?? '',
        agentName: readString(record, 'agentName', 'agent_name') ?? '',
        ...(readString(record, 'readAt', 'read_at')
          ? { readAt: readString(record, 'readAt', 'read_at') }
          : {}),
      };
    case 'reaction.added':
    case 'reaction.removed':
      return {
        type: sourceType === 'reaction.added' ? 'reactionAdded' : 'reactionRemoved',
        messageId: readString(record, 'messageId', 'message_id') ?? '',
        emoji: readString(record, 'emoji') ?? '',
        agentName: readString(record, 'agentName', 'agent_name') ?? '',
      };
    case 'open':
      return { type: 'connected' };
    case 'close':
      return { type: 'disconnected' };
    case 'error':
      return { type: 'error' };
    case 'reconnecting':
      return { type: 'reconnecting', attempt: readNumber(record, 'attempt') ?? 0 };
    case 'permanently_disconnected':
      return { type: 'permanentlyDisconnected', attempt: readNumber(record, 'attempt') ?? 0 };
    default:
      return { type: 'unknown', ...(sourceType ? { sourceType } : {}), raw: input };
  }
}
