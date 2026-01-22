import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import {
  bulkInsertMessages,
  streamingBulkInsert,
  optimizedBulkInsert,
  getPoolStats,
  checkPoolHealth,
} from './bulk-ingest.js';
import type { NewAgentMessage } from './schema.js';

const makeMessage = (overrides: Partial<NewAgentMessage> = {}): NewAgentMessage => ({
  workspaceId: overrides.workspaceId ?? '00000000-0000-0000-0000-000000000001',
  originalId: overrides.originalId ?? `msg-${Math.random().toString(36).slice(2, 10)}`,
  fromAgent: overrides.fromAgent ?? 'AgentA',
  toAgent: overrides.toAgent ?? 'AgentB',
  body: overrides.body ?? 'hello',
  kind: overrides.kind ?? 'message',
  messageTs: overrides.messageTs ?? new Date(),
  ...overrides,
});

function createMockPool(queryFn?: (text: string, values?: unknown[]) => Promise<QueryResult>): Pool {
  const defaultQuery = vi.fn().mockResolvedValue({ rowCount: 1 });

  return {
    query: queryFn ?? defaultQuery,
    connect: vi.fn().mockResolvedValue(createMockClient(queryFn)),
    totalCount: 10,
    idleCount: 5,
    waitingCount: 0,
  } as unknown as Pool;
}

function createMockClient(queryFn?: (text: string, values?: unknown[]) => Promise<QueryResult>): PoolClient {
  const defaultQuery = vi.fn().mockResolvedValue({ rowCount: 1 });

  return {
    query: queryFn ?? defaultQuery,
    release: vi.fn(),
  } as unknown as PoolClient;
}

describe('bulkInsertMessages', () => {
  it('returns early for empty message array', async () => {
    const pool = createMockPool();

    const result = await bulkInsertMessages(pool, []);

    expect(result.inserted).toBe(0);
    expect(result.duplicates).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.durationMs).toBe(0);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('inserts single message', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rowCount: 1 });
    const pool = createMockPool(queryMock);

    const result = await bulkInsertMessages(pool, [makeMessage()]);

    expect(result.inserted).toBe(1);
    expect(result.duplicates).toBe(0);
    expect(result.errors).toBe(0);
    expect(queryMock).toHaveBeenCalledTimes(1);

    // Verify query format
    const [query] = queryMock.mock.calls[0];
    expect(query).toContain('INSERT INTO agent_messages');
    expect(query).toContain('ON CONFLICT');
  });

  it('processes messages in chunks', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rowCount: 50 });
    const pool = createMockPool(queryMock);

    // Create 150 messages with chunk size 50
    const messages = Array.from({ length: 150 }, (_, i) =>
      makeMessage({ originalId: `msg-${i}` })
    );

    const result = await bulkInsertMessages(pool, messages, 50);

    // Should have made 3 chunks
    expect(queryMock).toHaveBeenCalledTimes(3);
    expect(result.inserted).toBe(150);
  });

  it('counts duplicates correctly', async () => {
    // 5 messages but only 3 inserted (2 duplicates)
    const queryMock = vi.fn().mockResolvedValue({ rowCount: 3 });
    const pool = createMockPool(queryMock);

    const messages = Array.from({ length: 5 }, (_, i) =>
      makeMessage({ originalId: `msg-${i}` })
    );

    const result = await bulkInsertMessages(pool, messages, 100);

    expect(result.inserted).toBe(3);
    expect(result.duplicates).toBe(2);
    expect(result.errors).toBe(0);
  });

  it('handles chunk insert errors', async () => {
    const queryMock = vi.fn().mockRejectedValue(new Error('DB error'));
    const pool = createMockPool(queryMock);

    const messages = [makeMessage()];

    const result = await bulkInsertMessages(pool, messages);

    expect(result.inserted).toBe(0);
    expect(result.errors).toBe(1);
  });

  it('handles partial chunk failures', async () => {
    let callCount = 0;
    const queryMock = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 2) {
        return Promise.reject(new Error('Chunk 2 failed'));
      }
      return Promise.resolve({ rowCount: 50 });
    });
    const pool = createMockPool(queryMock);

    // 150 messages in 3 chunks
    const messages = Array.from({ length: 150 }, (_, i) =>
      makeMessage({ originalId: `msg-${i}` })
    );

    const result = await bulkInsertMessages(pool, messages, 50);

    // 2 successful chunks (100 rows) + 1 failed chunk (50 errors)
    expect(result.inserted).toBe(100);
    expect(result.errors).toBe(50);
  });

  it('serializes JSON data fields', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rowCount: 1 });
    const pool = createMockPool(queryMock);

    const message = makeMessage({
      data: { key: 'value' },
      payloadMeta: { compressed: true },
    });

    await bulkInsertMessages(pool, [message]);

    const [, values] = queryMock.mock.calls[0];
    // data and payloadMeta should be stringified
    expect(values).toContain('{"key":"value"}');
    expect(values).toContain('{"compressed":true}');
  });
});

