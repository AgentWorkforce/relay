import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { WorkflowRunRow, WorkflowStepRow } from './types.js';
import type { WorkflowDb } from './runner.js';

type DbEntry = { kind: 'run'; row: WorkflowRunRow } | { kind: 'step'; row: WorkflowStepRow };

/**
 * JSONL-backed WorkflowDb for the CLI.
 *
 * Each insert/update appends a line to the file. On read, we scan from the
 * bottom and take the last record for each ID — so updates naturally shadow
 * earlier inserts without rewriting the file.
 *
 * This makes writes O(1) and reads O(n) where n = number of lines (small for
 * typical workflows). Resume only reads once at startup, so the read cost is
 * paid once per CLI invocation.
 *
 * File: .agent-relay/workflow-runs.jsonl in the workflow cwd.
 */
export class JsonFileWorkflowDb implements WorkflowDb {
  private readonly filePath: string;

  /** Whether the storage directory is writable. False = silent no-op mode. */
  private readonly writable: boolean;

  constructor(filePath: string) {
    this.filePath = filePath;
    let writable = false;
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writable = true;
    } catch {
      // Permission denied or read-only fs — run in memory-only mode.
      // The workflow executes normally; resume won't be available for this run.
    }
    this.writable = writable;
  }

  /** Returns false if the storage directory could not be created (permission error). */
  isWritable(): boolean {
    return this.writable;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private append(entry: DbEntry): void {
    if (!this.writable) return;
    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      // Non-critical — workflow execution continues; resume won't be available.
    }
  }

  /** Read all lines and build the latest snapshot for each ID. */
  private snapshot(): { runs: Map<string, WorkflowRunRow>; steps: Map<string, WorkflowStepRow> } {
    const runs = new Map<string, WorkflowRunRow>();
    const steps = new Map<string, WorkflowStepRow>();
    let raw = '';
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return { runs, steps };
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as DbEntry;
        if (entry.kind === 'run') {
          runs.set(entry.row.id, entry.row);
        } else {
          steps.set(entry.row.id, entry.row);
        }
      } catch {
        // Skip malformed lines
      }
    }
    return { runs, steps };
  }

  // ── WorkflowDb interface ─────────────────────────────────────────────────

  async insertRun(run: WorkflowRunRow): Promise<void> {
    this.append({ kind: 'run', row: run });
  }

  async updateRun(id: string, patch: Partial<WorkflowRunRow>): Promise<void> {
    const { runs } = this.snapshot();
    const existing = runs.get(id);
    if (!existing) return;
    this.append({ kind: 'run', row: { ...existing, ...patch, updatedAt: new Date().toISOString() } });
  }

  async getRun(id: string): Promise<WorkflowRunRow | null> {
    const { runs } = this.snapshot();
    return runs.get(id) ?? null;
  }

  async insertStep(step: WorkflowStepRow): Promise<void> {
    this.append({ kind: 'step', row: step });
  }

  async updateStep(id: string, patch: Partial<WorkflowStepRow>): Promise<void> {
    const { steps } = this.snapshot();
    const existing = steps.get(id);
    if (!existing) return;
    this.append({ kind: 'step', row: { ...existing, ...patch, updatedAt: new Date().toISOString() } });
  }

  async getStepsByRunId(runId: string): Promise<WorkflowStepRow[]> {
    const { steps } = this.snapshot();
    return Array.from(steps.values()).filter((s) => s.runId === runId);
  }
}
