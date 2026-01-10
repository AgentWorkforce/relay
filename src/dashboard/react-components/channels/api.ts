/**
 * Real API Service for Channels V1
 *
 * Production API calls for channel-based messaging.
 * Replaces mockApi.ts when USE_REAL_CHANNELS_API is enabled.
 */

import type {
  Channel,
  ChannelMember,
  ChannelMessage,
  ListChannelsResponse,
  GetChannelResponse,
  GetMessagesResponse,
  CreateChannelRequest,
  CreateChannelResponse,
  SendMessageRequest,
  SendMessageResponse,
  SearchResult,
  SearchResponse,
} from './types';

// Feature flag for switching between mock and real API
// Set via environment variable or runtime config
const USE_REAL_API = typeof process !== 'undefined'
  ? process.env.NEXT_PUBLIC_USE_REAL_CHANNELS_API === 'true'
  : false;

// Re-export mock functions for fallback
import * as mockApi from './mockApi';

/**
 * API request helper with error handling
 */
async function apiRequest<T>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new ApiError(
      `API request failed: ${response.status} ${response.statusText}`,
      response.status,
      errorBody
    );
  }

  return response.json();
}

/**
 * Custom error class for API errors
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// =============================================================================
// Channel API Functions
// =============================================================================

/**
 * List all channels for current user
 */
export async function listChannels(workspaceId: string): Promise<ListChannelsResponse> {
  if (!USE_REAL_API) {
    return mockApi.listChannels();
  }

  const data = await apiRequest<{ channels: unknown[]; archivedChannels?: unknown[] }>(
    `/api/workspaces/${workspaceId}/channels`
  );

  return {
    channels: data.channels.map(mapChannelFromBackend),
    archivedChannels: (data.archivedChannels || []).map(mapChannelFromBackend),
  };
}

/**
 * Get channel details and members
 */
export async function getChannel(
  workspaceId: string,
  channelId: string
): Promise<GetChannelResponse> {
  if (!USE_REAL_API) {
    return mockApi.getChannel(channelId);
  }

  const data = await apiRequest<{ channel: unknown; members: unknown[] }>(
    `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}`
  );

  return {
    channel: mapChannelFromBackend(data.channel),
    members: (data.members || []).map(mapMemberFromBackend),
  };
}

/**
 * Get messages in a channel
 */
export async function getMessages(
  workspaceId: string,
  channelId: string,
  options?: { before?: string; limit?: number; threadId?: string }
): Promise<GetMessagesResponse> {
  if (!USE_REAL_API) {
    return mockApi.getMessages(channelId, options);
  }

  const params = new URLSearchParams();
  if (options?.before) params.append('before', options.before);
  if (options?.limit) params.append('limit', String(options.limit));
  if (options?.threadId) params.append('threadId', options.threadId);

  const queryString = params.toString();
  const url = `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}/messages${
    queryString ? '?' + queryString : ''
  }`;

  const data = await apiRequest<{
    messages: unknown[];
    hasMore: boolean;
    unread: { count: number; firstUnreadMessageId?: string };
  }>(url);

  return {
    messages: data.messages.map(mapMessageFromBackend),
    hasMore: data.hasMore,
    unread: data.unread,
  };
}

/**
 * Create a new channel
 */
export async function createChannel(
  workspaceId: string,
  request: CreateChannelRequest
): Promise<CreateChannelResponse> {
  if (!USE_REAL_API) {
    return mockApi.createChannel(request);
  }

  const data = await apiRequest<{ channel: unknown }>(
    `/api/workspaces/${workspaceId}/channels`,
    {
      method: 'POST',
      body: JSON.stringify({
        name: request.name,
        description: request.description,
        isPrivate: request.visibility === 'private',
        members: request.members,
      }),
    }
  );

  return {
    channel: mapChannelFromBackend(data.channel),
  };
}

/**
 * Send a message to a channel
 */
