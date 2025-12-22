import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  type AgentSummary,
  type MessageQuery,
  type MessageStatus,
  type SessionQuery,
  type StorageAdapter,
  type StoredMessage,
  type StoredSession,
} from './adapter.js';

export interface SqliteAdapterOptions {
  dbPath: string;
}

// Re-export types for backwards compatibility
export type { StoredSession, SessionQuery } from './adapter.js';

type SqliteDriverName = 'better-sqlite3' | 'node';

interface SqliteStatement {
  run: (...params: any[]) => unknown;
  all: (...params: any[]) => any[];
  get: (...params: any[]) => any;
}

interface SqliteDatabase {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
  pragma?: (value: string) => void;
}

export class SqliteStorageAdapter implements StorageAdapter {
  private dbPath: string;
  private db?: SqliteDatabase;
  private insertStmt?: SqliteStatement;
  private insertSessionStmt?: SqliteStatement;
  private driver?: SqliteDriverName;

  constructor(options: SqliteAdapterOptions) {
    this.dbPath = options.dbPath;
  }

  private resolvePreferredDriver(): SqliteDriverName | undefined {
    const raw = process.env.AGENT_RELAY_SQLITE_DRIVER?.trim().toLowerCase();
    if (!raw) return undefined;
    if (raw === 'node' || raw === 'node:sqlite' || raw === 'nodesqlite') return 'node';
    if (raw === 'better-sqlite3' || raw === 'better' || raw === 'bss') return 'better-sqlite3';
    return undefined;
  }

  private async openDatabase(driver: SqliteDriverName): Promise<SqliteDatabase> {
    if (driver === 'node') {
      // Use require() to avoid toolchains that don't recognize node:sqlite yet (Vitest/Vite).
      const require = createRequire(import.meta.url);
      const mod: any = require('node:sqlite');
      const db: any = new mod.DatabaseSync(this.dbPath);
      db.exec('PRAGMA journal_mode = WAL;');
      return db as SqliteDatabase;
    }

    const mod = await import('better-sqlite3');
    const DatabaseCtor: any = (mod as any).default ?? mod;
    const db: any = new DatabaseCtor(this.dbPath);
    if (typeof db.pragma === 'function') {
      db.pragma('journal_mode = WAL');
    } else {
      db.exec('PRAGMA journal_mode = WAL;');
    }
    return db as SqliteDatabase;
  }

  async init(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const preferred = this.resolvePreferredDriver();
    const attempts: SqliteDriverName[] = preferred
      ? [preferred, preferred === 'better-sqlite3' ? 'node' : 'better-sqlite3']
      : ['better-sqlite3', 'node'];

    let lastError: unknown = null;
    for (const driver of attempts) {
      try {
        this.db = await this.openDatabase(driver);
        this.driver = driver;
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
      }
    }

    if (!this.db) {
      throw new Error(
        `Failed to initialize SQLite storage at ${this.dbPath}: ${lastError instanceof Error ? lastError.message : String(lastError)}`
      );
    }

    // Check if messages table exists for migration decisions
    const messagesTableExists = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='messages'"
    ).get() as { name: string } | undefined;

