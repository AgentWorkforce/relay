/**
 * Relay Watchdog - File-based relay message detection and processing
 *
 * Monitors agent outbox directories for new relay files and processes them:
 * 1. Detects new files via fs.watch + periodic reconciliation
 * 2. Validates files (size > 0, not symlink, settled)
 * 3. Claims files atomically via ledger
 * 4. Processes and archives files
 *
 * Features:
 * - fsevents/inotify watchers with overflow fallback
 * - Configurable settle time for file stability
 * - Symlink rejection (security)
 * - Orphaned .pending file cleanup
 * - Crash recovery on startup
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RelayLedger, type RelayFileRecord, type LedgerConfig } from './relay-ledger.js';
import { getBaseRelayPaths, type RelayPaths } from '@agent-relay/config/relay-file-writer';

// ============================================================================
// Types
// ============================================================================

export interface WatchdogConfig {
  /** Base relay paths (auto-detected if not provided) */
  relayPaths?: RelayPaths;
  /** Ledger database path (default: ~/.agent-relay/meta/ledger.sqlite) */
  ledgerPath?: string;
  /** Settle time before processing file (default: 500ms) */
  settleTimeMs?: number;
  /** Timeout for malformed/incomplete files (default: 10000ms) */
  malformedTimeoutMs?: number;
  /** Interval for periodic reconciliation (default: 30000ms) */
  reconcileIntervalMs?: number;
  /** Maximum message size in bytes (default: 1MB) */
  maxMessageSizeBytes?: number;
  /** Maximum attachment size in bytes (default: 10MB) */
  maxAttachmentSizeBytes?: number;
  /** Cleanup interval for orphaned files (default: 60000ms) */
  cleanupIntervalMs?: number;
  /** Age threshold for orphaned .pending files (default: 30000ms) */
  orphanedPendingAgeMs?: number;
  /** Archive retention in milliseconds (default: 7 days) */
  archiveRetentionMs?: number;
  /** Enable debug logging */
  debug?: boolean;
}

export interface DiscoveredFile {
  path: string;
  agentName: string;
  messageType: string;
  size: number;
  mtime: number;
  contentHash?: string;
}

export interface ProcessedFile {
  fileId: string;
  agentName: string;
  messageType: string;
  content: string;
  headers: Record<string, string>;
  body: string;
}

export interface WatchdogEvents {
  'file:discovered': (file: DiscoveredFile) => void;
  'file:processing': (record: RelayFileRecord) => void;
  'file:delivered': (result: ProcessedFile) => void;
  'file:failed': (record: RelayFileRecord, error: Error) => void;
  'file:archived': (record: RelayFileRecord, archivePath: string) => void;
  'watcher:overflow': (dir: string) => void;
  'reconcile:complete': (stats: { discovered: number; failed: number }) => void;
  error: (error: Error) => void;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_SETTLE_TIME_MS = parseInt(process.env.RELAY_SETTLE_TIME_MS ?? '500', 10);
const DEFAULT_MALFORMED_TIMEOUT_MS = parseInt(process.env.RELAY_MALFORMED_TIMEOUT_MS ?? '10000', 10);
const DEFAULT_RECONCILE_INTERVAL_MS = 30000;
const DEFAULT_MAX_MESSAGE_SIZE_BYTES = 1024 * 1024; // 1MB
const DEFAULT_MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_CLEANUP_INTERVAL_MS = 60000;
const DEFAULT_ORPHANED_PENDING_AGE_MS = 30000;
const DEFAULT_ARCHIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Files/directories to ignore
const IGNORE_PATTERNS = [
  /^\./,           // Hidden files
  /^\.pending$/,   // Pending marker
  /\.tmp$/,        // Temp files
  /~$/,            // Editor backups
];

// ============================================================================
// RelayWatchdog Class
// ============================================================================

export class RelayWatchdog extends EventEmitter {
  private config: Required<WatchdogConfig>;
  private relayPaths: RelayPaths;
  private ledger: RelayLedger;
  private watchers: Map<string, fs.FSWatcher> = new Map();
  private pendingFiles: Map<string, NodeJS.Timeout> = new Map();
  private reconcileTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private running = false;

