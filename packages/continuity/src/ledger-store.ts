/**
 * Ledger Store
 *
 * Persists within-session state as JSON files.
 * One ledger per agent, overwritten each session.
 *
 * Features:
 * - agentId index for O(1) lookups
 * - Hash-based filenames to avoid collisions
 * - File locking for concurrent access safety
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Ledger } from './types.js';

/** Index mapping agentId -> agentName for fast lookups */
interface AgentIdIndex {
  [agentId: string]: string; // agentId -> agentName
}

/** Lock state for managing concurrent access */
interface LockState {
  promise: Promise<void>;
  release: () => void;
  acquiredAt: number; // Timestamp for expiry check
}

/** Lock expiry time in milliseconds (5 minutes) */
const LOCK_EXPIRY_MS = 5 * 60 * 1000;

export class LedgerStore {
  private basePath: string;
  private indexPath: string;
  private index: AgentIdIndex | null = null;
  private locks: Map<string, LockState> = new Map();
  private indexLock: LockState | null = null; // Global lock for index operations

  constructor(basePath: string) {
    this.basePath = basePath;
    this.indexPath = path.join(basePath, '_agent-id-index.json');
  }

  /**
   * Ensure the ledgers directory exists
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
    await this.loadIndex();
  }

  /**
   * Generate a unique, collision-free filename from agent name
   * Uses SHA-256 hash prefix + sanitized name for readability
   */
  private getFilenameForAgent(agentName: string): string {
    // Create a short hash to ensure uniqueness
    const hash = crypto.createHash('sha256').update(agentName).digest('hex').slice(0, 8);
    // Also include sanitized name for human readability
    const safeName = agentName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
    return `${safeName}_${hash}`;
  }

  /**
   * Get the file path for an agent's ledger
   */
  private getLedgerPath(agentName: string): string {
    const filename = this.getFilenameForAgent(agentName);
    return path.join(this.basePath, `${filename}.json`);
  }

