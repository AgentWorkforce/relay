import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = '2100-copilot-native-mcp-route';
const caseDir = path.dirname(fileURLToPath(import.meta.url));
const arm = required('RELAY_PR_PROOF_ARM');
assert(['base', 'head'].includes(arm), 'Unknown proof arm.');
const target = await realpath(required('RELAY_PR_PROOF_TARGET_DIR'));
const harness = await realpath(required('RELAY_PR_PROOF_HARNESS_DIR'));
const resultPath = path.resolve(required('RELAY_PR_PROOF_RESULT_PATH'));
const baseSha = sha('RELAY_PR_PROOF_BASE_SHA');
const headSha = sha('RELAY_PR_PROOF_HEAD_SHA');
assert.notEqual(baseSha, headSha, 'Base and head must differ.');
assert.equal(gitSha(target), arm === 'base' ? baseSha : headSha, 'Target SHA mismatch.');
assert.equal(gitSha(harness), headSha, 'Harness SHA mismatch.');
assert.equal(
  await realpath(caseDir),
  path.join(harness, 'tests/relayflows/cases', CASE_ID),
  'Runner is not from the exact-head harness.'
);
const scratch = await mkdtemp(path.join(os.tmpdir(), 'relay-2100-proof-'));
try {
  const consumer = path.join(scratch, 'consumer');
  await mkdir(path.join(consumer, 'src'), { recursive: true });
  await copyFile(path.join(caseDir, 'fixture.rs'), path.join(consumer, 'src/main.rs'));
  // Seed exact-target dependency resolutions without mutating its manifest or lock.
  await copyFile(path.join(target, 'crates/relay-node/Cargo.lock'), path.join(consumer, 'Cargo.lock'));
  await writeFile(
    path.join(consumer, 'Cargo.toml'),
    `[package]\nname = "relay-pr-2100-consumer"\nversion = "0.0.0"\nedition = "2021"\n\n[workspace]\n\n[dependencies]\nagent-relay-node = { path = ${JSON.stringify(path.join(target, 'crates/relay-node'))}, default-features = false }\nfutures-util = "0.3"\nserde_json = "1"\ntempfile = "3"\ntokio = { version = "1", features = ["rt-multi-thread", "macros"] }\n\n[profile.dev]\ndebug = 0\nincremental = false\n`
  );
  const targetDir = process.env.RELAY_PR_PROOF_CARGO_TARGET_DIR
    ? path.resolve(process.env.RELAY_PR_PROOF_CARGO_TARGET_DIR)
    : path.join(scratch, 'target');
  const env = childEnv();
  env.CARGO_INCREMENTAL = '0';
  env.CARGO_BUILD_JOBS = '2';
  env.AGENT_RELAY_PROBE_GIT_DIR = target;
  run(
    'cargo',
    ['build', '--quiet', '--manifest-path', path.join(consumer, 'Cargo.toml'), '--target-dir', targetDir],
    { cwd: consumer, env, timeout: 1_050_000 }
  );
  const output = run(
    path.join(targetDir, 'debug', `relay-pr-2100-consumer${process.platform === 'win32' ? '.exe' : ''}`),
    [],
    { cwd: scratch, env, timeout: 30_000 }
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
  assert.equal(gitSha(target), arm === 'base' ? baseSha : headSha, 'Target moved during proof.');
  assert.equal(gitSha(harness), headSha, 'Harness moved during proof.');
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome: arm === 'base' ? 'bug' : 'fixed', signature: arm === 'base' ? 'copilot_native_mcp_route_unreachable' : 'copilot_native_mcp_route_reaches_account', details: JSON.stringify(actual) })}\n`,
    { mode: 0o600 }
  );
  console.log(JSON.stringify({ caseId: CASE_ID, arm, observed: actual }));
} finally {
  await rm(scratch, { recursive: true, force: true });
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

/** Bound process duration/output; a nonzero exit always fails the proof. */
function run(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    killSignal: 'SIGKILL',
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Proof subprocess failed (${command}, status ${result.status}, signal ${result.signal}): ${result.error?.message ?? ''}\n${result.stderr?.slice(-6000) ?? ''}`
    );
  }
  return result.stdout;
}

/** Read one checkout's actual identity through Git, not caller assertions. */
function gitSha(directory) {
  return run('git', ['-C', directory, 'rev-parse', 'HEAD'], { timeout: 10_000, env: childEnv() }).trim();
}

/** Exclude provider credentials, loader injections and Relay overrides from child processes. */
function childEnv() {
  return Object.fromEntries(
    [
      'PATH',
      'HOME',
      'CARGO_HOME',
      'RUSTUP_HOME',
      'TMPDIR',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'SystemRoot',
      'WINDIR',
    ]
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]])
  );
}
