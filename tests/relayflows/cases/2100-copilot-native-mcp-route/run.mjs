import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertArmIdentity, assertProofInputs, childEnv, externalPath, run } from './guards.mjs';
import { createReceipt } from './receipt.mjs';

const CASE_ID = '2100-copilot-native-mcp-route';
const caseDir = path.dirname(fileURLToPath(import.meta.url));
const arm = required('RELAY_PR_PROOF_ARM');
const target = await realpath(required('RELAY_PR_PROOF_TARGET_DIR'));
const harness = await realpath(required('RELAY_PR_PROOF_HARNESS_DIR'));
const resultPath = await externalPath(required('RELAY_PR_PROOF_RESULT_PATH'), [target, harness], 'Result');
const baseSha = sha('RELAY_PR_PROOF_BASE_SHA');
const headSha = sha('RELAY_PR_PROOF_HEAD_SHA');
assertArmIdentity(arm, baseSha, headSha);
const inputs = { target, harness, targetSha: arm === 'base' ? baseSha : headSha, headSha };
await assertProofInputs(inputs, 'before');
// Load the shared corpus validator only after its tracked provenance is checked.
const { validateCaseManifest, validateObservation } =
  await import('../../../../scripts/verify-features/case-contract.mjs');
const manifest = validateCaseManifest(JSON.parse(await readFile(path.join(caseDir, 'case.json'), 'utf8')), {
  caseId: CASE_ID,
  kind: 'bugfix',
});
assert.equal(
  await realpath(caseDir),
  path.join(harness, 'tests/relayflows/cases', CASE_ID),
  'Runner is not from the exact-head harness.'
);
const cache = process.env.RELAY_PR_PROOF_CARGO_TARGET_DIR
  ? await externalPath(process.env.RELAY_PR_PROOF_CARGO_TARGET_DIR, [target, harness])
  : null;
const scratchParent = await externalPath(os.tmpdir(), [target, harness], 'Scratch parent');
const receipt = await createReceipt(resultPath, [target, harness]);
let scratch;
try {
  scratch = await mkdtemp(path.join(scratchParent, 'relay-2100-proof-'));
  assert.equal(
    await externalPath(scratch, [target, harness], 'Scratch'),
    scratch,
    'Scratch directory changed.'
  );
  const consumer = path.join(scratch, 'consumer');
  await mkdir(path.join(consumer, 'src'), { recursive: true });
  await copyFile(path.join(caseDir, 'fixture.rs'), path.join(consumer, 'src/main.rs'));
  // Seed exact-target dependency resolutions without mutating its manifest or lock.
  await copyFile(path.join(target, 'crates/relay-node/Cargo.lock'), path.join(consumer, 'Cargo.lock'));
  await writeFile(
    path.join(consumer, 'Cargo.toml'),
    `[package]\nname = "relay-pr-2100-consumer"\nversion = "0.0.0"\nedition = "2021"\n\n[workspace]\n\n[dependencies]\nagent-relay-node = { path = ${JSON.stringify(path.join(target, 'crates/relay-node'))}, default-features = false }\nfutures-util = "0.3"\nserde_json = "1"\ntempfile = "3"\ntokio = { version = "1", features = ["rt-multi-thread", "macros"] }\n\n[profile.dev]\ndebug = 0\nincremental = false\n`
  );
  const targetDir = cache ?? path.join(scratch, 'target');
  const env = childEnv();
  env.CARGO_INCREMENTAL = '0';
  env.CARGO_BUILD_JOBS = '2';
  env.AGENT_RELAY_PROBE_GIT_DIR = target;
  await run(
    'cargo',
    ['build', '--quiet', '--manifest-path', path.join(consumer, 'Cargo.toml'), '--target-dir', targetDir],
    { cwd: consumer, env, timeoutMs: 1_050_000 }
  );
  const output = await run(
    path.join(targetDir, 'debug', `relay-pr-2100-consumer${process.platform === 'win32' ? '.exe' : ''}`),
    [],
    { cwd: scratch, env, timeoutMs: 30_000 }
  );
  const actual = JSON.parse(output.trim());
  const missing = { status: 404, code: 'not_found' };
  const unavailable = { status: 409, code: 'copilot_dispatch_unavailable' };
  const refused = { status: 403, code: 'fixture_peer_refused' };
  const expected =
    arm === 'base'
      ? {
          managed: missing,
          wrongPid: missing,
          wrongUid: missing,
          get: missing,
          noAccount: missing,
          declined: missing,
          control: { status: 409, code: 'attestation_unavailable' },
          managedCalls: 0,
          declinedCalls: 0,
          peerForwarding: false,
        }
      : {
          managed: { status: 200, id: 'native-init', protocol: '2025-03-26' },
          wrongPid: refused,
          wrongUid: refused,
          get: missing,
          noAccount: unavailable,
          declined: unavailable,
          control: { status: 409, code: 'attestation_unavailable' },
          managedCalls: 3,
          declinedCalls: 1,
          peerForwarding: true,
        };
  // Unexpected errors and absent behavior are infrastructure failures, never an expected-red substitute.
  assert.deepEqual(actual, expected, 'Production route observation did not match the complete arm contract.');
  await assertProofInputs(inputs, 'after');
  if (cache)
    assert.equal(await externalPath(cache, [target, harness]), cache, 'Cargo target changed during proof.');
  const observation = validateObservation(
    {
      version: 1,
      caseId: CASE_ID,
      arm,
      outcome: arm === 'base' ? 'bug' : 'fixed',
      signature:
        arm === 'base' ? 'copilot_native_mcp_route_unreachable' : 'copilot_native_mcp_route_reaches_account',
      details: JSON.stringify(actual),
    },
    { caseId: CASE_ID, arm, expected: manifest.expected[arm] }
  );
  await receipt.write(`${JSON.stringify(observation)}\n`);
  console.log(JSON.stringify({ caseId: CASE_ID, arm, observed: actual }));
} finally {
  try {
    await receipt.close();
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

/** Require one wrapper-supplied value without inferring an arm or checkout. */
function required(name) {
  const value = process.env[name]?.trim();
  assert(value, `Missing ${name}.`);
  return value;
}

/** Require an exact Git commit identity. */
function sha(name) {
  const value = required(name);
  assert(/^[0-9a-f]{40}$/.test(value), `Invalid ${name}.`);
  return value;
}
