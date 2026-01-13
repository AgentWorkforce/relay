/**
 * PostgreSQL Storage Adapter for Agent Relay
 *
 * Production-ready adapter with connection pooling,
 * proper indexing, and query optimization.
 */

import { Pool, PoolConfig } from 'pg';
import type {
  StorageAdapter,
  StoredMessage,
  MessageQuery,
  StoredSession,
  SessionQuery,
  AgentSummary,
} from 'agent-relay';

interface PostgresAdapterOptions {
  poolMin?: number;
  poolMax?: number;
  idleTimeoutMs?: number;
}

export class PostgresStorageAdapter implements StorageAdapter {
  private pool: Pool;

  constructor(connectionString: string, options: PostgresAdapterOptions = {}) {
    const config: PoolConfig = {
      connectionString,
      min: options.poolMin ?? 2,
      max: options.poolMax ?? 10,
      idleTimeoutMillis: options.idleTimeoutMs ?? 30000,
    };

    this.pool = new Pool(config);

    // Log pool errors
    this.pool.on('error', (err) => {
      console.error('[PostgresStorage] Pool error:', err);
    });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      -- Messages table
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        ts BIGINT NOT NULL,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        body TEXT NOT NULL,
        kind TEXT DEFAULT 'text',
        data JSONB,
        thread TEXT,
        topic TEXT,
        status TEXT DEFAULT 'delivered',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_agent);
      CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent);
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread) WHERE thread IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic) WHERE topic IS NOT NULL;

      -- Sessions table
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        started_at BIGINT NOT NULL,
        ended_at BIGINT,
        resume_token TEXT UNIQUE,
        message_count INT DEFAULT 0,
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_name);
      CREATE INDEX IF NOT EXISTS idx_sessions_resume_token ON sessions(resume_token) WHERE resume_token IS NOT NULL;

      -- Agent summaries table
      CREATE TABLE IF NOT EXISTS agent_summaries (
        agent_name TEXT PRIMARY KEY,
        summary TEXT,
        context JSONB,
        last_updated BIGINT NOT NULL
      );
    `);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ─────────────────────────────────────────────────────────────
  // Messages
  // ─────────────────────────────────────────────────────────────

  async saveMessage(message: StoredMessage): Promise<void> {
    await this.pool.query(
      `INSERT INTO messages (id, ts, from_agent, to_agent, body, kind, data, thread, topic, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO NOTHING`,
      [
        message.id,
        message.ts,
        message.from,
        message.to,
        message.body,
        message.kind || 'text',
        JSON.stringify(message.data || {}),
        message.thread || null,
        message.topic || null,
        message.status || 'delivered',
      ]
    );
  }

  async getMessages(query?: MessageQuery): Promise<StoredMessage[]> {
    const conditions: string[] = ['1=1'];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (query?.from) {
      conditions.push(`from_agent = $${paramIndex++}`);
      params.push(query.from);
    }

    if (query?.to) {
      conditions.push(`to_agent = $${paramIndex++}`);
      params.push(query.to);
    }

    if (query?.sinceTs) {
      conditions.push(`ts >= $${paramIndex++}`);
      params.push(query.sinceTs);
    }

    if (query?.topic) {
      conditions.push(`topic = $${paramIndex++}`);
      params.push(query.topic);
    }

    if (query?.thread) {
      conditions.push(`thread = $${paramIndex++}`);
      params.push(query.thread);
    }

    const order = query?.order === 'asc' ? 'ASC' : 'DESC';
    const limit = query?.limit || 100;

    const sql = `
      SELECT id, ts, from_agent, to_agent, body, kind, data, thread, topic, status
      FROM messages
      WHERE ${conditions.join(' AND ')}
      ORDER BY ts ${order}
      LIMIT $${paramIndex}
    `;
    params.push(limit);

    const result = await this.pool.query(sql, params);

    return result.rows.map((row) => ({
      id: row.id,
      ts: Number(row.ts),
      from: row.from_agent,
      to: row.to_agent,
      body: row.body,
      kind: row.kind,
      data: row.data,
      thread: row.thread,
      topic: row.topic,
      status: row.status,
    }));
  }

  async getMessageById(id: string): Promise<StoredMessage | null> {
    const result = await this.pool.query(
      `SELECT id, ts, from_agent, to_agent, body, kind, data, thread, topic, status
       FROM messages WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      ts: Number(row.ts),
      from: row.from_agent,
      to: row.to_agent,
      body: row.body,
      kind: row.kind,
      data: row.data,
      thread: row.thread,
      topic: row.topic,
      status: row.status,
    };
  }

  async updateMessageStatus(id: string, status: string): Promise<void> {
    await this.pool.query(
      'UPDATE messages SET status = $1 WHERE id = $2',
      [status, id]
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Sessions
  // ─────────────────────────────────────────────────────────────

  async startSession(session: Omit<StoredSession, 'messageCount'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (id, agent_name, started_at, resume_token, metadata)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        session.id,
        session.agentName,
        session.startedAt,
        session.resumeToken || null,
        JSON.stringify(session.metadata || {}),
      ]
    );
  }

  async endSession(
    sessionId: string,
    options?: { endedAt?: number }
  ): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET ended_at = $1 WHERE id = $2',
      [options?.endedAt || Date.now(), sessionId]
    );
  }

  async getSessions(query?: SessionQuery): Promise<StoredSession[]> {
    const conditions: string[] = ['1=1'];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (query?.agentName) {
      conditions.push(`agent_name = $${paramIndex++}`);
      params.push(query.agentName);
    }

    if (query?.activeOnly) {
      conditions.push('ended_at IS NULL');
    }

    const limit = query?.limit || 100;
    params.push(limit);

    const sql = `
      SELECT id, agent_name, started_at, ended_at, resume_token, message_count, metadata
      FROM sessions
      WHERE ${conditions.join(' AND ')}
      ORDER BY started_at DESC
      LIMIT $${paramIndex}
    `;

    const result = await this.pool.query(sql, params);

    return result.rows.map((row) => ({
      id: row.id,
      agentName: row.agent_name,
      startedAt: Number(row.started_at),
      endedAt: row.ended_at ? Number(row.ended_at) : undefined,
      resumeToken: row.resume_token,
      messageCount: row.message_count,
      metadata: row.metadata,
    }));
  }

  async getSessionByResumeToken(token: string): Promise<StoredSession | null> {
    const result = await this.pool.query(
      `SELECT id, agent_name, started_at, ended_at, resume_token, message_count, metadata
       FROM sessions WHERE resume_token = $1`,
      [token]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      agentName: row.agent_name,
      startedAt: Number(row.started_at),
      endedAt: row.ended_at ? Number(row.ended_at) : undefined,
      resumeToken: row.resume_token,
      messageCount: row.message_count,
      metadata: row.metadata,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Agent Summaries
  // ─────────────────────────────────────────────────────────────

  async saveAgentSummary(
    summary: Omit<AgentSummary, 'lastUpdated'>
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_summaries (agent_name, summary, context, last_updated)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (agent_name) DO UPDATE SET
         summary = EXCLUDED.summary,
         context = EXCLUDED.context,
         last_updated = EXCLUDED.last_updated`,
      [
        summary.agentName,
        summary.summary,
        JSON.stringify(summary.context || {}),
        Date.now(),
      ]
    );
  }

  async getAgentSummary(agentName: string): Promise<AgentSummary | null> {
    const result = await this.pool.query(
      'SELECT agent_name, summary, context, last_updated FROM agent_summaries WHERE agent_name = $1',
      [agentName]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      agentName: row.agent_name,
      summary: row.summary,
      context: row.context,
      lastUpdated: Number(row.last_updated),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────

  async cleanup(olderThanDays: number): Promise<number> {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const result = await this.pool.query(
      'DELETE FROM messages WHERE ts < $1',
      [cutoff]
    );
    return result.rowCount ?? 0;
  }

  async getStats(): Promise<{
    messageCount: number;
    sessionCount: number;
    oldestMessage?: number;
    newestMessage?: number;
  }> {
    const [messages, sessions, range] = await Promise.all([
      this.pool.query('SELECT COUNT(*) as count FROM messages'),
      this.pool.query('SELECT COUNT(*) as count FROM sessions'),
      this.pool.query('SELECT MIN(ts) as oldest, MAX(ts) as newest FROM messages'),
    ]);

    return {
      messageCount: parseInt(messages.rows[0].count, 10),
      sessionCount: parseInt(sessions.rows[0].count, 10),
      oldestMessage: range.rows[0].oldest ? Number(range.rows[0].oldest) : undefined,
      newestMessage: range.rows[0].newest ? Number(range.rows[0].newest) : undefined,
    };
  }
}
