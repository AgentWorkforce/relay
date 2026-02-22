/**
 * Barrier Manager — synchronization barriers with all/any/majority semantics.
 *
 * Barriers gate downstream workflow steps until a set of upstream agents
 * or steps have resolved. Supports three resolution modes:
 *
 * - **all**      — every agent in `waitFor` must resolve (default)
 * - **any**      — at least one agent resolves
 * - **majority** — more than half of `waitFor` must resolve
 */

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { DbClient } from './coordinator.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type BarrierMode = 'all' | 'any' | 'majority';

export interface BarrierDefinition {
  name: string;
  waitFor: string[];
  mode?: BarrierMode;
  timeoutMs?: number;
}

export interface BarrierRow {
  id: string;
  runId: string;
  barrierName: string;
  waitFor: string[];
  resolved: string[];
  isSatisfied: boolean;
  timeoutMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface BarrierManagerEvents {
  'barrier:created': (barrier: BarrierRow) => void;
  'barrier:resolved': (barrierName: string, agent: string) => void;
  'barrier:satisfied': (barrier: BarrierRow) => void;
  'barrier:timeout': (barrier: BarrierRow) => void;
}

// ── Manager ─────────────────────────────────────────────────────────────────

export class BarrierManager extends EventEmitter {
  private db: DbClient;
  /** In-memory mode tracking (not persisted — set once at creation). */
  private modes = new Map<string, BarrierMode>();
  private timeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(db: DbClient) {
    super();
    this.db = db;
  }

  // ── Create ──────────────────────────────────────────────────────────────

  /**
   * Create a barrier for a workflow run.
   */
  async createBarrier(
    runId: string,
    definition: BarrierDefinition,
  ): Promise<BarrierRow> {
    const id = `bar_${Date.now()}_${randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    const mode = definition.mode ?? 'all';

    const { rows } = await this.db.query<BarrierRow>(
      `INSERT INTO workflow_barriers (id, run_id, barrier_name, wait_for, resolved, is_satisfied, timeout_ms, created_at, updated_at)
       VALUES ($1, $2, $3, $4, '[]'::jsonb, FALSE, $5, $6, $6)
       RETURNING *`,
      [
        id,
        runId,
        definition.name,
        JSON.stringify(definition.waitFor),
        definition.timeoutMs ?? null,
        now,
      ],
    );

    const barrier = rows[0];
    const key = `${runId}:${definition.name}`;
    this.modes.set(key, mode);

    if (definition.timeoutMs) {
      this.scheduleTimeout(barrier, definition.timeoutMs);
    }

    this.emit('barrier:created', barrier);
    return barrier;
  }

  /**
   * Bulk-create barriers from a list of definitions (e.g. from coordination config).
   */
  async createBarriers(
    runId: string,
    definitions: BarrierDefinition[],
  ): Promise<BarrierRow[]> {
    const results: BarrierRow[] = [];
    for (const def of definitions) {
      results.push(await this.createBarrier(runId, def));
    }
    return results;
  }

  // ── Resolve ─────────────────────────────────────────────────────────────

  /**
   * Mark an agent/step as resolved for a barrier. Returns whether the
   * barrier is now fully satisfied.
   */
  async resolve(
    runId: string,
    barrierName: string,
    agent: string,
  ): Promise<{ satisfied: boolean; barrier: BarrierRow }> {
    const now = new Date().toISOString();

    // Atomic: append agent to resolved array if not already present.
    const { rows } = await this.db.query<BarrierRow>(
      `UPDATE workflow_barriers
       SET resolved = CASE
             WHEN resolved @> $3::jsonb THEN resolved
             ELSE resolved || $3::jsonb
           END,
           updated_at = $4
       WHERE run_id = $1 AND barrier_name = $2 AND is_satisfied = FALSE
       RETURNING *`,
      [runId, barrierName, JSON.stringify(agent), now],
    );

    if (rows.length === 0) {
      // Barrier may already be satisfied or not exist.
      const existing = await this.getBarrier(runId, barrierName);
      if (!existing) throw new Error(`Barrier ${barrierName} not found for run ${runId}`);
      return { satisfied: existing.isSatisfied, barrier: existing };
    }

    const barrier = rows[0];
    this.emit('barrier:resolved', barrierName, agent);

    const key = `${runId}:${barrierName}`;
    const mode = this.modes.get(key) ?? 'all';

    if (this.checkSatisfied(barrier, mode)) {
      return this.markSatisfied(barrier);
    }

    return { satisfied: false, barrier };
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  async getBarrier(runId: string, barrierName: string): Promise<BarrierRow | null> {
    const { rows } = await this.db.query<BarrierRow>(
      `SELECT * FROM workflow_barriers WHERE run_id = $1 AND barrier_name = $2`,
      [runId, barrierName],
    );
    return rows[0] ?? null;
  }

  async getBarriers(runId: string): Promise<BarrierRow[]> {
    const { rows } = await this.db.query<BarrierRow>(
      `SELECT * FROM workflow_barriers WHERE run_id = $1 ORDER BY created_at ASC`,
      [runId],
    );
    return rows;
  }

  async getUnsatisfiedBarriers(runId: string): Promise<BarrierRow[]> {
    const { rows } = await this.db.query<BarrierRow>(
      `SELECT * FROM workflow_barriers WHERE run_id = $1 AND is_satisfied = FALSE ORDER BY created_at ASC`,
      [runId],
    );
    return rows;
  }

  /**
   * Check if a named barrier is satisfied (useful for gating downstream work).
   */
  async isSatisfied(runId: string, barrierName: string): Promise<boolean> {
    const barrier = await this.getBarrier(runId, barrierName);
    return barrier?.isSatisfied ?? false;
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  cleanup(): void {
    for (const timer of this.timeoutTimers.values()) clearTimeout(timer);
    this.timeoutTimers.clear();
    this.modes.clear();
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private checkSatisfied(barrier: BarrierRow, mode: BarrierMode): boolean {
    const waitFor: string[] = Array.isArray(barrier.waitFor) ? barrier.waitFor : [];
    const resolved: string[] = Array.isArray(barrier.resolved) ? barrier.resolved : [];

    switch (mode) {
      case 'all':
        return waitFor.every((w) => resolved.includes(w));
      case 'any':
        return resolved.length > 0;
      case 'majority':
        return resolved.length > waitFor.length / 2;
    }
  }

  private async markSatisfied(
    barrier: BarrierRow,
  ): Promise<{ satisfied: boolean; barrier: BarrierRow }> {
    const now = new Date().toISOString();
    const { rows } = await this.db.query<BarrierRow>(
      `UPDATE workflow_barriers SET is_satisfied = TRUE, updated_at = $2
       WHERE id = $1
       RETURNING *`,
      [barrier.id, now],
    );

    const updated = rows[0];
    const key = `${barrier.runId}:${barrier.barrierName}`;
    this.clearTimeout(key);
    this.emit('barrier:satisfied', updated);

    return { satisfied: true, barrier: updated };
  }

  private scheduleTimeout(barrier: BarrierRow, timeoutMs: number): void {
    const key = `${barrier.runId}:${barrier.barrierName}`;
    const timer = setTimeout(async () => {
      const current = await this.getBarrier(barrier.runId, barrier.barrierName);
      if (current && !current.isSatisfied) {
        this.emit('barrier:timeout', current);
      }
    }, timeoutMs);
    timer.unref();
    this.timeoutTimers.set(key, timer);
  }

  private clearTimeout(key: string): void {
    const timer = this.timeoutTimers.get(key);
    if (timer) {
      globalThis.clearTimeout(timer);
      this.timeoutTimers.delete(key);
    }
  }
}
