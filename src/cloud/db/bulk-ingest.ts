/**
 * Bulk Ingest Utilities
 *
 * Optimized bulk insert operations for high-volume message sync.
 * Uses raw SQL for performance instead of ORM-generated queries.
 *
 * Key optimizations:
 * - Multi-row INSERT with VALUES for batches
 * - Streaming COPY for very large batches (>1000 rows)
 * - Proper JSONB serialization
 * - Connection reuse via pool
 * - Chunk processing for memory efficiency
 */

import { Pool, PoolClient } from 'pg';

// TODO: NewAgentMessage will be imported once agent messaging schema is complete
// import type { NewAgentMessage } from './schema.js';
type NewAgentMessage = Record<string, unknown>;

// Re-export pool config for use in drizzle.ts
export interface PoolConfig {
  connectionString: string;
  /** Maximum number of connections in pool (default: 20) */
  max?: number;
  /** How long a client can be idle before being closed (default: 30000) */
  idleTimeoutMillis?: number;
  /** Max time to wait for a connection (default: 10000) */
  connectionTimeoutMillis?: number;
  /** Enable SSL (default: based on connection string) */
  ssl?: boolean | { rejectUnauthorized: boolean };
}

export const DEFAULT_POOL_CONFIG: Partial<PoolConfig> = {
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
};

/**
 * Result of a bulk insert operation
 */
export interface BulkInsertResult {
  inserted: number;
  duplicates: number;
  errors: number;
  durationMs: number;
}

/**
 * Bulk insert messages using optimized multi-row INSERT.
 *
 * Uses ON CONFLICT DO NOTHING for deduplication.
 * Much faster than individual inserts for batches.
 *
 * @param pool Database connection pool
 * @param messages Messages to insert
 * @param chunkSize Number of rows per INSERT statement (default: 100)
 */
