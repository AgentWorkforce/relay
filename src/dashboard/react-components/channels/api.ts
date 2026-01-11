/**
 * Channels API Service
 *
 * Channels are now handled entirely by the daemon (not cloud).
 * Real-time messaging uses the daemon's CHANNEL_* protocol.
 * Mock data is still used for channel listing/display (daemon doesn't persist these).
 *
 * Cloud channels were removed because:
 * - Daemon already has full channel protocol support (CHANNEL_JOIN, CHANNEL_MESSAGE, etc.)
 * - Having two parallel implementations caused confusion
 * - See trajectory traj_fnmapojrllau for architectural decision
 */

import type {
  Channel,
  ChannelMember,
  ListChannelsResponse,
  GetChannelResponse,
  GetMessagesResponse,
  CreateChannelRequest,
  CreateChannelResponse,
  SendMessageRequest,
  SendMessageResponse,
  SearchResponse,
} from './types';

// Mock data still used for channel listing/display (daemon doesn't persist channels)
import * as mockApi from './mockApi';

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
// Channel API Functions - All delegate to daemon-based mockApi
// =============================================================================

/**
 * List all channels for current user
 * workspaceId parameter is kept for API compatibility but not used
 */
export async function listChannels(_workspaceId?: string): Promise<ListChannelsResponse> {
  return mockApi.listChannels();
}

/**
 * Get channel details and members
 */
export async function getChannel(
  _workspaceId: string,
  channelId: string
): Promise<GetChannelResponse> {
  return mockApi.getChannel(channelId);
}

/**
 * Get messages in a channel
 */
export async function getMessages(
  _workspaceId: string,
  channelId: string,
  options?: { before?: string; limit?: number; threadId?: string }
): Promise<GetMessagesResponse> {
  return mockApi.getMessages(channelId, options);
}

/**
 * Create a new channel
 */
export async function createChannel(
  _workspaceId: string,
  request: CreateChannelRequest
): Promise<CreateChannelResponse> {
  return mockApi.createChannel(request);
}

/**
 * Send a message to a channel via daemon API
 */
export async function sendMessage(
  _workspaceId: string,
  channelId: string,
  request: SendMessageRequest
): Promise<SendMessageResponse> {
  const username = getCurrentUsername();

  try {
    const response = await fetch('/api/channels/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        channel: channelId,
        body: request.content,
        thread: request.threadId,
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
  _workspaceId: string,
  channelId: string
): Promise<Channel> {
  const username = getCurrentUsername();

  try {
    const response = await fetch('/api/channels/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, channel: channelId }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new ApiError(error.error || 'Failed to join channel', response.status);
    }

    // Also update mock state for consistency
    return mockApi.joinChannel(channelId);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('Network error joining channel', 0);
  }
}

/**
 * Leave a channel via daemon API
 */
export async function leaveChannel(
  _workspaceId: string,
  channelId: string
): Promise<void> {
  const username = getCurrentUsername();

  try {
    const response = await fetch('/api/channels/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, channel: channelId }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new ApiError(error.error || 'Failed to leave channel', response.status);
    }

    // Also update mock state for consistency
    return mockApi.leaveChannel(channelId);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('Network error leaving channel', 0);
  }
}

/**
 * Archive a channel
 */
export async function archiveChannel(
  _workspaceId: string,
  channelId: string
): Promise<Channel> {
  return mockApi.archiveChannel(channelId);
}

/**
 * Unarchive a channel
 */
export async function unarchiveChannel(
  _workspaceId: string,
  channelId: string
): Promise<Channel> {
  return mockApi.unarchiveChannel(channelId);
}

/**
 * Delete a channel (permanent)
 */
export async function deleteChannel(
  _workspaceId: string,
  channelId: string
): Promise<void> {
  return mockApi.deleteChannel(channelId);
}

/**
 * Mark messages as read
 */
export async function markRead(
  _workspaceId: string,
  channelId: string,
  upToMessageId?: string
): Promise<void> {
  // Mock uses timestamp, pass current time if no message ID
  return mockApi.markRead(channelId, upToMessageId || new Date().toISOString());
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
  return mockApi.getMentionSuggestions();
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
  _channelId: string,
  _memberId: string,
  _memberType: 'user' | 'agent'
): Promise<void> {
  // No-op in daemon mode
  return;
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
  const response = await mockApi.getChannel(channelId);
  return response.members || [];
}

// =============================================================================
// Feature Flag Utilities (kept for API compatibility)
// =============================================================================

/**
 * Always returns true - channels now only use daemon/relay
 */
export function isRealApiEnabled(): boolean {
  return false; // "Real" cloud API is disabled, using daemon instead
}

/**
 * No-op - API mode is fixed to daemon/local
 */
export function setApiMode(_useReal: boolean): void {
  console.log('[ChannelsAPI] Mode is fixed to daemon-based implementation');
}

export function getApiMode(): 'real' | 'mock' {
  return 'mock'; // Always daemon-based (local) implementation
}
