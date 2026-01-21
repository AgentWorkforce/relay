/**
 * Dead Letter Queue Storage Adapter
 *
 * Abstract interface for DLQ storage with implementations for:
 * - SQLite (local daemon)
 * - PostgreSQL (cloud deployment)
 * - In-memory (testing)
 *
 * Follows the adapter pattern used by the main storage layer.
 */

// =============================================================================
// Types
// =============================================================================

export type DLQFailureReason =
  | 'max_retries_exceeded'
  | 'ttl_expired'
  | 'connection_lost'
  | 'target_not_found'
  | 'signature_invalid'
  | 'payload_too_large'
  | 'rate_limited'
  | 'unknown';

export interface DeadLetter {
  id: string;
  messageId: string;
  from: string;
  to: string;
  topic?: string;
  kind: string;
  body: string;
  data?: Record<string, unknown>;
  thread?: string;
  originalTs: number;
  dlqTs: number;
  reason: DLQFailureReason;
  errorMessage?: string;
  attemptCount: number;
  lastAttemptTs?: number;
  dlqRetryCount: number;
  acknowledged: boolean;
  acknowledgedTs?: number;
  acknowledgedBy?: string;
}

export interface DLQQuery {
  to?: string;
  from?: string;
  reason?: DLQFailureReason;
  acknowledged?: boolean;
  afterTs?: number;
  beforeTs?: number;
  limit?: number;
  offset?: number;
  orderBy?: 'dlqTs' | 'originalTs' | 'attemptCount';
  orderDir?: 'ASC' | 'DESC';
}

export interface DLQStats {
  totalEntries: number;
  unacknowledged: number;
  byReason: Record<DLQFailureReason, number>;
  byTarget: Record<string, number>;
  oldestEntryTs: number | null;
  newestEntryTs: number | null;
  avgRetryCount: number;
}

export interface DLQConfig {
  enabled: boolean;
  retentionHours: number;
  maxEntries: number;
  autoCleanup: boolean;
  cleanupIntervalMinutes: number;
  alertThreshold: number;
}

export interface MessageEnvelope {
  from: string;
  to: string;
  topic?: string;
  kind: string;
  body: string;
  data?: Record<string, unknown>;
  thread?: string;
  ts: number;
}

// =============================================================================
// Adapter Interface
// =============================================================================

/**
 * Abstract interface for DLQ storage backends.
 */
export interface DLQStorageAdapter {
  /**
   * Initialize the adapter (create tables, etc.)
   */
  init(): Promise<void>;

  /**
   * Add a dead letter to the queue.
   */
  add(
    messageId: string,
    envelope: MessageEnvelope,
    reason: DLQFailureReason,
    attemptCount: number,
    errorMessage?: string
  ): Promise<DeadLetter>;

  /**
   * Get a dead letter by ID.
   */
  get(id: string): Promise<DeadLetter | null>;

  /**
   * Query dead letters with filters.
   */
  query(query?: DLQQuery): Promise<DeadLetter[]>;

  /**
   * Acknowledge a dead letter.
   */
  acknowledge(id: string, acknowledgedBy?: string): Promise<boolean>;

  /**
   * Acknowledge multiple dead letters.
   */
  acknowledgeMany(ids: string[], acknowledgedBy?: string): Promise<number>;

  /**
   * Increment retry count for a dead letter.
   */
  incrementRetry(id: string): Promise<boolean>;

  /**
   * Remove a dead letter.
   */
  remove(id: string): Promise<boolean>;

  /**
   * Get DLQ statistics.
   */
  getStats(): Promise<DLQStats>;

  /**
   * Cleanup old entries.
   */
  cleanup(retentionHours: number, maxEntries: number): Promise<{ removed: number }>;

  /**
   * Get messages ready for retry.
   */
  getRetryable(maxRetries?: number, limit?: number): Promise<DeadLetter[]>;

  /**
   * Close the adapter (cleanup resources).
   */
  close(): Promise<void>;
}

