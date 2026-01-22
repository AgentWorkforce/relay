/**
 * Optimized Cloud Sync Queue
 *
 * Handles batched, compressed, resilient message syncing to cloud.
 * Features:
 * - Adaptive batching (size/time/bytes triggers)
 * - Gzip compression for payloads over threshold
 * - Disk spillover for offline resilience
 * - Retry with exponential backoff
 * - Startup reconciliation
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { generateId } from '@agent-relay/wrapper';
import { createLogger } from '@agent-relay/utils/logger';
import type { StoredMessage } from '@agent-relay/storage/adapter';

const gzipAsync = promisify(gzip);
const log = createLogger('sync-queue');

export interface SyncQueueConfig {
  /** Cloud API URL */
  cloudUrl: string;
  /** API key for authentication */
  apiKey: string;

  // Batching
  /** Maximum messages per batch (default: 100) */
  batchSize: number;
  /** Maximum time to wait before flush in ms (default: 200) */
  batchDelayMs: number;
  /** Maximum bytes in memory before flush (default: 512KB) */
  maxBatchBytes: number;

  // Compression
  /** Compress payloads larger than this (default: 1KB) */
  compressionThreshold: number;

  // Resilience
  /** Directory for spill files (default: /tmp/agent-relay-sync) */
  spillDir: string;
  /** Maximum spill files to keep (default: 100) */
  maxSpillFiles: number;
  /** Maximum retry attempts (default: 3) */
  maxRetries: number;
  /** Base retry delay in ms (default: 1000) */
  retryDelayMs: number;

  // Logging
  /** Log sync operations (default: false) */
  verbose: boolean;
}

export const DEFAULT_SYNC_QUEUE_CONFIG: SyncQueueConfig = {
  cloudUrl: 'https://agent-relay.com',
  apiKey: '',

  batchSize: 100,
  batchDelayMs: 200,
  maxBatchBytes: 512 * 1024, // 512KB

  compressionThreshold: 1024, // 1KB

  spillDir: path.join(os.tmpdir(), 'agent-relay-sync'),
  maxSpillFiles: 100,
  maxRetries: 3,
  retryDelayMs: 1000,

  verbose: false,
};

interface QueuedMessage {
  message: StoredMessage;
  sizeBytes: number;
}

export interface SyncResult {
  synced: number;
  duplicates: number;
  failed: number;
  compressed: boolean;
  bytesTransferred: number;
}

export interface SyncQueueStats {
  queuedMessages: number;
  queuedBytes: number;
  totalSynced: number;
  totalFailed: number;
  totalCompressed: number;
  totalBytesTransferred: number;
  spilledFiles: number;
  lastSyncAt?: number;
  lastError?: string;
}

export class SyncQueue {
  private config: SyncQueueConfig;
  private queue: QueuedMessage[] = [];
  private queueBytes = 0;
  private flushTimer?: NodeJS.Timeout;
  private flushing = false;
  private flushPromise?: Promise<SyncResult>;

  // Stats
  private stats: SyncQueueStats = {
    queuedMessages: 0,
    queuedBytes: 0,
    totalSynced: 0,
    totalFailed: 0,
    totalCompressed: 0,
    totalBytesTransferred: 0,
    spilledFiles: 0,
  };

  constructor(config: Partial<SyncQueueConfig>) {
    this.config = { ...DEFAULT_SYNC_QUEUE_CONFIG, ...config };
  }

