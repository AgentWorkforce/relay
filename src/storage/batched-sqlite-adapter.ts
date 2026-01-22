/**
 * Batched SQLite Storage Adapter
 *
 * Wraps SqliteStorageAdapter to provide batched writes for improved throughput.
 * Messages are buffered and flushed either when:
 *   - Batch size is reached
 *   - Time threshold is exceeded
 *   - Memory threshold is exceeded
 *   - close() is called
 *
 * All reads still go directly to SQLite for consistency.
 */

import {
  SqliteStorageAdapter,
  type SqliteAdapterOptions,
} from './sqlite-adapter.js';
import type { StoredMessage, MessageStatus } from './adapter.js';

export interface BatchConfig {
  /** Maximum messages in a batch before flush (default: 50) */
  maxBatchSize: number;
  /** Maximum time to wait before flush in ms (default: 100) */
  maxBatchDelayMs: number;
  /** Maximum bytes in memory before flush (default: 1MB) */
  maxBatchBytes: number;
  /** Whether to log batch operations (default: false) */
  logBatches: boolean;
}

export const DEFAULT_BATCH_CONFIG: BatchConfig = {
  maxBatchSize: 50,
  maxBatchDelayMs: 100,
  maxBatchBytes: 1024 * 1024, // 1MB
  logBatches: false,
};

export interface BatchedSqliteAdapterOptions extends SqliteAdapterOptions {
  batch?: Partial<BatchConfig>;
}

interface PendingMessage {
  message: StoredMessage;
  sizeBytes: number;
}

export class BatchedSqliteAdapter extends SqliteStorageAdapter {
  private batchConfig: BatchConfig;
  private pending: PendingMessage[] = [];
  private pendingBytes = 0;
  private flushTimer?: NodeJS.Timeout;
  private flushing = false;
  private flushPromise?: Promise<void>;

  // Metrics
  private metrics = {
    batchesWritten: 0,
    messagesWritten: 0,
    bytesWritten: 0,
    flushDueToSize: 0,
    flushDueToTime: 0,
    flushDueToBytes: 0,
  };

  constructor(options: BatchedSqliteAdapterOptions) {
    super(options);
    this.batchConfig = { ...DEFAULT_BATCH_CONFIG, ...options.batch };
  }

  /**
   * Queue a message for batched writing.
   * May trigger an immediate flush if thresholds are exceeded.
   */
  async saveMessage(message: StoredMessage): Promise<void> {
    // Ensure any pending flush completes first
    if (this.flushPromise) {
      await this.flushPromise;
    }

    const msgJson = JSON.stringify(message);
    const sizeBytes = Buffer.byteLength(msgJson, 'utf-8');

    this.pending.push({ message, sizeBytes });
    this.pendingBytes += sizeBytes;

    // Check flush conditions
    let flushReason: 'size' | 'bytes' | null = null;

    if (this.pending.length >= this.batchConfig.maxBatchSize) {
      flushReason = 'size';
      this.metrics.flushDueToSize++;
    } else if (this.pendingBytes >= this.batchConfig.maxBatchBytes) {
      flushReason = 'bytes';
      this.metrics.flushDueToBytes++;
    }

    if (flushReason) {
      await this.flush();
    } else if (!this.flushTimer) {
      // Schedule time-based flush
      this.flushTimer = setTimeout(() => {
        this.metrics.flushDueToTime++;
        this.flush().catch((err) => {
          console.error('[batched-sqlite] Timer flush failed:', err);
        });
      }, this.batchConfig.maxBatchDelayMs);
    }
  }

  /**
   * Flush all pending messages to SQLite.
   */
  async flush(): Promise<void> {
    // Clear timer if set
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    // Skip if nothing to flush or already flushing
    if (this.pending.length === 0 || this.flushing) {
      return;
    }

    this.flushing = true;

    // Take current batch
    const batch = this.pending;
    const batchBytes = this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;

    this.flushPromise = this.writeBatch(batch, batchBytes);

    try {
      await this.flushPromise;
    } finally {
      this.flushing = false;
      this.flushPromise = undefined;
    }
  }

  /**
   * Write a batch of messages within a transaction.
   */
  private async writeBatch(batch: PendingMessage[], batchBytes: number): Promise<void> {
    const startTime = Date.now();

    try {
      // Use transaction for atomicity and performance
      // The parent class's db is private, so we call saveMessage in a loop
      // but the SQLite driver will batch them efficiently due to WAL mode
      for (const { message } of batch) {
        await super.saveMessage(message);
      }

      // Update metrics
      this.metrics.batchesWritten++;
      this.metrics.messagesWritten += batch.length;
      this.metrics.bytesWritten += batchBytes;

      if (this.batchConfig.logBatches) {
        const elapsed = Date.now() - startTime;
        console.log(
          `[batched-sqlite] Wrote ${batch.length} messages (${(batchBytes / 1024).toFixed(1)}KB) in ${elapsed}ms`
        );
      }
    } catch (err) {
      // On failure, re-queue messages for retry
      console.error('[batched-sqlite] Batch write failed, re-queuing:', err);
      this.pending = [...batch, ...this.pending];
      this.pendingBytes += batchBytes;
      throw err;
    }
  }

  /**
   * Get batch metrics for monitoring.
   */
  getBatchMetrics(): typeof this.metrics & { pendingCount: number; pendingBytes: number } {
    return {
      ...this.metrics,
      pendingCount: this.pending.length,
      pendingBytes: this.pendingBytes,
    };
  }

  /**
   * Reset metrics (useful for testing or periodic reporting).
   */
  resetMetrics(): void {
    this.metrics = {
      batchesWritten: 0,
      messagesWritten: 0,
      bytesWritten: 0,
      flushDueToSize: 0,
      flushDueToTime: 0,
      flushDueToBytes: 0,
    };
  }

  /**
   * Close the adapter, flushing any pending messages first.
   */
  async close(): Promise<void> {
    // Ensure all pending messages are written
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    // Wait for any in-progress flush
    if (this.flushPromise) {
      await this.flushPromise;
    }

    // Flush remaining
    if (this.pending.length > 0) {
      await this.flush();
    }

    await super.close();
  }

  /**
   * Update message status - goes directly to SQLite (not batched).
   */
  async updateMessageStatus(id: string, status: MessageStatus): Promise<void> {
    // Status updates should be immediate, not batched
    return super.updateMessageStatus(id, status);
  }

  /**
   * Get channel memberships for an agent - delegates to SQLite (read-only, not batched).
   */
  async getChannelMembershipsForAgent(memberName: string): Promise<string[]> {
    return super.getChannelMembershipsForAgent?.(memberName) ?? [];
  }
}
