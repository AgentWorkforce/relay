/**
 * Relay Ledger - SQLite-based tracking of relay file processing
 *
 * Tracks files discovered in agent outboxes through their lifecycle:
 * pending -> processing -> delivered/failed -> archived
 *
 * Features:
 * - Atomic claims with status WHERE clause
 * - Crash recovery (reset processing -> pending on startup)
 * - Archive path tracking for auditing
 * - Configurable retention
 * - Schema migrations for version upgrades
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { runMigrations, getPendingMigrations, verifyMigrations, type MigrationResult } from './migrations/index.js';

// ============================================================================
// Types
// ============================================================================

export type RelayFileStatus = 'pending' | 'processing' | 'delivered' | 'failed' | 'archived';

export interface RelayFileRecord {
  id: number;
  fileId: string;
  /** Canonical/resolved path (symlinks resolved via realpath) */
  sourcePath: string;
  /** Original path that may have been a symlink (for debugging) */
  symlinkPath: string | null;
  archivePath: string | null;
  agentName: string;
  messageType: string;
  status: RelayFileStatus;
  retries: number;
  maxRetries: number;
  discoveredAt: number;
  processedAt: number | null;
  archivedAt: number | null;
  error: string | null;
  contentHash: string | null;
  fileSize: number;
  /** File modification time in nanoseconds (for change detection) */
  fileMtimeNs: number | null;
  /** File inode number (for change detection on Unix) */
  fileInode: number | null;
}

export interface LedgerAgentRecord {
  id: number;
  agentName: string;
  createdAt: number;
  lastSeenAt: number;
  status: 'active' | 'inactive';
  metadata: Record<string, unknown> | null;
}

export interface OrchestratorState {
  key: string;
  value: string;
  updatedAt: number;
}

export interface PendingOperation {
  id: number;
  operationType: 'process' | 'archive' | 'cleanup';
  targetId: string;
  payload: string | null;
  createdAt: number;
  attempts: number;
  lastAttemptAt: number | null;
  error: string | null;
}

export interface LedgerConfig {
  /** Path to SQLite database */
  dbPath: string;
  /** Maximum retries before marking as failed (default: 3) */
  maxRetries?: number;
  /** Archive retention in milliseconds (default: 7 days) */
  archiveRetentionMs?: number;
  /** Busy timeout for concurrent access (default: 5000ms) */
  busyTimeout?: number;
}

export interface ClaimResult {
  success: boolean;
  record?: RelayFileRecord;
  reason?: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_ARCHIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_BUSY_TIMEOUT = 5000;

// Reserved agent names for special routing
const RESERVED_AGENT_NAMES = new Set(['Lead', 'System', 'Broadcast', '*']);

// ============================================================================
// RelayLedger Class
// ============================================================================

export class RelayLedger {
  private db: Database.Database;
  private config: Required<LedgerConfig>;

  // Prepared statements for performance
  private stmtInsert!: Database.Statement;
  private stmtClaim!: Database.Statement;
  private stmtUpdateStatus!: Database.Statement;
  private stmtMarkDelivered!: Database.Statement;
  private stmtMarkFailed!: Database.Statement;
  private stmtMarkArchived!: Database.Statement;
  private stmtGetPending!: Database.Statement;
  private stmtGetByPath!: Database.Statement;
  private stmtIsActivePath!: Database.Statement;
  private stmtGetById!: Database.Statement;
  private stmtResetProcessing!: Database.Statement;
  private stmtCleanupArchived!: Database.Statement;
  private stmtGetStats!: Database.Statement;