  /**
   * Queue a message for sync to cloud.
   * May trigger an immediate flush if thresholds are exceeded.
   */
  async enqueue(message: StoredMessage): Promise<void> {
    // Wait for any in-progress flush
    if (this.flushPromise) {
      await this.flushPromise;
    }

    const msgJson = JSON.stringify(message);
    const sizeBytes = Buffer.byteLength(msgJson, 'utf-8');

    this.queue.push({ message, sizeBytes });
    this.queueBytes += sizeBytes;
    this.stats.queuedMessages = this.queue.length;
    this.stats.queuedBytes = this.queueBytes;

    // Check flush triggers
    const shouldFlush =
      this.queue.length >= this.config.batchSize ||
      this.queueBytes >= this.config.maxBatchBytes;

    if (shouldFlush) {
      await this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flush().catch((err) => {
          log.error('Timer flush failed', { error: String(err) });
        });
      }, this.config.batchDelayMs);
    }
  }

  /**
   * Enqueue multiple messages at once.
   */
  async enqueueBatch(messages: StoredMessage[]): Promise<void> {
    for (const msg of messages) {
      await this.enqueue(msg);
    }
  }

  /**
   * Flush all queued messages to cloud.
   */
  async flush(): Promise<SyncResult> {
    // Clear timer
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    // Skip if empty or already flushing
    if (this.queue.length === 0 || this.flushing) {
      return { synced: 0, duplicates: 0, failed: 0, compressed: false, bytesTransferred: 0 };
    }

    this.flushing = true;

    // Take current batch
    const batch = this.queue;
    const batchBytes = this.queueBytes;
    this.queue = [];
    this.queueBytes = 0;
    this.stats.queuedMessages = 0;
    this.stats.queuedBytes = 0;

    this.flushPromise = this.syncBatch(batch, batchBytes);

    try {
      const result = await this.flushPromise;
      return result;
    } finally {
      this.flushing = false;
      this.flushPromise = undefined;
    }
  }

  /**
   * Sync a batch of messages to cloud with retry and spillover.
   */
  private async syncBatch(batch: QueuedMessage[], batchBytes: number): Promise<SyncResult> {
    const messages = batch.map((q) => q.message);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        const result = await this.sendToCloud(messages, batchBytes);
        this.stats.totalSynced += result.synced;
        this.stats.totalBytesTransferred += result.bytesTransferred;
        if (result.compressed) {
          this.stats.totalCompressed++;
        }
        this.stats.lastSyncAt = Date.now();
        return result;
      } catch (err) {
        lastError = err as Error;
        this.stats.lastError = lastError.message;

        if (attempt < this.config.maxRetries - 1) {
          // Exponential backoff
          const delay = this.config.retryDelayMs * Math.pow(2, attempt);
          if (this.config.verbose) {
            log.warn(`Sync attempt ${attempt + 1} failed, retrying in ${delay}ms`, {
              error: lastError.message,
            });
          }
          await this.sleep(delay);
        }
      }
    }

    // All retries failed - spill to disk
    log.error('Sync failed after retries, spilling to disk', {
      count: messages.length,
      error: lastError?.message,
    });

    await this.spillToDisk(messages);
    this.stats.totalFailed += messages.length;

    return {
      synced: 0,
      duplicates: 0,
      failed: messages.length,
      compressed: false,
      bytesTransferred: 0,
    };
  }

  /**
   * Send messages to cloud API with optional compression.
   */
  private async sendToCloud(messages: StoredMessage[], _estimatedBytes: number): Promise<SyncResult> {
    // Transform to API format
    const syncPayload = {
      messages: messages.map((msg) => ({
        id: msg.id,
        ts: msg.ts,
        from: msg.from,
        to: msg.to,
        body: msg.body,
        kind: msg.kind,
        topic: msg.topic,
        thread: msg.thread,
        is_broadcast: msg.is_broadcast,
        is_urgent: msg.is_urgent,
        data: msg.data,
        payload_meta: msg.payloadMeta,
      })),
    };

    const payloadJson = JSON.stringify(syncPayload);
    const payloadBytes = Buffer.byteLength(payloadJson, 'utf-8');

    // Determine if we should compress
    const shouldCompress = payloadBytes > this.config.compressionThreshold;
    let body: Buffer | string;
    let contentEncoding: string | undefined;

    if (shouldCompress) {
      body = await gzipAsync(Buffer.from(payloadJson));
      contentEncoding = 'gzip';

      if (this.config.verbose) {
        const ratio = ((1 - body.length / payloadBytes) * 100).toFixed(1);
        log.info(`Compressed ${payloadBytes} → ${body.length} bytes (${ratio}% reduction)`);
      }
    } else {
      body = payloadJson;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
    };

    if (contentEncoding) {
      headers['Content-Encoding'] = contentEncoding;
    }

    const response = await fetch(`${this.config.cloudUrl}/api/daemons/messages/sync`, {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Sync failed: ${response.status} - ${errorText}`);
    }

    const result = (await response.json()) as { synced: number; duplicates: number };

    return {
      synced: result.synced,
      duplicates: result.duplicates,
      failed: 0,
      compressed: shouldCompress,
      bytesTransferred: typeof body === 'string' ? Buffer.byteLength(body) : body.length,
    };
  }

  /**
   * Spill failed batch to disk for later recovery.
   */
  private async spillToDisk(messages: StoredMessage[]): Promise<void> {
    try {
      await fs.mkdir(this.config.spillDir, { recursive: true });

      const filename = `spill-${Date.now()}-${generateId().replace(/-/g, '')}.json`;
      const filepath = path.join(this.config.spillDir, filename);

      await fs.writeFile(filepath, JSON.stringify(messages));
      this.stats.spilledFiles++;

      if (this.config.verbose) {
        log.info(`Spilled ${messages.length} messages to ${filename}`);
      }

      // Cleanup old spill files
      await this.cleanupSpillFiles();
    } catch (err) {
      log.error('Failed to spill to disk', { error: String(err) });
    }
  }

  /**
   * Recover and sync messages from spill files.
   * Call this on startup to resume failed syncs.
   */
  async recoverSpilledMessages(): Promise<{ recovered: number; failed: number }> {
    let recovered = 0;
    let failed = 0;

    try {
      const files = await fs.readdir(this.config.spillDir);
      const spillFiles = files.filter((f) => f.startsWith('spill-')).sort();

      for (const file of spillFiles) {
        const filepath = path.join(this.config.spillDir, file);

        try {
          const content = await fs.readFile(filepath, 'utf-8');
          const messages = JSON.parse(content) as StoredMessage[];

          // Try to sync
          const result = await this.sendToCloud(
            messages,
            Buffer.byteLength(content, 'utf-8')
          );

          if (result.synced > 0 || result.duplicates > 0) {
            // Success - remove spill file
            await fs.unlink(filepath);
            recovered += messages.length;
            this.stats.spilledFiles = Math.max(0, this.stats.spilledFiles - 1);

            if (this.config.verbose) {
              log.info(`Recovered ${messages.length} messages from ${file}`);
            }
          } else {
            failed += messages.length;
          }
        } catch (err) {
          log.warn(`Failed to recover ${file}`, { error: String(err) });
          failed++;
        }
      }
    } catch (err) {
      // Directory doesn't exist or other error
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.error('Failed to scan spill directory', { error: String(err) });
      }
    }

    if (recovered > 0) {
      log.info(`Recovered ${recovered} messages from spill files`);
    }

    return { recovered, failed };
  }

  /**
   * Cleanup old spill files beyond the limit.
   */
  private async cleanupSpillFiles(): Promise<void> {
    try {
      const files = await fs.readdir(this.config.spillDir);
      const spillFiles = files.filter((f) => f.startsWith('spill-')).sort();

      if (spillFiles.length > this.config.maxSpillFiles) {
        const toDelete = spillFiles.slice(0, spillFiles.length - this.config.maxSpillFiles);

        for (const file of toDelete) {
          await fs.unlink(path.join(this.config.spillDir, file)).catch(() => {});
        }

        if (this.config.verbose) {
          log.info(`Cleaned up ${toDelete.length} old spill files`);
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Get sync queue statistics.
   */
  getStats(): SyncQueueStats {
    return { ...this.stats };
  }

  /**
   * Reset statistics (for testing or periodic reporting).
   */
  resetStats(): void {
    this.stats = {
      queuedMessages: this.queue.length,
      queuedBytes: this.queueBytes,
      totalSynced: 0,
      totalFailed: 0,
      totalCompressed: 0,
      totalBytesTransferred: 0,
      spilledFiles: this.stats.spilledFiles, // Preserve spill count
    };
  }

  /**
   * Gracefully close the queue, flushing any pending messages.
   */
  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    // Wait for any in-progress flush
    if (this.flushPromise) {
      await this.flushPromise;
    }

    // Flush remaining
    if (this.queue.length > 0) {
      await this.flush();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
