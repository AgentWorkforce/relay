import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arm = process.env.RELAY_PR_PROOF_ARM;
const target = process.env.RELAY_PR_PROOF_TARGET_DIR;
const harness = process.env.RELAY_PR_PROOF_HARNESS_DIR;
const result = process.env.RELAY_PR_PROOF_RESULT_PATH;
assert(['base', 'head'].includes(arm) && target && harness && result, 'Missing proof environment');
rmSync(result, { force: true });
assert.equal(
  execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  process.env[arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA']
);
const relative = path.relative(harness, fileURLToPath(import.meta.url));
assert(!relative.startsWith('..') && !path.isAbsolute(relative), 'Runner is outside the head checkout');

// Execute the exact checkout's validator without launching an agent or rebuilding
// unrelated packages. Node's native type stripping requires Node 22.6 or newer.
const probe = spawnSync(
  process.execPath,
  [
    '--experimental-strip-types',
    '--input-type=module',
    '-e',
    `
  import { pathToFileURL } from 'node:url';
  const { validateTaskSize } = await import(pathToFileURL(process.argv[1]).href);
  const outcomes = {};
  for (const cli of ['claude', 'codex', 'muse']) {
    try { validateTaskSize('x'.repeat(2000), { cli }); outcomes[cli] = 'accepted'; }
    catch (error) {
      if (!error.message.startsWith('Task exceeds')) throw error;
      outcomes[cli] = 'rejected';
    }
  }
  validateTaskSize('read /brief.md', { cli: 'claude' });
  console.log(JSON.stringify(outcomes));
`,
    path.join(target, 'packages/cli/src/cli/lib/task-input.ts'),
  ],
  { encoding: 'utf8', timeout: 30000 }
);
assert(!probe.error && probe.status === 0, `Probe setup failed: ${probe.error?.message ?? probe.stderr}`);
const outcomes = JSON.parse(probe.stdout);
assert.equal(outcomes.codex, 'accepted', 'Bulk-write recipients must keep their larger limit');
assert.equal(outcomes.muse, 'accepted', 'Argv tasks must not inherit the typed-wire limit');
assert(['accepted', 'rejected'].includes(outcomes.claude));
const fixed = outcomes.claude === 'rejected';
writeFileSync(
  result,
  JSON.stringify({
    version: 1,
    caseId: '1960-recipient-wire-size',
    arm,
    outcome: fixed ? 'fixed' : 'bug',
    signature: fixed ? 'typed_task_rejected_before_launch' : 'typed_task_admitted',
    details: JSON.stringify(outcomes),
  }) + '\n'
);
