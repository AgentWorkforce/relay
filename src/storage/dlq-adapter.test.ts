/**
 * Tests for Dead Letter Queue Storage Adapter
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  SQLiteDLQAdapter,
  InMemoryDLQAdapter,
  createDLQAdapter,
  type DLQStorageAdapter,
  type MessageEnvelope,
  type DLQFailureReason,
} from './dlq-adapter.js';

// =============================================================================
// Test Helpers
// =============================================================================

const makeEnvelope = (overrides: Partial<MessageEnvelope> = {}): MessageEnvelope => ({
  from: overrides.from ?? 'AgentA',
  to: overrides.to ?? 'AgentB',
  topic: overrides.topic,
  kind: overrides.kind ?? 'message',
  body: overrides.body ?? 'Test message body',
  data: overrides.data,
  thread: overrides.thread,
  ts: overrides.ts ?? Date.now(),
});

// =============================================================================
// Shared Test Suite (runs for both adapters)
// =============================================================================

function runAdapterTests(
  name: string,
  createAdapter: () => Promise<{ adapter: DLQStorageAdapter; cleanup: () => Promise<void> }>
) {
  describe(name, () => {
    let adapter: DLQStorageAdapter;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const result = await createAdapter();
      adapter = result.adapter;
      cleanup = result.cleanup;
      await adapter.init();
    });

    afterEach(async () => {
      await adapter.close();
      await cleanup();
    });

    // =========================================================================
    // Basic Operations
    // =========================================================================

    describe('add', () => {
      it('adds a dead letter', async () => {
        const envelope = makeEnvelope();
        const dl = await adapter.add('msg-1', envelope, 'max_retries_exceeded', 5, 'Connection failed');

        expect(dl.id).toMatch(/^dlq_/);
        expect(dl.messageId).toBe('msg-1');
        expect(dl.from).toBe('AgentA');
        expect(dl.to).toBe('AgentB');
        expect(dl.reason).toBe('max_retries_exceeded');
        expect(dl.attemptCount).toBe(5);
        expect(dl.errorMessage).toBe('Connection failed');
        expect(dl.dlqRetryCount).toBe(0);
        expect(dl.acknowledged).toBe(false);
      });

      it('preserves all envelope fields', async () => {
        const envelope = makeEnvelope({
          topic: 'test-topic',
          thread: 'thread-123',
          data: { key: 'value', nested: { a: 1 } },
        });

        const dl = await adapter.add('msg-2', envelope, 'ttl_expired', 3);

        expect(dl.topic).toBe('test-topic');
        expect(dl.thread).toBe('thread-123');
        expect(dl.data).toEqual({ key: 'value', nested: { a: 1 } });
      });

      it('handles all failure reasons', async () => {
        const reasons: DLQFailureReason[] = [
          'max_retries_exceeded', 'ttl_expired', 'connection_lost',
          'target_not_found', 'signature_invalid', 'payload_too_large',
          'rate_limited', 'unknown',
        ];

        for (const reason of reasons) {
          const dl = await adapter.add(`msg-${reason}`, makeEnvelope(), reason, 1);
          expect(dl.reason).toBe(reason);
        }
      });
    });

    describe('get', () => {
      it('retrieves dead letter by ID', async () => {
        const envelope = makeEnvelope();
        const added = await adapter.add('msg-1', envelope, 'connection_lost', 2);

        const retrieved = await adapter.get(added.id);

        expect(retrieved).not.toBeNull();
        expect(retrieved!.id).toBe(added.id);
        expect(retrieved!.messageId).toBe('msg-1');
        expect(retrieved!.reason).toBe('connection_lost');
      });

      it('returns null for non-existent ID', async () => {
        const retrieved = await adapter.get('non-existent-id');
        expect(retrieved).toBeNull();
      });
    });

    // =========================================================================
    // Query Tests
    // =========================================================================

    describe('query', () => {
      beforeEach(async () => {
        // Add test data
        await adapter.add('msg-1', makeEnvelope({ from: 'Alice', to: 'Bob' }), 'max_retries_exceeded', 5);
        await adapter.add('msg-2', makeEnvelope({ from: 'Alice', to: 'Charlie' }), 'ttl_expired', 3);
        await adapter.add('msg-3', makeEnvelope({ from: 'Bob', to: 'Charlie' }), 'connection_lost', 2);
      });

      it('returns all dead letters with no filter', async () => {
        const results = await adapter.query();
        expect(results.length).toBe(3);
      });

      it('filters by recipient', async () => {
        const results = await adapter.query({ to: 'Charlie' });
        expect(results.length).toBe(2);
        expect(results.every(r => r.to === 'Charlie')).toBe(true);
      });

      it('filters by sender', async () => {
        const results = await adapter.query({ from: 'Alice' });
        expect(results.length).toBe(2);
        expect(results.every(r => r.from === 'Alice')).toBe(true);
      });

      it('filters by reason', async () => {
        const results = await adapter.query({ reason: 'ttl_expired' });
        expect(results.length).toBe(1);
        expect(results[0].reason).toBe('ttl_expired');
      });

      it('filters by acknowledged status', async () => {
        // Acknowledge one
        const all = await adapter.query();
        await adapter.acknowledge(all[0].id);

        const unacked = await adapter.query({ acknowledged: false });
        const acked = await adapter.query({ acknowledged: true });

        expect(unacked.length).toBe(2);
        expect(acked.length).toBe(1);
      });

      it('filters by timestamp range', async () => {
        const now = Date.now();
        const results = await adapter.query({
          afterTs: now - 1000,
          beforeTs: now + 1000,
        });
        expect(results.length).toBe(3);
      });

      it('applies limit and offset', async () => {
        const page1 = await adapter.query({ limit: 2, offset: 0 });
        const page2 = await adapter.query({ limit: 2, offset: 2 });

        expect(page1.length).toBe(2);
        expect(page2.length).toBe(1);
      });

      it('orders by dlqTs descending by default', async () => {
        const results = await adapter.query();
        for (let i = 1; i < results.length; i++) {
          expect(results[i - 1].dlqTs).toBeGreaterThanOrEqual(results[i].dlqTs);
        }
      });

      it('orders by specified field and direction', async () => {
        const asc = await adapter.query({ orderBy: 'attemptCount', orderDir: 'ASC' });
        expect(asc[0].attemptCount).toBe(2);
        expect(asc[2].attemptCount).toBe(5);

        const desc = await adapter.query({ orderBy: 'attemptCount', orderDir: 'DESC' });
        expect(desc[0].attemptCount).toBe(5);
        expect(desc[2].attemptCount).toBe(2);
      });
    });

    // =========================================================================
    // Acknowledgment Tests
    // =========================================================================

    describe('acknowledge', () => {
      it('acknowledges a dead letter', async () => {
        const dl = await adapter.add('msg-1', makeEnvelope(), 'connection_lost', 1);

        const success = await adapter.acknowledge(dl.id, 'admin');

        expect(success).toBe(true);

        const retrieved = await adapter.get(dl.id);
        expect(retrieved!.acknowledged).toBe(true);
        expect(retrieved!.acknowledgedBy).toBe('admin');
        expect(retrieved!.acknowledgedTs).toBeDefined();
      });

      it('returns false for already acknowledged', async () => {
        const dl = await adapter.add('msg-1', makeEnvelope(), 'connection_lost', 1);
        await adapter.acknowledge(dl.id);

        const success = await adapter.acknowledge(dl.id);
        expect(success).toBe(false);
      });

      it('returns false for non-existent ID', async () => {
        const success = await adapter.acknowledge('non-existent');
        expect(success).toBe(false);
      });
    });

    describe('acknowledgeMany', () => {
      it('acknowledges multiple dead letters', async () => {
        const dl1 = await adapter.add('msg-1', makeEnvelope(), 'connection_lost', 1);
        const dl2 = await adapter.add('msg-2', makeEnvelope(), 'ttl_expired', 2);
        const dl3 = await adapter.add('msg-3', makeEnvelope(), 'unknown', 3);

        const count = await adapter.acknowledgeMany([dl1.id, dl2.id], 'batch-ack');

        expect(count).toBe(2);

        const retrieved1 = await adapter.get(dl1.id);
        const retrieved3 = await adapter.get(dl3.id);

        expect(retrieved1!.acknowledged).toBe(true);
        expect(retrieved3!.acknowledged).toBe(false);
      });

      it('handles partial acknowledgment', async () => {
        const dl1 = await adapter.add('msg-1', makeEnvelope(), 'connection_lost', 1);
        await adapter.acknowledge(dl1.id); // Already acknowledged

        const dl2 = await adapter.add('msg-2', makeEnvelope(), 'ttl_expired', 2);

        const count = await adapter.acknowledgeMany([dl1.id, dl2.id, 'non-existent']);
        expect(count).toBe(1); // Only dl2 was newly acknowledged
      });
    });

    // =========================================================================
    // Retry Tests
    // =========================================================================

    describe('incrementRetry', () => {
      it('increments retry count', async () => {
        const dl = await adapter.add('msg-1', makeEnvelope(), 'connection_lost', 1);

        expect(dl.dlqRetryCount).toBe(0);

        await adapter.incrementRetry(dl.id);
        const after1 = await adapter.get(dl.id);
        expect(after1!.dlqRetryCount).toBe(1);

        await adapter.incrementRetry(dl.id);
        const after2 = await adapter.get(dl.id);
        expect(after2!.dlqRetryCount).toBe(2);
      });

      it('updates lastAttemptTs', async () => {
        const dl = await adapter.add('msg-1', makeEnvelope(), 'connection_lost', 1);
        const originalTs = dl.lastAttemptTs;

        await new Promise(r => setTimeout(r, 10));
        await adapter.incrementRetry(dl.id);

        const after = await adapter.get(dl.id);
        expect(after!.lastAttemptTs).toBeGreaterThan(originalTs!);
      });

      it('returns false for non-existent ID', async () => {
        const success = await adapter.incrementRetry('non-existent');
        expect(success).toBe(false);
      });
    });

    describe('getRetryable', () => {
      it('returns unacknowledged letters below retry threshold', async () => {
        const dl1 = await adapter.add('msg-1', makeEnvelope(), 'connection_lost', 1);
        const dl2 = await adapter.add('msg-2', makeEnvelope(), 'ttl_expired', 2);

        // Increment dl1 past threshold
        await adapter.incrementRetry(dl1.id);
        await adapter.incrementRetry(dl1.id);
        await adapter.incrementRetry(dl1.id);
        await adapter.incrementRetry(dl1.id);

        const retryable = await adapter.getRetryable(3, 10);

        expect(retryable.length).toBe(1);
        expect(retryable[0].id).toBe(dl2.id);
      });

      it('excludes acknowledged letters', async () => {
        const dl1 = await adapter.add('msg-1', makeEnvelope(), 'connection_lost', 1);
        await adapter.add('msg-2', makeEnvelope(), 'ttl_expired', 2);
        await adapter.acknowledge(dl1.id);

        const retryable = await adapter.getRetryable();
        expect(retryable.length).toBe(1);
      });

      it('respects limit', async () => {
        for (let i = 0; i < 5; i++) {
          await adapter.add(`msg-${i}`, makeEnvelope(), 'connection_lost', 1);
        }

        const retryable = await adapter.getRetryable(3, 2);
        expect(retryable.length).toBe(2);
      });
    });

    // =========================================================================
    // Remove Tests
    // =========================================================================

    describe('remove', () => {
      it('removes a dead letter', async () => {
        const dl = await adapter.add('msg-1', makeEnvelope(), 'connection_lost', 1);

        const success = await adapter.remove(dl.id);
        expect(success).toBe(true);

        const retrieved = await adapter.get(dl.id);
        expect(retrieved).toBeNull();
      });

      it('returns false for non-existent ID', async () => {
        const success = await adapter.remove('non-existent');
        expect(success).toBe(false);
      });
    });

    // =========================================================================
    // Stats Tests
    // =========================================================================

    describe('getStats', () => {
      it('returns correct statistics', async () => {
        await adapter.add('msg-1', makeEnvelope({ to: 'Bob' }), 'max_retries_exceeded', 5);
        await adapter.add('msg-2', makeEnvelope({ to: 'Bob' }), 'ttl_expired', 3);
        await adapter.add('msg-3', makeEnvelope({ to: 'Charlie' }), 'connection_lost', 2);

        const all = await adapter.query();
        await adapter.acknowledge(all[0].id);

        const stats = await adapter.getStats();

        expect(stats.totalEntries).toBe(3);
        expect(stats.unacknowledged).toBe(2);
        expect(stats.byReason.max_retries_exceeded).toBe(1);
        expect(stats.byReason.ttl_expired).toBe(1);
        expect(stats.byReason.connection_lost).toBe(1);
        expect(stats.byTarget.Bob).toBe(2);
        expect(stats.byTarget.Charlie).toBe(1);
        expect(stats.oldestEntryTs).toBeDefined();
        expect(stats.newestEntryTs).toBeDefined();
      });

      it('handles empty queue', async () => {
        const stats = await adapter.getStats();

        expect(stats.totalEntries).toBe(0);
        expect(stats.unacknowledged).toBe(0);
        expect(stats.oldestEntryTs).toBeNull();
        expect(stats.newestEntryTs).toBeNull();
      });
    });

    // =========================================================================
    // Cleanup Tests
    // =========================================================================

    describe('cleanup', () => {
      it('removes entries older than retention period', async () => {
        // Add entries
        await adapter.add('msg-1', makeEnvelope(), 'connection_lost', 1);
        await adapter.add('msg-2', makeEnvelope(), 'connection_lost', 1);

        const beforeCleanup = await adapter.query();
        expect(beforeCleanup.length).toBe(2);

        // Cleanup with very long retention (should not remove recent entries)
        const result = await adapter.cleanup(168, 10000); // 7 days retention
        // Recent entries should not be removed (they're not old enough)
        expect(result.removed).toBe(0);

        // Verify entries still exist
        const afterCleanup = await adapter.query();
        expect(afterCleanup.length).toBe(2);
      });

      it('enforces max entries', async () => {
        // Add many entries
        for (let i = 0; i < 10; i++) {
          const dl = await adapter.add(`msg-${i}`, makeEnvelope(), 'connection_lost', 1);
          await adapter.acknowledge(dl.id); // Acknowledged entries are removed first
        }

        const _result = await adapter.cleanup(168, 5);

        const remaining = await adapter.query();
        expect(remaining.length).toBeLessThanOrEqual(5);
      });
    });
  });
}

// =============================================================================
// Run Tests for Each Adapter
// =============================================================================

runAdapterTests('SQLiteDLQAdapter', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlq-test-'));
  const dbPath = path.join(tmpDir, 'dlq.sqlite');
  const db = new Database(dbPath);

  return {
    adapter: new SQLiteDLQAdapter(db),
    cleanup: async () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
});

runAdapterTests('InMemoryDLQAdapter', async () => {
  return {
    adapter: new InMemoryDLQAdapter(),
    cleanup: async () => {},
  };
});

// =============================================================================
// Factory Tests
// =============================================================================

describe('createDLQAdapter', () => {
  it('creates SQLite adapter', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlq-factory-'));
    const db = new Database(path.join(tmpDir, 'test.db'));

    const adapter = createDLQAdapter({ type: 'sqlite', sqlite: db });
    expect(adapter).toBeInstanceOf(SQLiteDLQAdapter);

    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates in-memory adapter', () => {
    const adapter = createDLQAdapter({ type: 'memory' });
    expect(adapter).toBeInstanceOf(InMemoryDLQAdapter);
  });

  it('throws for SQLite without database', () => {
    expect(() => createDLQAdapter({ type: 'sqlite' })).toThrow('SQLite database required');
  });

  it('throws for PostgreSQL without pool', () => {
    expect(() => createDLQAdapter({ type: 'postgres' })).toThrow('PostgreSQL pool required');
  });

  it('throws for unknown type', () => {
    expect(() => createDLQAdapter({ type: 'unknown' as never })).toThrow('Unknown DLQ adapter type');
  });
});
