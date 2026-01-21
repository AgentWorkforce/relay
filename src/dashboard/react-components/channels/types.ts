/**
 * Channels V1 Type Definitions
 *
 * Comprehensive types for the channel-based messaging UI.
 * Defines data models, API contracts, and component props.
 */

import type { ThreadMetadata } from '../../types/threading';

/**
 * Channel visibility types.
 */
export type ChannelVisibility = 'public' | 'private';

/**
 * Channel status.
 */
export type ChannelStatus = 'active' | 'archived';

/**
 * Channel member role.
 */
export type ChannelMemberRole = 'owner' | 'admin' | 'member';

/**
 * Entity types in the system.
 */
export type EntityType = 'agent' | 'user';

/**
 * Channel member information.
 */
export interface ChannelMember {
  /** Unique identifier (username or agent name) */
  id: string;
  /** Display name */
  displayName?: string;
  /** Avatar URL */
  avatarUrl?: string;
  /** Whether this is a human user or AI agent */
  entityType: EntityType;
  /** Member's role in the channel */
  role: ChannelMemberRole;
  /** Online status */
  status: 'online' | 'away' | 'offline';
  /** When the member joined this channel */
  joinedAt: string;
}

/**
 * Channel data model.
 */
export interface Channel {
  /** Unique channel identifier (e.g., '#general', 'dm:alice:bob') */
  id: string;
  /** Display name (without # prefix for public channels) */
  name: string;
  /** Optional channel description */
  description?: string;
  /** Current topic */
  topic?: string;
  /** Channel visibility */
  visibility: ChannelVisibility;
  /** Channel status */
  status: ChannelStatus;
  /** When the channel was created */
  createdAt: string;
  /** Who created the channel */
  createdBy: string;
  /** When the channel was last active */
  lastActivityAt?: string;
  /** Number of members */
  memberCount: number;
  /** Preview of recent members (for display) */
  memberPreview?: ChannelMember[];
  /** Unread message count for current user */
  unreadCount: number;
  /** Whether channel has unread mentions for current user */
  hasMentions: boolean;
  /** Last message preview */
  lastMessage?: {
    content: string;
    from: string;
    timestamp: string;
  };
  /** Whether this is a DM channel */
  isDm: boolean;
  /** For DMs: the other participant(s) */
  dmParticipants?: string[];
}

/**
 * Message attachment.
 */
export interface MessageAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  url: string;
  /** Optional thumbnail for images */
  thumbnailUrl?: string;
  /** Dimensions for images/videos */
  width?: number;
  height?: number;
}

/**
 * Thread summary for message display.
 */
export type ThreadSummary = ThreadMetadata;

/**
 * Message in a channel.
 */
export interface ChannelMessage {
  /** Unique message ID */
  id: string;
  /** Channel this message belongs to */
  channelId: string;
  /** Sender name */
  from: string;
  /** Sender entity type */
  fromEntityType: EntityType;
  /** Sender avatar URL */
  fromAvatarUrl?: string;
  /** Message content */
  content: string;
  /** When the message was sent */
  timestamp: string;
  /** When the message was last edited (if edited) */
  editedAt?: string;
  /** Thread ID if this is a reply */
  threadId?: string;
  /** Thread summary if this message has replies */
  threadSummary?: ThreadSummary;
  /** Mentioned users/agents */
  mentions?: string[];
  /** Attachments */
  attachments?: MessageAttachment[];
  /** Reactions */
  reactions?: Record<string, string[]>; // emoji -> list of usernames
  /** Whether this message is pinned */
  isPinned?: boolean;
  /** Whether this message was read by current user */
  isRead: boolean;
}

/**
 * Unread state for the message list.
 */
export interface UnreadState {
  /** Number of unread messages */
  count: number;
  /** ID of the first unread message (for separator) */
  firstUnreadMessageId?: string;
  /** Timestamp of last read message */
  lastReadTimestamp?: string;
}

// =============================================================================
// API Contracts - These define what the backend needs to implement
// =============================================================================

/**
 * API: List channels for current user.
 * GET /api/channels
 */
export interface ListChannelsResponse {
  channels: Channel[];
  /** Archived channels (shown in collapsed section) */
  archivedChannels: Channel[];
}

/**
 * API: Get channel details.
 * GET /api/channels/:channelId
 */
export interface GetChannelResponse {
  channel: Channel;
  members: ChannelMember[];
}

/**
 * API: Get messages in a channel.
 * GET /api/channels/:channelId/messages
 */
export interface GetMessagesRequest {
  /** Cursor for pagination (message ID) */
  before?: string;
  /** Number of messages to fetch */
  limit?: number;
  /** Thread ID to fetch thread replies */
  threadId?: string;
}