export async function sendMessage(
  workspaceId: string,
  channelId: string,
  request: SendMessageRequest
): Promise<SendMessageResponse> {
  if (!USE_REAL_API) {
    return mockApi.sendMessage(channelId, request);
  }

  const data = await apiRequest<{ message: unknown }>(
    `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: 'POST',
      body: JSON.stringify(request),
    }
  );

  return {
    message: mapMessageFromBackend(data.message),
  };
}

/**
 * Join a channel
 */
export async function joinChannel(
  workspaceId: string,
  channelId: string
): Promise<Channel> {
  if (!USE_REAL_API) {
    return mockApi.joinChannel(channelId);
  }

  const data = await apiRequest<{ channel: unknown }>(
    `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}/join`,
    { method: 'POST' }
  );

  return mapChannelFromBackend(data.channel);
}

/**
 * Leave a channel
 */
export async function leaveChannel(
  workspaceId: string,
  channelId: string
): Promise<void> {
  if (!USE_REAL_API) {
    return mockApi.leaveChannel(channelId);
  }

  await apiRequest<void>(
    `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}/leave`,
    { method: 'POST' }
  );
}

/**
 * Archive a channel
 */
export async function archiveChannel(
  workspaceId: string,
  channelId: string
): Promise<Channel> {
  if (!USE_REAL_API) {
    return mockApi.archiveChannel(channelId);
  }

  const data = await apiRequest<{ channel: unknown }>(
    `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}/archive`,
    { method: 'POST' }
  );

  return mapChannelFromBackend(data.channel);
}

/**
 * Unarchive a channel
 */
export async function unarchiveChannel(
  workspaceId: string,
  channelId: string
): Promise<Channel> {
  if (!USE_REAL_API) {
    return mockApi.unarchiveChannel(channelId);
  }

  const data = await apiRequest<{ channel: unknown }>(
    `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}/unarchive`,
    { method: 'POST' }
  );

  return mapChannelFromBackend(data.channel);
}

/**
 * Delete a channel (permanent)
 */
export async function deleteChannel(
  workspaceId: string,
  channelId: string
): Promise<void> {
  if (!USE_REAL_API) {
    return mockApi.deleteChannel(channelId);
  }

  await apiRequest<void>(
    `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}`,
    { method: 'DELETE' }
  );
}

/**
 * Mark messages as read up to a specific message or all messages
 * @param upToMessageId - Optional message ID to mark read up to. If omitted, marks all as read.
 */
export async function markRead(
  workspaceId: string,
  channelId: string,
  upToMessageId?: string
): Promise<void> {
  if (!USE_REAL_API) {
    // Mock uses timestamp, pass current time if no message ID
    return mockApi.markRead(channelId, new Date().toISOString());
  }

  await apiRequest<{ success: boolean; unreadCount: number }>(
    `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}/read`,
    {
      method: 'POST',
      body: JSON.stringify(upToMessageId ? { lastMessageId: upToMessageId } : {}),
    }
  );
}

/**
 * Pin a message
 */
export async function pinMessage(
  workspaceId: string,
  channelId: string,
  messageId: string
): Promise<void> {
  if (!USE_REAL_API) {
    // Mock doesn't have pin support - no-op
    return;
  }

  await apiRequest<void>(
    `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/pin`,
    { method: 'POST' }
  );
}

/**
 * Unpin a message
 */
export async function unpinMessage(
  workspaceId: string,
  channelId: string,
  messageId: string
): Promise<void> {
  if (!USE_REAL_API) {
    // Mock doesn't have unpin support - no-op
    return;
  }

  await apiRequest<void>(
    `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/unpin`,
    { method: 'POST' }
  );
}

/**
 * Get mention suggestions (online agents/users)
 */
export async function getMentionSuggestions(
  workspaceId: string
): Promise<string[]> {
  if (!USE_REAL_API) {
    return mockApi.getMentionSuggestions();
  }

  // Use existing agents endpoint or presence data
  try {
    const data = await apiRequest<{ agents?: { name: string }[] }>(
      `/api/workspaces/${workspaceId}/agents`
    );
    return (data.agents || []).map(a => a.name);
  } catch {
    // Fallback to empty if endpoint not available
    return [];
  }
}

// =============================================================================
// Search API Functions (Task 5)
// =============================================================================

/**
 * Search messages across a workspace
 */
export async function searchMessages(
  workspaceId: string,
  query: string,
  options?: { channelId?: string; limit?: number; offset?: number }
): Promise<SearchResponse> {
  if (!USE_REAL_API) {
    // Mock search response
    return {
      results: [],
      total: 0,
      hasMore: false,
      query,
    };
  }

  const params = new URLSearchParams();
  params.append('q', query);
  if (options?.limit) params.append('limit', String(options.limit));
  if (options?.offset) params.append('offset', String(options.offset));

  // Use channel-scoped or workspace-wide search
  const basePath = options?.channelId
    ? `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(options.channelId)}/search`
    : `/api/workspaces/${workspaceId}/search`;

  const url = `${basePath}?${params.toString()}`;

  const data = await apiRequest<{
    results: unknown[];
    total: number;
    hasMore: boolean;
  }>(url);

  return {
    results: data.results.map(mapSearchResultFromBackend),
    total: data.total,
    hasMore: data.hasMore,
    query,
  };
}

/**
 * Search within a specific channel
 */
export async function searchChannel(
  workspaceId: string,
  channelId: string,
  query: string,
  options?: { limit?: number; offset?: number }
): Promise<SearchResponse> {
  return searchMessages(workspaceId, query, {
    ...options,
    channelId,
  });
}

// =============================================================================
// Admin API Functions (Task 10)
// =============================================================================

/**
 * Update channel settings (name, description, visibility)
 * Requires channel or workspace admin role.
 */
export async function updateChannel(
  workspaceId: string,
  channelId: string,
  updates: { name?: string; description?: string; isPrivate?: boolean }
): Promise<Channel> {
  if (!USE_REAL_API) {
    // Mock: return updated channel
    const channels = await mockApi.listChannels();
    const channel = channels.channels.find(c => c.id === channelId);
    if (!channel) throw new ApiError('Channel not found', 404);
    return {
      ...channel,
      name: updates.name ?? channel.name,
      description: updates.description ?? channel.description,
      visibility: updates.isPrivate !== undefined
        ? (updates.isPrivate ? 'private' : 'public')
        : channel.visibility,
    };
  }

  const data = await apiRequest<{ channel: unknown }>(
    `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }
  );

  return mapChannelFromBackend(data.channel);
}