describe('streamingBulkInsert', () => {
  it('returns early for empty message array', async () => {
    const pool = createMockPool();

    const result = await streamingBulkInsert(pool, []);

    expect(result.inserted).toBe(0);
    expect(result.duplicates).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.durationMs).toBe(0);
  });

  it('creates and uses staging table in transaction', async () => {
    const queries: string[] = [];
    const clientQueryMock = vi.fn().mockImplementation((query: string) => {
      queries.push(query);
      return Promise.resolve({ rowCount: 5 });
    });

    const pool = {
      ...createMockPool(),
      connect: vi.fn().mockResolvedValue({
        query: clientQueryMock,
        release: vi.fn(),
      }),
    } as unknown as Pool;

    const messages = Array.from({ length: 5 }, (_, i) =>
      makeMessage({ originalId: `stream-${i}` })
    );

    await streamingBulkInsert(pool, messages);

    // Verify transaction flow
    expect(queries[0]).toBe('BEGIN');
    expect(queries[1]).toContain('CREATE TEMP TABLE _staging_messages');
    expect(queries[1]).toContain('ON COMMIT DROP');
    expect(queries.some((q) => q.includes('INSERT INTO _staging_messages'))).toBe(true);
    expect(queries.some((q) => q.includes('INSERT INTO agent_messages'))).toBe(true);
    expect(queries.some((q) => q.includes('FROM _staging_messages'))).toBe(true);
    expect(queries[queries.length - 1]).toBe('COMMIT');
  });

  it('rolls back transaction on error', async () => {
    const queries: string[] = [];
    let insertCount = 0;

    const clientQueryMock = vi.fn().mockImplementation((query: string) => {
      queries.push(query);
      if (query.includes('INSERT INTO agent_messages')) {
        insertCount++;
        if (insertCount === 1) {
          return Promise.reject(new Error('Insert failed'));
        }
      }
      return Promise.resolve({ rowCount: 1 });
    });

    const pool = {
      ...createMockPool(),
      connect: vi.fn().mockResolvedValue({
        query: clientQueryMock,
        release: vi.fn(),
      }),
    } as unknown as Pool;

    const result = await streamingBulkInsert(pool, [makeMessage()]);

    expect(result.errors).toBe(1);
    expect(queries).toContain('ROLLBACK');
  });

  it('releases client after completion', async () => {
    const releaseMock = vi.fn();
    const pool = {
      ...createMockPool(),
      connect: vi.fn().mockResolvedValue({
        query: vi.fn().mockResolvedValue({ rowCount: 1 }),
        release: releaseMock,
      }),
    } as unknown as Pool;

    await streamingBulkInsert(pool, [makeMessage()]);

    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('releases client even on error', async () => {
    const releaseMock = vi.fn();
    const pool = {
      ...createMockPool(),
      connect: vi.fn().mockResolvedValue({
        query: vi.fn().mockRejectedValue(new Error('Fail')),
        release: releaseMock,
      }),
    } as unknown as Pool;

    await streamingBulkInsert(pool, [makeMessage()]);

    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('counts deduplication correctly', async () => {
    let insertCalled = false;
    const clientQueryMock = vi.fn().mockImplementation((query: string) => {
      if (query.includes('INSERT INTO agent_messages') && query.includes('FROM _staging_messages')) {
        insertCalled = true;
        // 10 messages but only 7 inserted (3 duplicates)
        return Promise.resolve({ rowCount: 7 });
      }
      return Promise.resolve({ rowCount: 1 });
    });

    const pool = {
      ...createMockPool(),
      connect: vi.fn().mockResolvedValue({
        query: clientQueryMock,
        release: vi.fn(),
      }),
    } as unknown as Pool;

    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMessage({ originalId: `dedup-${i}` })
    );

    const result = await streamingBulkInsert(pool, messages);

    expect(insertCalled).toBe(true);
    expect(result.inserted).toBe(7);
    expect(result.duplicates).toBe(3);
  });
});

describe('optimizedBulkInsert', () => {
  it('returns early for empty array', async () => {
    const pool = createMockPool();

    const result = await optimizedBulkInsert(pool, []);

    expect(result.inserted).toBe(0);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('uses regular insert for small batches', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rowCount: 50 });
    const pool = createMockPool(queryMock);

    const messages = Array.from({ length: 50 }, (_, i) =>
      makeMessage({ originalId: `small-${i}` })
    );

    await optimizedBulkInsert(pool, messages);

    // Should use bulkInsertMessages (direct query)
    expect(queryMock).toHaveBeenCalled();
  });

  it('uses streaming insert for large batches', async () => {
    const clientQueryMock = vi.fn().mockResolvedValue({ rowCount: 1500 });
    const connectMock = vi.fn().mockResolvedValue({
      query: clientQueryMock,
      release: vi.fn(),
    });

    const pool = {
      query: vi.fn(),
      connect: connectMock,
      totalCount: 10,
      idleCount: 5,
      waitingCount: 0,
    } as unknown as Pool;

    const messages = Array.from({ length: 1500 }, (_, i) =>
      makeMessage({ originalId: `large-${i}` })
    );

    await optimizedBulkInsert(pool, messages);

    // Should use streamingBulkInsert (uses connect)
    expect(connectMock).toHaveBeenCalled();
  });
});

describe('getPoolStats', () => {
  it('returns pool statistics', () => {
    const pool = {
      totalCount: 20,
      idleCount: 15,
      waitingCount: 2,
    } as unknown as Pool;

    const stats = getPoolStats(pool);

    expect(stats.total).toBe(20);
    expect(stats.idle).toBe(15);
    expect(stats.waiting).toBe(2);
  });
});

describe('checkPoolHealth', () => {
  it('returns healthy status on successful query', async () => {
    const pool = createMockPool();

    const result = await checkPoolHealth(pool);

    expect(result.healthy).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('returns unhealthy status on query failure', async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error('Connection failed')),
    } as unknown as Pool;

    const result = await checkPoolHealth(pool);

    expect(result.healthy).toBe(false);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toContain('Connection failed');
  });
});
