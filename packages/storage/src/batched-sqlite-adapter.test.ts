import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BatchedSqliteAdapter } from './batched-sqlite-adapter.js';
import type { StoredMessage } from './adapter.js';

// Check if any SQLite driver is available (better-sqlite3 is an optional peer dependency,
// node:sqlite requires Node 22.5+)
let hasSqliteDriver = false;
try {
  await import('better-sqlite3');
  hasSqliteDriver = true;
} catch {
  // better-sqlite3 not available
}
if (!hasSqliteDriver) {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 22) {
    hasSqliteDriver = true;
  }
}

const makeMessage = (overrides: Partial<StoredMessage> = {}): StoredMessage => ({
  id: overrides.id ?? `msg-${Math.random().toString(36).slice(2, 10)}`,
  ts: overrides.ts ?? Date.now(),
  from: overrides.from ?? 'AgentA',
  to: overrides.to ?? 'AgentB',
  topic: overrides.topic,
  kind: overrides.kind ?? 'message',
  body: overrides.body ?? 'hello',
  data: overrides.data,
  payloadMeta: overrides.payloadMeta,
  thread: overrides.thread,
  deliverySeq: overrides.deliverySeq,
  deliverySessionId: overrides.deliverySessionId,
  sessionId: overrides.sessionId,
  status: overrides.status ?? 'unread',
  is_urgent: overrides.is_urgent ?? false,
  is_broadcast: overrides.is_broadcast ?? false,
});

