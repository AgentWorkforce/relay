/**
 * State Store — CRUD on swarm_state with optional consensus-gated writes.
 *
 * Provides a key-value store scoped to a workflow run and namespace.
 * When consensus gating is enabled, writes require approval from a
 * ConsensusEngine before being committed.
 */

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { DbClient } from './coordinator.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface StateEntry {
  id: string;
  runId: string;
  namespace: string;
  key: string;
  value: unknown;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StateStoreOptions {
  /** Default namespace for keys. */
  namespace?: string;
  /** Default TTL in milliseconds for new entries. */
  defaultTtlMs?: number;
}

export interface WriteOptions {
  namespace?: string;
  ttlMs?: number;
}

export interface ReadOptions {
  namespace?: string;
}

/** Callback invoked to gate a write. Return true to allow, false to reject. */
export type ConsensusGate = (
  runId: string,
  key: string,
  value: unknown,
  agent: string,
) => Promise<boolean>;

export interface StateStoreEvents {
  'state:set': (entry: StateEntry) => void;
  'state:deleted': (runId: string, key: string, namespace: string) => void;
  'state:gated': (runId: string, key: string, agent: string) => void;
}

// ── Store ───────────────────────────────────────────────────────────────────

export class StateStore extends EventEmitter {
  private db: DbClient;
  private defaultNamespace: string;
  private defaultTtlMs: number | null;
  private consensusGate: ConsensusGate | null = null;

  constructor(db: DbClient, options: StateStoreOptions = {}) {
    super();
    this.db = db;
    this.defaultNamespace = options.namespace ?? 'default';
    this.defaultTtlMs = options.defaultTtlMs ?? null;
  }

  // ── Consensus gating ──────────────────────────────────────────────────

  /**
   * Enable consensus-gated writes. When set, every `set()` call will
   * invoke the gate function before persisting. If the gate returns false,
   * the write is rejected.
   */
  setConsensusGate(gate: ConsensusGate): void {
    this.consensusGate = gate;
  }

  clearConsensusGate(): void {
    this.consensusGate = null;
  }

  // ── Write ─────────────────────────────────────────────────────────────

  /**
   * Set a key-value pair. If consensus gating is enabled, the write is
   * subject to approval.
   *
   * @param agent - The agent requesting the write (used for consensus gating).
   */
  async set(
    runId: string,
    key: string,
    value: unknown,
    agent: string,
    options: WriteOptions = {},
  ): Promise<StateEntry> {
    // Consensus gate check.
    if (this.consensusGate) {
      const allowed = await this.consensusGate(runId, key, value, agent);
      if (!allowed) {
        this.emit('state:gated', runId, key, agent);
        throw new Error(
          `Write to "${key}" rejected by consensus gate for agent "${agent}"`,
        );
      }
    }

    const namespace = options.namespace ?? this.defaultNamespace;
    const ttlMs = options.ttlMs ?? this.defaultTtlMs;
    const expiresAt = ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null;
    const id = `st_${Date.now()}_${randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();

    // Upsert: use the unique (run_id, namespace, key) constraint.
    const { rows } = await this.db.query<StateEntry>(
      `INSERT INTO swarm_state (id, run_id, namespace, key, value, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (run_id, namespace, key)
       DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [id, runId, namespace, key, JSON.stringify(value), expiresAt, now],
    );

    const entry = rows[0];
    this.emit('state:set', entry);
    return entry;
  }

  // ── Read ──────────────────────────────────────────────────────────────

  async get(
    runId: string,
    key: string,
    options: ReadOptions = {},
  ): Promise<unknown | null> {
    const namespace = options.namespace ?? this.defaultNamespace;

    const { rows } = await this.db.query<StateEntry>(
      `SELECT * FROM swarm_state
       WHERE run_id = $1 AND namespace = $2 AND key = $3
         AND (expires_at IS NULL OR expires_at > now())`,
      [runId, namespace, key],
    );

    if (rows.length === 0) return null;
    return rows[0].value;
  }

  async getEntry(
    runId: string,
    key: string,
    options: ReadOptions = {},
  ): Promise<StateEntry | null> {
    const namespace = options.namespace ?? this.defaultNamespace;

    const { rows } = await this.db.query<StateEntry>(
      `SELECT * FROM swarm_state
       WHERE run_id = $1 AND namespace = $2 AND key = $3
         AND (expires_at IS NULL OR expires_at > now())`,
      [runId, namespace, key],
    );

    return rows[0] ?? null;
  }

  async getAll(
    runId: string,
    options: ReadOptions = {},
  ): Promise<StateEntry[]> {
    const namespace = options.namespace ?? this.defaultNamespace;

    const { rows } = await this.db.query<StateEntry>(
      `SELECT * FROM swarm_state
       WHERE run_id = $1 AND namespace = $2
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY key ASC`,
      [runId, namespace],
    );

    return rows;
  }

  async keys(
    runId: string,
    options: ReadOptions = {},
  ): Promise<string[]> {
    const namespace = options.namespace ?? this.defaultNamespace;

    const { rows } = await this.db.query<{ key: string }>(
      `SELECT key FROM swarm_state
       WHERE run_id = $1 AND namespace = $2
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY key ASC`,
      [runId, namespace],
    );

    return rows.map((r) => r.key);
  }

  // ── Delete ────────────────────────────────────────────────────────────

  async delete(
    runId: string,
    key: string,
    options: ReadOptions = {},
  ): Promise<boolean> {
    const namespace = options.namespace ?? this.defaultNamespace;

    const { rows } = await this.db.query(
      `DELETE FROM swarm_state WHERE run_id = $1 AND namespace = $2 AND key = $3 RETURNING id`,
      [runId, namespace, key],
    );

    if (rows.length > 0) {
      this.emit('state:deleted', runId, key, namespace);
      return true;
    }

    return false;
  }

  async deleteAll(
    runId: string,
    options: ReadOptions = {},
  ): Promise<number> {
    const namespace = options.namespace ?? this.defaultNamespace;

    const { rows } = await this.db.query(
      `DELETE FROM swarm_state WHERE run_id = $1 AND namespace = $2 RETURNING id`,
      [runId, namespace],
    );

    return rows.length;
  }

  // ── Expiry cleanup ────────────────────────────────────────────────────

  /**
   * Remove all expired entries for a run (or globally if runId is omitted).
   * Returns the number of entries purged.
   */
  async purgeExpired(runId?: string): Promise<number> {
    if (runId) {
      const { rows } = await this.db.query(
        `DELETE FROM swarm_state WHERE run_id = $1 AND expires_at IS NOT NULL AND expires_at <= now() RETURNING id`,
        [runId],
      );
      return rows.length;
    }

    const { rows } = await this.db.query(
      `DELETE FROM swarm_state WHERE expires_at IS NOT NULL AND expires_at <= now() RETURNING id`,
      [],
    );
    return rows.length;
  }

  // ── Snapshot ───────────────────────────────────────────────────────────

  /**
   * Take a snapshot of all state for a run as a plain object.
   * Useful for persisting into workflow_runs.state_snapshot.
   */
  async snapshot(
    runId: string,
    options: ReadOptions = {},
  ): Promise<Record<string, unknown>> {
    const entries = await this.getAll(runId, options);
    const result: Record<string, unknown> = {};
    for (const entry of entries) {
      result[entry.key] = entry.value;
    }
    return result;
  }
}
