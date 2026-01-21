/**
 * Channels API Service
 *
 * Channels are handled entirely by the daemon (not cloud).
 * Real-time messaging uses the daemon's CHANNEL_* protocol while the HTTP API now reads from daemon storage.
 *
 * Cloud channels were removed because:
 * - Daemon already has full channel protocol support (CHANNEL_JOIN, CHANNEL_MESSAGE, etc.)
 * - Having two parallel implementations caused confusion
 * - See trajectory traj_fnmapojrllau for architectural decision
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
  SearchResponse,
} from './types';
import { getCsrfToken, getApiUrl, initializeWorkspaceId } from '../../lib/api';

/**
 * Get current username from localStorage or return default
 */
function getCurrentUsername(): string {
  if (typeof window !== 'undefined') {
    return localStorage.getItem('relay_username') || 'Dashboard';
  }
  return 'Dashboard';
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
// Channel API Functions - daemon-backed with minimal placeholders
// =============================================================================

/**
 * List all channels for a workspace
 * Channels are workspace-scoped, not user-scoped
 */
export async function listChannels(workspaceId?: string): Promise<ListChannelsResponse> {
  // Ensure workspace ID is initialized for proper URL routing
  initializeWorkspaceId();
  const params = new URLSearchParams();
  // workspaceId is required for cloud mode
  if (workspaceId) {
    params.set('workspaceId', workspaceId);
  }
  const url = getApiUrl(`/api/channels?${params.toString()}`);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });

    if (!res.ok) {
      throw new ApiError('Failed to fetch channels', res.status);
    }

    const json = await res.json() as { channels?: Channel[]; archivedChannels?: Channel[] };
    return {
      channels: json.channels ?? [],
      archivedChannels: json.archivedChannels ?? [],
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('Network error fetching channels', 0);
  }
}

/**
 * Get channel details and members
 */