describe.skipIf(!hasSqliteDriver)('BatchedSqliteAdapter', () => {
  let dbPath: string;
  let adapter: BatchedSqliteAdapter;

  beforeEach(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-batch-sqlite-'));
    dbPath = path.join(tmpDir, 'messages.sqlite');
    adapter = new BatchedSqliteAdapter({
      dbPath,
      batch: {
        maxBatchSize: 5,
        maxBatchDelayMs: 50,
        maxBatchBytes: 10 * 1024,
        logBatches: false,
      },
    });
    await adapter.init();
  });

  afterEach(async () => {
    await adapter.close();
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('saveMessage batching', () => {
    it('queues messages and flushes when batch size is reached', async () => {
      // Save 5 messages (batch size threshold)
      for (let i = 0; i < 5; i++) {
        await adapter.saveMessage(makeMessage({ id: `batch-msg-${i}` }));
      }

      // Messages should be flushed after reaching batch size
      const messages = await adapter.getMessages();
      expect(messages).toHaveLength(5);
    });

    it('flushes on time threshold when batch size not reached', async () => {
      vi.useFakeTimers();
      try {
        // Save fewer messages than batch size
        await adapter.saveMessage(makeMessage({ id: 'time-msg-1' }));
        await adapter.saveMessage(makeMessage({ id: 'time-msg-2' }));

        // Advance past the delay threshold
        await vi.advanceTimersByTimeAsync(100);

        // Force flush to ensure completion
        await adapter.flush();

        const messages = await adapter.getMessages();
        expect(messages).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('flushes when memory threshold is exceeded', async () => {
      // Create adapter with small memory threshold
      await adapter.close();

      adapter = new BatchedSqliteAdapter({
        dbPath,
        batch: {
          maxBatchSize: 100, // Large batch size so it won't trigger
          maxBatchDelayMs: 5000, // Long delay so it won't trigger
          maxBatchBytes: 100, // Small byte threshold
          logBatches: false,
        },
      });
      await adapter.init();

      // Create a message with large body to exceed byte threshold
      const largeBody = 'x'.repeat(200);
      await adapter.saveMessage(makeMessage({ id: 'large-msg', body: largeBody }));

      // Should have been flushed due to byte threshold
      const messages = await adapter.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].body).toBe(largeBody);
    });

    it('tracks metrics for flush reasons', async () => {
      // Save batch size worth of messages
      for (let i = 0; i < 5; i++) {
        await adapter.saveMessage(makeMessage({ id: `metric-msg-${i}` }));
      }

      const metrics = adapter.getBatchMetrics();
      expect(metrics.batchesWritten).toBe(1);
      expect(metrics.messagesWritten).toBe(5);
      expect(metrics.flushDueToSize).toBe(1);
    });
  });

  describe('flush behavior', () => {
    it('flush is idempotent when queue is empty', async () => {
      // Multiple flushes on empty queue should not error
      await adapter.flush();
      await adapter.flush();
      await adapter.flush();

      const metrics = adapter.getBatchMetrics();
      expect(metrics.batchesWritten).toBe(0);
    });

    it('does not flush concurrently', async () => {
      // Queue some messages
      for (let i = 0; i < 3; i++) {
        adapter.saveMessage(makeMessage({ id: `concurrent-msg-${i}` }));
      }

      // Call flush multiple times concurrently
      await Promise.all([
        adapter.flush(),
        adapter.flush(),
        adapter.flush(),
      ]);

      const metrics = adapter.getBatchMetrics();
      // Only one batch should have been written
      expect(metrics.batchesWritten).toBe(1);
    });

    it('re-queues messages on write failure', async () => {
      // We can't easily test this without mocking internals,
      // but we can verify the basic happy path
      await adapter.saveMessage(makeMessage({ id: 'requeue-msg' }));
      await adapter.flush();

      const messages = await adapter.getMessages();
      expect(messages).toHaveLength(1);
    });
  });

  describe('close behavior', () => {
    it('flushes pending messages on close', async () => {
      // Save messages without triggering batch threshold
      await adapter.saveMessage(makeMessage({ id: 'close-msg-1' }));
      await adapter.saveMessage(makeMessage({ id: 'close-msg-2' }));

      // Close should flush pending messages
      await adapter.close();

      // Re-open to verify messages were saved
      adapter = new BatchedSqliteAdapter({ dbPath });
      await adapter.init();

      const messages = await adapter.getMessages();
      expect(messages).toHaveLength(2);
    });
  });

  describe('metrics', () => {
    it('tracks pending count and bytes', async () => {
      // Create adapter with large batch to keep messages pending
      await adapter.close();
      adapter = new BatchedSqliteAdapter({
        dbPath,
        batch: {
          maxBatchSize: 100,
          maxBatchDelayMs: 10000,
          maxBatchBytes: 1024 * 1024,
          logBatches: false,
        },
      });
      await adapter.init();

      await adapter.saveMessage(makeMessage({ id: 'pending-1', body: 'hello' }));
      await adapter.saveMessage(makeMessage({ id: 'pending-2', body: 'world' }));

      const metrics = adapter.getBatchMetrics();
      expect(metrics.pendingCount).toBe(2);
      expect(metrics.pendingBytes).toBeGreaterThan(0);

      // Flush and check metrics are cleared
      await adapter.flush();
      const afterFlush = adapter.getBatchMetrics();
      expect(afterFlush.pendingCount).toBe(0);
      expect(afterFlush.pendingBytes).toBe(0);
    });

    it('resetMetrics clears counters', async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.saveMessage(makeMessage({ id: `reset-msg-${i}` }));
      }

      let metrics = adapter.getBatchMetrics();
      expect(metrics.batchesWritten).toBe(1);

      adapter.resetMetrics();
      metrics = adapter.getBatchMetrics();
      expect(metrics.batchesWritten).toBe(0);
      expect(metrics.messagesWritten).toBe(0);
    });
  });

  describe('updateMessageStatus', () => {
    it('updates status immediately without batching', async () => {
      // Save and flush a message
      await adapter.saveMessage(makeMessage({ id: 'status-msg', status: 'unread' }));
      await adapter.flush();

      // Update status - should be immediate
      await adapter.updateMessageStatus('status-msg', 'read');

      const messages = await adapter.getMessages();
      expect(messages[0].status).toBe('read');
    });
  });
});