    if (!messagesTableExists) {
      // Fresh install: create messages table with all columns
      this.db.exec(`
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          sender TEXT NOT NULL,
          recipient TEXT NOT NULL,
          topic TEXT,
          kind TEXT NOT NULL,
          body TEXT NOT NULL,
          data TEXT,
          thread TEXT,
          delivery_seq INTEGER,
          delivery_session_id TEXT,
          session_id TEXT,
          status TEXT NOT NULL DEFAULT 'unread',
          is_urgent INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_messages_ts ON messages (ts);
        CREATE INDEX idx_messages_sender ON messages (sender);
        CREATE INDEX idx_messages_recipient ON messages (recipient);
        CREATE INDEX idx_messages_topic ON messages (topic);
        CREATE INDEX idx_messages_thread ON messages (thread);
        CREATE INDEX idx_messages_status ON messages (status);
        CREATE INDEX idx_messages_is_urgent ON messages (is_urgent);
      `);
    } else {
      // Existing database: run migrations for missing columns
      const columns = this.db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
      const columnNames = new Set(columns.map(c => c.name));

      if (!columnNames.has('thread')) {
        this.db.exec('ALTER TABLE messages ADD COLUMN thread TEXT');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread)');
      }
      if (!columnNames.has('status')) {
        this.db.exec("ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'unread'");
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_status ON messages (status)');
      }
      if (!columnNames.has('is_urgent')) {
        this.db.exec("ALTER TABLE messages ADD COLUMN is_urgent INTEGER NOT NULL DEFAULT 0");
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_is_urgent ON messages (is_urgent)');
      }
    }

    // Create sessions table (IF NOT EXISTS is safe here - no new columns to migrate)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        cli TEXT,
        project_id TEXT,
        project_root TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        message_count INTEGER DEFAULT 0,
        summary TEXT,
        closed_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions (agent_name);
      CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions (started_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions (project_id);
    `);

    // Create agent_summaries table (IF NOT EXISTS is safe here - no new columns to migrate)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_summaries (
        agent_name TEXT PRIMARY KEY,
        project_id TEXT,
        last_updated INTEGER NOT NULL,
        current_task TEXT,
        completed_tasks TEXT,
        decisions TEXT,
        context TEXT,
        files TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_summaries_updated ON agent_summaries (last_updated);
    `);

    this.insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages
      (id, ts, sender, recipient, topic, kind, body, data, thread, delivery_seq, delivery_session_id, session_id, status, is_urgent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  async saveMessage(message: StoredMessage): Promise<void> {
    if (!this.db || !this.insertStmt) {
      throw new Error('SqliteStorageAdapter not initialized');
    }

    this.insertStmt.run(
      message.id,
      message.ts,
      message.from,
      message.to,
      message.topic ?? null,
      message.kind,
      message.body,
      message.data ? JSON.stringify(message.data) : null,
      message.thread ?? null,
      message.deliverySeq ?? null,
      message.deliverySessionId ?? null,
      message.sessionId ?? null,
      message.status,
      message.is_urgent ? 1 : 0
    );
  }

  async getMessages(query: MessageQuery = {}): Promise<StoredMessage[]> {
    if (!this.db) {
      throw new Error('SqliteStorageAdapter not initialized');
    }

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (query.sinceTs) {
      clauses.push('ts >= ?');
      params.push(query.sinceTs);
    }
    if (query.from) {
      clauses.push('sender = ?');
      params.push(query.from);
    }
    if (query.to) {
      clauses.push('recipient = ?');
      params.push(query.to);
    }
    if (query.topic) {
      clauses.push('topic = ?');
      params.push(query.topic);
    }
    if (query.thread) {
      clauses.push('thread = ?');
      params.push(query.thread);
    }
    if (query.unreadOnly) {
      clauses.push('status = ?');
      params.push('unread');
    }
    if (query.urgentOnly) {
      clauses.push('is_urgent = ?');
      params.push(1);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const order = query.order === 'asc' ? 'ASC' : 'DESC';
    const limit = query.limit ?? 200;

    const stmt = this.db.prepare(`
      SELECT id, ts, sender, recipient, topic, kind, body, data, thread, delivery_seq, delivery_session_id, session_id, status, is_urgent
      FROM messages
      ${where}
      ORDER BY ts ${order}
      LIMIT ?
    `);

    const rows = stmt.all(...params, limit);
    return rows.map((row: any) => ({
      id: row.id,
      ts: row.ts,
      from: row.sender,
      to: row.recipient,
      topic: row.topic ?? undefined,
      kind: row.kind,
      body: row.body,
      data: row.data ? JSON.parse(row.data) : undefined,
      thread: row.thread ?? undefined,
      deliverySeq: row.delivery_seq ?? undefined,
      deliverySessionId: row.delivery_session_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      status: row.status,
      is_urgent: row.is_urgent === 1,
    }));
  }

  async updateMessageStatus(id: string, status: MessageStatus): Promise<void> {
    if (!this.db) {
      throw new Error('SqliteStorageAdapter not initialized');
    }
    const stmt = this.db.prepare('UPDATE messages SET status = ? WHERE id = ?');
    stmt.run(status, id);
  }

  async getMessageById(id: string): Promise<StoredMessage | null> {
    if (!this.db) {
      throw new Error('SqliteStorageAdapter not initialized');
    }

    // Support both exact match and prefix match (for short IDs like "06eb33da")
    const stmt = this.db.prepare(`
      SELECT id, ts, sender, recipient, topic, kind, body, data, thread, delivery_seq, delivery_session_id, session_id, status, is_urgent
      FROM messages
      WHERE id = ? OR id LIKE ?
      ORDER BY ts DESC
      LIMIT 1
    `);

    const row: any = stmt.get(id, `${id}%`);
    if (!row) return null;

    return {
      id: row.id,
      ts: row.ts,
      from: row.sender,
      to: row.recipient,
      topic: row.topic ?? undefined,
      kind: row.kind,
      body: row.body,
      data: row.data ? JSON.parse(row.data) : undefined,
      thread: row.thread ?? undefined,
      deliverySeq: row.delivery_seq ?? undefined,
      deliverySessionId: row.delivery_session_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      status: row.status ?? 'unread',
      is_urgent: row.is_urgent === 1,
    };
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = undefined;
    }
  }

  // ============ Session Management ============

  async startSession(session: Omit<StoredSession, 'messageCount'>): Promise<void> {
    if (!this.db) {
      throw new Error('SqliteStorageAdapter not initialized');
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions
      (id, agent_name, cli, project_id, project_root, started_at, ended_at, message_count, summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      session.id,
      session.agentName,
      session.cli ?? null,
      session.projectId ?? null,
      session.projectRoot ?? null,
      session.startedAt,
      session.endedAt ?? null,
      0,
      session.summary ?? null
    );
  }

  /**
   * End a session and optionally set a summary.
   *
   * Note: The summary uses COALESCE(?, summary) - if a summary was previously
   * set (e.g., during startSession or a prior endSession call), passing null/undefined
   * for summary will preserve the existing value rather than clearing it.
   * To explicitly clear a summary, pass an empty string.
   */
  async endSession(
    sessionId: string,
    options?: { summary?: string; closedBy?: 'agent' | 'disconnect' | 'error' }
  ): Promise<void> {
    if (!this.db) {
      throw new Error('SqliteStorageAdapter not initialized');
    }

    const stmt = this.db.prepare(`
      UPDATE sessions
      SET ended_at = ?, summary = COALESCE(?, summary), closed_by = ?
      WHERE id = ?
    `);

    stmt.run(
      Date.now(),
      options?.summary ?? null,
      options?.closedBy ?? null,
      sessionId
    );
  }

  async incrementSessionMessageCount(sessionId: string): Promise<void> {
    if (!this.db) {
      throw new Error('SqliteStorageAdapter not initialized');
    }

    const stmt = this.db.prepare(`
      UPDATE sessions SET message_count = message_count + 1 WHERE id = ?
    `);

    stmt.run(sessionId);
  }

  async getSessions(query: SessionQuery = {}): Promise<StoredSession[]> {
    if (!this.db) {
      throw new Error('SqliteStorageAdapter not initialized');
    }

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (query.agentName) {
      clauses.push('agent_name = ?');
      params.push(query.agentName);
    }
    if (query.projectId) {
      clauses.push('project_id = ?');
      params.push(query.projectId);
    }
    if (query.since) {
      clauses.push('started_at >= ?');
      params.push(query.since);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = query.limit ?? 50;

    const stmt = this.db.prepare(`
      SELECT id, agent_name, cli, project_id, project_root, started_at, ended_at, message_count, summary, closed_by
      FROM sessions
      ${where}
      ORDER BY started_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(...params, limit);
    return rows.map((row: any) => ({
      id: row.id,
      agentName: row.agent_name,
      cli: row.cli ?? undefined,
      projectId: row.project_id ?? undefined,
      projectRoot: row.project_root ?? undefined,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
      messageCount: row.message_count,
      summary: row.summary ?? undefined,
      closedBy: row.closed_by ?? undefined,
    }));
  }

  async getRecentSessions(limit: number = 10): Promise<StoredSession[]> {
    return this.getSessions({ limit });
  }

  // ============ Agent Summaries ============

  async saveAgentSummary(summary: {
    agentName: string;
    projectId?: string;
    currentTask?: string;
    completedTasks?: string[];
    decisions?: string[];
    context?: string;
    files?: string[];
  }): Promise<void> {
    if (!this.db) {
      throw new Error('SqliteStorageAdapter not initialized');
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO agent_summaries
      (agent_name, project_id, last_updated, current_task, completed_tasks, decisions, context, files)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      summary.agentName,
      summary.projectId ?? null,
      Date.now(),
      summary.currentTask ?? null,
      summary.completedTasks ? JSON.stringify(summary.completedTasks) : null,
      summary.decisions ? JSON.stringify(summary.decisions) : null,
      summary.context ?? null,
      summary.files ? JSON.stringify(summary.files) : null
    );
  }

  async getAgentSummary(agentName: string): Promise<AgentSummary | null> {
    if (!this.db) {
      throw new Error('SqliteStorageAdapter not initialized');
    }

    const stmt = this.db.prepare(`
      SELECT agent_name, project_id, last_updated, current_task, completed_tasks, decisions, context, files
      FROM agent_summaries
      WHERE agent_name = ?
    `);

    const row: any = stmt.get(agentName);
    if (!row) return null;

    return {
      agentName: row.agent_name,
      projectId: row.project_id ?? undefined,
      lastUpdated: row.last_updated,
      currentTask: row.current_task ?? undefined,
      completedTasks: row.completed_tasks ? JSON.parse(row.completed_tasks) : undefined,
      decisions: row.decisions ? JSON.parse(row.decisions) : undefined,
      context: row.context ?? undefined,
      files: row.files ? JSON.parse(row.files) : undefined,
    };
  }

  async getAllAgentSummaries(): Promise<AgentSummary[]> {
    if (!this.db) {
      throw new Error('SqliteStorageAdapter not initialized');
    }

    const stmt = this.db.prepare(`
      SELECT agent_name, project_id, last_updated, current_task, completed_tasks, decisions, context, files
      FROM agent_summaries
      ORDER BY last_updated DESC
    `);

    const rows = stmt.all();
    return rows.map((row: any) => ({
      agentName: row.agent_name,
      projectId: row.project_id ?? undefined,
      lastUpdated: row.last_updated,
      currentTask: row.current_task ?? undefined,
      completedTasks: row.completed_tasks ? JSON.parse(row.completed_tasks) : undefined,
      decisions: row.decisions ? JSON.parse(row.decisions) : undefined,
      context: row.context ?? undefined,
      files: row.files ? JSON.parse(row.files) : undefined,
    }));
  }
}