export async function getChannel(
  _workspaceId: string,
  channelId: string
): Promise<GetChannelResponse> {
  // Minimal channel details until daemon exposes metadata
  return {
    channel: {
      id: channelId,
      name: channelId.startsWith('#') ? channelId.slice(1) : channelId,
      visibility: 'public',
      status: 'active',
      createdAt: new Date().toISOString(),
      createdBy: getCurrentUsername(),
      memberCount: 0,
      unreadCount: 0,
      hasMentions: false,
      isDm: channelId.startsWith('dm:'),
    },
    members: [],
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
  // Ensure workspace ID is initialized for proper URL routing
  initializeWorkspaceId();
  const params = new URLSearchParams();
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.before) {
    // convert ISO to timestamp for server query
    const ts = Date.parse(options.before);
    if (!Number.isNaN(ts)) params.set('before', String(ts));
  }
  if (workspaceId) {
    params.set('workspaceId', workspaceId);
  }

  const url = `/api/channels/${encodeURIComponent(channelId)}/messages${params.toString() ? `?${params.toString()}` : ''}`;
  const res = await fetch(getApiUrl(url), {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!res.ok) {
    throw new ApiError('Failed to fetch channel messages', res.status);
  }

  const json = await res.json() as { messages: Array<ChannelMessage>; hasMore?: boolean };
  return {
    messages: json.messages ?? [],
    hasMore: Boolean(json.hasMore),
    unread: { count: 0 },
  };
}

/**
 * Create a new channel
 */
export async function createChannel(
  workspaceId: string,
  request: CreateChannelRequest
): Promise<CreateChannelResponse> {
  // Ensure workspace ID is initialized for proper URL routing
  initializeWorkspaceId();

  try {
    const csrfToken = getCsrfToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }

    const response = await fetch(getApiUrl('/api/channels'), {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({
        name: request.name,
        description: request.description,
        isPrivate: request.visibility === 'private',
        invites: request.members, // Array of strings or {id, type} objects
        workspaceId,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new ApiError(error.error || 'Failed to create channel', response.status);
    }

    const result = await response.json() as {
      success: boolean;
      channel: {
        id: string;
        name: string;
        description?: string;
        visibility: 'public' | 'private';
        status: string;
        createdAt: string;
        createdBy: string;
      };
    };

    return {
      channel: {
        id: result.channel.id,
        name: result.channel.name,
        description: result.channel.description,
        visibility: result.channel.visibility,
        status: result.channel.status as 'active' | 'archived',
        createdAt: result.channel.createdAt,
        createdBy: result.channel.createdBy,
        memberCount: 1,
        unreadCount: 0,
        hasMentions: false,
        isDm: false,
      },
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('Network error creating channel', 0);
  }
}

/**
 * Send a message to a channel via daemon API
 */
export async function sendMessage(
  workspaceId: string,
  channelId: string,
  request: SendMessageRequest
): Promise<SendMessageResponse> {
  // Ensure workspace ID is initialized for proper URL routing
  initializeWorkspaceId();
  const username = getCurrentUsername();

  try {
    const response = await fetch(getApiUrl('/api/channels/message'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        channel: channelId,
        body: request.content,
        thread: request.threadId,
        workspaceId,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new ApiError(error.error || 'Failed to send message', response.status);
    }

    // Return optimistic message for immediate UI update
    // Real message will come via WebSocket
    return {
      message: {
        id: `pending-${Date.now()}`,
        channelId,
        from: username,
        fromEntityType: 'user',
        content: request.content,
        timestamp: new Date().toISOString(),
        threadId: request.threadId,
        isRead: true,
      },
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('Network error sending message', 0);
  }
}

/**
 * Join a channel via daemon API
 */
export async function joinChannel(
  workspaceId: string,
  channelId: string
): Promise<Channel> {
  // Ensure workspace ID is initialized for proper URL routing
  initializeWorkspaceId();
  const username = getCurrentUsername();

  try {
    const response = await fetch(getApiUrl('/api/channels/join'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, channel: channelId, workspaceId }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new ApiError(error.error || 'Failed to join channel', response.status);
    }

    return {
      id: channelId,
      name: channelId.startsWith('#') ? channelId.slice(1) : channelId,
      visibility: 'public',
      status: 'active',
      createdAt: new Date().toISOString(),
      createdBy: username,
      memberCount: 1,
      unreadCount: 0,
      hasMentions: false,
      isDm: channelId.startsWith('dm:'),
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('Network error joining channel', 0);
  }
}

/**
 * Leave a channel via daemon API
 */
export async function leaveChannel(
  workspaceId: string,
  channelId: string
): Promise<void> {
  // Ensure workspace ID is initialized for proper URL routing
  initializeWorkspaceId();
  const username = getCurrentUsername();

  try {
    const response = await fetch(getApiUrl('/api/channels/leave'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, channel: channelId, workspaceId }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new ApiError(error.error || 'Failed to leave channel', response.status);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('Network error leaving channel', 0);
  }
}

/**
 * Archive a channel
 */
export async function archiveChannel(
  workspaceId: string,
  channelId: string
): Promise<Channel> {
  // Ensure workspace ID is initialized for proper URL routing
  initializeWorkspaceId();
  const res = await fetch(getApiUrl('/api/channels/archive'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: channelId, workspaceId }),
  });
  if (!res.ok) {
    throw new ApiError('Failed to archive channel', res.status);
  }
  return {
    id: channelId,
    name: channelId.startsWith('#') ? channelId.slice(1) : channelId,
    visibility: 'public',
    status: 'archived',
    createdAt: new Date().toISOString(),
    createdBy: getCurrentUsername(),
    memberCount: 0,
    unreadCount: 0,
    hasMentions: false,
    isDm: channelId.startsWith('dm:'),
  };
}

/**
 * Unarchive a channel
 */
export async function unarchiveChannel(
  workspaceId: string,
  channelId: string
): Promise<Channel> {
  // Ensure workspace ID is initialized for proper URL routing
  initializeWorkspaceId();
  const res = await fetch(getApiUrl('/api/channels/unarchive'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: channelId, workspaceId }),
  });
  if (!res.ok) {
    throw new ApiError('Failed to unarchive channel', res.status);
  }
  return {
    id: channelId,
    name: channelId.startsWith('#') ? channelId.slice(1) : channelId,
    visibility: 'public',
    status: 'active',
    createdAt: new Date().toISOString(),
    createdBy: getCurrentUsername(),
    memberCount: 0,
    unreadCount: 0,
    hasMentions: false,
    isDm: channelId.startsWith('dm:'),
  };
}

/**
 * Delete a channel (permanent)
 */
export async function deleteChannel(
  _workspaceId: string,
  _channelId: string
): Promise<void> {
  // Daemon deletes automatically when empty; nothing to do client-side
  return;
}

/**
 * Mark messages as read
 */
export async function markRead(
  _workspaceId: string,
  _channelId: string,
  _upToMessageId?: string
): Promise<void> {
  // TODO: add mark-read to daemon; no-op for now
  return;
}

/**
 * Pin a message (no-op in daemon mode)
 */
export async function pinMessage(
  _workspaceId: string,
  _channelId: string,
  _messageId: string
): Promise<void> {
  // Pinning not supported in daemon mode
  return;
}

/**
 * Unpin a message (no-op in daemon mode)
 */
export async function unpinMessage(
  _workspaceId: string,
  _channelId: string,
  _messageId: string
): Promise<void> {
  // Unpinning not supported in daemon mode
  return;
}

/**
 * Get mention suggestions (online agents/users)
 */
export async function getMentionSuggestions(
  _workspaceId?: string
): Promise<string[]> {
  return ['lead', 'frontend', 'reviewer', 'ops', 'qa'];
}

/**
 * Available member for channel invites
 */
export interface AvailableMember {
  id: string;
  displayName: string;
  type: 'user' | 'agent';
  avatarUrl?: string;
  status?: string;
}

/**
 * Get available members for channel invites
 * Returns workspace members (humans) and agents from linked daemons
 */
export async function getAvailableMembers(
  workspaceId?: string
): Promise<{ members: AvailableMember[]; agents: AvailableMember[] }> {
  // Ensure workspace ID is initialized for proper URL routing
  initializeWorkspaceId();
  const params = new URLSearchParams();
  if (workspaceId) {
    params.set('workspaceId', workspaceId);
  }

  try {
    const url = getApiUrl(`/api/channels/available-members?${params.toString()}`);
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });

    if (!res.ok) {
      console.error('[ChannelsAPI] Failed to fetch available members:', res.status);
      return { members: [], agents: [] };
    }

    const json = await res.json() as { members?: AvailableMember[]; agents?: AvailableMember[] };
    return {
      members: json.members ?? [],
      agents: json.agents ?? [],
    };
  } catch (error) {
    console.error('[ChannelsAPI] Error fetching available members:', error);
    return { members: [], agents: [] };
  }
}

// =============================================================================
// Search API Functions
// =============================================================================

/**
 * Search messages (returns empty in daemon mode - search via relay)
 */
export async function searchMessages(
  _workspaceId: string,
  query: string,
  _options?: { channelId?: string; limit?: number; offset?: number }
): Promise<SearchResponse> {
  // Search not implemented in daemon mode
  return {
    results: [],
    total: 0,
    hasMore: false,
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
  return searchMessages(workspaceId, query, { ...options, channelId });
}

// =============================================================================
// Admin API Functions
// =============================================================================

/**
 * Update channel settings
 */
export async function updateChannel(
  _workspaceId: string,
  channelId: string,
  updates: { name?: string; description?: string; isPrivate?: boolean }
): Promise<Channel> {
  const channel: Channel = {
    id: channelId,
    name: channelId.startsWith('#') ? channelId.slice(1) : channelId,
    description: updates.description,
    visibility: updates.isPrivate ? 'private' : 'public',
    status: 'active',
    createdAt: new Date().toISOString(),
    createdBy: getCurrentUsername(),
    memberCount: 0,
    unreadCount: 0,
    hasMentions: false,
    isDm: channelId.startsWith('dm:'),
  };
  return {
    ...channel,
    name: updates.name ?? channel.name,
  };
}

/**
 * Add a member to a channel
 */
export async function addMember(
  _workspaceId: string,
  _channelId: string,
  request: { memberId: string; memberType: 'user' | 'agent'; role?: 'admin' | 'member' | 'read_only' }
): Promise<ChannelMember> {
  return {
    id: request.memberId,
    displayName: request.memberId,
    entityType: request.memberType,
    role: request.role === 'admin' ? 'admin' : 'member',
    status: 'offline',
    joinedAt: new Date().toISOString(),
  };
}

/**
 * Remove a member from a channel
 */
export async function removeMember(
  _workspaceId: string,
  channelId: string,
  memberId: string,
  _memberType: 'user' | 'agent'
): Promise<void> {
  const url = getApiUrl('/api/channels/admin-remove');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: channelId.startsWith('#') ? channelId : `#${channelId}`,
      member: memberId,
    }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError(error.error || 'Failed to remove member', response.status);
  }
}

/**
 * Update a member's role
 */
export async function updateMemberRole(
  _workspaceId: string,
  _channelId: string,
  memberId: string,
  request: { role: 'admin' | 'member' | 'read_only'; memberType: 'user' | 'agent' }
): Promise<ChannelMember> {
  return {
    id: memberId,
    displayName: memberId,
    entityType: request.memberType,
    role: request.role === 'admin' ? 'admin' : 'member',
    status: 'offline',
    joinedAt: new Date().toISOString(),
  };
}

/**
 * Get all members of a channel
 */
export async function getChannelMembers(
  _workspaceId: string,
  channelId: string
): Promise<ChannelMember[]> {
  try {
    const url = getApiUrl(`/api/channels/${encodeURIComponent(channelId)}/members`);
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      console.warn('[ChannelsAPI] Failed to get channel members:', response.statusText);
      // Fall back to just returning current user
      return [{
        id: getCurrentUsername(),
        displayName: getCurrentUsername(),
        entityType: 'user',
        role: 'owner',
        status: 'online',
        joinedAt: new Date().toISOString(),
      }];
    }
    const data = await response.json();
    return data.members || [];
  } catch (error) {
    console.error('[ChannelsAPI] Error getting channel members:', error);
    // Fall back to just returning current user
    return [{
      id: getCurrentUsername(),
      displayName: getCurrentUsername(),
      entityType: 'user',
      role: 'owner',
      status: 'online',
      joinedAt: new Date().toISOString(),
    }];
  }
}

// =============================================================================
// Feature Flag Utilities (kept for API compatibility)
// =============================================================================

/**
 * Always returns true - channels now only use daemon/relay
 */
export function isRealApiEnabled(): boolean {
  return true;
}

/**
 * No-op - API mode is fixed to daemon/local
 */
export function setApiMode(_useReal: boolean): void {
  console.log('[ChannelsAPI] Mode is fixed to daemon-based implementation');
}

export function getApiMode(): 'real' | 'mock' {
  return 'real';
}
