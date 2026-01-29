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
  CheckMentionMembershipResponse,
  SendMentionInviteResponse,
  GetMentionInvitesResponse,
  RespondToInviteResponse,
  MentionInvite,
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
        attachmentIds: request.attachmentIds,
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
// Mention Invite API Functions
// =============================================================================

/**
 * Check if mentioned users are members of a channel.
 * Used when a message containing @mentions is sent to determine
 * which mentioned users are not in the channel and should receive invites.
 *
 * @param workspaceId - The workspace ID
 * @param channelId - The channel to check membership in
 * @param usernames - Array of mentioned usernames to check
 * @returns Membership status for each user and list of non-members
 */
export async function checkMentionMembership(
  workspaceId: string,
  channelId: string,
  usernames: string[]
): Promise<CheckMentionMembershipResponse> {
  initializeWorkspaceId();

  try {
    // First get channel members to check against
    const members = await getChannelMembers(workspaceId, channelId);
    const memberIds = new Set(members.map(m => m.id.toLowerCase()));

    // Determine channel visibility
    const channelData = await getChannel(workspaceId, channelId);
    const visibility = channelData.channel.visibility;

    const results = usernames.map(username => ({
      username,
      isMember: memberIds.has(username.toLowerCase()),
      channelId,
      channelVisibility: visibility,
    }));

    const nonMembers = results
      .filter(r => !r.isMember && r.channelVisibility === 'public')
      .map(r => r.username);

    return { results, nonMembers };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('Failed to check mention membership', 0);
  }
}

/**
 * Send a channel invite to a user who was @mentioned but is not a member.
 * Only works for public channels. Private channels will return an error.
 *
 * This sends a notification to the mentioned user with a CTA to join the channel.
 *
 * @param workspaceId - The workspace ID
 * @param channelId - The channel to invite the user to
 * @param invitee - The username to invite
 * @param messageContent - Optional preview of the message containing the mention
 * @returns Success status and invite details
 */
