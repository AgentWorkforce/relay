/**
 * Core types for the Headless Slack MCP Server.
 *
 * Data model inspired by Slack's unified conversation abstraction
 * and Discord's Snowflake IDs for time-sortable identifiers.
 */

// ---------------------------------------------------------------------------
// Channel types (inspired by Discord's numeric channel types)
// ---------------------------------------------------------------------------

export const ChannelType = {
  /** Standard text channel in a workspace */
  TEXT: 0,
  /** Direct message between two agents */
  DM: 1,
  /** Group direct message between multiple agents */
  GROUP_DM: 3,
} as const;

export type ChannelType = (typeof ChannelType)[keyof typeof ChannelType];

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------

export interface Workspace {
  id: string;
  name: string;
  created_at: number;
  metadata?: Record<string, unknown>;
}

export interface Agent {
  id: string;
  workspace_id: string;
  name: string;
  status: 'online' | 'offline' | 'away';
  persona?: string;
  created_at: number;
  last_seen: number;
  metadata?: Record<string, unknown>;
}

export interface Channel {
  id: string;
  workspace_id: string;
  name: string;
  channel_type: ChannelType;
  topic?: string;
  created_by: string;
  created_at: number;
  is_archived: boolean;
  /** Computed: number of members in this channel */
  member_count?: number;
}

export interface ChannelMember {
  channel_id: string;
  agent_id: string;
  role: 'owner' | 'admin' | 'member';
  joined_at: number;
  /** Snowflake ID of the last message the agent has read */
  last_read_id: string;
}

/**
 * Message in a channel or DM.
 *
 * Threading follows Slack's model: top-level messages have thread_id = null.
 * Replies set thread_id to the parent message's ID.
 */
export interface Message {
  id: string;
  workspace_id: string;
  channel_id: string;
  /** null for top-level messages; parent message ID for thread replies */
  thread_id: string | null;
  agent_id: string;
  body: string;
  created_at: number;
  updated_at: number | null;
  /** Computed: number of replies (for top-level messages) */
  reply_count?: number;
  /** Computed: reaction summaries */
  reactions?: ReactionSummary[];
  /** Computed: agent name (joined from agents table) */
  agent_name?: string;
}

export interface Reaction {
  id: string;
  message_id: string;
  agent_id: string;
  emoji: string;
  created_at: number;
}

/** Aggregated reaction info for display */
export interface ReactionSummary {
  emoji: string;
  count: number;
  agents: string[];
}

// ---------------------------------------------------------------------------
// Query / result types
// ---------------------------------------------------------------------------

export interface UnreadInfo {
  channel_id: string;
  channel_name: string;
  channel_type: ChannelType;
  unread_count: number;
  mention_count: number;
}

export interface InboxResult {
  unread_channels: UnreadInfo[];
  mentions: Message[];
  unread_dms: UnreadInfo[];
}

export interface GetMessagesOptions {
  limit?: number;
  /** Snowflake ID — return messages before this ID */
  before?: string;
  /** Snowflake ID — return messages after this ID */
  after?: string;
}

export interface SearchOptions {
  query: string;
  channel_id?: string;
  agent_id?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Session state (per MCP connection)
// ---------------------------------------------------------------------------

export interface SessionState {
  agentId: string | null;
  agentName: string | null;
  workspaceId: string | null;
}
