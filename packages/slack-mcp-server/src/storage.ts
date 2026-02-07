/**
 * SQLite storage layer for the Headless Slack MCP Server.
 *
 * Uses better-sqlite3 for synchronous, low-latency reads/writes.
 * WAL mode enables concurrent readers with a single writer.
 *
 * Schema inspired by Slack's data model (workspaces, unified conversations,
 * per-channel read cursors) and the old Agent Relay Cloud Drizzle schema.
 *
 * Message IDs are Snowflake IDs — time-sortable and embeddable timestamps.
 * FTS5 provides full-text search over message bodies.
 */

import Database from 'better-sqlite3';
import type {
  Workspace,
  Agent,
  Channel,
  ChannelMember,
  Message,
  Reaction,
  ReactionSummary,
  GetMessagesOptions,
  SearchOptions,
  ChannelType,
} from './types.js';
import { snowflake, snowflakeToTimestamp } from './snowflake.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'online',
  persona TEXT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  metadata TEXT,
  UNIQUE(workspace_id, name)
);
CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  channel_type INTEGER NOT NULL DEFAULT 0,
  topic TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  is_archived INTEGER NOT NULL DEFAULT 0,
  UNIQUE(workspace_id, name)
);
CREATE INDEX IF NOT EXISTS idx_channels_workspace ON channels(workspace_id);
CREATE INDEX IF NOT EXISTS idx_channels_type ON channels(channel_type);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  last_read_id TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (channel_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_members_agent ON channel_members(agent_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  thread_id TEXT,
  agent_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id, id);

CREATE TABLE IF NOT EXISTS reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(message_id, agent_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE messages_fts USING fts5(
  body,
  content=messages,
  content_rowid=rowid
);

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.rowid, old.body);
END;

CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.rowid, old.body);
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;
`;

// ---------------------------------------------------------------------------
// Storage class
// ---------------------------------------------------------------------------

export class Storage {
  private db: Database.Database;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -64000'); // 64MB cache
    this.init();
  }

  private init(): void {
    this.db.exec(SCHEMA);

    // FTS5 tables do not support IF NOT EXISTS
    const ftsExists = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'",
      )
      .get();
    if (!ftsExists) {
      this.db.exec(FTS_SCHEMA);
    }
  }

  close(): void {
    this.db.close();
  }

  // =========================================================================
  // Workspaces
  // =========================================================================

  createWorkspace(name: string, metadata?: Record<string, unknown>): Workspace {
    const id = snowflake();
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO workspaces (id, name, created_at, metadata) VALUES (?, ?, ?, ?)',
      )
      .run(id, name, now, metadata ? JSON.stringify(metadata) : null);
    return { id, name, created_at: now, metadata };
  }

  getWorkspace(id: string): Workspace | undefined {
    const row = this.db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.parseWorkspace(row) : undefined;
  }

  getWorkspaceByName(name: string): Workspace | undefined {
    const row = this.db
      .prepare('SELECT * FROM workspaces WHERE name = ?')
      .get(name) as Record<string, unknown> | undefined;
    return row ? this.parseWorkspace(row) : undefined;
  }

  listWorkspaces(): Workspace[] {
    const rows = this.db
      .prepare('SELECT * FROM workspaces ORDER BY created_at')
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.parseWorkspace(r));
  }

  // =========================================================================
  // Agents
  // =========================================================================

  createAgent(
    workspaceId: string,
    name: string,
    persona?: string,
  ): Agent {
    const id = snowflake();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO agents (id, workspace_id, name, status, persona, created_at, last_seen)
         VALUES (?, ?, ?, 'online', ?, ?, ?)`,
      )
      .run(id, workspaceId, name, persona ?? null, now, now);
    return {
      id,
      workspace_id: workspaceId,
      name,
      status: 'online',
      persona,
      created_at: now,
      last_seen: now,
    };
  }

  getAgent(workspaceId: string, name: string): Agent | undefined {
    const row = this.db
      .prepare('SELECT * FROM agents WHERE workspace_id = ? AND name = ?')
      .get(workspaceId, name) as Record<string, unknown> | undefined;
    return row ? this.parseAgent(row) : undefined;
  }

  getAgentById(id: string): Agent | undefined {
    const row = this.db
      .prepare('SELECT * FROM agents WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.parseAgent(row) : undefined;
  }

  updateAgentStatus(id: string, status: string): void {
    this.db
      .prepare('UPDATE agents SET status = ?, last_seen = ? WHERE id = ?')
      .run(status, Date.now(), id);
  }

  touchAgent(id: string): void {
    this.db
      .prepare('UPDATE agents SET last_seen = ? WHERE id = ?')
      .run(Date.now(), id);
  }

  listAgents(workspaceId: string, status?: string): Agent[] {
    let sql = 'SELECT * FROM agents WHERE workspace_id = ?';
    const params: unknown[] = [workspaceId];
    if (status && status !== 'all') {
      sql += ' AND status = ?';
      params.push(status);
    }
    sql += ' ORDER BY name';
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.parseAgent(r));
  }

  // =========================================================================
  // Channels
  // =========================================================================

  createChannel(
    workspaceId: string,
    name: string,
    createdBy: string,
    channelType: ChannelType = 0,
    topic?: string,
  ): Channel {
    const id = snowflake();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO channels (id, workspace_id, name, channel_type, topic, created_by, created_at, is_archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(id, workspaceId, name, channelType, topic ?? null, createdBy, now);
    return {
      id,
      workspace_id: workspaceId,
      name,
      channel_type: channelType,
      topic,
      created_by: createdBy,
      created_at: now,
      is_archived: false,
    };
  }

  getChannel(workspaceId: string, name: string): Channel | undefined {
    const row = this.db
      .prepare('SELECT * FROM channels WHERE workspace_id = ? AND name = ?')
      .get(workspaceId, name) as Record<string, unknown> | undefined;
    return row ? this.parseChannel(row) : undefined;
  }

  getChannelById(id: string): Channel | undefined {
    const row = this.db
      .prepare('SELECT * FROM channels WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.parseChannel(row) : undefined;
  }

  listChannels(
    workspaceId: string,
    includeArchived = false,
    channelType?: ChannelType,
  ): Channel[] {
    let sql = `
      SELECT c.*, COUNT(cm.agent_id) as member_count
      FROM channels c
      LEFT JOIN channel_members cm ON c.id = cm.channel_id
      WHERE c.workspace_id = ?`;
    const params: unknown[] = [workspaceId];

    if (!includeArchived) {
      sql += ' AND c.is_archived = 0';
    }
    if (channelType !== undefined) {
      sql += ' AND c.channel_type = ?';
      params.push(channelType);
    }

    sql += ' GROUP BY c.id ORDER BY c.name';
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.parseChannel(r));
  }

  archiveChannel(id: string): void {
    this.db.prepare('UPDATE channels SET is_archived = 1 WHERE id = ?').run(id);
  }

  setChannelTopic(id: string, topic: string): void {
    this.db.prepare('UPDATE channels SET topic = ? WHERE id = ?').run(topic, id);
  }

  // =========================================================================
  // Channel Members
  // =========================================================================

  addChannelMember(
    channelId: string,
    agentId: string,
    role: string = 'member',
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO channel_members (channel_id, agent_id, role, joined_at, last_read_id)
         VALUES (?, ?, ?, ?, '0')`,
      )
      .run(channelId, agentId, role, now);
  }

  removeChannelMember(channelId: string, agentId: string): void {
    this.db
      .prepare('DELETE FROM channel_members WHERE channel_id = ? AND agent_id = ?')
      .run(channelId, agentId);
  }

  getChannelMembers(channelId: string): ChannelMember[] {
    return this.db
      .prepare('SELECT * FROM channel_members WHERE channel_id = ?')
      .all(channelId) as ChannelMember[];
  }

  isChannelMember(channelId: string, agentId: string): boolean {
    const row = this.db
      .prepare(
        'SELECT 1 FROM channel_members WHERE channel_id = ? AND agent_id = ?',
      )
      .get(channelId, agentId);
    return !!row;
  }

  updateLastRead(channelId: string, agentId: string, messageId: string): void {
    this.db
      .prepare(
        'UPDATE channel_members SET last_read_id = ? WHERE channel_id = ? AND agent_id = ?',
      )
      .run(messageId, channelId, agentId);
  }

  getAgentChannels(agentId: string): Channel[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, COUNT(cm2.agent_id) as member_count
         FROM channels c
         JOIN channel_members cm ON c.id = cm.channel_id
         LEFT JOIN channel_members cm2 ON c.id = cm2.channel_id
         WHERE cm.agent_id = ?
         GROUP BY c.id
         ORDER BY c.name`,
      )
      .all(agentId) as Record<string, unknown>[];
    return rows.map((r) => this.parseChannel(r));
  }

  // =========================================================================
  // Messages
  // =========================================================================

  createMessage(
    workspaceId: string,
    channelId: string,
    agentId: string,
    body: string,
    threadId?: string,
  ): Message {
    const id = snowflake();
    const now = snowflakeToTimestamp(id);
    this.db
      .prepare(
        `INSERT INTO messages (id, workspace_id, channel_id, thread_id, agent_id, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, workspaceId, channelId, threadId ?? null, agentId, body, now);
    return {
      id,
      workspace_id: workspaceId,
      channel_id: channelId,
      thread_id: threadId ?? null,
      agent_id: agentId,
      body,
      created_at: now,
      updated_at: null,
    };
  }

  getMessage(id: string): (Message & { agent_name?: string }) | undefined {
    const row = this.db
      .prepare(
        `SELECT m.*, a.name as agent_name
         FROM messages m
         JOIN agents a ON m.agent_id = a.id
         WHERE m.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? (row as unknown as Message & { agent_name?: string }) : undefined;
  }

  /**
   * Get messages for a channel (top-level only, not thread replies).
   * Uses Snowflake ID cursor-based pagination (like Discord's before/after).
   */
  getMessages(channelId: string, options: GetMessagesOptions = {}): Message[] {
    const { limit = 50, before, after } = options;
    let sql = `
      SELECT m.*, a.name as agent_name
      FROM messages m
      JOIN agents a ON m.agent_id = a.id
      WHERE m.channel_id = ? AND m.thread_id IS NULL`;
    const params: unknown[] = [channelId];

    if (before) {
      sql += ' AND m.id < ?';
      params.push(before);
    }
    if (after) {
      sql += ' AND m.id > ?';
      params.push(after);
    }

    sql += ' ORDER BY m.id DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Message[];
    // Return in chronological order
    return rows.reverse();
  }

  /**
   * Get all messages in a thread (parent + replies, chronological).
   */
  getThread(threadId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, a.name as agent_name
         FROM messages m
         JOIN agents a ON m.agent_id = a.id
         WHERE m.id = ? OR m.thread_id = ?
         ORDER BY m.id ASC`,
      )
      .all(threadId, threadId) as Message[];
    return rows;
  }

  // =========================================================================
  // Batch enrichment (avoids N+1 queries)
  // =========================================================================

  getReplyCountsBatch(messageIds: string[]): Map<string, number> {
    const result = new Map<string, number>();
    if (messageIds.length === 0) return result;

    const placeholders = messageIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT thread_id, COUNT(*) as cnt
         FROM messages
         WHERE thread_id IN (${placeholders})
         GROUP BY thread_id`,
      )
      .all(...messageIds) as { thread_id: string; cnt: number }[];

    for (const row of rows) {
      result.set(row.thread_id, row.cnt);
    }
    return result;
  }

  getReactionsBatch(messageIds: string[]): Map<string, ReactionSummary[]> {
    const result = new Map<string, ReactionSummary[]>();
    if (messageIds.length === 0) return result;

    const placeholders = messageIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT r.message_id, r.emoji, a.name as agent_name
         FROM reactions r
         JOIN agents a ON r.agent_id = a.id
         WHERE r.message_id IN (${placeholders})
         ORDER BY r.message_id, r.emoji, r.created_at`,
      )
      .all(...messageIds) as {
      message_id: string;
      emoji: string;
      agent_name: string;
    }[];

    for (const row of rows) {
      let reactions = result.get(row.message_id);
      if (!reactions) {
        reactions = [];
        result.set(row.message_id, reactions);
      }
      let existing = reactions.find((r) => r.emoji === row.emoji);
      if (!existing) {
        existing = { emoji: row.emoji, count: 0, agents: [] };
        reactions.push(existing);
      }
      existing.count++;
      existing.agents.push(row.agent_name);
    }
    return result;
  }

  /**
   * Enrich a batch of messages with reply counts and reactions.
   * Two queries total regardless of message count.
   */
  enrichMessages(messages: Message[]): Message[] {
    const ids = messages.map((m) => m.id);
    const replyCounts = this.getReplyCountsBatch(ids);
    const reactions = this.getReactionsBatch(ids);

    return messages.map((m) => ({
      ...m,
      reply_count: m.thread_id === null ? (replyCounts.get(m.id) ?? 0) : undefined,
      reactions: reactions.get(m.id) ?? [],
    }));
  }

  // =========================================================================
  // Reactions
  // =========================================================================

  addReaction(
    messageId: string,
    agentId: string,
    emoji: string,
  ): Reaction {
    const id = snowflake();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO reactions (id, message_id, agent_id, emoji, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, messageId, agentId, emoji, now);
    return { id, message_id: messageId, agent_id: agentId, emoji, created_at: now };
  }

  removeReaction(
    messageId: string,
    agentId: string,
    emoji: string,
  ): boolean {
    const result = this.db
      .prepare(
        'DELETE FROM reactions WHERE message_id = ? AND agent_id = ? AND emoji = ?',
      )
      .run(messageId, agentId, emoji);
    return result.changes > 0;
  }

  getReactions(messageId: string): ReactionSummary[] {
    const batch = this.getReactionsBatch([messageId]);
    return batch.get(messageId) ?? [];
  }

  // =========================================================================
  // Search (FTS5)
  // =========================================================================

  searchMessages(workspaceId: string, options: SearchOptions): Message[] {
    const { query, channel_id, agent_id, limit = 20 } = options;

    let sql = `
      SELECT m.*, a.name as agent_name
      FROM messages m
      JOIN agents a ON m.agent_id = a.id
      JOIN messages_fts fts ON m.rowid = fts.rowid
      WHERE fts.body MATCH ? AND m.workspace_id = ?`;
    const params: unknown[] = [query, workspaceId];

    if (channel_id) {
      sql += ' AND m.channel_id = ?';
      params.push(channel_id);
    }
    if (agent_id) {
      sql += ' AND m.agent_id = ?';
      params.push(agent_id);
    }

    sql += ' ORDER BY fts.rank LIMIT ?';
    params.push(limit);

    return this.db.prepare(sql).all(...params) as Message[];
  }

  // =========================================================================
  // Inbox / Unread tracking
  // =========================================================================

  /**
   * Get unread counts per channel for an agent.
   * Compares channel_members.last_read_id against message IDs.
   */
  getUnreadCounts(
    agentId: string,
  ): { channel_id: string; channel_name: string; channel_type: number; unread_count: number }[] {
    return this.db
      .prepare(
        `SELECT c.id as channel_id, c.name as channel_name, c.channel_type,
                COUNT(m.id) as unread_count
         FROM channel_members cm
         JOIN channels c ON cm.channel_id = c.id
         LEFT JOIN messages m
           ON m.channel_id = c.id
           AND m.id > cm.last_read_id
           AND m.agent_id != ?
           AND m.thread_id IS NULL
         WHERE cm.agent_id = ? AND c.is_archived = 0
         GROUP BY c.id
         HAVING unread_count > 0
         ORDER BY MAX(m.id) DESC`,
      )
      .all(agentId, agentId) as {
      channel_id: string;
      channel_name: string;
      channel_type: number;
      unread_count: number;
    }[];
  }

  /**
   * Get messages mentioning @agentName that the agent hasn't read yet.
   */
  getMentions(agentId: string, agentName: string): Message[] {
    return this.db
      .prepare(
        `SELECT m.*, a.name as agent_name
         FROM messages m
         JOIN agents a ON m.agent_id = a.id
         JOIN channel_members cm
           ON m.channel_id = cm.channel_id
           AND cm.agent_id = ?
         WHERE m.body LIKE ?
           AND m.id > cm.last_read_id
           AND m.agent_id != ?
         ORDER BY m.id DESC
         LIMIT 50`,
      )
      .all(agentId, `%@${agentName}%`, agentId) as Message[];
  }

  // =========================================================================
  // Parsing helpers
  // =========================================================================

  private parseWorkspace(row: Record<string, unknown>): Workspace {
    return {
      id: row.id as string,
      name: row.name as string,
      created_at: row.created_at as number,
      metadata: row.metadata
        ? (JSON.parse(row.metadata as string) as Record<string, unknown>)
        : undefined,
    };
  }

  private parseAgent(row: Record<string, unknown>): Agent {
    return {
      id: row.id as string,
      workspace_id: row.workspace_id as string,
      name: row.name as string,
      status: row.status as Agent['status'],
      persona: (row.persona as string) ?? undefined,
      created_at: row.created_at as number,
      last_seen: row.last_seen as number,
      metadata: row.metadata
        ? (JSON.parse(row.metadata as string) as Record<string, unknown>)
        : undefined,
    };
  }

  private parseChannel(row: Record<string, unknown>): Channel {
    return {
      id: row.id as string,
      workspace_id: row.workspace_id as string,
      name: row.name as string,
      channel_type: row.channel_type as ChannelType,
      topic: (row.topic as string) ?? undefined,
      created_by: row.created_by as string,
      created_at: row.created_at as number,
      is_archived: !!(row.is_archived as number),
      member_count: row.member_count as number | undefined,
    };
  }
}