// =============================================================================
// Default Configuration
// =============================================================================

export const DEFAULT_DLQ_CONFIG: DLQConfig = {
  enabled: true,
  retentionHours: 168, // 7 days
  maxEntries: 10000,
  autoCleanup: true,
  cleanupIntervalMinutes: 60,
  alertThreshold: 1000,
};

// =============================================================================
// SQLite Adapter
// =============================================================================

import type { Database as BetterSqlite3Database } from 'better-sqlite3';

const DLQ_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS dead_letters (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  topic TEXT,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  data TEXT,
  thread TEXT,
  original_ts INTEGER NOT NULL,
  dlq_ts INTEGER NOT NULL,
  reason TEXT NOT NULL,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_ts INTEGER,
  dlq_retry_count INTEGER NOT NULL DEFAULT 0,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  acknowledged_ts INTEGER,
  acknowledged_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_dlq_to ON dead_letters(to_agent);
CREATE INDEX IF NOT EXISTS idx_dlq_from ON dead_letters(from_agent);
CREATE INDEX IF NOT EXISTS idx_dlq_reason ON dead_letters(reason);
CREATE INDEX IF NOT EXISTS idx_dlq_ts ON dead_letters(dlq_ts);
CREATE INDEX IF NOT EXISTS idx_dlq_acknowledged ON dead_letters(acknowledged);
`;

export class SQLiteDLQAdapter implements DLQStorageAdapter {
  private db: BetterSqlite3Database;

  constructor(db: BetterSqlite3Database) {
    this.db = db;
  }

  async init(): Promise<void> {
    this.db.exec(DLQ_SQLITE_SCHEMA);
  }

  async add(
    messageId: string,
    envelope: MessageEnvelope,
    reason: DLQFailureReason,
    attemptCount: number,
    errorMessage?: string
  ): Promise<DeadLetter> {
    const id = `dlq_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = Date.now();

    const deadLetter: DeadLetter = {
      id,
      messageId,
      from: envelope.from,
      to: envelope.to,
      topic: envelope.topic,
      kind: envelope.kind,
      body: envelope.body,
      data: envelope.data,
      thread: envelope.thread,
      originalTs: envelope.ts,
      dlqTs: now,
      reason,
      errorMessage,
      attemptCount,
      lastAttemptTs: now,
      dlqRetryCount: 0,
      acknowledged: false,
    };

    const stmt = this.db.prepare(`
      INSERT INTO dead_letters (
        id, message_id, from_agent, to_agent, topic, kind, body, data, thread,
        original_ts, dlq_ts, reason, error_message, attempt_count, last_attempt_ts,
        dlq_retry_count, acknowledged
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      deadLetter.id,
      deadLetter.messageId,
      deadLetter.from,
      deadLetter.to,
      deadLetter.topic ?? null,
      deadLetter.kind,
      deadLetter.body,
      deadLetter.data ? JSON.stringify(deadLetter.data) : null,
      deadLetter.thread ?? null,
      deadLetter.originalTs,
      deadLetter.dlqTs,
      deadLetter.reason,
      deadLetter.errorMessage ?? null,
      deadLetter.attemptCount,
      deadLetter.lastAttemptTs ?? null,
      deadLetter.dlqRetryCount,
      deadLetter.acknowledged ? 1 : 0
    );

    return deadLetter;
  }

  async get(id: string): Promise<DeadLetter | null> {
    const stmt = this.db.prepare('SELECT * FROM dead_letters WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToDeadLetter(row) : null;
  }

  async query(query: DLQQuery = {}): Promise<DeadLetter[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.to) {
      conditions.push('to_agent = ?');
      params.push(query.to);
    }
    if (query.from) {
      conditions.push('from_agent = ?');
      params.push(query.from);
    }
    if (query.reason) {
      conditions.push('reason = ?');
      params.push(query.reason);
    }
    if (query.acknowledged !== undefined) {
      conditions.push('acknowledged = ?');
      params.push(query.acknowledged ? 1 : 0);
    }
    if (query.afterTs) {
      conditions.push('dlq_ts > ?');
      params.push(query.afterTs);
    }
    if (query.beforeTs) {
      conditions.push('dlq_ts < ?');
      params.push(query.beforeTs);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderColumn = query.orderBy === 'originalTs' ? 'original_ts' :
                        query.orderBy === 'attemptCount' ? 'attempt_count' : 'dlq_ts';
    const orderDir = query.orderDir ?? 'DESC';
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const sql = `
      SELECT * FROM dead_letters ${whereClause}
      ORDER BY ${orderColumn} ${orderDir}
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map(row => this.rowToDeadLetter(row));
  }

  async acknowledge(id: string, acknowledgedBy: string = 'system'): Promise<boolean> {
    const stmt = this.db.prepare(`
      UPDATE dead_letters SET acknowledged = 1, acknowledged_ts = ?, acknowledged_by = ?
      WHERE id = ? AND acknowledged = 0
    `);
    const result = stmt.run(Date.now(), acknowledgedBy, id);
    return result.changes > 0;
  }

  async acknowledgeMany(ids: string[], acknowledgedBy: string = 'system'): Promise<number> {
    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      UPDATE dead_letters SET acknowledged = 1, acknowledged_ts = ?, acknowledged_by = ?
      WHERE id IN (${placeholders}) AND acknowledged = 0
    `);
    const result = stmt.run(Date.now(), acknowledgedBy, ...ids);
    return result.changes;
  }

  async incrementRetry(id: string): Promise<boolean> {
    const stmt = this.db.prepare(`
      UPDATE dead_letters SET dlq_retry_count = dlq_retry_count + 1, last_attempt_ts = ?
      WHERE id = ?
    `);
    const result = stmt.run(Date.now(), id);
    return result.changes > 0;
  }

  async remove(id: string): Promise<boolean> {
    const stmt = this.db.prepare('DELETE FROM dead_letters WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  async getStats(): Promise<DLQStats> {
    const totalRow = this.db.prepare('SELECT COUNT(*) as count FROM dead_letters').get() as { count: number };
    const unackRow = this.db.prepare('SELECT COUNT(*) as count FROM dead_letters WHERE acknowledged = 0').get() as { count: number };

    const reasonRows = this.db.prepare('SELECT reason, COUNT(*) as count FROM dead_letters GROUP BY reason').all() as Array<{ reason: string; count: number }>;
    const byReason: Record<DLQFailureReason, number> = {
      max_retries_exceeded: 0, ttl_expired: 0, connection_lost: 0, target_not_found: 0,
      signature_invalid: 0, payload_too_large: 0, rate_limited: 0, unknown: 0,
    };
    for (const row of reasonRows) {
      byReason[row.reason as DLQFailureReason] = row.count;
    }

    const targetRows = this.db.prepare('SELECT to_agent, COUNT(*) as count FROM dead_letters GROUP BY to_agent ORDER BY count DESC LIMIT 10').all() as Array<{ to_agent: string; count: number }>;
    const byTarget: Record<string, number> = {};
    for (const row of targetRows) {
      byTarget[row.to_agent] = row.count;
    }

    const oldestRow = this.db.prepare('SELECT MIN(dlq_ts) as ts FROM dead_letters WHERE acknowledged = 0').get() as { ts: number | null };
    const newestRow = this.db.prepare('SELECT MAX(dlq_ts) as ts FROM dead_letters WHERE acknowledged = 0').get() as { ts: number | null };
    const avgRow = this.db.prepare('SELECT AVG(dlq_retry_count) as avg FROM dead_letters').get() as { avg: number | null };

    return {
      totalEntries: totalRow.count,
      unacknowledged: unackRow.count,
      byReason,
      byTarget,
      oldestEntryTs: oldestRow.ts,
      newestEntryTs: newestRow.ts,
      avgRetryCount: avgRow.avg ?? 0,
    };
  }

  async cleanup(retentionHours: number, maxEntries: number): Promise<{ removed: number }> {
    const cutoffTs = Date.now() - retentionHours * 3600 * 1000;

    const retentionResult = this.db.prepare('DELETE FROM dead_letters WHERE dlq_ts < ?').run(cutoffTs);

    const countRow = this.db.prepare('SELECT COUNT(*) as count FROM dead_letters').get() as { count: number };
    let maxEntriesRemoved = 0;
    if (countRow.count > maxEntries) {
      const excess = countRow.count - maxEntries;
      const trimResult = this.db.prepare(`
        DELETE FROM dead_letters WHERE id IN (
          SELECT id FROM dead_letters WHERE acknowledged = 1 ORDER BY dlq_ts ASC LIMIT ?
        )
      `).run(excess);
      maxEntriesRemoved = trimResult.changes;
    }

    return { removed: retentionResult.changes + maxEntriesRemoved };
  }

  async getRetryable(maxRetries: number = 3, limit: number = 10): Promise<DeadLetter[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM dead_letters
      WHERE acknowledged = 0 AND dlq_retry_count < ?
      ORDER BY dlq_ts ASC LIMIT ?
    `);
    const rows = stmt.all(maxRetries, limit) as Record<string, unknown>[];
    return rows.map(row => this.rowToDeadLetter(row));
  }

  async close(): Promise<void> {
    // SQLite connection managed externally
  }

  private rowToDeadLetter(row: Record<string, unknown>): DeadLetter {
    let data: Record<string, unknown> | undefined;
    if (row.data) {
      try {
        data = JSON.parse(row.data as string);
      } catch {
        // Invalid JSON data, leave as undefined
        console.warn(`[dlq] Failed to parse data for dead letter ${row.id}`);
      }
    }

    return {
      id: row.id as string,
      messageId: row.message_id as string,
      from: row.from_agent as string,
      to: row.to_agent as string,
      topic: row.topic as string | undefined,
      kind: row.kind as string,
      body: row.body as string,
      data,
      thread: row.thread as string | undefined,
      originalTs: row.original_ts as number,
      dlqTs: row.dlq_ts as number,
      reason: row.reason as DLQFailureReason,
      errorMessage: row.error_message as string | undefined,
      attemptCount: row.attempt_count as number,
      lastAttemptTs: row.last_attempt_ts as number | undefined,
      dlqRetryCount: row.dlq_retry_count as number,
      acknowledged: (row.acknowledged as number) === 1,
      acknowledgedTs: row.acknowledged_ts as number | undefined,
      acknowledgedBy: row.acknowledged_by as string | undefined,
    };
  }
}

