import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const target = process.env.RELAY_PR_PROOF_TARGET_DIR;
const harness = process.env.RELAY_PR_PROOF_HARNESS_DIR;
const resultPath = process.env.RELAY_PR_PROOF_RESULT_PATH;
if (!target || !harness || !resultPath) throw new Error('Missing proof environment');
const script = join(target, 'scripts/fleet/disk_reaper.py');
let observation;
if (!existsSync(script)) {
  observation = {
    outcome: 'absent',
    signature: 'fleet_disk_reaper_absent',
    details: 'Target checkout has no fleet disk reaper entry point.',
  };
} else {
  // The same real-Git fixtures from HEAD exercise production code in TARGET.
  // Missing tests, skipped tests, timeouts, or interpreter errors are failures.
  const result = spawnSync(
    'python3',
    ['-m', 'unittest', 'discover', '-s', join(harness, 'tests/fleet'), '-v'],
    {
      cwd: target,
      env: { ...process.env, DISK_REAPER_TARGET: target, PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8',
      timeout: 240_000,
    }
  );
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  // unittest writes its summary to stderr. Require exactly one positive count;
  // a successful exit or a test's stdout cannot prove that discovery ran tests.
  const summaries = [...(result.stderr ?? '').matchAll(/^Ran (\d+) tests? in .+$/gm)];
  const testCount = summaries.length === 1 ? Number(summaries[0][1]) : 0;
  if (
    result.error ||
    result.status !== 0 ||
    !Number.isSafeInteger(testCount) ||
    testCount <= 0 ||
    /skipped=/i.test(output)
  ) {
    throw new Error('Fleet reaper safety harness did not complete successfully');
  }
  observation = {
    outcome: 'fixed',
    signature: 'fleet_disk_reaper_safety_verified',
    details:
      'Real Git fixtures verified dry-run/apply, dirty/untracked/unpushed retention, active cwd/lease retention, cache guards and merged worktree removal against target production code.',
  };
}
writeFileSync(
  resultPath,
  JSON.stringify({
    version: 1,
    caseId: 'fleet-disk-reaper',
    arm: process.env.RELAY_PR_PROOF_ARM,
    ...observation,
  })
);