export interface GetMessagesResponse {
  messages: ChannelMessage[];
  /** Whether there are more messages to load */
  hasMore: boolean;
  /** Unread state for this channel */
  unread: UnreadState;
}

/**
 * API: Create a channel.
 * POST /api/channels
 */
export interface CreateChannelRequest {
  name: string;
  description?: string;
  visibility: ChannelVisibility;
  /** Initial members to invite (with optional type) */
  members?: Array<string | { id: string; type: 'user' | 'agent' }>;
}

export interface CreateChannelResponse {
  channel: Channel;
}

/**
 * API: Update channel.
 * PATCH /api/channels/:channelId
 */
export interface UpdateChannelRequest {
  name?: string;
  description?: string;
  topic?: string;
  status?: ChannelStatus;
}

/**
 * API: Send a message.
 * POST /api/channels/:channelId/messages
 */
export interface SendMessageRequest {
  content: string;
  threadId?: string;
  attachmentIds?: string[];
}

export interface SendMessageResponse {
  message: ChannelMessage;
}

/**
 * API: Mark messages as read.
 * POST /api/channels/:channelId/read
 */
export interface MarkReadRequest {
  /** Mark all messages up to this timestamp as read */
  upToTimestamp: string;
}

/**
 * API: Archive/delete channel.
 * POST /api/channels/:channelId/archive
 * DELETE /api/channels/:channelId
 */
export interface ArchiveChannelRequest {
  /** Whether to archive (true) or unarchive (false) */
  archive: boolean;
}

// =============================================================================
// Component Props
// =============================================================================

/**
 * Props for ChannelHeader component.
 */
export interface ChannelHeaderProps {
  /** Current channel */
  channel: Channel;
  /** Channel members */
  members?: ChannelMember[];
  /** Whether user can edit channel */
  canEdit?: boolean;
  /** Callback to edit channel settings */
  onEditChannel?: () => void;
  /** Callback to show member list */
  onShowMembers?: () => void;
  /** Callback to show pinned messages */
  onShowPinned?: () => void;
  /** Callback to search in channel */
  onSearch?: () => void;
}

/**
 * Props for ChannelMessageList component.
 */
export interface ChannelMessageListProps {
  /** Messages to display */
  messages: ChannelMessage[];
  /** Unread state */
  unreadState?: UnreadState;
  /** Current user name */
  currentUser: string;
  /** Whether loading more messages */
  isLoadingMore?: boolean;
  /** Whether there are more messages to load */
  hasMore?: boolean;
  /** Callback to load more messages */
  onLoadMore?: () => void;
  /** Callback when clicking thread button */
  onThreadClick?: (messageId: string) => void;
  /** Callback when clicking on a member name (for DM navigation) */
  onMemberClick?: (memberId: string, entityType: 'user' | 'agent') => void;
}

/**
 * Props for MessageInput component.
 */
export interface MessageInputProps {
  /** Channel to send to */
  channelId: string;
  /** Placeholder text */
  placeholder?: string;
  /** Whether input is disabled */
  disabled?: boolean;
  /** Callback to send message */
  onSend: (content: string) => void;
  /** Callback when typing status changes */
  onTyping?: (isTyping: boolean) => void;
  /** Available users/agents for @-mentions */
  mentionSuggestions?: string[];
}

// =============================================================================
// Mock Data for Development
// =============================================================================

export const MOCK_CHANNELS: Channel[] = [
  {
    id: '#general',
    name: 'general',
    description: 'General discussion for all team members',
    visibility: 'public',
    status: 'active',
    createdAt: '2024-01-01T00:00:00Z',
    createdBy: 'system',
    lastActivityAt: new Date().toISOString(),
    memberCount: 12,
    unreadCount: 3,
    hasMentions: true,
    lastMessage: {
      content: 'Has anyone reviewed the latest PR?',
      from: 'CodeReviewer',
      timestamp: new Date(Date.now() - 300000).toISOString(),
    },
    isDm: false,
  },
  {
    id: '#engineering',
    name: 'engineering',
    description: 'Engineering team discussions',
    visibility: 'public',
    status: 'active',
    createdAt: '2024-01-15T00:00:00Z',
    createdBy: 'Lead',
    lastActivityAt: new Date(Date.now() - 3600000).toISOString(),
    memberCount: 8,
    unreadCount: 0,
    hasMentions: false,
    isDm: false,
  },
  {
    id: '#frontend',
    name: 'frontend',
    description: 'Frontend development',
    visibility: 'public',
    status: 'active',
    createdAt: '2024-02-01T00:00:00Z',
    createdBy: 'Frontend',
    memberCount: 4,
    unreadCount: 7,
    hasMentions: false,
    isDm: false,
  },
  {
    id: 'dm:Lead:Frontend',
    name: 'Lead',
    visibility: 'private',
    status: 'active',
    createdAt: '2024-01-20T00:00:00Z',
    createdBy: 'Lead',
    memberCount: 2,
    unreadCount: 1,
    hasMentions: false,
    lastMessage: {
      content: 'Great progress on the channels feature!',
      from: 'Lead',
      timestamp: new Date(Date.now() - 1800000).toISOString(),
    },
    isDm: true,
    dmParticipants: ['Lead', 'Frontend'],
  },
];