  constructor(config: WatchdogConfig = {}) {
    super();

    this.relayPaths = config.relayPaths ?? getBaseRelayPaths();

    this.config = {
      relayPaths: this.relayPaths,
      ledgerPath: config.ledgerPath ?? path.join(this.relayPaths.metaDir, 'ledger.sqlite'),
      settleTimeMs: config.settleTimeMs ?? DEFAULT_SETTLE_TIME_MS,
      malformedTimeoutMs: config.malformedTimeoutMs ?? DEFAULT_MALFORMED_TIMEOUT_MS,
      reconcileIntervalMs: config.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
      maxMessageSizeBytes: config.maxMessageSizeBytes ?? DEFAULT_MAX_MESSAGE_SIZE_BYTES,
      maxAttachmentSizeBytes: config.maxAttachmentSizeBytes ?? DEFAULT_MAX_ATTACHMENT_SIZE_BYTES,
      cleanupIntervalMs: config.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS,
      orphanedPendingAgeMs: config.orphanedPendingAgeMs ?? DEFAULT_ORPHANED_PENDING_AGE_MS,
      archiveRetentionMs: config.archiveRetentionMs ?? DEFAULT_ARCHIVE_RETENTION_MS,
      debug: config.debug ?? false,
    };

    // Initialize ledger
    this.ledger = new RelayLedger({
      dbPath: this.config.ledgerPath,
      archiveRetentionMs: this.config.archiveRetentionMs,
    });
  }

  /**
   * Resolve symlinks in relay paths for cloud/production workspace support
   * This ensures we work with canonical paths even when directories are symlinked
   */
  private async resolveRelayPaths(): Promise<void> {
    const resolvePath = async (p: string): Promise<string> => {
      try {
        const resolved = await fs.promises.realpath(p);
        if (resolved !== p) {
          this.log(`Resolved symlink: ${p} -> ${resolved}`);
        }
        return resolved;
      } catch {
        // Path doesn't exist yet, keep original
        return p;
      }
    };

    // Resolve all relay paths to canonical form
    this.relayPaths = {
      rootDir: await resolvePath(this.relayPaths.rootDir),
      outboxDir: await resolvePath(this.relayPaths.outboxDir),
      attachmentsDir: await resolvePath(this.relayPaths.attachmentsDir),
      metaDir: await resolvePath(this.relayPaths.metaDir),
      legacyOutboxDir: await resolvePath(this.relayPaths.legacyOutboxDir),
    };
  }

  /**
   * Start the watchdog
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.log('Starting relay watchdog...');

    // Resolve symlinks in relay paths for cloud/production workspace support
    await this.resolveRelayPaths();

    // Ensure directories exist
    await this.ensureDirectories();

    // Crash recovery: reset processing files and reconcile
    const resetCount = this.ledger.resetProcessingFiles();
    if (resetCount > 0) {
      this.log(`Crash recovery: reset ${resetCount} processing files to pending`);
    }

    const reconcileResult = this.ledger.reconcileWithFilesystem();
    if (reconcileResult.failed > 0) {
      this.log(`Crash recovery: marked ${reconcileResult.failed} missing files as failed`);
    }

    // Initial scan to seed ledger
    await this.fullReconciliation();

    // Start root watcher for new agents
    this.startRootWatcher();

    // Start watchers for existing agents
    await this.startAgentWatchers();

    // Start periodic reconciliation
    this.reconcileTimer = setInterval(() => {
      this.fullReconciliation().catch(err => {
        this.emit('error', err);
      });
    }, this.config.reconcileIntervalMs);
    this.reconcileTimer.unref();

    // Start cleanup timer
    this.cleanupTimer = setInterval(() => {
      this.cleanupOrphanedFiles();
      this.ledger.cleanupArchivedRecords();
    }, this.config.cleanupIntervalMs);
    this.cleanupTimer.unref();

    this.log('Relay watchdog started');
  }

  /**
   * Stop the watchdog
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    this.log('Stopping relay watchdog...');

    // Clear timers
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    // Clear pending file timers
    for (const timer of this.pendingFiles.values()) {
      clearTimeout(timer);
    }
    this.pendingFiles.clear();

    // Close all watchers
    for (const [dir, watcher] of this.watchers) {
      watcher.close();
      this.log(`Closed watcher for: ${dir}`);
    }
    this.watchers.clear();

    // Close ledger
    this.ledger.close();

    this.log('Relay watchdog stopped');
  }

  /**
   * Get ledger statistics
   */
  getStats(): Record<string, number> {
    return this.ledger.getStats();
  }

  /**
   * Get pending file count
   */
  getPendingCount(): number {
    return this.ledger.getPendingFiles(1).length > 0 ? this.ledger.getStats().pending : 0;
  }

  // ==========================================================================
  // Directory Management
  // ==========================================================================

  private async ensureDirectories(): Promise<void> {
    const dirs = [
      this.relayPaths.outboxDir,
      this.relayPaths.attachmentsDir,
      this.relayPaths.metaDir,
      path.join(this.relayPaths.rootDir, 'archive'),
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
        this.log(`Created directory: ${dir}`);
      }
    }
  }

