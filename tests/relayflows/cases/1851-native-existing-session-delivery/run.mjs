import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineFixture } from '../1766-durable-task-receipt/engine-fixture.mjs';

const caseId = '1851-native-existing-session-delivery';
const deliverCapability = 'relay:native-existing-session:v1';
const reconcileCapability = 'relay:native-existing-session-reconcile:v1';
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

const directory = await mkdtemp(path.join(tmpdir(), 'relayflow-native-delivery-'));
const state = path.join(directory, 'state');
await mkdir(state);
const engine = await engineFixture();
let broker;
let logs = '';

async function waitForRegistration(milliseconds = 15_000) {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    engine.check();
    const registration = engine.frames.find((frame) => frame.type === 'node.register');
    if (registration) return registration;
    if (broker?.exitCode !== null && broker?.exitCode !== undefined) {
      throw new Error(`Broker exited before registration: ${logs}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for node.register: ${logs}`);
}

async function stop() {
  if (!broker || broker.exitCode !== null || broker.signalCode !== null) return;
  const child = broker;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
  await exited;
  clearTimeout(timer);
  broker = undefined;
}

try {
  broker = spawn(
    binary,
    [
      'init',
      '--persist',
      '--instance-name',
      'native-delivery-proof-node',
      '--workspace-key',
      'rk_fixture_native_delivery_proof',
      '--state-dir',
      state,
      '--api-port',
      '0',
      '--channels',
      '',
    ],
    {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        TMPDIR: directory,
        AGENT_RELAY_BROKER_LOG: 'stderr',
        RELAYCAST_BASE_URL: engine.baseUrl,
        RELAY_BASE_URL: engine.baseUrl,
        RELAY_BROKER_API_KEY: 'br_fixture_native_delivery_proof',
        RELAY_NODE_ID: 'node-fixture-native-delivery-proof',
        // The shared loopback engine fixture deliberately accepts one fixed
        // credential so a case cannot weaken its authentication behavior.
        RELAY_NODE_TOKEN: 'nt_fixture_task_proof',
        AGENT_RELAY_TELEMETRY_DISABLED: '1',
        AGENT_RELAY_NO_DEBUG_FILES: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  broker.stdout.on('data', (chunk) => {
    logs = (logs + chunk).slice(-10_000);
  });
  broker.stderr.on('data', (chunk) => {
    logs = (logs + chunk).slice(-10_000);
  });

  const registration = await waitForRegistration();
  const capabilities = new Map(registration.capabilities.map((value) => [value.name, value]));
  if (arm === 'base') {
    assert.equal(capabilities.has(deliverCapability), false);
    assert.equal(capabilities.has(reconcileCapability), false);
  } else {
    const delivery = capabilities.get(deliverCapability);
    const reconciliation = capabilities.get(reconcileCapability);
    assert.equal(delivery?.kind, 'action');
    assert.equal(delivery?.metadata?.contract, 'deliverNativeExistingSession');
    assert.equal(delivery?.metadata?.durableReceipts, true);
    assert.equal(delivery?.metadata?.idempotencyField, 'deliveryId');
    assert.equal(delivery?.metadata?.reconcileAction, reconcileCapability);
    assert.equal(reconciliation?.kind, 'action');
    assert.equal(reconciliation?.metadata?.contract, 'reconcileNativeExistingSession');
  }
  engine.check();
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({
      version: 1,
      caseId,
      arm,
      outcome: arm === 'base' ? 'absent' : 'fixed',
      signature:
        arm === 'base'
          ? 'native_existing_session_capabilities_absent'
          : 'native_existing_session_capabilities_advertised',
      details:
        arm === 'base'
          ? 'The exact base broker registered without either native existing-session action.'
          : 'The exact head broker registered both versioned actions and advertised the durable receipt and reconciliation contract metadata.',
    })}\n`
  );
} finally {
  await stop();
  await engine.close();
  await rm(directory, { recursive: true, force: true });
}