export const MOCK_ARCHIVED_CHANNELS: Channel[] = [
  {
    id: '#old-project',
    name: 'old-project',
    description: 'Archived project channel',
    visibility: 'public',
    status: 'archived',
    createdAt: '2023-06-01T00:00:00Z',
    createdBy: 'Lead',
    memberCount: 5,
    unreadCount: 0,
    hasMentions: false,
    isDm: false,
  },
];

export const MOCK_MESSAGES: ChannelMessage[] = [
  {
    id: 'msg-1',
    channelId: '#general',
    from: 'Lead',
    fromEntityType: 'agent',
    content: 'Good morning team! Let\'s sync on today\'s priorities.',
    timestamp: new Date(Date.now() - 7200000).toISOString(),
    isRead: true,
  },
  {
    id: 'msg-2',
    channelId: '#general',
    from: 'CodeReviewer',
    fromEntityType: 'agent',
    content: 'I\'ll be reviewing the authentication PRs today.',
    timestamp: new Date(Date.now() - 6000000).toISOString(),
    threadSummary: {
      threadId: 'msg-2',
      replyCount: 3,
      participants: ['Lead', 'Frontend'],
      lastReplyAt: Date.now() - 3600000,
      lastReplyPreview: 'Sounds good, let me know if you need help.',
    },
    isRead: true,
  },
  {
    id: 'msg-3',
    channelId: '#general',
    from: 'Frontend',
    fromEntityType: 'agent',
    content: 'Working on the channels sidebar UI. Making good progress!',
    timestamp: new Date(Date.now() - 3600000).toISOString(),
    isRead: true,
  },
  {
    id: 'msg-4',
    channelId: '#general',
    from: 'Lead',
    fromEntityType: 'agent',
    content: '@Frontend Great work! Can you share a screenshot when ready?',
    timestamp: new Date(Date.now() - 1800000).toISOString(),
    mentions: ['Frontend'],
    isRead: false,
  },
  {
    id: 'msg-5',
    channelId: '#general',
    from: 'CodeReviewer',
    fromEntityType: 'agent',
    content: 'Has anyone reviewed the latest PR?',
    timestamp: new Date(Date.now() - 300000).toISOString(),
    isRead: false,
  },
];

// =============================================================================
// Search Types (Task 5)
// =============================================================================

/**
 * Search result item from full-text search.
 */
export interface SearchResult {
  /** Message ID */
  id: string;
  /** Channel ID where message was found */
  channelId: string;
  /** Channel name for display */
  channelName: string;
  /** Sender name */
  from: string;
  /** Sender entity type */
  fromEntityType: EntityType;
  /** Message content (may contain highlight markers) */
  content: string;
  /** Highlighted snippet with search terms marked */
  snippet: string;
  /** Message timestamp */
  timestamp: string;
  /** Search relevance rank */
  rank: number;
}

/**
 * API: Search messages across workspace.
 * GET /api/workspaces/:workspaceId/search?q=query
 */
export interface SearchRequest {
  /** Search query string */
  query: string;
  /** Optional channel ID to limit search scope */
  channelId?: string;
  /** Pagination limit */
  limit?: number;
  /** Pagination offset */
  offset?: number;
}

export interface SearchResponse {
  /** Search results */
  results: SearchResult[];
  /** Total number of matching results */
  total: number;
  /** Whether there are more results */
  hasMore: boolean;
  /** Search query that was executed */
  query: string;
}

/**
 * Props for SearchInput component.
 */
export interface SearchInputProps {
  /** Initial query value */
  initialQuery?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Debounce delay in ms */
  debounceMs?: number;
  /** Whether search is in progress */
  isSearching?: boolean;
  /** Callback when search query changes */
  onSearch: (query: string) => void;
  /** Callback when search is cleared */
  onClear?: () => void;
  /** Optional channel scope */
  channelId?: string;
}

/**
 * Props for SearchResults component.
 */
export interface SearchResultsProps {
  /** Search results to display */
  results: SearchResult[];
  /** Total count for pagination */
  total: number;
  /** Current search query (for highlighting) */
  query: string;
  /** Whether currently loading */
  isLoading?: boolean;
  /** Whether there are more results */
  hasMore?: boolean;
  /** Error message if search failed */
  error?: string;
  /** Callback to load more results */
  onLoadMore?: () => void;
  /** Callback when a result is clicked */
  onResultClick?: (result: SearchResult) => void;
}
