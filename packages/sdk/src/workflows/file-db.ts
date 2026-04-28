import {
  accessSync,
  appendFileSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { WorkflowRunRow, WorkflowStepRow } from './types.js';
import type { WorkflowDb } from './runner.js';

type DbEntry = { kind: 'run'; row: WorkflowRunRow } | { kind: 'step'; row: WorkflowStepRow };

/**
 * Optional hook: fired whenever a persistence write fails (e.g. EACCES,
 * ENOSPC). Surfaced so the CLI, dashboard, or bootstrap can decide how
 * to react beyond the single console.warn. Not called for the initial
 * "directory unwritable" detection — that's stored in {@link isWritable}.
 */
export type DbWriteFailureListener = (err: unknown, filePath: string) => void;

export interface JsonFileWorkflowDbOptions {
  /** Override the resolved filePath. Kept for tests / advanced callers. */
  filePath?: string;
  /** Notified on every underlying write error. */
  onWriteFailure?: DbWriteFailureListener;
  /**
   * When true, if the preferred file path is unwritable, fall back to
   * `$HOME/.agent-relay/workflow-runs-<basename>.jsonl` so `--resume`
   * still works in environments where the workflow cwd is read-only
   * (cloud sandboxes with restrictive workspace ACLs).
   *
   * Defaults to `false` — strict "write to this path or run in-memory"
   * semantics, matching the pre-cache behavior. Opt-in via `true`.
   */
  homeFallback?: boolean;
}

export function shouldUseWorkflowDbHomeFallback(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DAYTONA_SANDBOX_ID || env.RELAY_CLOUD_PROVISIONING_DONE === '1') {
    return true;
  }

  return Boolean(
    env.RELAYFILE_TOKEN && (env.RELAYFILE_WORKSPACE_ID || env.RELAYFILE_WORKSPACE || env.RELAY_WORKSPACE_ID)
  );
}

/**
 * JSONL-backed WorkflowDb for the CLI.
 *
 * Design: the **in-memory cache is the single source of truth** for the
 * process lifetime. Every mutation updates the cache synchronously and
 * then best-effort appends to the jsonl file for durability / `--resume`.
 *
 * This matters because the runtime correctness of a running workflow
 * must not depend on disk writes succeeding. If the storage path is
 * unwritable (ACL-restricted workspace, full disk, ENOSPC), the workflow
 * still progresses through its state machine correctly — we just lose
 * the ability to resume a future process from that run.
 *
 * Read paths used to re-snapshot the jsonl on every call, which meant
 * a failed `updateRun(..., { status: 'completed' })` would leave a
 * subsequent `getRun` returning the stale 'running' row from disk.
 * That bug surfaced as workflows passing per-step but reporting
 * `status: 'running'` to callers.
 *
 * Storage path resolution:
 *   1. Try the caller-supplied file path. If the parent directory is
 *      writable, use it.
 *   2. If (1) fails and `homeFallback` is true (opt-in, default false),
 *      try `$HOME/.agent-relay/workflow-runs-<basename>.jsonl`. This is
 *      outside any workspace mount in cloud sandboxes and almost always
 *      writable by the agent.
 *   3. If both fail, run in memory-only mode. The workflow still
 *      executes correctly; `--resume` won't be available for this run.
 *
 * File: `.agent-relay/workflow-runs.jsonl` in the workflow cwd by default.
 */
export class JsonFileWorkflowDb implements WorkflowDb {
  private readonly filePath: string;

  /** Whether persistence is active. False = in-memory-only mode. */
  private readonly writable: boolean;
  private appendFailedOnce = false;
  private readonly onWriteFailure?: DbWriteFailureListener;

  /**
   * Authoritative in-memory mirror. Every mutation updates this; reads
   * return from here. The jsonl file is only consulted at construction
   * (to replay prior state for `--resume`) and is otherwise write-only.
   */
  private readonly cache: {
    runs: Map<string, WorkflowRunRow>;
    steps: Map<string, WorkflowStepRow>;
  };

  constructor(filePathOrOptions: string | JsonFileWorkflowDbOptions) {
    const options: JsonFileWorkflowDbOptions =
      typeof filePathOrOptions === 'string' ? { filePath: filePathOrOptions } : filePathOrOptions;
    this.onWriteFailure = options.onWriteFailure;

    const requestedPath = options.filePath ?? path.join('.agent-relay', 'workflow-runs.jsonl');
    const homeFallback = options.homeFallback ?? false;

    const { resolvedPath, writable } = JsonFileWorkflowDb.resolveStoragePath(requestedPath, homeFallback);
    this.filePath = resolvedPath;
    this.writable = writable;

    // Load existing state from disk (for --resume) once at construction.
    // From this point on, the cache is authoritative.
    this.cache = JsonFileWorkflowDb.loadSnapshot(this.filePath);
  }

  /** Returns false if persistence is not active (in-memory-only mode). */
  isWritable(): boolean {
    return this.writable;
  }