  constructor(config: LedgerConfig) {
    this.config = {
      dbPath: config.dbPath,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
      archiveRetentionMs: config.archiveRetentionMs ?? DEFAULT_ARCHIVE_RETENTION_MS,
      busyTimeout: config.busyTimeout ?? DEFAULT_BUSY_TIMEOUT,
    };

    // Ensure directory exists
    const dbDir = path.dirname(this.config.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Open database with recommended settings
    this.db = new Database(this.config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma(`busy_timeout = ${this.config.busyTimeout}`);
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    this.initSchema();
    this.prepareStatements();
  }

  /** Last migration result (for debugging) */
  private lastMigrationResult?: MigrationResult;

  /**
   * Initialize database schema using migrations
   */
  private initSchema(): void {
    // Run migrations (creates tables if they don't exist, or upgrades existing schema)
    this.lastMigrationResult = runMigrations(this.db);

    // Log migration results for debugging
    if (this.lastMigrationResult.applied.length > 0) {
      console.log(`[relay-ledger] Applied migrations: ${this.lastMigrationResult.applied.join(', ')}`);
    }
    if (this.lastMigrationResult.errors.length > 0) {
      console.error(`[relay-ledger] Migration errors:`, this.lastMigrationResult.errors);
    }
  }

  /**
   * Get the last migration result
   */
  getMigrationResult(): MigrationResult | undefined {
    return this.lastMigrationResult;
  }

  /**
   * Get pending migrations that haven't been applied
   */
  getPendingMigrations(): Array<{ name: string; sql: string; checksum: string }> {
    return getPendingMigrations(this.db);
  }

  /**
   * Verify migration checksums match what was originally applied
   */
  verifyMigrationIntegrity(): Array<{ name: string; expected: string; actual: string }> {
    return verifyMigrations(this.db);
  }

  /**
   * Prepare frequently-used statements
   */
  private prepareStatements(): void {
    this.stmtInsert = this.db.prepare(`
      INSERT INTO relay_files (file_id, source_path, symlink_path, agent_name, message_type, discovered_at, file_size, content_hash, file_mtime_ns, file_inode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_id) DO NOTHING
    `);

    this.stmtClaim = this.db.prepare(`
      UPDATE relay_files
      SET status = 'processing', retries = retries + 1
      WHERE file_id = ? AND status = 'pending' AND retries < max_retries
      RETURNING *
    `);

    this.stmtUpdateStatus = this.db.prepare(`
      UPDATE relay_files SET status = ? WHERE file_id = ?
    `);

    this.stmtMarkDelivered = this.db.prepare(`
      UPDATE relay_files
      SET status = 'delivered', processed_at = ?
      WHERE file_id = ?
    `);

    this.stmtMarkFailed = this.db.prepare(`
      UPDATE relay_files
      SET status = 'failed', processed_at = ?, error = ?
      WHERE file_id = ?
    `);

    this.stmtMarkArchived = this.db.prepare(`
      UPDATE relay_files
      SET status = 'archived', archive_path = ?, archived_at = ?
      WHERE file_id = ?
    `);

    this.stmtGetPending = this.db.prepare(`
      SELECT * FROM relay_files
      WHERE status = 'pending' AND retries < max_retries
      ORDER BY id ASC
      LIMIT ?
    `);

    this.stmtGetByPath = this.db.prepare(`
      SELECT * FROM relay_files WHERE source_path = ?
    `);

    // Only check for pending/processing files (not archived/delivered/failed)
    this.stmtIsActivePath = this.db.prepare(`
      SELECT 1 FROM relay_files WHERE source_path = ? AND status IN ('pending', 'processing')
    `);

    this.stmtGetById = this.db.prepare(`
      SELECT * FROM relay_files WHERE file_id = ?
    `);

    this.stmtResetProcessing = this.db.prepare(`
      UPDATE relay_files
      SET status = 'pending'
      WHERE status = 'processing'
    `);

    this.stmtCleanupArchived = this.db.prepare(`
      DELETE FROM relay_files
      WHERE status = 'archived' AND archived_at < ?
    `);

    this.stmtGetStats = this.db.prepare(`
      SELECT status, COUNT(*) as count FROM relay_files GROUP BY status
    `);
  }

  /**
   * Generate a unique file ID (12-char hex for ~281 trillion combinations)
   */
  generateFileId(): string {
    return crypto.randomBytes(6).toString('hex');
  }

  /**
   * Check if an agent name is reserved
   */
  isReservedAgentName(name: string): boolean {
    return RESERVED_AGENT_NAMES.has(name);
  }

  /**
   * Register a newly discovered file
   * @param sourcePath - Canonical path (symlinks resolved)
   * @param agentName - Agent that owns the file
   * @param messageType - Type of message (msg, spawn, release, etc.)
   * @param fileSize - Size in bytes
   * @param contentHash - Optional hash for deduplication
   * @param fileMtimeNs - Optional modification time in nanoseconds
   * @param fileInode - Optional inode number
   * @param symlinkPath - Original path if it was a symlink (for debugging)
   */
  registerFile(
    sourcePath: string,
    agentName: string,
    messageType: string,
    fileSize: number,
    contentHash?: string,
    fileMtimeNs?: number,
    fileInode?: number,
    symlinkPath?: string
  ): string {
    const fileId = this.generateFileId();
    const now = Date.now();

    this.stmtInsert.run(
      fileId,
      sourcePath,
      symlinkPath ?? null,
      agentName,
      messageType,
      now,
      fileSize,
      contentHash ?? null,
      fileMtimeNs ?? null,
      fileInode ?? null
    );
    return fileId;
  }

  /**
   * Check if a file is actively being processed (pending or processing).
   * Returns false for archived/delivered/failed files so new files at the same path can be registered.
   */
  isFileRegistered(sourcePath: string): boolean {
    const row = this.stmtIsActivePath.get(sourcePath);
    return row !== undefined;
  }

  /**
   * Atomically claim a file for processing
   * Returns the record if claim succeeded, null otherwise
   */
  claimFile(fileId: string): ClaimResult {
    const row = this.stmtClaim.get(fileId) as any;

    if (!row) {
      // Check why claim failed
      const existing = this.stmtGetById.get(fileId) as any;
      if (!existing) {
        return { success: false, reason: 'File not found' };
      }
      if (existing.status !== 'pending') {
        return { success: false, reason: `File status is ${existing.status}, not pending` };
      }
      if (existing.retries >= existing.max_retries) {
        return { success: false, reason: `Max retries (${existing.max_retries}) exceeded` };
      }
      return { success: false, reason: 'Unknown claim failure' };
    }

    return {
      success: true,
      record: this.rowToRecord(row),
    };
  }

  /**
   * Mark a file as successfully delivered
   */
  markDelivered(fileId: string): void {
    this.stmtMarkDelivered.run(Date.now(), fileId);
  }

  /**
   * Mark a file as failed (will retry if under max retries)
   */
  markFailed(fileId: string, error: string): void {
    const record = this.getById(fileId);
    if (!record) return;

    if (record.retries >= record.maxRetries) {
      // Permanent failure
      this.stmtMarkFailed.run(Date.now(), error, fileId);
    } else {
      // Reset to pending for retry
      this.stmtUpdateStatus.run('pending', fileId);
    }
  }

  /**
   * Mark a file as archived (moved to archive location)
   */
  markArchived(fileId: string, archivePath: string): void {
    this.stmtMarkArchived.run(archivePath, Date.now(), fileId);
  }

  /**
   * Get pending files ready for processing
   */
  getPendingFiles(limit = 100): RelayFileRecord[] {
    const rows = this.stmtGetPending.all(limit) as any[];
    return rows.map(row => this.rowToRecord(row));
  }

  /**
   * Get a file record by ID
   */
  getById(fileId: string): RelayFileRecord | null {
    const row = this.stmtGetById.get(fileId) as any;
    return row ? this.rowToRecord(row) : null;
  }

  /**
   * Get a file record by source path
   */
  getByPath(sourcePath: string): RelayFileRecord | null {
    const row = this.stmtGetByPath.get(sourcePath) as any;
    return row ? this.rowToRecord(row) : null;
  }

  /**
   * Reset all 'processing' files to 'pending' (crash recovery)
   */
  resetProcessingFiles(): number {
    const result = this.stmtResetProcessing.run();
    return result.changes;
  }

  /**
   * Mark files as failed if their source file no longer exists
   */
  reconcileWithFilesystem(): { reset: number; failed: number } {
    let reset = 0;
    let failed = 0;

    // Get all processing files
    const processingFiles = this.db
      .prepare(`SELECT * FROM relay_files WHERE status = 'processing'`)
      .all() as any[];

    for (const row of processingFiles) {
      if (!fs.existsSync(row.source_path)) {
        // File was deleted while processing - mark as failed
        this.stmtMarkFailed.run(Date.now(), 'Source file deleted during processing', row.file_id);
        failed++;
      } else {
        // Reset to pending
        this.stmtUpdateStatus.run('pending', row.file_id);
        reset++;
      }
    }

    return { reset, failed };
  }

  /**
   * Clean up old archived records
   */
  cleanupArchivedRecords(): number {
    const cutoff = Date.now() - this.config.archiveRetentionMs;
    const result = this.stmtCleanupArchived.run(cutoff);
    return result.changes;
  }

  /**
   * Get statistics about file processing
   */
  getStats(): Record<RelayFileStatus, number> {
    const rows = this.stmtGetStats.all() as Array<{ status: string; count: number }>;
    const stats: Record<string, number> = {
      pending: 0,
      processing: 0,
      delivered: 0,
      failed: 0,
      archived: 0,
    };

    for (const row of rows) {
      stats[row.status] = row.count;
    }

    return stats as Record<RelayFileStatus, number>;
  }

  /**
   * Convert database row to RelayFileRecord
   */
  private rowToRecord(row: any): RelayFileRecord {
    return {
      id: row.id,
      fileId: row.file_id,
      sourcePath: row.source_path,
      symlinkPath: row.symlink_path,
      archivePath: row.archive_path,
      agentName: row.agent_name,
      messageType: row.message_type,
      status: row.status as RelayFileStatus,
      retries: row.retries,
      maxRetries: row.max_retries,
      discoveredAt: row.discovered_at,
      processedAt: row.processed_at,
      archivedAt: row.archived_at,
      error: row.error,
      contentHash: row.content_hash,
      fileSize: row.file_size,
      fileMtimeNs: row.file_mtime_ns,
      fileInode: row.file_inode,
    };
  }

  // ==========================================================================
  // Agent Management
  // ==========================================================================

  /**
   * Register or update an agent
   */
  registerAgent(agentName: string, metadata?: Record<string, unknown>): void {
    const now = Date.now();
    const metadataJson = metadata ? JSON.stringify(metadata) : null;

    this.db.prepare(`
      INSERT INTO agents (agent_name, created_at, last_seen_at, status, metadata)
      VALUES (?, ?, ?, 'active', ?)
      ON CONFLICT(agent_name) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        status = 'active',
        metadata = COALESCE(excluded.metadata, agents.metadata)
    `).run(agentName, now, now, metadataJson);
  }

  /**
   * Update agent last seen time
   */
  updateAgentLastSeen(agentName: string): void {
    this.db.prepare(`
      UPDATE agents SET last_seen_at = ? WHERE agent_name = ?
    `).run(Date.now(), agentName);
  }

  /**
   * Mark agent as inactive
   */
  markAgentInactive(agentName: string): void {
    this.db.prepare(`
      UPDATE agents SET status = 'inactive' WHERE agent_name = ?
    `).run(agentName);
  }

  /**
   * Get all active agents
   */
  getActiveAgents(): LedgerAgentRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM agents WHERE status = 'active' ORDER BY last_seen_at DESC
    `).all() as any[];

    return rows.map(row => ({
      id: row.id,
      agentName: row.agent_name,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      status: row.status,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    }));
  }

  /**
   * Get agent by name
   */
  getAgent(agentName: string): LedgerAgentRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM agents WHERE agent_name = ?
    `).get(agentName) as any;

    if (!row) return null;

    return {
      id: row.id,
      agentName: row.agent_name,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      status: row.status,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    };
  }