  // ==========================================================================
  // File Watching
  // ==========================================================================

  private startRootWatcher(): void {
    const outboxDir = this.relayPaths.outboxDir;

    if (!fs.existsSync(outboxDir)) {
      this.log(`Outbox directory doesn't exist yet: ${outboxDir}`);
      return;
    }

    try {
      const watcher = fs.watch(outboxDir, (eventType, filename) => {
        if (!filename || this.shouldIgnore(filename)) return;

        const agentDir = path.join(outboxDir, filename);

        // Check if new agent directory was created
        if (eventType === 'rename') {
          this.checkAndWatchAgentDir(agentDir, filename);
        }
      });

      watcher.on('error', (err) => {
        this.log(`Root watcher error: ${err.message}`);
        this.emit('watcher:overflow', outboxDir);
        // Trigger full reconciliation on watcher error
        this.fullReconciliation().catch(e => this.emit('error', e));
      });

      this.watchers.set(outboxDir, watcher);
      this.log(`Started root watcher: ${outboxDir}`);
    } catch (err: any) {
      this.log(`Failed to start root watcher: ${err.message}`);
    }
  }

  private async startAgentWatchers(): Promise<void> {
    const outboxDir = this.relayPaths.outboxDir;

    if (!fs.existsSync(outboxDir)) return;

    const entries = await fs.promises.readdir(outboxDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory() && !this.shouldIgnore(entry.name)) {
        const agentDir = path.join(outboxDir, entry.name);
        this.startAgentWatcher(agentDir, entry.name);
      }
    }
  }

  private checkAndWatchAgentDir(agentDir: string, agentName: string): void {
    try {
      const stats = fs.statSync(agentDir);
      if (stats.isDirectory() && !this.watchers.has(agentDir)) {
        this.startAgentWatcher(agentDir, agentName);
      }
    } catch {
      // Directory might not exist yet or was deleted
    }
  }

  private startAgentWatcher(agentDir: string, agentName: string): void {
    if (this.watchers.has(agentDir)) return;

    try {
      const watcher = fs.watch(agentDir, (eventType, filename) => {
        if (!filename || this.shouldIgnore(filename)) return;

        const filePath = path.join(agentDir, filename);
        this.handleFileEvent(filePath, agentName, filename);
      });

      watcher.on('error', (err) => {
        this.log(`Agent watcher error (${agentName}): ${err.message}`);
        this.emit('watcher:overflow', agentDir);
        // Remove failed watcher and trigger reconciliation
        this.watchers.delete(agentDir);
        this.fullReconciliation().catch(e => this.emit('error', e));
      });

      this.watchers.set(agentDir, watcher);
      this.log(`Started agent watcher: ${agentDir}`);
    } catch (err: any) {
      this.log(`Failed to start agent watcher (${agentName}): ${err.message}`);
    }
  }

  // ==========================================================================
  // File Event Handling
  // ==========================================================================

  private handleFileEvent(filePath: string, agentName: string, messageType: string): void {
    // Cancel any existing settle timer for this file
    const existingTimer = this.pendingFiles.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Start settle timer
    const timer = setTimeout(() => {
      this.pendingFiles.delete(filePath);
      this.processDiscoveredFile(filePath, agentName, messageType).catch(err => {
        this.emit('error', err);
      });
    }, this.config.settleTimeMs);

    this.pendingFiles.set(filePath, timer);
  }

  private async processDiscoveredFile(
    filePath: string,
    agentName: string,
    messageType: string
  ): Promise<void> {
    try {
      // SECURITY: Check if the file itself is a symlink BEFORE resolving
      // This prevents symlink attacks where an attacker creates a symlink
      // pointing to a file outside the agent's outbox
      try {
        const lstats = await fs.promises.lstat(filePath);
        if (lstats.isSymbolicLink()) {
          this.log(`Rejected symlink file (security): ${filePath}`);
          return;
        }
      } catch {
        // File doesn't exist - will be caught later
      }

      // Resolve symlinks in DIRECTORY path to get canonical path
      // (for cloud workspaces where the outbox directory may be symlinked)
      // Note: The file itself was already verified to NOT be a symlink above
      let canonicalPath: string;
      let originalPath: string | undefined;
      try {
        canonicalPath = await fs.promises.realpath(filePath);
        // Only store original if it differs (directory was symlinked)
        if (canonicalPath !== filePath) {
          originalPath = filePath;
          this.log(`Resolved directory symlink: ${filePath} -> ${canonicalPath}`);
        }
      } catch {
        // File doesn't exist or can't resolve - use original
        canonicalPath = filePath;
      }

      // Validate file exists and get stats (uses canonical path)
      const validation = await this.validateFile(canonicalPath);
      if (!validation.valid) {
        this.log(`File validation failed (${canonicalPath}): ${validation.reason}`);
        return;
      }

      const stats = validation.stats!;

      // Check if already registered (by canonical path)
      if (this.ledger.isFileRegistered(canonicalPath)) {
        this.log(`File already registered: ${canonicalPath}`);
        return;
      }

      // Calculate content hash for deduplication
      const contentHash = await this.calculateFileHash(canonicalPath);

      // Register in ledger with both paths
      // sourcePath = canonical (resolved), symlinkPath = original (if symlinked)
      const fileId = this.ledger.registerFile(
        canonicalPath,
        agentName,
        messageType,
        stats.size,
        contentHash,
        undefined, // fileMtimeNs
        undefined, // fileInode
        originalPath // symlinkPath (only set if it was a symlink)
      );

      const discoveredFile: DiscoveredFile = {
        path: canonicalPath,
        agentName,
        messageType,
        size: stats.size,
        mtime: stats.mtimeMs,
        contentHash,
      };

      this.emit('file:discovered', discoveredFile);
      this.log(`Discovered file: ${canonicalPath} (id: ${fileId})`);

      // Attempt to process immediately
      await this.processFile(fileId);
    } catch (err: any) {
      this.log(`Error processing discovered file (${filePath}): ${err.message}`);
    }
  }

  // ==========================================================================
  // File Validation
  // ==========================================================================

  private async validateFile(
    filePath: string
  ): Promise<{ valid: boolean; stats?: fs.Stats; reason?: string }> {
    try {
      // Use lstat to detect symlinks (don't follow them)
      const stats = await fs.promises.lstat(filePath);

      // Reject symlinks (security)
      if (stats.isSymbolicLink()) {
        return { valid: false, reason: 'Symlinks not allowed' };
      }

      // Must be a regular file
      if (!stats.isFile()) {
        return { valid: false, reason: 'Not a regular file' };
      }

      // Skip 0-byte files
      if (stats.size === 0) {
        return { valid: false, reason: 'Empty file (0 bytes)' };
      }

      // Check size limits
      if (stats.size > this.config.maxMessageSizeBytes) {
        return { valid: false, reason: `File too large (${stats.size} > ${this.config.maxMessageSizeBytes})` };
      }

      // Re-stat to check stability (file size hasn't changed)
      await new Promise(resolve => setTimeout(resolve, 50));
      const stats2 = await fs.promises.lstat(filePath);

      if (stats.size !== stats2.size || stats.mtimeMs !== stats2.mtimeMs) {
        return { valid: false, reason: 'File still being written' };
      }

      return { valid: true, stats };
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { valid: false, reason: 'File does not exist' };
      }
      return { valid: false, reason: err.message };
    }
  }

  private async calculateFileHash(filePath: string): Promise<string> {
    const content = await fs.promises.readFile(filePath);
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  // ==========================================================================
  // File Processing
  // ==========================================================================

  private async processFile(fileId: string): Promise<void> {
    // Atomically claim the file
    const claimResult = this.ledger.claimFile(fileId);

    if (!claimResult.success) {
      this.log(`Failed to claim file ${fileId}: ${claimResult.reason}`);
      return;
    }

    const record = claimResult.record!;
    this.emit('file:processing', record);

    try {
      // Read file content
      const content = await fs.promises.readFile(record.sourcePath, 'utf-8');

      // Parse headers and body
      const { headers, body } = this.parseFileContent(content);

      const processedFile: ProcessedFile = {
        fileId: record.fileId,
        agentName: record.agentName,
        messageType: record.messageType,
        content,
        headers,
        body,
      };

      // Mark as delivered
      this.ledger.markDelivered(fileId);
      this.emit('file:delivered', processedFile);

      // Archive the file
      await this.archiveFile(record);

      this.log(`Processed file: ${record.sourcePath} (id: ${fileId})`);
    } catch (err: any) {
      this.log(`Error processing file ${fileId}: ${err.message}`);
      this.ledger.markFailed(fileId, err.message);
      this.emit('file:failed', record, err);
    }
  }

  private parseFileContent(content: string): { headers: Record<string, string>; body: string } {
    const headers: Record<string, string> = {};
    const lines = content.split('\n');
    let bodyStartIndex = 0;

    // Parse headers until empty line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Empty line marks end of headers
      if (line.trim() === '') {
        bodyStartIndex = i + 1;
        break;
      }

      // Parse header: "KEY: value"
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.slice(0, colonIndex).trim().toUpperCase();
        const value = line.slice(colonIndex + 1).trim();
        headers[key] = value;
      } else {
        // No colon found, treat rest as body
        bodyStartIndex = i;
        break;
      }
    }

    const body = lines.slice(bodyStartIndex).join('\n').trim();

    return { headers, body };
  }

  // ==========================================================================
  // File Archiving
  // ==========================================================================

  private async archiveFile(record: RelayFileRecord): Promise<void> {
    const archiveDir = path.join(
      this.relayPaths.rootDir,
      'archive',
      record.agentName,
      new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    );

    await fs.promises.mkdir(archiveDir, { recursive: true });

    const archivePath = path.join(archiveDir, `${record.fileId}-${record.messageType}`);

    try {
      // Move file to archive
      await fs.promises.rename(record.sourcePath, archivePath);
      this.ledger.markArchived(record.fileId, archivePath);
      this.emit('file:archived', record, archivePath);
    } catch (err: any) {
      // If rename fails (cross-device), copy and delete
      if (err.code === 'EXDEV') {
        await fs.promises.copyFile(record.sourcePath, archivePath);
        await fs.promises.unlink(record.sourcePath);
        this.ledger.markArchived(record.fileId, archivePath);
        this.emit('file:archived', record, archivePath);
      } else {
        throw err;
      }
    }
  }

  // ==========================================================================
  // Reconciliation
  // ==========================================================================

  private async fullReconciliation(): Promise<void> {
    const outboxDir = this.relayPaths.outboxDir;
    let discovered = 0;
    let failed = 0;

    if (!fs.existsSync(outboxDir)) {
      return;
    }

    try {
      // Scan all agent directories
      const agents = await fs.promises.readdir(outboxDir, { withFileTypes: true });

      for (const agent of agents) {
        if (!agent.isDirectory() || this.shouldIgnore(agent.name)) continue;

        const agentDir = path.join(outboxDir, agent.name);

        // Ensure watcher exists for this agent
        if (!this.watchers.has(agentDir)) {
          this.startAgentWatcher(agentDir, agent.name);
        }

        // Scan agent's outbox
        try {
          const files = await fs.promises.readdir(agentDir, { withFileTypes: true });

          for (const file of files) {
            if (!file.isFile() || this.shouldIgnore(file.name)) continue;

            const filePath = path.join(agentDir, file.name);

            // Skip if already registered
            if (this.ledger.isFileRegistered(filePath)) continue;

            try {
              await this.processDiscoveredFile(filePath, agent.name, file.name);
              discovered++;
            } catch {
              failed++;
            }
          }
        } catch (err: any) {
          this.log(`Failed to scan agent directory (${agent.name}): ${err.message}`);
        }
      }

      // Process any pending files from ledger
      const pendingFiles = this.ledger.getPendingFiles();
      for (const record of pendingFiles) {
        await this.processFile(record.fileId);
      }

      this.emit('reconcile:complete', { discovered, failed });
    } catch (err: any) {
      this.log(`Reconciliation error: ${err.message}`);
      this.emit('error', err);
    }
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  private async cleanupOrphanedFiles(): Promise<void> {
    const outboxDir = this.relayPaths.outboxDir;
    const now = Date.now();

    if (!fs.existsSync(outboxDir)) return;

    try {
      const agents = await fs.promises.readdir(outboxDir, { withFileTypes: true });

      for (const agent of agents) {
        if (!agent.isDirectory()) continue;

        const agentDir = path.join(outboxDir, agent.name);
        const files = await fs.promises.readdir(agentDir);

        for (const file of files) {
          // Clean up .pending files older than threshold
          if (file.endsWith('.pending')) {
            const filePath = path.join(agentDir, file);
            try {
              const stats = await fs.promises.stat(filePath);
              if (now - stats.mtimeMs > this.config.orphanedPendingAgeMs) {
                await fs.promises.unlink(filePath);
                this.log(`Cleaned up orphaned .pending file: ${filePath}`);
              }
            } catch {
              // File may have been deleted
            }
          }
        }
      }
    } catch (err: any) {
      this.log(`Cleanup error: ${err.message}`);
    }
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  private shouldIgnore(filename: string): boolean {
    return IGNORE_PATTERNS.some(pattern => pattern.test(filename));
  }

  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[relay-watchdog] ${message}`);
    }
  }
}

// Type augmentation for EventEmitter
export interface RelayWatchdog {
  on<K extends keyof WatchdogEvents>(event: K, listener: WatchdogEvents[K]): this;
  emit<K extends keyof WatchdogEvents>(event: K, ...args: Parameters<WatchdogEvents[K]>): boolean;
}
