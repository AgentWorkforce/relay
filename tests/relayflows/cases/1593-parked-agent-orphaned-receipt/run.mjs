/**
 * relay#1593 — a parked (`manual_flush`) message is stamped with the Relaycast
 * `agent_id` that was live when it was queued, and the flush gate looks that
 * cursor up by id. A second spawn of a still-live agent name re-registers it
 * under a fresh immutable identity (`bind_authoritative_identity`), which
 * retires the previous `agent_id` and drops its cursor — while the parked queue
 * itself survives, because only release and permanent-death clear it.
 *
 * Base: the flush stops on that receipt forever. The message never leaves the
 * queue, so every later DM parks behind it and the agent is permanently deaf.
 * Head: the receipt is recognised as un-ACKable, dead-lettered, and the queue
 * drains — so the agent hears everything that arrives afterwards.
 *
 * The observation is `GET /api/spawned/{name}/pending`, which exists on both
 * arms, rather than any field this PR adds.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1593-parked-agent-orphaned-receipt';
const AGENT = 'proof-probe';
const BROKER_API_KEY = 'rk_proof_broker_api_key';
const READY_TIMEOUT_MS = 60_000;

const targetDir = requiredValue('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredValue('RELAY_PR_PROOF_HARNESS_DIR');
const binaryPath = requiredValue('RELAY_PR_PROOF_BROKER_BINARY');
const resultPath = requiredValue('RELAY_PR_PROOF_RESULT_PATH');
const arm = requiredValue('RELAY_PR_PROOF_ARM');
if (arm !== 'base' && arm !== 'head') {
  throw new Error(`RELAY_PR_PROOF_ARM must be base or head, received ${JSON.stringify(arm)}.`);
}

const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
if (!expectedSha) throw new Error(`Missing expected ${arm} SHA.`);
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
}

const runnerPath = fileURLToPath(import.meta.url);
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

const workDir = await mkdtemp(path.join(tmpdir(), 'relayflow-1593-'));
const stateDir = path.join(workDir, 'state');
await mkdir(stateDir, { recursive: true });

let fake;
let broker;
const fakeEvents = [];
const brokerLog = [];

try {
  // ---------------------------------------------------------------- fake
  fake = spawn(process.execPath, [path.join(path.dirname(runnerPath), 'fake-relaycast.mjs')], {
    cwd: workDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  fake.stderr.on('data', (d) => brokerLog.push(`[fake] ${d}`));
  let fakeBuf = '';
  fake.stdout.on('data', (chunk) => {
    fakeBuf += chunk;
    let idx;
    while ((idx = fakeBuf.indexOf('\n')) >= 0) {
      const line = fakeBuf.slice(0, idx).trim();
      fakeBuf = fakeBuf.slice(idx + 1);
      if (!line) continue;
      try {
        fakeEvents.push(JSON.parse(line));
      } catch {}
    }
  });
  const listening = await waitForEvent((e) => e.event === 'listening', 'fake relaycast to listen');
  const relaycastPort = listening.port;

  // ---------------------------------------------------------------- broker
  broker = spawn(
    binaryPath,
    ['init', '--api-port', '0', '--api-bind', '127.0.0.1', '--state-dir', stateDir],
    {
      cwd: workDir,
      env: {
        ...process.env,
        RELAY_BASE_URL: `http://127.0.0.1:${relaycastPort}`,
        RELAY_API_KEY: 'rk_live_proof',
        RELAY_BROKER_API_KEY: BROKER_API_KEY,
        RELAY_SKIP_TELEMETRY: '1',
        RUST_LOG: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let apiPort = null;
  const capture = (d) => {
    const text = d.toString();
    brokerLog.push(text);
    const m = text.match(/API listener bound on 127\.0\.0\.1:(\d+)/);
    if (m) apiPort = Number(m[1]);
  };
  broker.stdout.on('data', capture);
  broker.stderr.on('data', capture);

  await waitFor(() => apiPort !== null, 'broker API listener to bind');
  await waitForEvent((e) => e.event === 'node_control_connected', 'node-control to connect');

  const api = makeApi(apiPort);

  // 1. A worker exists and is holding its inbound queue.
  await api('POST', '/api/spawn', { name: AGENT, cli: 'cat', transport: 'pty' });
  const firstRegister = await waitForEvent(
    (e) => e.event === 'agent_register' && e.name === AGENT,
    'the agent to register with Relaycast'
  );
  await api('PUT', `/api/spawned/${AGENT}/delivery-mode`, { mode: 'manual_flush' });

  // 2. A message arrives and parks.
  fake.stdin.write(
    `${JSON.stringify({ cmd: 'deliver', agent: AGENT, seq: 1, msgId: 'msg_proof_1', body: 'parked probe message' })}\n`
  );
  await waitFor(async () => (await pendingCount(api)) === 1, 'the message to park');

  // 3. A second spawn arrives for the same still-live name — the shape of a
  //    double-dispatched spawn (relay#1604 / #1554). `workers.spawn` rejects
  //    it with `agent '<name>' already exists`, but that guard lives inside
  //    `workers.spawn`, which runs *after* the broker has already re-registered
  //    the name with Relaycast. So the rejected spawn still rebinds the
  //    identity and retires the previous cursor, and nothing rolls that back.
  //    The failure is expected here and is part of what makes this reachable.
  fake.stdin.write(`${JSON.stringify({ cmd: 'rotate_agent_id', name: AGENT })}\n`);
  //    A duplicate spawn that SUCCEEDS would invalidate the whole observation,
  //    so require the rejection rather than merely tolerating it.
  let duplicateSpawnRejected = false;
  await api('POST', '/api/spawn', { name: AGENT, cli: 'cat', transport: 'pty' }).then(
    () => {
      throw new Error(
        'The duplicate spawn was accepted. This case only proves anything if a REJECTED spawn ' +
          'still rebinds the identity, so a success invalidates the observation.'
      );
    },
    (error) => {
      if (!/already exists/.test(String(error))) throw error;
      duplicateSpawnRejected = true;
    }
  );
  if (!duplicateSpawnRejected) throw new Error('Expected the duplicate spawn to be rejected.');
  const secondRegister = await waitForEvent(
    (e) => e.event === 'agent_register' && e.name === AGENT && e.agentId !== firstRegister.agentId,
    'the agent identity to be rebound'
  );

  // 4. Flush, then read the queue through an endpoint both arms have.
  const flushBody = await api('POST', `/api/spawned/${AGENT}/flush`, undefined);
  await sleep(1_500);
  const remaining = await pendingCount(api);

  // An empty queue alone does not prove the identity boundary held: an
  // implementation that *injected* the stale message into the rebound identity
  // would empty the queue too. Where the queue drained, require that it drained
  // by dead-lettering, with nothing injected and nothing ACKed.
  if (remaining === 0) {
    if (flushBody.dead_lettered !== 1 || flushBody.flushed !== 0) {
      throw new Error(
        `The queue drained without dead-lettering the orphan: ${JSON.stringify(flushBody)}. ` +
          'Draining is only correct here if the message was dead-lettered rather than injected ' +
          'into the rebound identity.'
      );
    }
    const acked = fakeEvents.filter((event) => event.event === 'delivery_ack');
    if (acked.length > 0) {
      throw new Error(`A retired identity's receipt must never be ACKed, saw ${JSON.stringify(acked)}.`);
    }
  }

  const detail =
    `identity ${firstRegister.agentId} -> ${secondRegister.agentId}; ` +
    `pending after flush = ${remaining}; flush response ${JSON.stringify(flushBody)}`;

  let outcome;
  let signature;
  let details;
  if (remaining === 1) {
    outcome = 'bug';
    signature = 'parked_message_never_leaves_the_queue';
    details =
      `The base broker left the parked message in the queue after an explicit flush (${detail}). ` +
      'Its receipt names a retired identity, so the flush stops on it and every later message ' +
      'parks behind it.';
  } else if (remaining === 0) {
    outcome = 'fixed';
    signature = 'parked_message_dead_lettered_and_queue_drains';
    details =
      `The head broker cleared the parked queue after the flush (${detail}). ` +
      'The un-ACKable message is dead-lettered with a distinguishing reason rather than injected ' +
      'into the rebound identity, and no delivery.ack was emitted for it, so later messages ' +
      'reach the agent without any cross-identity delivery.';
  } else {
    throw new Error(`Unexpected pending count ${remaining} (${detail}).`);
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
  process.stdout.write(`${signature}\n`);
} catch (error) {
  process.stderr.write(`${brokerLog.join('').slice(-8_000)}\n`);
  throw error;
} finally {
  for (const child of [broker, fake]) await stop(child);
  await rm(workDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- helpers
function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}
function isWithin(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function makeApi(port) {
  return async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-api-key': BROKER_API_KEY },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    if (!response.ok) {
      throw new Error(`${method} ${route} -> ${response.status} ${text.slice(0, 400)}`);
    }
    return parsed;
  };
}
async function pendingCount(api) {
  const body = await api('GET', `/api/spawned/${AGENT}/pending`, undefined);
  return Array.isArray(body.pending) ? body.pending.length : 0;
}
async function waitFor(predicate, label, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}.`);
}
async function waitForEvent(predicate, label, timeoutMs = READY_TIMEOUT_MS) {
  return waitFor(() => fakeEvents.find(predicate), label, timeoutMs);
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
