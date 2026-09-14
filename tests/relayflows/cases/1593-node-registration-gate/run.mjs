// Execute the same real-loopback socket regression against each exact source
// revision. The production run_connected_once function is unchanged by the
// harness; only a cfg(test) module is installed in an isolated checkout.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const required = (name) => {
  const v = process.env[name];
  if (!v) throw Error(`Missing ${name}`);
  return v;
};
const target = required('RELAY_PR_PROOF_TARGET_DIR');
const harness = required('RELAY_PR_PROOF_HARNESS_DIR');
const resultPath = required('RELAY_PR_PROOF_RESULT_PATH');
const arm = required('RELAY_PR_PROOF_ARM');
assert.ok(['base', 'head'].includes(arm));
const sha = required(arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA');
assert.equal(execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sha);
const relative = path.relative(harness, fileURLToPath(import.meta.url));
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
const temp = await mkdtemp(path.join(path.dirname(target), '.registration-proof-'));
const checkout = path.join(temp, 'target');
let added = false;
try {
  execFileSync('git', ['-C', target, 'worktree', 'add', '--detach', checkout, sha], { stdio: 'pipe' });
  added = true;
  const sourcePath = path.join(checkout, 'crates/broker/src/node_control.rs');
  let source = await readFile(sourcePath, 'utf8');
  let test = await readFile(
    path.join(harness, 'crates/broker/src/node_control/registration_tests.rs'),
    'utf8'
  );
  // Older source revisions have no optional instrumentation handle.
  if (!source.includes('pub(crate) probe:')) test = test.replace(/^\s*probe: None,\n/gm, '\n');
  if (!source.includes('mod registration_tests;')) source += '\n#[cfg(test)]\nmod registration_tests;\n';
  await writeFile(sourcePath, source);
  await mkdir(path.join(checkout, 'crates/broker/src/node_control'), { recursive: true });
  await writeFile(path.join(checkout, 'crates/broker/src/node_control/registration_tests.rs'), test);
  const env = {
    ...process.env,
    CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? path.join(target, 'target'),
  };
  for (const key of Object.keys(env))
    if (key.startsWith('GIT_CONFIG_') || key.startsWith('RELAY_ATTEST_')) delete env[key];
  const run = spawnSync(
    'cargo',
    [
      'test',
      '-p',
      'agent-relay-broker',
      '--lib',
      'node_control::registration_tests::rejected_registration_never_advertises_or_syncs',
      '--',
      '--exact',
    ],
    { cwd: checkout, env, encoding: 'utf8', timeout: 840000, maxBuffer: 8 * 1024 * 1024 }
  );
  const output = (run.stdout ?? '') + (run.stderr ?? '');
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath + '.log', output);
  if (run.error) throw run.error;
  let outcome, signature;
  if (run.status === 0 && /1 passed; 0 failed/.test(output)) {
    outcome = 'fixed';
    signature = 'rejected_registration_never_opens_delivery_path';
  } else if (
    run.status === 101 &&
    /registration-dependent frame escaped gate: "inventory.sync"/.test(output) &&
    /0 passed; 1 failed/.test(output)
  ) {
    outcome = 'bug';
    signature = 'rejected_registration_still_publishes_inventory';
  } else
    throw Error(
      `The socket regression did not reach a recognized outcome (exit ${run.status}); inspect its transcript.`
    );
  await writeFile(
    resultPath,
    JSON.stringify({
      version: 1,
      caseId: '1593-node-registration-gate',
      arm,
      outcome,
      signature,
      details:
        'A real loopback WebSocket peer rejects node.register while keeping transport open. The exact target production node-control loop must disconnect without advertising Connected or sending inventory.sync; compilation and unrelated failures are not evidence.',
    }) + '\n'
  );
  console.log(signature);
} finally {
  if (added)
    execFileSync('git', ['-C', target, 'worktree', 'remove', '--force', checkout], { stdio: 'pipe' });
  await rm(temp, { recursive: true, force: true });
}
