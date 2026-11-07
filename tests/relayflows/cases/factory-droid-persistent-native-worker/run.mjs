import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
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
let host;
let logs = '';
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(probe, description) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (host?.exitCode !== null && host?.exitCode !== undefined)
      throw new Error(`Host exited during ${description}: ${logs}`);
    const value = await probe();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`Timed out: ${description}: ${logs}`);
}
async function exchange(socket, request) {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(socket);
    let response = '';
    connection.setTimeout(3000, () => connection.destroy(new Error('Control response timed out')));
    connection.on('error', reject);
    connection.on('connect', () => connection.write(`${JSON.stringify(request)}\n`));
    connection.on('data', (chunk) => {
      response += chunk;
      if (response.includes('\n')) {
        connection.destroy();
        try {
          resolve(JSON.parse(response));
        } catch (error) {
          reject(error);
        }
      }
    });
    connection.on('end', () => {
      if (!response.includes('\n')) reject(new Error('Control response truncated'));
    });
  });
}
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
    const launch = randomUUID();
    await mkdir(runtime, { mode: 0o700 });
    await writeFile(
      path.join(runtime, `${launch}.task.json`),
      JSON.stringify({ id: 'one', text: 'synthetic owned turn one' }),
      { mode: 0o600 }
    );
    host = spawn(
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
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    host.stdout.on('data', (chunk) => {
      logs = (logs + chunk).slice(-4000);
    });
    host.stderr.on('data', (chunk) => {
      logs = (logs + chunk).slice(-4000);
    });
    const record = await waitFor(async () => {
      try {
        return JSON.parse(await readFile(path.join(runtime, `${launch}.ready.json`), 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    }, 'native initialization');
    assert.equal(record.session_id, '11111111-2222-4333-8444-555555555555');
    assert.equal(record.host.pid, host.pid);
    assert.equal(record.initial_message_id, 'one');
    for (const id of ['one', 'two']) {
      const request = { op: 'prompt', id, text: `synthetic owned turn ${id}` };
      assert(['accepted', 'delivered'].includes((await exchange(record.socket, request)).status));
      await waitFor(
        async () => (await exchange(record.socket, request)).status === 'delivered',
        `completion ${id}`
      );
      assert.equal((await exchange(record.socket, { op: 'status' })).state, 'idle');
      assert.equal((await exchange(record.socket, request)).status, 'delivered');
      assert.equal(
        (await exchange(record.socket, { ...request, text: 'different payload' })).status,
        'refused'
      );
    }
    const lines = (await readFile(events, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => line.split(' '));
    assert.deepEqual(
      lines.map((row) => row[2]),
      ['prompt:one', 'prompt:two']
    );
    assert(lines.every((row) => Number(row[0]) === record.child.pid && row[1] === record.session_id));
    const ended = once(host, 'exit');
    assert.equal((await exchange(record.socket, { op: 'stop' })).status, 'stopped');
    const [code] = await ended;
    assert.equal(code, 0, logs);
    assert.throws(() => process.kill(record.child.pid, 0), { code: 'ESRCH' });
    await observe(
      'fixed',
      'factory_native_worker_reuses_session_and_deduplicates',
      'The exact production host initializes a disposable compiled Droid wire peer, injects the pinned MCP definition, admits only its send permission and denies foreign/Execute permissions. The initial task is queued before readiness, and two idle-separated turns retain the same native session/PID; duplicates are not emitted and changed payloads are refused. Stop reaps the child. This uses no Factory credential/model/network and does not claim a live Relay MCP or hosted-history roundtrip.'
    );
  }
} catch (error) {
  proofError = error;
  throw error;
} finally {
  const cleanupErrors = [];
  if (host && host.exitCode === null) {
    try {
      process.kill(-host.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') cleanupErrors.push(error);
    }
  }
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
