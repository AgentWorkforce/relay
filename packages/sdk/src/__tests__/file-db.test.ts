/**
 * Tests for JsonFileWorkflowDb — in-memory cache is authoritative.
 *
 * Regression: before this file existed, `getRun` re-read the jsonl from
 * disk on every call. If a write failed (EACCES in cloud, ENOSPC, etc.)
 * the cache-less implementation would return stale data, which in turn
 * caused `WorkflowRunner.execute()` to report a completed run as
 * `status: 'running'` to callers.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JsonFileWorkflowDb } from '../workflows/file-db.js';
import type { WorkflowRunRow, WorkflowStepRow } from '../workflows/types.js';

function makeRun(overrides: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  const now = new Date().toISOString();
  return {
    id: 'run_test',
    workflowName: 'test',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeStep(overrides: Partial<WorkflowStepRow> = {}): WorkflowStepRow {
  const now = new Date().toISOString();
  return {
    id: 'step_test',
    runId: 'run_test',
    stepName: 'test-step',
    status: 'pending',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('JsonFileWorkflowDb', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'filedb-test-'));
  });

  afterEach(() => {
    try {
      // Restore perms in case a test made the dir read-only.
      chmodSync(tmpDir, 0o755);
    } catch {
      /* no-op */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips a run through cache without re-reading disk', async () => {
    const dbPath = path.join(tmpDir, 'workflow-runs.jsonl');
    const db = new JsonFileWorkflowDb(dbPath);
    expect(db.isWritable()).toBe(true);

    await db.insertRun(makeRun({ id: 'run_1', status: 'running' }));
    await db.updateRun('run_1', { status: 'completed' });

    const run = await db.getRun('run_1');
    expect(run?.status).toBe('completed');

    // The new write should also be durable.
    const raw = readFileSync(dbPath, 'utf8');
    expect(raw).toContain('"status":"completed"');
  });

  it('returns the latest run status even when the disk write silently fails', async () => {
    // Deny writes to the storage directory so appendFileSync throws EACCES.
    // On directories the mode controls whether new entries can be added —
    // existing files inside become effectively read-only for append.
    const dbPath = path.join(tmpDir, 'workflow-runs.jsonl');
    const db = new JsonFileWorkflowDb(dbPath);
    await db.insertRun(makeRun({ id: 'run_1', status: 'running' }));

    // Revoke directory write permission AFTER the initial insert so the
    // next append fails while the cache should still track the update.
    chmodSync(tmpDir, 0o555);

    await db.updateRun('run_1', { status: 'completed' });

    // The in-memory mirror must reflect the update regardless of disk state.
    const run = await db.getRun('run_1');
    expect(run?.status).toBe('completed');
  });

  it('keeps cache state authoritative when disk writes lazy-fail (default, no fallback)', async () => {
    // With homeFallback default (false), the constructor is optimistic about
    // an unwritable directory — writable=true, first append() throws lazily.
    // The key invariant: cache state is NOT lost even when the durable write
    // never lands. This is the regression guard for the "workflow passes but
    // reports status: running" bug.
    const unwritableDir = path.join(tmpDir, 'unwritable');
    mkdirSync(unwritableDir, { recursive: true });
    chmodSync(unwritableDir, 0o555);
    const blockedPath = path.join(unwritableDir, 'workflow-runs.jsonl');

    const db = new JsonFileWorkflowDb(blockedPath); // default homeFallback: false
    expect(db.isWritable()).toBe(true);

    await db.insertRun(makeRun({ id: 'run_mem', status: 'running' }));
    await db.updateRun('run_mem', { status: 'completed' });

    const run = await db.getRun('run_mem');
    expect(run?.status).toBe('completed');
    // The jsonl was never created — disk writes all failed.
    expect(existsSync(blockedPath)).toBe(false);
  });

  it('opt-in homeFallback: true → unwritable path routes to $HOME/.agent-relay', () => {
    const unwritableDir = path.join(tmpDir, 'unwritable');
    mkdirSync(unwritableDir, { recursive: true });
    chmodSync(unwritableDir, 0o555);
    const blockedPath = path.join(unwritableDir, 'workflow-runs.jsonl');

    const db = new JsonFileWorkflowDb({
      filePath: blockedPath,
      homeFallback: true,
    });

    const resolved = db.getStoragePath();
    expect(db.isWritable()).toBe(true);
    expect(resolved.startsWith(os.homedir())).toBe(true);
    expect(resolved).toContain(path.join('.agent-relay', 'workflow-runs-workflow-runs.jsonl'));
  });

  // Regression for PR #757 Codex review feedback: the primary path's
  // directory can be writable while the jsonl file itself is read-only
  // (relayfile-mount chmods synced files to 0o444 while leaving the
  // parent dir at 0o755). The old dir-only probe would accept the
  // primary path, every append would lazy-fail, and homeFallback
  // would never kick in despite the caller explicitly opting in.
  it('opt-in homeFallback: true → read-only file with writable dir still falls back', () => {
    const writableDir = path.join(tmpDir, 'project');
    mkdirSync(writableDir, { recursive: true });
    const primaryPath = path.join(writableDir, 'workflow-runs.jsonl');
    writeFileSync(primaryPath, ''); // create the file so chmod targets it
    chmodSync(primaryPath, 0o444); // file read-only; dir still 0o755

    const db = new JsonFileWorkflowDb({
      filePath: primaryPath,
      homeFallback: true,
    });

    const resolved = db.getStoragePath();
    expect(db.isWritable()).toBe(true);
    expect(resolved.startsWith(os.homedir())).toBe(true);
    expect(resolved).not.toBe(primaryPath);
  });

  it('notifies onWriteFailure on every failed append', async () => {
    const dbPath = path.join(tmpDir, 'workflow-runs.jsonl');
    const failures: Array<{ err: unknown; filePath: string }> = [];
    const db = new JsonFileWorkflowDb({
      filePath: dbPath,
      homeFallback: false,
      onWriteFailure: (err, filePath) => failures.push({ err, filePath }),
    });

    await db.insertRun(makeRun({ id: 'run_1', status: 'running' }));

    // Making the file itself read-only forces appendFileSync to throw.
    // (Directory chmod alone is insufficient because appending to an
    // already-open inode doesn't require directory write.)
    chmodSync(dbPath, 0o444);

    await db.updateRun('run_1', { status: 'completed' });
    await db.updateRun('run_1', { status: 'completed' }); // second failure — listener should fire again

    expect(failures.length).toBeGreaterThanOrEqual(2);
    expect(failures[0].filePath).toBe(dbPath);

    // The cache still reflects the latest state regardless of the write failure.
    const run = await db.getRun('run_1');
    expect(run?.status).toBe('completed');
  });

  it('replays existing jsonl on construction (--resume path)', async () => {
    const dbPath = path.join(tmpDir, 'workflow-runs.jsonl');

    {
      const db = new JsonFileWorkflowDb(dbPath);
      await db.insertRun(makeRun({ id: 'run_replay', status: 'running' }));
      await db.insertStep(makeStep({ id: 'step_1', runId: 'run_replay', status: 'pending' }));
      await db.updateStep('step_1', { status: 'completed' });
      await db.updateRun('run_replay', { status: 'completed' });
    }

    // Fresh instance should see the replayed state.
    const reloaded = new JsonFileWorkflowDb(dbPath);
    const run = await reloaded.getRun('run_replay');
    expect(run?.status).toBe('completed');

    const steps = await reloaded.getStepsByRunId('run_replay');
    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe('completed');
  });

  // Regression for PR #757 Devin review: InMemoryWorkflowDb shallow-copies
  // on insert, JsonFileWorkflowDb previously stored the caller's object by
  // reference. The runner inserts a row and also keeps it in its own map,
  // then mutates state.row.status directly before calling updateStep/Run —
  // if the cache held the same reference, those mutations would silently
  // bypass updateStep's append + timestamp handling.
  it('insertRun/insertStep do not alias the caller object into the cache', async () => {
    const dbPath = path.join(tmpDir, 'workflow-runs.jsonl');
    const db = new JsonFileWorkflowDb(dbPath);

    const run = makeRun({ id: 'run_alias', status: 'running' });
    await db.insertRun(run);

    // Mutate the caller's object post-insert — shouldn't reach the cache.
    run.status = 'failed';
    run.error = 'direct mutation should not leak into the db';

    const cached = await db.getRun('run_alias');
    expect(cached?.status).toBe('running');
    expect(cached?.error).toBeUndefined();

    const step = makeStep({ id: 'step_alias', runId: 'run_alias', status: 'pending' });
    await db.insertStep(step);
    step.status = 'failed';
    step.error = 'same hazard';

    const cachedSteps = await db.getStepsByRunId('run_alias');
    expect(cachedSteps).toHaveLength(1);
    expect(cachedSteps[0].status).toBe('pending');
    expect(cachedSteps[0].error).toBeUndefined();
  });

  it('cache insert/update is visible to getStepsByRunId without a disk round-trip', async () => {
    const dbPath = path.join(tmpDir, 'workflow-runs.jsonl');
    const db = new JsonFileWorkflowDb(dbPath);

    await db.insertStep(makeStep({ id: 's1', runId: 'r1', stepName: 'a', status: 'pending' }));
    await db.insertStep(makeStep({ id: 's2', runId: 'r1', stepName: 'b', status: 'pending' }));
    await db.updateStep('s1', { status: 'completed' });

    const steps = await db.getStepsByRunId('r1');
    expect(steps.map((s) => `${s.stepName}=${s.status}`).sort()).toEqual(['a=completed', 'b=pending']);
  });

  it('hasStepOutputs still works relative to the resolved storage path', () => {
    const dbPath = path.join(tmpDir, 'workflow-runs.jsonl');
    const db = new JsonFileWorkflowDb(dbPath);

    const outputsDir = path.join(tmpDir, 'step-outputs', 'run_x');
    mkdirSync(outputsDir, { recursive: true });
    // Drop a file so readdirSync reports length > 0.
    writeFileSync(path.join(outputsDir, 'out.txt'), 'hi');

    expect(db.hasStepOutputs('run_x')).toBe(true);
    expect(db.hasStepOutputs('run_y')).toBe(false);
    expect(existsSync(dbPath)).toBe(false); // no writes happened yet
  });
});