// =============================================================================
// PostgreSQL Adapter
// =============================================================================

import type { Pool as PgPool } from 'pg';

const DLQ_POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS dead_letters (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  topic TEXT,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  data JSONB,
  thread TEXT,
  original_ts BIGINT NOT NULL,
  dlq_ts BIGINT NOT NULL,
  reason TEXT NOT NULL,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_ts BIGINT,
  dlq_retry_count INTEGER NOT NULL DEFAULT 0,
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_ts BIGINT,
  acknowledged_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_dlq_to ON dead_letters(to_agent);
CREATE INDEX IF NOT EXISTS idx_dlq_from ON dead_letters(from_agent);
CREATE INDEX IF NOT EXISTS idx_dlq_reason ON dead_letters(reason);
CREATE INDEX IF NOT EXISTS idx_dlq_ts ON dead_letters(dlq_ts);
CREATE INDEX IF NOT EXISTS idx_dlq_acknowledged ON dead_letters(acknowledged);
`;

export class PostgresDLQAdapter implements DLQStorageAdapter {
  private pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(DLQ_POSTGRES_SCHEMA);
    } finally {
      client.release();
    }
  }

  async add(
    messageId: string,
    envelope: MessageEnvelope,
    reason: DLQFailureReason,
    attemptCount: number,
    errorMessage?: string
  ): Promise<DeadLetter> {
    const id = `dlq_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = Date.now();

    const deadLetter: DeadLetter = {
      id,
      messageId,
      from: envelope.from,
      to: envelope.to,
      topic: envelope.topic,
      kind: envelope.kind,
      body: envelope.body,
      data: envelope.data,
      thread: envelope.thread,
      originalTs: envelope.ts,
      dlqTs: now,
      reason,
      errorMessage,
      attemptCount,
      lastAttemptTs: now,
      dlqRetryCount: 0,
      acknowledged: false,
    };

    await this.pool.query(`
      INSERT INTO dead_letters (
        id, message_id, from_agent, to_agent, topic, kind, body, data, thread,
        original_ts, dlq_ts, reason, error_message, attempt_count, last_attempt_ts,
        dlq_retry_count, acknowledged
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    `, [
      deadLetter.id, deadLetter.messageId, deadLetter.from, deadLetter.to,
      deadLetter.topic ?? null, deadLetter.kind, deadLetter.body,
      deadLetter.data ? JSON.stringify(deadLetter.data) : null,
      deadLetter.thread ?? null, deadLetter.originalTs, deadLetter.dlqTs,
      deadLetter.reason, deadLetter.errorMessage ?? null, deadLetter.attemptCount,
      deadLetter.lastAttemptTs ?? null, deadLetter.dlqRetryCount, deadLetter.acknowledged
    ]);

    return deadLetter;
  }

  async get(id: string): Promise<DeadLetter | null> {
    const result = await this.pool.query('SELECT * FROM dead_letters WHERE id = $1', [id]);
    return result.rows[0] ? this.rowToDeadLetter(result.rows[0]) : null;
  }

  async query(query: DLQQuery = {}): Promise<DeadLetter[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (query.to) {
      conditions.push(`to_agent = $${paramIndex++}`);
      params.push(query.to);
    }
    if (query.from) {
      conditions.push(`from_agent = $${paramIndex++}`);
      params.push(query.from);
    }
    if (query.reason) {
      conditions.push(`reason = $${paramIndex++}`);
      params.push(query.reason);
    }
    if (query.acknowledged !== undefined) {
      conditions.push(`acknowledged = $${paramIndex++}`);
      params.push(query.acknowledged);
    }
    if (query.afterTs) {
      conditions.push(`dlq_ts > $${paramIndex++}`);
      params.push(query.afterTs);
    }
    if (query.beforeTs) {
      conditions.push(`dlq_ts < $${paramIndex++}`);
      params.push(query.beforeTs);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderColumn = query.orderBy === 'originalTs' ? 'original_ts' :
                        query.orderBy === 'attemptCount' ? 'attempt_count' : 'dlq_ts';
    const orderDir = query.orderDir ?? 'DESC';
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    params.push(limit, offset);

    const sql = `
      SELECT * FROM dead_letters ${whereClause}
      ORDER BY ${orderColumn} ${orderDir}
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    const result = await this.pool.query(sql, params);
    return result.rows.map(row => this.rowToDeadLetter(row));
  }

  async acknowledge(id: string, acknowledgedBy: string = 'system'): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE dead_letters SET acknowledged = TRUE, acknowledged_ts = $1, acknowledged_by = $2
      WHERE id = $3 AND acknowledged = FALSE
    `, [Date.now(), acknowledgedBy, id]);
    return (result.rowCount ?? 0) > 0;
  }

  async acknowledgeMany(ids: string[], acknowledgedBy: string = 'system'): Promise<number> {
    const result = await this.pool.query(`
      UPDATE dead_letters SET acknowledged = TRUE, acknowledged_ts = $1, acknowledged_by = $2
      WHERE id = ANY($3) AND acknowledged = FALSE
    `, [Date.now(), acknowledgedBy, ids]);
    return result.rowCount ?? 0;
  }

  async incrementRetry(id: string): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE dead_letters SET dlq_retry_count = dlq_retry_count + 1, last_attempt_ts = $1
      WHERE id = $2
    `, [Date.now(), id]);
    return (result.rowCount ?? 0) > 0;
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM dead_letters WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async getStats(): Promise<DLQStats> {
    const [totalResult, unackResult, reasonResult, targetResult, oldestResult, newestResult, avgResult] = await Promise.all([
      this.pool.query('SELECT COUNT(*) as count FROM dead_letters'),
      this.pool.query('SELECT COUNT(*) as count FROM dead_letters WHERE acknowledged = FALSE'),
      this.pool.query('SELECT reason, COUNT(*) as count FROM dead_letters GROUP BY reason'),
      this.pool.query('SELECT to_agent, COUNT(*) as count FROM dead_letters GROUP BY to_agent ORDER BY count DESC LIMIT 10'),
      this.pool.query('SELECT MIN(dlq_ts) as ts FROM dead_letters WHERE acknowledged = FALSE'),
      this.pool.query('SELECT MAX(dlq_ts) as ts FROM dead_letters WHERE acknowledged = FALSE'),
      this.pool.query('SELECT AVG(dlq_retry_count) as avg FROM dead_letters'),
    ]);

    const byReason: Record<DLQFailureReason, number> = {
      max_retries_exceeded: 0, ttl_expired: 0, connection_lost: 0, target_not_found: 0,
      signature_invalid: 0, payload_too_large: 0, rate_limited: 0, unknown: 0,
    };
    for (const row of reasonResult.rows) {
      byReason[row.reason as DLQFailureReason] = parseInt(row.count, 10);
    }

    const byTarget: Record<string, number> = {};
    for (const row of targetResult.rows) {
      byTarget[row.to_agent] = parseInt(row.count, 10);
    }

    return {
      totalEntries: parseInt(totalResult.rows[0]?.count ?? '0', 10),
      unacknowledged: parseInt(unackResult.rows[0]?.count ?? '0', 10),
      byReason,
      byTarget,
      oldestEntryTs: oldestResult.rows[0]?.ts ? parseInt(oldestResult.rows[0].ts, 10) : null,
      newestEntryTs: newestResult.rows[0]?.ts ? parseInt(newestResult.rows[0].ts, 10) : null,
      avgRetryCount: parseFloat(avgResult.rows[0]?.avg ?? '0'),
    };
  }

  async cleanup(retentionHours: number, maxEntries: number): Promise<{ removed: number }> {
    const cutoffTs = Date.now() - retentionHours * 3600 * 1000;
    const retentionResult = await this.pool.query('DELETE FROM dead_letters WHERE dlq_ts < $1', [cutoffTs]);

    const countResult = await this.pool.query('SELECT COUNT(*) as count FROM dead_letters');
    const count = parseInt(countResult.rows[0]?.count ?? '0', 10);
    let maxEntriesRemoved = 0;

    if (count > maxEntries) {
      const excess = count - maxEntries;
      const trimResult = await this.pool.query(`
        DELETE FROM dead_letters WHERE id IN (
          SELECT id FROM dead_letters WHERE acknowledged = TRUE ORDER BY dlq_ts ASC LIMIT $1
        )
      `, [excess]);
      maxEntriesRemoved = trimResult.rowCount ?? 0;
    }

    return { removed: (retentionResult.rowCount ?? 0) + maxEntriesRemoved };
  }

  async getRetryable(maxRetries: number = 3, limit: number = 10): Promise<DeadLetter[]> {
    const result = await this.pool.query(`
      SELECT * FROM dead_letters
      WHERE acknowledged = FALSE AND dlq_retry_count < $1
      ORDER BY dlq_ts ASC LIMIT $2
    `, [maxRetries, limit]);
    return result.rows.map(row => this.rowToDeadLetter(row));
  }

  async close(): Promise<void> {
    // Pool managed externally
  }

  private rowToDeadLetter(row: Record<string, unknown>): DeadLetter {
    return {
      id: row.id as string,
      messageId: row.message_id as string,
      from: row.from_agent as string,
      to: row.to_agent as string,
      topic: row.topic as string | undefined,
      kind: row.kind as string,
      body: row.body as string,
      data: row.data as Record<string, unknown> | undefined,
      thread: row.thread as string | undefined,
      originalTs: parseInt(row.original_ts as string, 10),
      dlqTs: parseInt(row.dlq_ts as string, 10),
      reason: row.reason as DLQFailureReason,
      errorMessage: row.error_message as string | undefined,
      attemptCount: row.attempt_count as number,
      lastAttemptTs: row.last_attempt_ts ? parseInt(row.last_attempt_ts as string, 10) : undefined,
      dlqRetryCount: row.dlq_retry_count as number,
      acknowledged: row.acknowledged as boolean,
      acknowledgedTs: row.acknowledged_ts ? parseInt(row.acknowledged_ts as string, 10) : undefined,
      acknowledgedBy: row.acknowledged_by as string | undefined,
    };
  }
}

// =============================================================================
// In-Memory Adapter (for testing)
// =============================================================================

export class InMemoryDLQAdapter implements DLQStorageAdapter {
  private letters: Map<string, DeadLetter> = new Map();

  async init(): Promise<void> {
    // No-op
  }

  async add(
    messageId: string,
    envelope: MessageEnvelope,
    reason: DLQFailureReason,
    attemptCount: number,
    errorMessage?: string
  ): Promise<DeadLetter> {
    const id = `dlq_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = Date.now();

    const deadLetter: DeadLetter = {
      id,
      messageId,
      from: envelope.from,
      to: envelope.to,
      topic: envelope.topic,
      kind: envelope.kind,
      body: envelope.body,
      data: envelope.data,
      thread: envelope.thread,
      originalTs: envelope.ts,
      dlqTs: now,
      reason,
      errorMessage,
      attemptCount,
      lastAttemptTs: now,
      dlqRetryCount: 0,
      acknowledged: false,
    };

    this.letters.set(id, deadLetter);
    return deadLetter;
  }

  async get(id: string): Promise<DeadLetter | null> {
    return this.letters.get(id) ?? null;
  }

  async query(query: DLQQuery = {}): Promise<DeadLetter[]> {
    let results = Array.from(this.letters.values());

    if (query.to) results = results.filter(l => l.to === query.to);
    if (query.from) results = results.filter(l => l.from === query.from);
    if (query.reason) results = results.filter(l => l.reason === query.reason);
    if (query.acknowledged !== undefined) results = results.filter(l => l.acknowledged === query.acknowledged);
    if (query.afterTs) results = results.filter(l => l.dlqTs > query.afterTs!);
    if (query.beforeTs) results = results.filter(l => l.dlqTs < query.beforeTs!);

    const orderDir = query.orderDir ?? 'DESC';
    const orderBy = query.orderBy ?? 'dlqTs';
    results.sort((a, b) => {
      const aVal = orderBy === 'originalTs' ? a.originalTs : orderBy === 'attemptCount' ? a.attemptCount : a.dlqTs;
      const bVal = orderBy === 'originalTs' ? b.originalTs : orderBy === 'attemptCount' ? b.attemptCount : b.dlqTs;
      return orderDir === 'ASC' ? aVal - bVal : bVal - aVal;
    });

    const offset = query.offset ?? 0;
    const limit = query.limit ?? 100;
    return results.slice(offset, offset + limit);
  }

  async acknowledge(id: string, acknowledgedBy: string = 'system'): Promise<boolean> {
    const letter = this.letters.get(id);
    if (!letter || letter.acknowledged) return false;
    letter.acknowledged = true;
    letter.acknowledgedTs = Date.now();
    letter.acknowledgedBy = acknowledgedBy;
    return true;
  }

  async acknowledgeMany(ids: string[], acknowledgedBy: string = 'system'): Promise<number> {
    let count = 0;
    for (const id of ids) {
      if (await this.acknowledge(id, acknowledgedBy)) count++;
    }
    return count;
  }

  async incrementRetry(id: string): Promise<boolean> {
    const letter = this.letters.get(id);
    if (!letter) return false;
    letter.dlqRetryCount++;
    letter.lastAttemptTs = Date.now();
    return true;
  }

  async remove(id: string): Promise<boolean> {
    return this.letters.delete(id);
  }

  async getStats(): Promise<DLQStats> {
    const letters = Array.from(this.letters.values());
    const byReason: Record<DLQFailureReason, number> = {
      max_retries_exceeded: 0, ttl_expired: 0, connection_lost: 0, target_not_found: 0,
      signature_invalid: 0, payload_too_large: 0, rate_limited: 0, unknown: 0,
    };
    const byTarget: Record<string, number> = {};
    let unacknowledged = 0;
    let totalRetry = 0;

    for (const l of letters) {
      byReason[l.reason]++;
      byTarget[l.to] = (byTarget[l.to] ?? 0) + 1;
      if (!l.acknowledged) unacknowledged++;
      totalRetry += l.dlqRetryCount;
    }

    const unackLetters = letters.filter(l => !l.acknowledged);
    const timestamps = unackLetters.map(l => l.dlqTs);

    return {
      totalEntries: letters.length,
      unacknowledged,
      byReason,
      byTarget,
      oldestEntryTs: timestamps.length > 0 ? Math.min(...timestamps) : null,
      newestEntryTs: timestamps.length > 0 ? Math.max(...timestamps) : null,
      avgRetryCount: letters.length > 0 ? totalRetry / letters.length : 0,
    };
  }

  async cleanup(retentionHours: number, maxEntries: number): Promise<{ removed: number }> {
    const cutoffTs = Date.now() - retentionHours * 3600 * 1000;
    let removed = 0;

    for (const [id, letter] of this.letters) {
      if (letter.dlqTs < cutoffTs) {
        this.letters.delete(id);
        removed++;
      }
    }

    // Enforce max entries
    if (this.letters.size > maxEntries) {
      const sorted = Array.from(this.letters.entries())
        .filter(([, l]) => l.acknowledged)
        .sort((a, b) => a[1].dlqTs - b[1].dlqTs);

      const excess = this.letters.size - maxEntries;
      for (let i = 0; i < excess && i < sorted.length; i++) {
        this.letters.delete(sorted[i][0]);
        removed++;
      }
    }

    return { removed };
  }

  async getRetryable(maxRetries: number = 3, limit: number = 10): Promise<DeadLetter[]> {
    return Array.from(this.letters.values())
      .filter(l => !l.acknowledged && l.dlqRetryCount < maxRetries)
      .sort((a, b) => a.dlqTs - b.dlqTs)
      .slice(0, limit);
  }

  async close(): Promise<void> {
    this.letters.clear();
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export type DLQAdapterType = 'sqlite' | 'postgres' | 'memory';

export interface DLQAdapterOptions {
  type: DLQAdapterType;
  sqlite?: BetterSqlite3Database;
  postgres?: PgPool;
}

/**
 * Create a DLQ adapter based on configuration.
 */
export function createDLQAdapter(options: DLQAdapterOptions): DLQStorageAdapter {
  switch (options.type) {
    case 'sqlite':
      if (!options.sqlite) throw new Error('SQLite database required');
      return new SQLiteDLQAdapter(options.sqlite);
    case 'postgres':
      if (!options.postgres) throw new Error('PostgreSQL pool required');
      return new PostgresDLQAdapter(options.postgres);
    case 'memory':
      return new InMemoryDLQAdapter();
    default:
      throw new Error(`Unknown DLQ adapter type: ${options.type}`);
  }
}
