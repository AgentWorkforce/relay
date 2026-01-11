import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SyncQueue } from './sync-queue.js';
import type { StoredMessage } from '../storage/adapter.js';

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
  status: overrides.status ?? 'unread',
  is_urgent: overrides.is_urgent ?? false,
  is_broadcast: overrides.is_broadcast ?? false,
});

describe('SyncQueue', () => {
  let spillDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    spillDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-queue-test-'));

    // Mock fetch
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ synced: 1, duplicates: 0 }),
    });
    global.fetch = fetchMock as typeof fetch;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await fs.rm(spillDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('enqueue behavior', () => {
    it('queues messages and flushes when batch size is reached', async () => {
      const queue = new SyncQueue({
        cloudUrl: 'https://test.example.com',
        apiKey: 'test-key',
        batchSize: 3,
        batchDelayMs: 5000,
        spillDir,
        verbose: false,
      });

      // Enqueue exactly batch size
      await queue.enqueue(makeMessage({ id: 'msg-1' }));
      await queue.enqueue(makeMessage({ id: 'msg-2' }));
      await queue.enqueue(makeMessage({ id: 'msg-3' }));

      // Should have triggered a flush
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const stats = queue.getStats();
      expect(stats.totalSynced).toBe(1);

      await queue.close();
    });

    it('flushes on time threshold', async () => {
      vi.useFakeTimers();
      try {
        const queue = new SyncQueue({
          cloudUrl: 'https://test.example.com',
          apiKey: 'test-key',
          batchSize: 100,
          batchDelayMs: 50,
          spillDir,
          verbose: false,
        });

        await queue.enqueue(makeMessage({ id: 'time-msg' }));

        // Advance past delay threshold
        await vi.advanceTimersByTimeAsync(100);

        expect(fetchMock).toHaveBeenCalledTimes(1);

        await queue.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it('flushes when byte threshold is exceeded', async () => {
      const queue = new SyncQueue({
        cloudUrl: 'https://test.example.com',
        apiKey: 'test-key',
        batchSize: 1000,
        batchDelayMs: 10000,
        maxBatchBytes: 100, // Small threshold
        spillDir,
        verbose: false,
      });

      // Create message with large body
      const largeBody = 'x'.repeat(200);
      await queue.enqueue(makeMessage({ id: 'large-msg', body: largeBody }));

      // Should have triggered flush due to byte threshold
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await queue.close();
    });
  });

  describe('compression', () => {
    it('compresses payloads above threshold', async () => {
      const queue = new SyncQueue({
        cloudUrl: 'https://test.example.com',
        apiKey: 'test-key',
        batchSize: 1,
        compressionThreshold: 50, // Low threshold
        spillDir,
        verbose: false,
      });

      // Large message body to trigger compression
      const largeBody = 'x'.repeat(1000);
      await queue.enqueue(makeMessage({ id: 'compress-msg', body: largeBody }));

      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Check that Content-Encoding was set
      const [, options] = fetchMock.mock.calls[0];
      expect(options.headers['Content-Encoding']).toBe('gzip');

      // Body should be a Buffer (compressed)
      expect(Buffer.isBuffer(options.body)).toBe(true);

      const stats = queue.getStats();
      expect(stats.totalCompressed).toBe(1);

      await queue.close();
    });

    it('does not compress small payloads', async () => {
      const queue = new SyncQueue({
        cloudUrl: 'https://test.example.com',
        apiKey: 'test-key',
        batchSize: 1,
        compressionThreshold: 10000, // High threshold
        spillDir,
        verbose: false,
      });

      await queue.enqueue(makeMessage({ id: 'small-msg', body: 'hi' }));

      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [, options] = fetchMock.mock.calls[0];
      expect(options.headers['Content-Encoding']).toBeUndefined();

      // Body should be a string (uncompressed JSON)
      expect(typeof options.body).toBe('string');

      await queue.close();
    });
  });

  describe('disk spillover', () => {
    it('spills to disk on sync failure after retries', async () => {
      fetchMock.mockRejectedValue(new Error('Network error'));

      const queue = new SyncQueue({
        cloudUrl: 'https://test.example.com',
        apiKey: 'test-key',
        batchSize: 1,
        maxRetries: 2,
        retryDelayMs: 10,
        spillDir,
        verbose: false,
      });

      await queue.enqueue(makeMessage({ id: 'fail-msg' }));

      // Should have retried
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Check spill file was created
      const files = await fs.readdir(spillDir);
      const spillFiles = files.filter((f) => f.startsWith('spill-'));
      expect(spillFiles).toHaveLength(1);

      const stats = queue.getStats();
      expect(stats.totalFailed).toBe(1);
      expect(stats.spilledFiles).toBe(1);

      await queue.close();
    });

    it('uses UUID for spill file names to avoid collisions', async () => {
      fetchMock.mockRejectedValue(new Error('Network error'));

      const queue = new SyncQueue({
        cloudUrl: 'https://test.example.com',
        apiKey: 'test-key',
        batchSize: 1,
        maxRetries: 1,
        retryDelayMs: 1,
        spillDir,
        verbose: false,
      });

      // Create multiple spill files
      await queue.enqueue(makeMessage({ id: 'fail-1' }));
      await queue.enqueue(makeMessage({ id: 'fail-2' }));

      const files = await fs.readdir(spillDir);
      const spillFiles = files.filter((f) => f.startsWith('spill-'));
      expect(spillFiles).toHaveLength(2);

      // Verify filenames are unique
      expect(new Set(spillFiles).size).toBe(2);

      // Verify filename format includes ID segment
      for (const file of spillFiles) {
        // Format: spill-{timestamp}-{id}.json (ID is alphanumeric base36)
        expect(file).toMatch(/^spill-\d+-[a-z0-9]+\.json$/);
      }

      await queue.close();
    });

    it('cleans up old spill files beyond limit', async () => {
      fetchMock.mockRejectedValue(new Error('Network error'));

      const queue = new SyncQueue({
        cloudUrl: 'https://test.example.com',
        apiKey: 'test-key',
        batchSize: 1,
        maxRetries: 1,
        retryDelayMs: 1,
        maxSpillFiles: 2,
        spillDir,
        verbose: false,
      });

      // Create more spill files than limit
      for (let i = 0; i < 4; i++) {
        await queue.enqueue(makeMessage({ id: `overflow-${i}` }));
        // Small delay for different timestamps
        await new Promise((r) => setTimeout(r, 10));
      }

      const files = await fs.readdir(spillDir);
      const spillFiles = files.filter((f) => f.startsWith('spill-'));

      // Should have cleaned up to maxSpillFiles
      expect(spillFiles.length).toBeLessThanOrEqual(2);

      await queue.close();
    });
  });

  describe('recovery', () => {
    it('recovers spilled messages on startup', async () => {
      // Create a spill file manually
      const messages = [
        makeMessage({ id: 'recover-1' }),
        makeMessage({ id: 'recover-2' }),
      ];
      const spillFile = path.join(spillDir, 'spill-0001-testfile.json');
      await fs.writeFile(spillFile, JSON.stringify(messages));

      const queue = new SyncQueue({
        cloudUrl: 'https://test.example.com',
        apiKey: 'test-key',
        spillDir,
        verbose: false,
      });

      const result = await queue.recoverSpilledMessages();

      expect(result.recovered).toBe(2);
      expect(result.failed).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Spill file should be deleted after recovery
      const files = await fs.readdir(spillDir);
      expect(files.filter((f) => f.startsWith('spill-'))).toHaveLength(0);

      await queue.close();
    });

    it('handles recovery failure gracefully', async () => {
      // Create a spill file
      const messages = [makeMessage({ id: 'fail-recover' })];
      const spillFile = path.join(spillDir, 'spill-0001-failtest.json');
      await fs.writeFile(spillFile, JSON.stringify(messages));

      fetchMock.mockRejectedValue(new Error('Recovery failed'));

      const queue = new SyncQueue({
        cloudUrl: 'https://test.example.com',
        apiKey: 'test-key',
        spillDir,
        verbose: false,
      });

      const result = await queue.recoverSpilledMessages();

      expect(result.recovered).toBe(0);
      expect(result.failed).toBeGreaterThan(0);

      // Spill file should still exist
      const files = await fs.readdir(spillDir);
      expect(files.filter((f) => f.startsWith('spill-'))).toHaveLength(1);

      await queue.close();
    });
  });

  describe('stats', () => {
    it('tracks queue statistics', async () => {
      const queue = new SyncQueue({
        cloudUrl: 'https://test.example.com',
        apiKey: 'test-key',
        batchSize: 2,
        spillDir,
        verbose: false,
      });

      await queue.enqueue(makeMessage({ id: 'stat-1' }));
      await queue.enqueue(makeMessage({ id: 'stat-2' }));

      const stats = queue.getStats();
      expect(stats.totalSynced).toBe(1); // Batch of 2 messages
      expect(stats.totalBytesTransferred).toBeGreaterThan(0);
      expect(stats.lastSyncAt).toBeDefined();

      await queue.close();
    });

    it('resets statistics', async () => {
      const queue = new SyncQueue({
        cloudUrl: 'https://test.example.com',
        apiKey: 'test-key',
        batchSize: 1,
        spillDir,
        verbose: false,
      });

      await queue.enqueue(makeMessage({ id: 'reset-msg' }));

      queue.resetStats();
      const stats = queue.getStats();

      expect(stats.totalSynced).toBe(0);
      expect(stats.totalBytesTransferred).toBe(0);

      await queue.close();
    });
  });

  describe('close behavior', () => {
    it('flushes pending messages on close', async () => {
      const queue = new SyncQueue({
        cloudUrl: 'https://test.example.com',
        apiKey: 'test-key',
        batchSize: 100, // Large batch so it won't trigger
        batchDelayMs: 10000, // Long delay
        spillDir,
        verbose: false,
      });

      await queue.enqueue(makeMessage({ id: 'close-msg' }));

      // Stats should show message queued but not synced yet
      const stats = queue.getStats();
      expect(stats.queuedMessages).toBe(1);
      expect(stats.totalSynced).toBe(0);

      // Close should flush
      await queue.close();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