/**
 * Add a member to a channel (user or agent)
 * Requires channel or workspace admin role.
 */
export async function addMember(
  workspaceId: string,
  channelId: string,
  request: { memberId: string; memberType: 'user' | 'agent'; role?: 'admin' | 'member' | 'read_only' }
): Promise<ChannelMember> {
  if (!USE_REAL_API) {
    // Mock: return new member
    return {
      id: request.memberId,
      displayName: request.memberId,
      entityType: request.memberType,
      role: request.role === 'admin' ? 'admin' : 'member',
      status: 'offline',
      joinedAt: new Date().toISOString(),
    };
  }

  const data = await apiRequest<{ member: unknown }>(
    `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}/members`,
    {
      method: 'POST',
      body: JSON.stringify(request),
    }
  );

  return mapMemberFromBackend(data.member);
}

/**
 * Remove a member from a channel
 * Requires channel or workspace admin role.
 * Cannot remove the last admin.
 */
export async function removeMember(
  workspaceId: string,
  channelId: string,
  memberId: string,
  memberType: 'user' | 'agent'
): Promise<void> {
  if (!USE_REAL_API) {
    // Mock: no-op
    return;
  }

  await apiRequest<void>(
    `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(memberId)}?memberType=${memberType}`,
    { method: 'DELETE' }
  );
}

/**
 * Update a member's role in a channel
 * Requires channel or workspace admin role.
 * Cannot demote the last admin.
 */
export async function updateMemberRole(
  workspaceId: string,
  channelId: string,
  memberId: string,
  request: { role: 'admin' | 'member' | 'read_only'; memberType: 'user' | 'agent' }
): Promise<ChannelMember> {
  if (!USE_REAL_API) {
    // Mock: return updated member
    return {
      id: memberId,
      displayName: memberId,
      entityType: request.memberType,
      role: request.role === 'admin' ? 'admin' : 'member',
      status: 'offline',
      joinedAt: new Date().toISOString(),
    };
  }

  const data = await apiRequest<{ member: unknown }>(
    `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(memberId)}/role`,
    {
      method: 'PATCH',
      body: JSON.stringify(request),
    }
  );

  return mapMemberFromBackend(data.member);
}

/**
 * Get all members of a channel
 */
export async function getChannelMembers(
  workspaceId: string,
  channelId: string
): Promise<ChannelMember[]> {
  if (!USE_REAL_API) {
    // Mock: return empty list or from getChannel
    const response = await mockApi.getChannel(channelId);
    return response.members || [];
  }

  const data = await apiRequest<{ members: unknown[] }>(
    `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}/members`
  );

  return (data.members || []).map(mapMemberFromBackend);
}

/**
 * Map search result from backend format
 */
