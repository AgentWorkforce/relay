#!/usr/bin/env node

/**
 * Run `relay.verify.features` with the lifecycle v1 wrapped around `wf.run()`.
 *
 * A generated spec is executed by the `flows` CLI, so the prepare/cleanup
 * bracket and the verdict-derived exit code can no longer live inside the flow
 * file. They live here instead, unchanged in order and meaning:
 *
 *   prepare artifacts → prepare worktree → generate → check → run
 *     → read verdict.json → escalation delivery audit → exit code
 *     → remove worktree → mark artifacts complete
 *
 * The exit code answers "did verification pass", not "did the run succeed":
 *
 *   0  verdict PASS and escalations delivered
 *   1  verdict not PASS
 *   2  no verdict for this run, or escalation delivery failed — harness breakage
 *
 * `--check-only` stops after `flows check`, which is the v2 replacement for
 * v1's `DRY_RUN=1`: it validates the graph without executing it.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import {
  markRunArtifactsComplete,
  prepareRunArtifacts,
} from '../../scripts/verify-features/run-artifacts.mjs';
import { prepareRunWorktree, removeRunWorktree } from '../../scripts/verify-features/run-worktree.mjs';
import {
  ARTIFACTS,
  ARTIFACTS_ROOT,
  AUTOFIX,
  ESCALATION_STATUS_TOOL,
  REPO_ROOT,
  RUN_ID,
  RUN_NONCE,
  RUN_WORKTREE,
  VERDICT_FILE,
  WORKTREE_ROOT,
} from './features.spec.ts';

const SPEC = '.workflow-artifacts/flows/relay.verify.features.json';
const CHECK_ONLY = process.argv.includes('--check-only');

function run(command: string, args: string[]): number {
  const { status } = spawnSync(command, args, {
    stdio: 'inherit',
    // The generator derives its run identity from these when set, so the spec
    // it emits points at the directory this runner prepared and reads.
    env: { ...process.env, VERIFY_RUN_ID: RUN_ID, VERIFY_RUN_NONCE: RUN_NONCE },
  });
  return status ?? 2;
}

async function main(): Promise<void> {
  if (!CHECK_ONLY) prepareRunArtifacts(ARTIFACTS_ROOT, RUN_ID, RUN_NONCE);

  if (
    run(process.execPath, ['--experimental-strip-types', 'flows/verify/features.spec.ts', '--out', SPEC]) !==
    0
  ) {
    console.error('[verify-features] could not generate the flow spec');
    process.exitCode = 2;
    return;
  }
  if (run('npx', ['flows', 'check', SPEC]) !== 0) {
    console.error('[verify-features] flows check refused the generated spec');
    process.exitCode = 2;
    return;
  }
  if (CHECK_ONLY) return;

  let workflowLifecycleCompleted = false;
  try {
    const preparedWorktree = await prepareRunWorktree(REPO_ROOT, WORKTREE_ROOT, RUN_ID);
    if (preparedWorktree !== RUN_WORKTREE) {
      throw new Error(`prepared unexpected worktree path: ${preparedWorktree}`);
    }
    // Only a run that actually reached a terminal flow state may mark its
    // artifacts complete. A failed launch — `flows run` exiting before it
    // produces verdict.json — would otherwise get a completion marker, and
    // retention would treat a partial artifact directory as a finished run.
    // v1 set this after `wf.run()` returned a result, which is the same bar.
    const runStatus = run('npx', ['flows', 'run', SPEC]);
    workflowLifecycleCompleted = existsSync(VERDICT_FILE);
    if (runStatus !== 0 && !workflowLifecycleCompleted) {
      console.error(`[verify-features] flows run exited ${runStatus} before producing a verdict`);
    }

    // Read the verdict directly rather than trusting the run's row status, and
    // fail closed when it is missing: a run with four failing checks must not
    // exit 0 just because every step completed.
    let verdict: {
      runId?: string;
      verdict?: string;
      reasons?: string[];
      totals?: Record<string, number>;
    } | null = null;
    if (existsSync(VERDICT_FILE)) {
      try {
        verdict = JSON.parse(readFileSync(VERDICT_FILE, 'utf8'));
      } catch (err) {
        console.error(`[verify-features] verdict.json is unreadable: ${(err as Error).message}`);
      }
    }

    if (!verdict || verdict.runId !== RUN_ID) {
      console.error(
        `[verify-features] no verdict for run ${RUN_ID} at ${VERDICT_FILE} — treating this run as FAILED. ` +
          'The verification pipeline did not complete; this is harness breakage, not a clean run.'
      );
      process.exitCode = 2;
      return;
    }

    const totals = verdict.totals ?? {};
    console.log(
      `[verify-features] verdict=${verdict.verdict} ` +
        `pass=${totals.pass ?? '?'} fail=${totals.fail ?? '?'} skip=${totals.skip ?? '?'}`
    );
    if (verdict.verdict !== 'PASS') {
      console.error(`[verify-features] FAILED: ${(verdict.reasons ?? []).join('; ')}`);
    }

    const escalationAuditArgs =
      verdict.verdict === 'PASS'
        ? [ESCALATION_STATUS_TOOL, 'audit-channel', ARTIFACTS, 'posthog', '1', '0']
        : [ESCALATION_STATUS_TOOL, 'audit', ARTIFACTS, AUTOFIX ? '1' : '0'];
    const escalationAudit = spawnSync(process.execPath, escalationAuditArgs, {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    if (escalationAudit.stdout) process.stdout.write(escalationAudit.stdout);
    if (escalationAudit.stderr) process.stderr.write(escalationAudit.stderr);
    if (escalationAudit.status !== 0) {
      console.error(
        '[verify-features] ESCALATION DELIVERY FAILED independently of the flow DAG ' +
          `(audit exit ${escalationAudit.status ?? 'unknown'})`
      );
      process.exitCode = 2;
    } else if (verdict.verdict !== 'PASS') {
      process.exitCode = 1;
    }
  } finally {
    try {
      await removeRunWorktree(REPO_ROOT, RUN_WORKTREE);
    } catch (cleanupError) {
      console.error(
        `[verify-features] worktree cleanup failed: ${
          cleanupError instanceof Error ? cleanupError.stack : String(cleanupError)
        }`
      );
    }
    if (workflowLifecycleCompleted) {
      try {
        markRunArtifactsComplete(ARTIFACTS, RUN_ID);
      } catch (completionError) {
        console.error(
          `[verify-features] artifact completion marker failed: ${
            completionError instanceof Error ? completionError.stack : String(completionError)
          }`
        );
      }
    }
  }
}

main().catch((err: unknown) => {
  // A throw here means the harness itself broke — the runner could not even
  // produce a result. That is the NightCTO escalation case, and it must not
  // exit 0.
  console.error(`[verify-features] harness failure: ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 2;
});