export async function bulkInsertMessages(
  pool: Pool,
  messages: NewAgentMessage[],
  chunkSize = 100
): Promise<BulkInsertResult> {
  if (messages.length === 0) {
    return { inserted: 0, duplicates: 0, errors: 0, durationMs: 0 };
  }

  const startTime = Date.now();
  let totalInserted = 0;
  let totalErrors = 0;

  // Process in chunks to avoid query size limits
  for (let i = 0; i < messages.length; i += chunkSize) {
    const chunk = messages.slice(i, i + chunkSize);
    const result = await insertMessageChunk(pool, chunk);
    totalInserted += result.inserted;
    totalErrors += result.errors;
  }

  return {
    inserted: totalInserted,
    duplicates: messages.length - totalInserted - totalErrors,
    errors: totalErrors,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Insert a chunk of messages with multi-row VALUES.
 */
async function insertMessageChunk(
  pool: Pool,
  messages: NewAgentMessage[]
): Promise<{ inserted: number; errors: number }> {
  if (messages.length === 0) {
    return { inserted: 0, errors: 0 };
  }

  // Build parameterized multi-row INSERT
  const columns = [
    'workspace_id',
    'daemon_id',
    'original_id',
    'from_agent',
    'to_agent',
    'body',
    'kind',
    'topic',
    'thread',
    'channel',
    'is_broadcast',
    'is_urgent',
    'data',
    'payload_meta',
    'message_ts',
    'expires_at',
  ];

  const values: unknown[] = [];
  const placeholders: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const offset = i * columns.length;
    const rowPlaceholders = columns.map((_, j) => `$${offset + j + 1}`);
    placeholders.push(`(${rowPlaceholders.join(', ')})`);

    values.push(
      msg.workspaceId,
      msg.daemonId ?? null,
      msg.originalId,
      msg.fromAgent,
      msg.toAgent,
      msg.body,
      msg.kind ?? 'message',
      msg.topic ?? null,
      msg.thread ?? null,
      msg.channel ?? null,
      msg.isBroadcast ?? false,
      msg.isUrgent ?? false,
      msg.data ? JSON.stringify(msg.data) : null,
      msg.payloadMeta ? JSON.stringify(msg.payloadMeta) : null,
      msg.messageTs,
      msg.expiresAt ?? null
    );
  }

  const query = `
    INSERT INTO agent_messages (${columns.join(', ')})
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (workspace_id, original_id) DO NOTHING
  `;

  try {
    const result = await pool.query(query, values);
    return { inserted: result.rowCount ?? 0, errors: 0 };
  } catch (err) {
    console.error('[bulk-ingest] Chunk insert failed:', err);
    return { inserted: 0, errors: messages.length };
  }
}

/**
 * Streaming bulk insert using staging table for very large batches.
 *
 * Uses chunked multi-row INSERT into a temp staging table,
 * then a single INSERT SELECT for deduplication.
 * This avoids holding all data in memory and is efficient for large batches.
 *
 * @param pool Database connection pool
 * @param messages Messages to insert
 */
export async function streamingBulkInsert(
  pool: Pool,
  messages: NewAgentMessage[]
): Promise<BulkInsertResult> {
  if (messages.length === 0) {
    return { inserted: 0, duplicates: 0, errors: 0, durationMs: 0 };
  }

  const startTime = Date.now();
  const client = await pool.connect();

  try {
    // Start transaction
    await client.query('BEGIN');

    // Create temp staging table
    await client.query(`
      CREATE TEMP TABLE _staging_messages (
        workspace_id UUID NOT NULL,
        daemon_id UUID,
        original_id VARCHAR(255) NOT NULL,
        from_agent VARCHAR(255) NOT NULL,
        to_agent VARCHAR(255) NOT NULL,
        body TEXT NOT NULL,
        kind VARCHAR(50) DEFAULT 'message',
        topic VARCHAR(255),
        thread VARCHAR(255),
        channel VARCHAR(255),
        is_broadcast BOOLEAN DEFAULT false,
        is_urgent BOOLEAN DEFAULT false,
        data JSONB,
        payload_meta JSONB,
        message_ts TIMESTAMP NOT NULL,
        expires_at TIMESTAMP
      ) ON COMMIT DROP
    `);

    // Insert into staging table in chunks
    const chunkSize = 200;
    for (let i = 0; i < messages.length; i += chunkSize) {
      const chunk = messages.slice(i, i + chunkSize);
      await insertStagingChunk(client, chunk);
    }

    // Insert from staging to main table with dedup
    const result = await client.query(`
      INSERT INTO agent_messages (
        workspace_id, daemon_id, original_id, from_agent, to_agent, body,
        kind, topic, thread, channel, is_broadcast, is_urgent,
        data, payload_meta, message_ts, expires_at
      )
      SELECT
        workspace_id, daemon_id, original_id, from_agent, to_agent, body,
        kind, topic, thread, channel, is_broadcast, is_urgent,
        data, payload_meta, message_ts, expires_at
      FROM _staging_messages
      ON CONFLICT (workspace_id, original_id) DO NOTHING
    `);

    await client.query('COMMIT');

    return {
      inserted: result.rowCount ?? 0,
      duplicates: messages.length - (result.rowCount ?? 0),
      errors: 0,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[bulk-ingest] Streaming insert failed:', err);
    return {
      inserted: 0,
      duplicates: 0,
      errors: messages.length,
      durationMs: Date.now() - startTime,
    };
  } finally {
    client.release();
  }
}

/**
 * Insert a chunk of messages into the staging table.
 */
async function insertStagingChunk(
  client: PoolClient,
  messages: NewAgentMessage[]
): Promise<void> {
  if (messages.length === 0) return;

  const columns = [
    'workspace_id',
    'daemon_id',
    'original_id',
    'from_agent',
    'to_agent',
    'body',
    'kind',
    'topic',
    'thread',
    'channel',
    'is_broadcast',
    'is_urgent',
    'data',
    'payload_meta',
    'message_ts',
    'expires_at',
  ];

  const values: unknown[] = [];
  const placeholders: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const offset = i * columns.length;
    const rowPlaceholders = columns.map((_, j) => `$${offset + j + 1}`);
    placeholders.push(`(${rowPlaceholders.join(', ')})`);

    values.push(
      msg.workspaceId,
      msg.daemonId ?? null,
      msg.originalId,
      msg.fromAgent,
      msg.toAgent,
      msg.body,
      msg.kind ?? 'message',
      msg.topic ?? null,
      msg.thread ?? null,
      msg.channel ?? null,
      msg.isBroadcast ?? false,
      msg.isUrgent ?? false,
      msg.data ? JSON.stringify(msg.data) : null,
      msg.payloadMeta ? JSON.stringify(msg.payloadMeta) : null,
      msg.messageTs,
      msg.expiresAt ?? null
    );
  }

  await client.query(
    `INSERT INTO _staging_messages (${columns.join(', ')}) VALUES ${placeholders.join(', ')}`,
    values
  );
}

/**
 * Optimized bulk insert that chooses strategy based on batch size.
 *
 * - Small batches (<100): Use regular ORM insert
 * - Medium batches (100-1000): Use multi-row INSERT
 * - Large batches (>1000): Use streaming COPY
 *
 * @param pool Database connection pool
 * @param messages Messages to insert
 */
export async function optimizedBulkInsert(
  pool: Pool,
  messages: NewAgentMessage[]
): Promise<BulkInsertResult> {
  const count = messages.length;

  if (count === 0) {
    return { inserted: 0, duplicates: 0, errors: 0, durationMs: 0 };
  }

  // For very large batches, use streaming COPY
  if (count > 1000) {
    return streamingBulkInsert(pool, messages);
  }

  // For medium batches, use multi-row INSERT
  return bulkInsertMessages(pool, messages);
}

/**
 * Get pool statistics for monitoring.
 */
export function getPoolStats(pool: Pool): {
  total: number;
  idle: number;
  waiting: number;
} {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}

/**
 * Health check for the connection pool.
 */
export async function checkPoolHealth(pool: Pool): Promise<{
  healthy: boolean;
  latencyMs: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    return {
      healthy: true,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      error: String(err),
    };
  }
}