export async function sendMentionInvite(
  workspaceId: string,
  channelId: string,
  invitee: string,
  messageContent?: string
): Promise<SendMentionInviteResponse> {
  initializeWorkspaceId();

  try {
    // Check channel visibility - only public channels allow mention invites
    const channelData = await getChannel(workspaceId, channelId);
    if (channelData.channel.visibility === 'private') {
      return {
        success: false,
        error: 'Cannot invite users to private channels via @mention',
        channelIsPrivate: true,
      };
    }

    // Check if user is already a member
    const members = await getChannelMembers(workspaceId, channelId);
    const isMember = members.some(m => m.id.toLowerCase() === invitee.toLowerCase());
    if (isMember) {
      return {
        success: false,
        error: `${invitee} is already a member of this channel`,
        alreadyMember: true,
      };
    }

    // Send the invite via the daemon API
    const csrfToken = getCsrfToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }

    const response = await fetch(getApiUrl(`/api/channels/${encodeURIComponent(channelId)}/mention-invite`), {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({
        invitee,
        invitedBy: getCurrentUsername(),
        messageContent,
        workspaceId,
      }),
    });

    if (!response.ok) {
      // If the server doesn't support this endpoint yet, create invite locally
      if (response.status === 404) {
        const invite: MentionInvite = {
          id: `invite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          channelId,
          channelName: channelData.channel.name,
          invitedBy: getCurrentUsername(),
          invitee,
          createdAt: new Date().toISOString(),
          status: 'pending',
          messagePreview: messageContent,
        };

        // Store invite in localStorage for persistence
        storeMentionInvite(invite);

        return { success: true, invite };
      }

      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      return {
        success: false,
        error: errorData.error || 'Failed to send mention invite',
      };
    }

    const result = await response.json() as { success: boolean; invite?: MentionInvite; error?: string };
    return {
      success: result.success,
      invite: result.invite,
      error: result.error,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return {
      success: false,
      error: 'Network error sending mention invite',
    };
  }
}

/**
 * Get pending mention invites for the current user.
 * Checks both server-side invites and locally stored ones.
 */
export async function getMentionInvites(
  workspaceId?: string
): Promise<GetMentionInvitesResponse> {
  initializeWorkspaceId();

  try {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspaceId', workspaceId);
    params.set('username', getCurrentUsername());

    const response = await fetch(
      getApiUrl(`/api/channels/mention-invites?${params.toString()}`),
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      }
    );

    if (response.ok) {
      const data = await response.json() as { invites?: MentionInvite[] };
      const serverInvites = data.invites ?? [];
      const localInvites = getStoredMentionInvites(getCurrentUsername());
      // Merge, deduplicating by ID
      const allIds = new Set(serverInvites.map(i => i.id));
      const merged = [...serverInvites, ...localInvites.filter(i => !allIds.has(i.id))];
      return { invites: merged.filter(i => i.status === 'pending') };
    }

    // If server doesn't support this endpoint, fall back to local storage
    if (response.status === 404) {
      const localInvites = getStoredMentionInvites(getCurrentUsername());
      return { invites: localInvites.filter(i => i.status === 'pending') };
    }

    return { invites: [] };
  } catch {
    // Fall back to local storage on network error
    const localInvites = getStoredMentionInvites(getCurrentUsername());
    return { invites: localInvites.filter(i => i.status === 'pending') };
  }
}

/**
 * Respond to a mention invite (accept or decline).
 * If accepted, the user joins the channel automatically.
 *
 * @param workspaceId - The workspace ID
 * @param inviteId - The invite ID to respond to
 * @param action - 'accept' or 'decline'
 */
export async function respondToMentionInvite(
  workspaceId: string,
  inviteId: string,
  action: 'accept' | 'decline'
): Promise<RespondToInviteResponse> {
  initializeWorkspaceId();

  try {
    const csrfToken = getCsrfToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }

    const response = await fetch(
      getApiUrl(`/api/channels/mention-invites/${encodeURIComponent(inviteId)}/respond`),
      {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({ action, workspaceId }),
      }
    );

    if (response.ok) {
      const result = await response.json() as RespondToInviteResponse;
      // Also update local storage
      updateStoredInviteStatus(inviteId, action === 'accept' ? 'accepted' : 'declined');
      return result;
    }

    // If server doesn't support this endpoint, handle locally
    if (response.status === 404) {
      const invite = getStoredInviteById(inviteId);
      if (!invite) {
        return { success: false, error: 'Invite not found' };
      }

      updateStoredInviteStatus(inviteId, action === 'accept' ? 'accepted' : 'declined');

      if (action === 'accept') {
        // Join the channel
        await joinChannel(workspaceId, invite.channelId);
        return { success: true, channelId: invite.channelId };
      }

      return { success: true };
    }

    const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
    return { success: false, error: errorData.error || 'Failed to respond to invite' };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return { success: false, error: 'Network error responding to invite' };
  }
}

/**
 * Process @mentions in a message and send invites to non-members.
 * This is the main entry point called when a message with mentions is sent.
 *
 * @param workspaceId - The workspace ID
 * @param channelId - The channel the message was sent in
 * @param messageContent - The full message content
 * @param mentions - Array of mentioned usernames (without @)
 * @returns Results of invite attempts for each non-member
 */
export async function processMentionInvites(
  workspaceId: string,
  channelId: string,
  messageContent: string,
  mentions: string[]
): Promise<{
  invitesSent: SendMentionInviteResponse[];
  nonMembers: string[];
  errors: string[];
}> {
  // Filter out broadcast mentions
  const validMentions = mentions.filter(m => m !== '*' && m !== 'everyone' && !m.startsWith('team:'));

  if (validMentions.length === 0) {
    return { invitesSent: [], nonMembers: [], errors: [] };
  }

  // Check membership for all mentioned users
  const membershipCheck = await checkMentionMembership(workspaceId, channelId, validMentions);

  if (membershipCheck.nonMembers.length === 0) {
    return { invitesSent: [], nonMembers: [], errors: [] };
  }

  // Send invites to all non-members
  const inviteResults: SendMentionInviteResponse[] = [];
  const errors: string[] = [];

  for (const username of membershipCheck.nonMembers) {
    try {
      const result = await sendMentionInvite(workspaceId, channelId, username, messageContent);
      inviteResults.push(result);
      if (!result.success && result.error) {
        errors.push(`${username}: ${result.error}`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      errors.push(`${username}: ${errorMsg}`);
    }
  }

  return {
    invitesSent: inviteResults,
    nonMembers: membershipCheck.nonMembers,
    errors,
  };
}

// =============================================================================
// Local Storage Helpers for Mention Invites
// =============================================================================

const MENTION_INVITES_KEY = 'relay_mention_invites';

/** Store a mention invite in localStorage */
function storeMentionInvite(invite: MentionInvite): void {
  if (typeof window === 'undefined') return;
  try {
    const stored = JSON.parse(localStorage.getItem(MENTION_INVITES_KEY) || '[]') as MentionInvite[];
    stored.push(invite);
    // Keep only last 100 invites
    const trimmed = stored.slice(-100);
    localStorage.setItem(MENTION_INVITES_KEY, JSON.stringify(trimmed));
  } catch {
    // Silently fail if localStorage is unavailable
  }
}

/** Get stored mention invites for a specific user */
function getStoredMentionInvites(username: string): MentionInvite[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = JSON.parse(localStorage.getItem(MENTION_INVITES_KEY) || '[]') as MentionInvite[];
    return stored.filter(i => i.invitee.toLowerCase() === username.toLowerCase());
  } catch {
    return [];
  }
}

/** Get a stored invite by ID */
function getStoredInviteById(inviteId: string): MentionInvite | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const stored = JSON.parse(localStorage.getItem(MENTION_INVITES_KEY) || '[]') as MentionInvite[];
    return stored.find(i => i.id === inviteId);
  } catch {
    return undefined;
  }
}

/** Update status of a stored invite */
function updateStoredInviteStatus(inviteId: string, status: MentionInvite['status']): void {
  if (typeof window === 'undefined') return;
  try {
    const stored = JSON.parse(localStorage.getItem(MENTION_INVITES_KEY) || '[]') as MentionInvite[];
    const updated = stored.map(i => i.id === inviteId ? { ...i, status } : i);
    localStorage.setItem(MENTION_INVITES_KEY, JSON.stringify(updated));
  } catch {
    // Silently fail
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