  // ==========================================================================
  // Orchestrator State
  // ==========================================================================

  /**
   * Save orchestrator state
   */
  saveState(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO orchestrator_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(key, value, Date.now());
  }

  /**
   * Get orchestrator state
   */
  getState(key: string): string | null {
    const row = this.db.prepare(`
      SELECT value FROM orchestrator_state WHERE key = ?
    `).get(key) as { value: string } | undefined;

    return row?.value ?? null;
  }

  /**
   * Delete orchestrator state
   */
  deleteState(key: string): void {
    this.db.prepare(`
      DELETE FROM orchestrator_state WHERE key = ?
    `).run(key);
  }

  /**
   * Get all orchestrator state
   */
  getAllState(): OrchestratorState[] {
    const rows = this.db.prepare(`
      SELECT * FROM orchestrator_state ORDER BY key
    `).all() as any[];

    return rows.map(row => ({
      key: row.key,
      value: row.value,
      updatedAt: row.updated_at,
    }));
  }

  // ==========================================================================
  // Pending Operations (for crash recovery)
  // ==========================================================================

  /**
   * Add a pending operation
   */
  addPendingOperation(
    operationType: 'process' | 'archive' | 'cleanup',
    targetId: string,
    payload?: string
  ): number {
    const result = this.db.prepare(`
      INSERT INTO pending_operations (operation_type, target_id, payload, created_at)
      VALUES (?, ?, ?, ?)
    `).run(operationType, targetId, payload ?? null, Date.now());

    return result.lastInsertRowid as number;
  }