  /**
   * Load the agentId index from disk
   */
  private async loadIndex(): Promise<void> {
    try {
      const content = await fs.readFile(this.indexPath, 'utf-8');
      this.index = JSON.parse(content) as AgentIdIndex;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        this.index = {};
      } else {
        throw error;
      }
    }
  }

  /**
   * Save the agentId index to disk (atomic write)
   */
  private async saveIndex(): Promise<void> {
    if (!this.index) return;
    const tempPath = `${this.indexPath}.tmp.${Date.now()}`;
    await fs.writeFile(tempPath, JSON.stringify(this.index, null, 2), 'utf-8');
    await fs.rename(tempPath, this.indexPath);
  }

  /**
   * Acquire the global index lock
   */
  private async acquireIndexLock(): Promise<() => void> {
    const startTime = Date.now();
    const timeoutMs = 5000;

    while (this.indexLock) {
      // Check for expired lock
      if (Date.now() - this.indexLock.acquiredAt > LOCK_EXPIRY_MS) {
        this.indexLock.release();
        this.indexLock = null;
        break;
      }

      // Check timeout
      if (Date.now() - startTime > timeoutMs) {
        throw new Error('Index lock acquisition timeout');
      }

      // Wait briefly and retry
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    let release: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.indexLock = { promise, release, acquiredAt: Date.now() };

    return () => {
      release();
      this.indexLock = null;
    };
  }

  /**
   * Update the index with a new agentId -> agentName mapping (with locking)
   */
  private async updateIndex(agentId: string, agentName: string): Promise<void> {
    const releaseIndexLock = await this.acquireIndexLock();
    try {
      if (!this.index) await this.loadIndex();
      if (this.index) {
        this.index[agentId] = agentName;
        await this.saveIndex();
      }
    } finally {
      releaseIndexLock();
    }
  }

  /**
   * Remove an agentId from the index (with locking)
   */
  private async removeFromIndex(agentId: string): Promise<void> {
    const releaseIndexLock = await this.acquireIndexLock();
    try {
      if (!this.index) await this.loadIndex();
      if (this.index && this.index[agentId]) {
        delete this.index[agentId];
        await this.saveIndex();
      }
    } finally {
      releaseIndexLock();
    }
  }

  /**
   * Check and release expired locks
   */
  private cleanupExpiredLocks(): void {
    const now = Date.now();
    for (const [key, lock] of this.locks.entries()) {
      if (now - lock.acquiredAt > LOCK_EXPIRY_MS) {
        lock.release();
        this.locks.delete(key);
      }
    }
  }

  /**
   * Acquire a lock for an agent's ledger with retry logic
   * @param agentName - Agent name to lock
   * @param maxRetries - Maximum number of retry attempts (default: 5)
   * @param baseDelayMs - Base delay for exponential backoff (default: 100ms)
   * @param timeoutMs - Maximum time to wait for lock (default: 10000ms)
   */
  private async acquireLock(
    agentName: string,
    maxRetries = 5,
    baseDelayMs = 100,
    timeoutMs = 10000
  ): Promise<() => void> {
    const key = this.getFilenameForAgent(agentName);
    const startTime = Date.now();

    // Cleanup any expired locks first
    this.cleanupExpiredLocks();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Check timeout
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`Lock acquisition timeout for agent "${agentName}" after ${timeoutMs}ms`);
      }

      const existingLock = this.locks.get(key);

      // Check if existing lock is expired
      if (existingLock && Date.now() - existingLock.acquiredAt > LOCK_EXPIRY_MS) {
        existingLock.release();
        this.locks.delete(key);
      }

      if (!existingLock || Date.now() - existingLock.acquiredAt > LOCK_EXPIRY_MS) {
        // Lock is available, acquire it
        let release: () => void = () => {};
        const promise = new Promise<void>((resolve) => {
          release = resolve;
        });

        this.locks.set(key, { promise, release, acquiredAt: Date.now() });

        return () => {
          release();
          this.locks.delete(key);
        };
      }

      // Lock is occupied, wait with exponential backoff
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), 2000); // Cap at 2s

      try {
        // Race between lock release and timeout
        await Promise.race([
          existingLock.promise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('retry')), delay)
          ),
        ]);
      } catch {
        // Timeout or retry, continue to next attempt
      }
    }

    // Final attempt - wait for existing lock or throw
    const existingLock = this.locks.get(key);
    if (existingLock) {
      const remainingTime = timeoutMs - (Date.now() - startTime);
      if (remainingTime > 0) {
        await Promise.race([
          existingLock.promise,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`Lock acquisition timeout for agent "${agentName}"`)),
              remainingTime
            )
          ),
        ]);
      } else {
        throw new Error(`Lock acquisition timeout for agent "${agentName}" after ${maxRetries} retries`);
      }
    }

    // Lock should be available now
    let release: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.locks.set(key, { promise, release, acquiredAt: Date.now() });

    return () => {
      release();
      this.locks.delete(key);
    };
  }

  /**
   * Save a ledger for an agent (with locking)
   */
  async save(agentName: string, ledger: Ledger): Promise<void> {
    await this.initialize();
    const releaseLock = await this.acquireLock(agentName);

    try {
      const filePath = this.getLedgerPath(agentName);

      // Ensure updatedAt is set
      const ledgerToSave: Ledger = {
        ...ledger,
        agentName,
        updatedAt: new Date(),
      };

      // Write to temp file first, then rename (atomic write)
      const tempPath = `${filePath}.tmp.${Date.now()}`;
      await fs.writeFile(tempPath, JSON.stringify(ledgerToSave, null, 2), 'utf-8');
      await fs.rename(tempPath, filePath);

      // Update agentId index
      if (ledger.agentId) {
        await this.updateIndex(ledger.agentId, agentName);
      }
    } finally {
      releaseLock();
    }
  }

  /**
   * Load a ledger for an agent
   */
  async load(agentName: string): Promise<Ledger | null> {
    const filePath = this.getLedgerPath(agentName);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const ledger = JSON.parse(content) as Ledger;

      // Parse date strings back to Date objects
      ledger.updatedAt = new Date(ledger.updatedAt);
      if (ledger.keyDecisions) {
        ledger.keyDecisions = ledger.keyDecisions.map((d) => ({
          ...d,
          timestamp: new Date(d.timestamp),
        }));
      }

      return ledger;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Delete a ledger for an agent
   */
  async delete(agentName: string): Promise<boolean> {
    const releaseLock = await this.acquireLock(agentName);

    try {
      // Load ledger to get agentId for index cleanup
      const ledger = await this.load(agentName);
      const filePath = this.getLedgerPath(agentName);

      try {
        await fs.unlink(filePath);

        // Remove from index
        if (ledger?.agentId) {
          await this.removeFromIndex(ledger.agentId);
        }

        return true;
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return false;
        }
        throw error;
      }
    } finally {
      releaseLock();
    }
  }

  /**
   * Check if a ledger exists for an agent
   */
  async exists(agentName: string): Promise<boolean> {
    const filePath = this.getLedgerPath(agentName);

    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all agents with ledgers
   */
  async listAgents(): Promise<string[]> {
    try {
      await this.initialize();
      const files = await fs.readdir(this.basePath);
      const agents: string[] = [];

      for (const file of files) {
        // Skip index file and non-JSON files
        if (!file.endsWith('.json') || file.startsWith('_')) continue;

        try {
          const filePath = path.join(this.basePath, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const ledger = JSON.parse(content) as Ledger;
          if (ledger.agentName) {
            agents.push(ledger.agentName);
          }
        } catch {
          // Skip corrupted files
        }
      }

      return agents;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Update specific fields in a ledger (merge, with locking)
   */
  async update(
    agentName: string,
    updates: Partial<Omit<Ledger, 'agentName' | 'updatedAt'>>
  ): Promise<Ledger | null> {
    const releaseLock = await this.acquireLock(agentName);

    try {
      const existing = await this.load(agentName);
      if (!existing) {
        return null;
      }

      const updated: Ledger = {
        ...existing,
        ...updates,
        agentName,
        agentId: existing.agentId, // Preserve agentId
        updatedAt: new Date(),
      };

      // Use internal save that doesn't acquire lock again
      const filePath = this.getLedgerPath(agentName);
      const tempPath = `${filePath}.tmp.${Date.now()}`;
      await fs.writeFile(tempPath, JSON.stringify(updated, null, 2), 'utf-8');
      await fs.rename(tempPath, filePath);

      return updated;
    } finally {
      releaseLock();
    }
  }

  /**
   * Add an item to a list field (completed, inProgress, etc.)
   */
  async addToList(
    agentName: string,
    field: 'completed' | 'inProgress' | 'blocked' | 'uncertainItems',
    item: string
  ): Promise<boolean> {
    const releaseLock = await this.acquireLock(agentName);

    try {
      const ledger = await this.load(agentName);
      if (!ledger) {
        return false;
      }

      if (!ledger[field].includes(item)) {
        ledger[field].push(item);
        const filePath = this.getLedgerPath(agentName);
        const tempPath = `${filePath}.tmp.${Date.now()}`;
        await fs.writeFile(tempPath, JSON.stringify({ ...ledger, updatedAt: new Date() }, null, 2), 'utf-8');
        await fs.rename(tempPath, filePath);
      }
      return true;
    } finally {
      releaseLock();
    }
  }

  /**
   * Add a decision to the ledger
   */
  async addDecision(
    agentName: string,
    decision: Omit<Ledger['keyDecisions'][0], 'timestamp'>
  ): Promise<boolean> {
    const releaseLock = await this.acquireLock(agentName);

    try {
      const ledger = await this.load(agentName);
      if (!ledger) {
        return false;
      }

      ledger.keyDecisions.push({
        ...decision,
        timestamp: new Date(),
      });

      const filePath = this.getLedgerPath(agentName);
      const tempPath = `${filePath}.tmp.${Date.now()}`;
      await fs.writeFile(tempPath, JSON.stringify({ ...ledger, updatedAt: new Date() }, null, 2), 'utf-8');
      await fs.rename(tempPath, filePath);

      return true;
    } finally {
      releaseLock();
    }
  }

  /**
   * Create an empty ledger for an agent
   */
  async create(
    agentName: string,
    cli: string,
    sessionId: string,
    agentId: string
  ): Promise<Ledger> {
    const ledger: Ledger = {
      agentName,
      agentId,
      sessionId,
      cli,
      currentTask: '',
      completed: [],
      inProgress: [],
      blocked: [],
      keyDecisions: [],
      uncertainItems: [],
      fileContext: [],
      updatedAt: new Date(),
    };

    await this.save(agentName, ledger);
    return ledger;
  }

  /**
   * Find a ledger by agent ID (O(1) via index)
   */
  async findByAgentId(agentId: string): Promise<Ledger | null> {
    await this.initialize();

    // Use index for O(1) lookup
    if (this.index && this.index[agentId]) {
      const agentName = this.index[agentId];
      const ledger = await this.load(agentName);
      // Verify the agentId still matches (index could be stale)
      if (ledger && ledger.agentId === agentId) {
        return ledger;
      }
      // Index is stale, remove it
      await this.removeFromIndex(agentId);
    }

    // Fallback: scan all ledgers (and rebuild index)
    const agents = await this.listAgents();
    for (const agentName of agents) {
      const ledger = await this.load(agentName);
      if (ledger && ledger.agentId === agentId) {
        // Update index for future lookups
        await this.updateIndex(agentId, agentName);
        return ledger;
      }
    }

    return null;
  }

  /**
   * Rebuild the agentId index from all ledgers
   */
  async rebuildIndex(): Promise<void> {
    await this.initialize();
    const releaseIndexLock = await this.acquireIndexLock();

    try {
      this.index = {};

      const agents = await this.listAgents();
      for (const agentName of agents) {
        const ledger = await this.load(agentName);
        if (ledger?.agentId) {
          this.index[ledger.agentId] = agentName;
        }
      }

      await this.saveIndex();
    } finally {
      releaseIndexLock();
    }
  }
}