function mapSearchResultFromBackend(backend: unknown): SearchResult {
  const b = backend as Record<string, unknown>;
  return {
    id: String(b.id || b.messageId || ''),
    channelId: String(b.channelId || ''),
    channelName: String(b.channelName || ''),
    from: String(b.from || b.senderName || ''),
    fromEntityType: (b.fromEntityType as 'agent' | 'user') || 'user',
    content: String(b.content || b.body || ''),
    snippet: String(b.snippet || b.headline || b.content || ''),
    timestamp: String(b.timestamp || b.createdAt || new Date().toISOString()),
    rank: Number(b.rank) || 0,
  };
}

// =============================================================================
// Mapping Functions - Convert backend responses to frontend types
// =============================================================================

/**
 * Map channel from backend format to frontend format
 */
function mapChannelFromBackend(backend: unknown): Channel {
  const b = backend as Record<string, unknown>;
  return {
    id: String(b.id || ''),
    name: String(b.name || ''),
    description: b.description as string | undefined,
    topic: b.topic as string | undefined,
    visibility: b.isPrivate ? 'private' : 'public',
    status: b.isArchived ? 'archived' : 'active',
    createdAt: String(b.createdAt || new Date().toISOString()),
    createdBy: String(b.createdById || b.createdBy || ''),
    lastActivityAt: b.lastActivityAt as string | undefined,
    memberCount: Number(b.memberCount) || 0,
    unreadCount: Number(b.unreadCount) || 0,
    hasMentions: Boolean(b.hasMentions),
    lastMessage: b.lastMessage as Channel['lastMessage'],
    isDm: Boolean(b.isDm),
    dmParticipants: b.dmParticipants as string[] | undefined,
  };
}

/**
 * Map member from backend format to frontend format
 */
function mapMemberFromBackend(backend: unknown): ChannelMember {
  const b = backend as Record<string, unknown>;
  return {
    id: String(b.id || b.userId || ''),
    displayName: b.displayName as string | undefined,
    avatarUrl: b.avatarUrl as string | undefined,
    entityType: (b.entityType as 'agent' | 'user') || 'user',
    role: mapRole(b.role as string),
    status: (b.status as 'online' | 'away' | 'offline') || 'offline',
    joinedAt: String(b.joinedAt || new Date().toISOString()),
  };
}

/**
 * Map role from backend to frontend format
 */
function mapRole(backendRole: string | undefined): 'owner' | 'admin' | 'member' {
  switch (backendRole) {
    case 'admin':
      return 'owner'; // Backend admin = frontend owner for channel creator
    case 'member':
      return 'member';
    case 'read_only':
      return 'member'; // Map read_only to member for display
    default:
      return 'member';
  }
}

/**
 * Map message from backend format to frontend format
 */
function mapMessageFromBackend(backend: unknown): ChannelMessage {
  const b = backend as Record<string, unknown>;
  return {
    id: String(b.id || ''),
    channelId: String(b.channelId || ''),
    from: String(b.from || b.senderName || ''),
    fromEntityType: (b.fromEntityType as 'agent' | 'user') || 'user',
    fromAvatarUrl: b.fromAvatarUrl as string | undefined,
    content: String(b.content || b.body || ''),
    timestamp: String(b.timestamp || b.createdAt || new Date().toISOString()),
    editedAt: b.editedAt as string | undefined,
    threadId: b.threadId as string | undefined,
    threadSummary: b.threadSummary as ChannelMessage['threadSummary'],
    mentions: b.mentions as string[] | undefined,
    attachments: b.attachments as ChannelMessage['attachments'],
    reactions: b.reactions as ChannelMessage['reactions'],
    isPinned: Boolean(b.isPinned),
    isRead: b.isRead !== false, // Default to read if not specified
  };
}

// =============================================================================
// Feature Flag Utilities
// =============================================================================

/**
 * Check if real API is enabled
 */
export function isRealApiEnabled(): boolean {
  return USE_REAL_API;
}

/**
 * Runtime toggle for testing (use with caution)
 */
let runtimeOverride: boolean | null = null;

export function setApiMode(useReal: boolean): void {
  runtimeOverride = useReal;
  console.log(`[ChannelsAPI] Mode switched to: ${useReal ? 'REAL' : 'MOCK'}`);
}

export function getApiMode(): 'real' | 'mock' {
  return (runtimeOverride ?? USE_REAL_API) ? 'real' : 'mock';
}