  /** Resolved path on disk. For tests + diagnostics. */
  getStoragePath(): string {
    return this.filePath;
  }

  hasStepOutputs(runId: string): boolean {
    try {
      const dir = path.join(path.dirname(this.filePath), 'step-outputs', runId);
      return existsSync(dir) && readdirSync(dir).length > 0;
    } catch {
      return false;
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private static resolveStoragePath(
    requestedPath: string,
    homeFallback: boolean
  ): { resolvedPath: string; writable: boolean } {
    const candidates: string[] = [requestedPath];
    if (homeFallback) {
      const base = path.basename(requestedPath) || 'workflow-runs.jsonl';
      candidates.push(path.join(os.homedir(), '.agent-relay', `workflow-runs-${base}`));
    }

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const isLastCandidate = i === candidates.length - 1;
      try {
        mkdirSync(path.dirname(candidate), { recursive: true });
        // If there's a later fallback to try, actively probe writability
        // so we know whether to move on. Two levels matter:
        //   1. Directory must be writable to create the jsonl file.
        //   2. If the jsonl file already exists, IT must also be writable
        //      — a writable directory does not guarantee a writable file.
        //      Relayfile-mount, for example, can sync a file and chmod it
        //      to 0o444 while leaving the parent dir at 0o755; the old
        //      dir-only check would accept the path and every append would
        //      then lazy-fail, bypassing the fallback.
        // If this is already the last candidate, skip the probe and be
        // optimistic — an unwritable path will surface as a lazy append()
        // failure handled by the cache + onWriteFailure path. Matches the
        // pre-cache "warn on first failure" semantic callers expect.
        if (!isLastCandidate) {
          accessSync(path.dirname(candidate), fsConstants.W_OK);
          if (existsSync(candidate)) {
            accessSync(candidate, fsConstants.W_OK);
          }
        }
        return { resolvedPath: candidate, writable: true };
      } catch {
        // Try the next candidate; if this was the last, fall through
        // to memory-only.
      }
    }

    // Memory-only mode. Path is reported for diagnostics but nothing
    // is written to it.
    return { resolvedPath: requestedPath, writable: false };
  }

  private static loadSnapshot(filePath: string): {
    runs: Map<string, WorkflowRunRow>;
    steps: Map<string, WorkflowStepRow>;
  } {
    const runs = new Map<string, WorkflowRunRow>();
    const steps = new Map<string, WorkflowStepRow>();
    let raw = '';
    try {
      raw = readFileSync(filePath, 'utf8');
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

  private append(entry: DbEntry): void {
    if (!this.writable) return;
    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      // Notify every failure so callers can aggregate / surface.
      this.onWriteFailure?.(err, this.filePath);
      // Warn to console once per process — subsequent failures are noise.
      if (!this.appendFailedOnce) {
        this.appendFailedOnce = true;
        console.warn(
          '[workflow] warning: failed to write run state to ' +
            this.filePath +
            ' — --resume will not be available for this run. Use --start-from instead. ' +
            'Error: ' +
            (err instanceof Error ? err.message : String(err))
        );
      }
    }
  }

  // ── WorkflowDb interface ─────────────────────────────────────────────────

  async insertRun(run: WorkflowRunRow): Promise<void> {
    // Shallow-copy so later mutations on the caller's object don't silently
    // alias into the cache. Matches InMemoryWorkflowDb semantics. The runner
    // keeps inserted rows in its own stepStates map and occasionally mutates
    // state.row.status directly before calling updateRun — without this copy
    // the mutation would land in the cache and bypass updateRun's
    // updatedAt + append path, causing exactly the observability hazard this
    // cache is meant to prevent.
    this.cache.runs.set(run.id, { ...run });
    this.append({ kind: 'run', row: run });
  }

  async updateRun(id: string, patch: Partial<WorkflowRunRow>): Promise<void> {
    const existing = this.cache.runs.get(id);
    if (!existing) return;
    const updated: WorkflowRunRow = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.cache.runs.set(id, updated);
    this.append({ kind: 'run', row: updated });
  }

  async getRun(id: string): Promise<WorkflowRunRow | null> {
    return this.cache.runs.get(id) ?? null;
  }

  async insertStep(step: WorkflowStepRow): Promise<void> {
    // Shallow-copy to prevent caller-mutation aliasing — see insertRun.
    this.cache.steps.set(step.id, { ...step });
    this.append({ kind: 'step', row: step });
  }

  async updateStep(id: string, patch: Partial<WorkflowStepRow>): Promise<void> {
    const existing = this.cache.steps.get(id);
    if (!existing) return;
    const updated: WorkflowStepRow = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.cache.steps.set(id, updated);
    this.append({ kind: 'step', row: updated });
  }

  async getStepsByRunId(runId: string): Promise<WorkflowStepRow[]> {
    return Array.from(this.cache.steps.values()).filter((s) => s.runId === runId);
  }
}
