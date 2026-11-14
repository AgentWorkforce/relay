import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const caseId = 'factory-droid-persistent-native-worker';
// PR proof and targeted verification run on Linux. A manual Windows run is
// unsupported and must never emit a passing proof observation.
if (process.platform === 'win32') {
  console.error('Factory Droid managed messaging proof is unsupported on Windows.');
  process.exit(77);
}
const required = (name) => {
  assert(process.env[name], `Missing ${name}`);
  return process.env[name];
};
const arm = required('RELAY_PR_PROOF_ARM');
assert(['base', 'head'].includes(arm));
const target = path.resolve(required('RELAY_PR_PROOF_TARGET_DIR'));
const harness = path.resolve(required('RELAY_PR_PROOF_HARNESS_DIR'));
const resultPath = path.resolve(required('RELAY_PR_PROOF_RESULT_PATH'));
for (const [directory, revision] of [
  [target, required(arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA')],
  [harness, required('RELAY_PR_PROOF_HEAD_SHA')],
]) {
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim(),
    revision
  );
  execFileSync('git', ['diff', '--quiet', revision, '--'], { cwd: directory });
}
await rm(resultPath, { force: true });
const directory = await mkdtemp(path.join(tmpdir(), 'relay-factory-proof-'));
const targetDir = process.env.RELAY_PR_PROOF_CARGO_TARGET_DIR ?? path.join(directory, 'target');
let proofError;
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: target,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 12 * 60 * 1000,
    ...options,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed: ${(result.stderr ?? '').slice(-4000)}`);
  return result;
};
const observe = async (outcome, signature, details) => {
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId, arm, outcome, signature, details }, null, 2)}\n`
  );
};

try {
  run(
    'cargo',
    [
      'build',
      '--locked',
      '--quiet',
      '--manifest-path',
      'crates/relay-node/Cargo.toml',
      '--bin',
      'agent-relay-node',
    ],
    { env: { ...process.env, CARGO_TARGET_DIR: targetDir } }
  );
  const binary = path.join(targetDir, 'debug', 'agent-relay-node');
  const help = spawnSync(binary, ['droid-spawn-host', '--help'], { encoding: 'utf8', timeout: 10_000 });
  if (help.error) throw help.error;
  if (help.status !== 0) {
    assert.equal(help.status, 2);
    assert.match(help.stderr, /unrecognized subcommand ['"]droid-spawn-host['"]/);
    await observe(
      'absent',
      'factory_native_worker_absent',
      'The exact base production CLI has no Factory native host command. No test name, compilation failure, model or network result is used as absence proof.'
    );
  } else {
    assert.match(help.stdout, /droid-spawn-host/);
    const fake = path.join(directory, 'droid');
    run('rustc', [path.join(harness, 'tests/relayflows/cases', caseId, 'droid.rs'), '-o', fake]);
    const runtime = path.join(directory, 'runtime');
    const events = path.join(directory, 'events');
    const control = path.join(directory, 'sentinel-control');
    const sentinel = spawnSync(fake, [], {
      env: { RELAY_FACTORY_FIXTURE_EVENTS: control },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.ifError(sentinel.error);
    assert.equal(sentinel.status, 1);
    assert.equal(await readFile(control, 'utf8'), 'provider unexpectedly started');
    const launch = randomUUID();
    await mkdir(runtime, { mode: 0o700 });
    await writeFile(
      path.join(runtime, `${launch}.task.json`),
      JSON.stringify({ id: 'one', text: 'synthetic owned turn one' }),
      { mode: 0o600 }
    );
    const held = spawnSync(
      binary,
      [
        'droid-spawn-host',
        '--executable',
        fake,
        '--directory',
        directory,
        '--runtime',
        runtime,
        '--launch-id',
        launch,
      ],
      {
        env: { ...process.env, AGENT_RELAY_DROID_SPAWN: launch, RELAY_FACTORY_FIXTURE_EVENTS: events },
        encoding: 'utf8',
        timeout: 10_000,
      }
    );
    assert.ifError(held.error);
    assert.notEqual(held.status, 0);
    assert.match(held.stderr, /unavailable until inherited MCP server startup can be isolated/);
    assert.equal(held.stderr.trim().split('\n').length, 1);
    assert.doesNotMatch(held.stderr, /Check your connection/);
    await assert.rejects(readFile(events), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(runtime, `${launch}.ready.json`)), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(runtime, `${launch}.droid.log`)), { code: 'ENOENT' });
    await observe(
      'fixed',
      'factory_native_worker_refuses_unverified_mcp_startup',
      'The exact production host refuses before invoking a disposable compiled sentinel provider or opening provider logs/readiness. Inherited MCP startup isolation is not established, so managed messaging remains unavailable. Protocol serialization/deduplication are unit-tested separately; no Factory credential/model/network or live Relay roundtrip is claimed.'
    );
  }
} catch (error) {
  proofError = error;
  throw error;
} finally {
  const cleanupErrors = [];
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length) {
    if (proofError) console.error('Additional cleanup errors:', ...cleanupErrors);
    else {
      console.error('Cleanup errors:', ...cleanupErrors);
      process.exitCode = 1;
    }
  }
}
