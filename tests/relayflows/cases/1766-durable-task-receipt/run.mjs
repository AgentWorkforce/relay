import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineFixture } from './engine-fixture.mjs';

const caseId = '1766-durable-task-receipt';
const required = (key) => {
  assert(process.env[key], `Missing ${key}`);
  return process.env[key];
};
const arm = required('RELAY_PR_PROOF_ARM');
assert(['base', 'head'].includes(arm));
const binary = path.resolve(required('RELAY_PR_PROOF_BROKER_BINARY'));
const target = required('RELAY_PR_PROOF_TARGET_DIR');
const harness = required('RELAY_PR_PROOF_HARNESS_DIR');
const resultPath = required('RELAY_PR_PROOF_RESULT_PATH');
assert.equal(
  execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  required(arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA')
);
const relative = path.relative(path.resolve(harness), fileURLToPath(import.meta.url));
assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
await access(binary, 1);
const directory = await mkdtemp(path.join(tmpdir(), 'relayflow-task-receipt-'));
const state = path.join(directory, 'state');
await mkdir(state);
const engine = await engineFixture();
let broker;
let logs = '';
let cursor = 0;
const invocation = {
  v: 1,
  type: 'action.invoke',
  invocation_id: 'inv-proof-task',
  action: 'task.run',
  // Deliberately missing cli: exercise a real terminal provider failure without
  // launching a model or interpreting a process exit as a successful task.
  input: {
    task: 'fixture task',
    task_context: {
      run_id: 'run-proof',
      step_id: 'step-proof',
      dispatch_id: 'dispatch-proof',
      timeout_ms: 120000,
    },
  },
  task_execution: {
    execution_id: 'inv-proof-task/1',
    run_id: 'run-proof',
    step_id: 'step-proof',
    dispatch_id: 'dispatch-proof',
    deadline: new Date(Date.now() + 120000).toISOString(),
  },
};

async function waitFor(probe, description, milliseconds = 15000) {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    engine.check();
    if (broker?.exitCode !== null && broker?.exitCode !== undefined)
      throw new Error(`Broker exited before ${description}: ${logs}`);
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}: ${logs}`);
}
async function next(type) {
  return waitFor(() => {
    while (cursor < engine.frames.length) {
      const value = engine.frames[cursor++];
      if (value.type === type) return value;
      assert(
        !['action.accept', 'action.result'].includes(value.type),
        `Unexpected task frame while waiting for ${type}`
      );
    }
  }, type);
}
async function start() {
  logs = '';
  broker = spawn(
    binary,
    [
      'init',
      '--persist',
      '--instance-name',
      'task-proof-node',
      '--workspace-key',
      'rk_fixture_task_proof',
      '--state-dir',
      state,
      '--api-port',
      '0',
      '--channels',
      '',
    ],
    {
      cwd: directory,
      // Explicit allowlist: no live tokens or dynamic-loader injection inherited.
      env: {
        PATH: process.env.PATH,
        TMPDIR: directory,
        // This proof only consumes captured process output. Avoid the default
        // rolling file under a runner-owned home directory.
        AGENT_RELAY_BROKER_LOG: 'stderr',
        RELAYCAST_BASE_URL: engine.baseUrl,
        RELAY_BASE_URL: engine.baseUrl,
        RELAY_BROKER_API_KEY: 'br_fixture_task_proof',
        RELAY_NODE_ID: 'node-fixture-task-proof',
        RELAY_NODE_TOKEN: 'nt_fixture_task_proof',
        AGENT_RELAY_TASK_PROVIDER: '1',
        AGENT_RELAY_TELEMETRY_DISABLED: '1',
        AGENT_RELAY_NO_DEBUG_FILES: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  broker.stdout.on('data', (chunk) => {
    logs = (logs + chunk).slice(-10000);
  });
  broker.stderr.on('data', (chunk) => {
    logs = (logs + chunk).slice(-10000);
  });
  const registration = await next('node.register');
  await next('inventory.sync');
  return registration;
}
async function stop(signal = 'SIGTERM') {
  if (!broker || broker.exitCode !== null || broker.signalCode !== null) return;
  const child = broker;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill(signal);
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  await exited;
  clearTimeout(timer);
  broker = undefined;
}
function receipt(accept, status) {
  return {
    invocation_id: invocation.invocation_id,
    action_name: 'task.run',
    status,
    task_execution: {
      ...invocation.task_execution,
      worker_generation: accept.worker_generation,
      accepted_at: '2026-01-01T00:00:00.000Z',
    },
    output: null,
    error: status === 'failed' ? 'task_missing_cli' : null,
    completed_at: status === 'failed' ? '2026-01-01T00:00:01.000Z' : null,
  };
}
const reply = (id, data) => engine.send({ v: 1, type: 'reply', id, ok: true, data });
try {
  const registration = await start();
  const capability = registration.capabilities.find((value) => value.name === 'task.run');
  if (arm === 'base') {
    assert.equal(capability, undefined);
    // Base rejects the known action name using its supported short-action wire;
    // no missing-test or deserialization failure is counted as feature absence.
    const { task_execution: ignored, ...legacy } = invocation;
    engine.send(legacy);
    const result = await next('action.result');
    assert.equal(result.invocation_id, invocation.invocation_id);
    assert.equal(result.error, 'handler_unavailable');
    assert.equal(result.final, undefined);
  } else {
    assert.equal(capability.execution_mode, 'task');
    assert.equal(capability.global, true);
    engine.send(invocation);
    const accepted = await next('action.accept');
    assert.equal(accepted.invocation_id, invocation.invocation_id);
    assert.equal(accepted.execution_id, invocation.task_execution.execution_id);
    assert.match(accepted.worker_generation, /^[0-9a-f-]{36}$/);
    engine.send(invocation); // duplicate delivery before the engine accepts
    await new Promise((resolve) => setTimeout(resolve, 300));
    engine.check();
    assert(
      !engine.frames.some((frame) => frame.type === 'action.result'),
      'Task failed/completed before durable acceptance'
    );
    reply(accepted.id, receipt(accepted, 'running'));
    const reconciliation = await next('action.accept');
    assert.equal(reconciliation.worker_generation, accepted.worker_generation);
    reply(reconciliation.id, receipt(accepted, 'running'));
    const terminal = await next('action.result');
    assert.equal(terminal.invocation_id, invocation.invocation_id);
    assert.equal(terminal.execution_id, accepted.execution_id);
    assert.equal(terminal.worker_generation, accepted.worker_generation);
    assert.equal(terminal.final, true);
    assert.equal(terminal.error, 'task_missing_cli');
    assert(terminal.id);
    // The fixture engine commits the result but loses the ACK. Kill the actual
    // broker, preserving its ledger, then reconcile with the terminal receipt.
    await stop('SIGKILL');
    cursor = engine.frames.length;
    await start();
    const recovered = await next('action.accept');
    assert.equal(recovered.invocation_id, accepted.invocation_id);
    assert.equal(recovered.execution_id, accepted.execution_id);
    assert.equal(recovered.worker_generation, accepted.worker_generation);
    reply(recovered.id, receipt(accepted, 'failed'));
    const ledgerPath = path.join(state, 'state-task-proof-node.tasks.json');
    await waitFor(async () => {
      const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
      return ledger[invocation.invocation_id]?.receipt?.status === 'failed';
    }, 'durably stored reconciled terminal receipt');
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
    assert.equal(ledger[invocation.invocation_id].receipt.error, 'task_missing_cli');
    assert.equal(ledger[invocation.invocation_id].generation, accepted.worker_generation);
    assert.equal(
      engine.frames.filter((frame) => frame.type === 'action.result').length,
      1,
      'Final result duplicated after terminal reconciliation'
    );
  }
  engine.check();
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    JSON.stringify({
      version: 1,
      caseId,
      arm,
      outcome: arm === 'base' ? 'absent' : 'fixed',
      signature:
        arm === 'base' ? 'task_action_handler_unavailable' : 'fenced_task_failure_receipt_survives_restart',
      details:
        arm === 'base'
          ? 'Actual base broker returned handler_unavailable for task.run.'
          : 'Actual head broker waited for acceptance, sent a fenced explicit failure, and durably reconciled the same generation after SIGKILL and lost final ACK. Loopback engine fixture; no deployed engine or model execution claim.',
    }) + '\n'
  );
} finally {
  await stop();
  await engine.close();
  await rm(directory, { recursive: true, force: true });
}