  /**
   * Complete a pending operation (remove it)
   */
  completePendingOperation(id: number): void {
    this.db.prepare(`
      DELETE FROM pending_operations WHERE id = ?
    `).run(id);
  }

  /**
   * Fail a pending operation (increment attempts, record error)
   */
  failPendingOperation(id: number, error: string): void {
    this.db.prepare(`
      UPDATE pending_operations
      SET attempts = attempts + 1, last_attempt_at = ?, error = ?
      WHERE id = ?
    `).run(Date.now(), error, id);
  }

  /**
   * Get pending operations for recovery
   */
  getPendingOperations(maxAttempts = 5): PendingOperation[] {
    const rows = this.db.prepare(`
      SELECT * FROM pending_operations
      WHERE attempts < ?
      ORDER BY created_at ASC
    `).all(maxAttempts) as any[];

    return rows.map(row => ({
      id: row.id,
      operationType: row.operation_type,
      targetId: row.target_id,
      payload: row.payload,
      createdAt: row.created_at,
      attempts: row.attempts,
      lastAttemptAt: row.last_attempt_at,
      error: row.error,
    }));
  }

  /**
   * Cleanup old failed operations
   */
  cleanupFailedOperations(maxAge = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAge;
    const result = this.db.prepare(`
      DELETE FROM pending_operations
      WHERE created_at < ? AND attempts >= 5
    `).run(cutoff);

    return result.changes;
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}
