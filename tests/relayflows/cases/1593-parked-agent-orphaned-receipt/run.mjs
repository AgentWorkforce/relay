/**
 * relay#1593 — a parked agent stays deaf after its Relaycast identity is
 * replaced underneath it.
 *
 * A parked (`manual_flush`) message carries a delivery receipt stamped with the
 * `agent_id` that was live when it was queued, and the flush gate looks that
 * agent's ACK cursor up by id. If the Relaycast agent record is deleted and the
 * same name re-registered — a release issued elsewhere, a dashboard release, or
 * a roster reaper — the broker rebinds the name to a NEW immutable id and drops
 * the old cursor, while the worker and its parked queue keep running. Every
 * parked receipt is then permanently un-ACKable.
 *
 * Base: the flush stops on that receipt forever. The message never leaves the
 * queue, so every later message parks behind it and the agent is deaf for good.
 * Head: the receipt is recognised as un-ACKable, dead-lettered with a reason,
 * and the queue drains — so later messages reach the agent again.
 *
 * This case drives a REAL Relaycast engine (`@relaycast/engine`, standalone on
 * sqlite), not a stand-in. That matters: the identity rules are the thing under
 * test. A fake would be free to hand back whatever id the case found
 * convenient, and an earlier version of this case did exactly that — it
 * asserted a trigger the real engine refuses (`agent_already_exists`, 409). The
 * engine decides here, so the case cannot prove a path production does not have.
 *
 * Observed through `GET /api/spawned/{name}/pending`, which exists on both arms.
 */
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { ensureEngine, startEngine } from './relaycast-engine.mjs';

const CASE_ID = '1593-parked-agent-orphaned-receipt';
const AGENT = 'orphan-probe';
const BROKER_API_KEY = 'rk_proof_broker_api_key';
const READY_TIMEOUT_MS = 90_000;

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
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
}
const runnerPath = fileURLToPath(import.meta.url);
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

const workDir = await mkdtemp(path.join(tmpdir(), 'relayflow-1593-'));
const engineDir = path.join(workDir, 'engine');
const stateDir = path.join(workDir, 'state');
await mkdir(stateDir, { recursive: true });

const diag = [];
const log = (line) => diag.push(String(line));
let engine;
let broker;

try {
  const serveBin = await ensureEngine(engineDir, log);
  const enginePort = await freePort();
  const engineUrl = `http://127.0.0.1:${enginePort}`;
  engine = await startEngine(serveBin, engineDir, enginePort, log);
  const eng = engineClient(engineUrl);
  await waitFor(async () => {
    if (engine.exitCode !== null) throw new Error(`engine exited with code ${engine.exitCode}`);
    await fetch(engineUrl);
    return true;
  }, 'the Relaycast engine to accept connections');

  // Real workspace, real node registration.
  const ws = await eng('POST', '/v1/workspaces', { name: 'relayflow-1593' });
  const workspaceKey = ws.body?.data?.api_key;
  if (!workspaceKey) throw new Error(`workspace create failed: ${JSON.stringify(ws.body).slice(0, 300)}`);
  const wsAuth = { authorization: `Bearer ${workspaceKey}` };

  const nodeId = `node_relayflow_1593_${Date.now()}`;
  const nodeReg = await eng(
    'POST',
    '/v1/nodes',
    {
      node_id: nodeId,
      name: 'relayflow-1593-node',
      kind: 'ws',
      role: 'broker',
      capabilities: [],
      max_agents: 8,
      version: 'relayflow/1593',
    },
    wsAuth
  );
  const nodeToken = nodeReg.body?.data?.token;
  if (!nodeToken) throw new Error(`node mint failed: ${JSON.stringify(nodeReg.body).slice(0, 300)}`);

  // The broker must not inherit this process's own Relaycast credentials, or it
  // authenticates against production instead of the engine under test.
  const apiPort = await freePort();
  broker = spawn(
    binaryPath,
    ['init', '--api-port', '0', '--api-bind', '127.0.0.1', '--state-dir', stateDir],
    {
      cwd: workDir,
      env: {
        PATH: process.env.PATH,
        HOME: workDir,
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        RELAY_BASE_URL: engineUrl,
        RELAYCAST_BASE_URL: engineUrl,
        RELAY_API_KEY: workspaceKey,
        RELAY_WORKSPACE_KEY: workspaceKey,
        RELAY_NODE_TOKEN: nodeToken,
        RELAY_NODE_ID: nodeId,
        RELAY_BROKER_API_KEY: BROKER_API_KEY,
        RELAY_SKIP_TELEMETRY: '1',
        RUST_LOG: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  broker.stdout.on('data', (d) => log(`[broker] ${d}`));
  broker.stderr.on('data', (d) => log(`[broker] ${d}`));
  void apiPort;

  // The broker publishes its bound port in connection.json — a contract, unlike
  // its log output.
  const brokerUrl = await waitFor(async () => {
    if (broker.exitCode !== null) throw new Error(`broker exited early with code ${broker.exitCode}`);
    const connection = JSON.parse(await readFile(path.join(stateDir, 'connection.json'), 'utf8'));
    const url = new URL(connection.url);
    if (url.hostname !== '127.0.0.1' || !Number(url.port))
      throw new Error(`bad connection url ${connection.url}`);
    return connection.url;
  }, 'the broker connection file to publish its bound API port');
  const api = brokerClient(brokerUrl);
  await waitFor(() => api('GET', '/api/status').then(() => true), 'the broker API to answer');

  // 1. A live worker holding its inbound queue.
  await api('POST', '/api/spawn', { name: AGENT, cli: 'cat', transport: 'pty' });
  const first = await waitFor(async () => {
    const found = await agentRow(eng, wsAuth, AGENT);
    return found?.id ? found : null;
  }, 'the agent to register with the real engine');
  await api('PUT', `/api/spawned/${AGENT}/delivery-mode`, { mode: 'manual_flush' });

  // 2. A real DM through the engine parks in the worker's queue.
  const sender = await eng('POST', '/v1/agents', { name: 'proof-sender', type: 'agent' }, wsAuth);
  const senderToken = sender.body?.data?.token;
  if (!senderToken) throw new Error(`sender create failed: ${JSON.stringify(sender.body).slice(0, 300)}`);
  await eng(
    'POST',
    '/v1/dm',
    { to: AGENT, text: 'parked probe message' },
    { authorization: `Bearer ${senderToken}` }
  );
  await waitFor(async () => (await pendingCount(api)) === 1, 'the DM to park in the broker queue');

  // 3. The agent record is replaced underneath the still-live worker. The
  //    engine refuses a colliding register (409 agent_already_exists), so the
  //    only way a name gains a new immutable id is delete-then-register — which
  //    is what a release issued elsewhere or a roster reaper performs.
  const del = await eng('DELETE', `/v1/agents/${AGENT}`, undefined, wsAuth);
  if (del.status >= 300)
    throw new Error(`agent delete failed: ${del.status} ${JSON.stringify(del.body).slice(0, 200)}`);
  log(`engine agent ${first.id} deleted while the worker and its queue stay live`);

  // The BROKER must mint the replacement, not this case. With the name freed,
  // the broker's own re-registration succeeds and returns a fresh immutable id,
  // and `bind_authoritative_identity` retires the cursor the parked receipt
  // points at. Recreating the record here instead makes the broker's register
  // collide (409) so it keeps the old id and nothing is orphaned — which is
  // exactly what the first revision of this case got wrong, and why it
  // reported `flushed: 1` instead of a dead letter.
  await api('POST', '/api/spawn', { name: AGENT, cli: 'cat', transport: 'pty' }).catch((error) => {
    if (!/already exists/.test(String(error))) throw error;
  });
  const second = await waitFor(async () => {
    const row = await agentRow(eng, wsAuth, AGENT);
    return row?.id && row.id !== first.id ? row : null;
  }, 'the broker to re-register the freed name under a new immutable id');
  const secondId = second.id;
  log(`identity replaced by the broker: ${first.id} -> ${secondId}`);

  // 4. Flush and read the queue through an endpoint both arms have.
  const flushBody = await api('POST', `/api/spawned/${AGENT}/flush`);
  await sleep(1_500);
  const remaining = await pendingCount(api);
  const detail = `identity ${first.id} -> ${secondId}; pending after flush = ${remaining}; flush ${JSON.stringify(flushBody)}`;

  let outcome;
  let signature;
  let details;
  if (remaining === 1) {
    outcome = 'bug';
    signature = 'parked_message_never_leaves_the_queue';
    details = `The base broker left the parked message queued after an explicit flush (${detail}). Its receipt names an identity the engine has replaced, so the flush stops on it and every later message parks behind it.`;
  } else if (remaining === 0) {
    // Draining is only correct if it drained by dead-lettering. An
    // implementation that injected the stale message into the replacement
    // identity would empty the queue too, and that is the leak this guards.
    if (
      flushBody.dead_lettered !== 1 ||
      flushBody.flushed !== 0 ||
      flushBody.held !== 0 ||
      flushBody.blocked_reason !== null
    ) {
      throw new Error(`The queue drained without dead-lettering the orphan: ${JSON.stringify(flushBody)}.`);
    }
    const screen = await api('GET', `/api/spawned/${AGENT}/snapshot?format=plain`).catch(() => ({}));
    if (typeof screen.screen === 'string' && screen.screen.includes('parked probe message')) {
      throw new Error(
        'The orphaned message was injected into the replacement identity instead of dead-lettered.'
      );
    }
    // And the queue must be usable again, not merely empty.
    await eng(
      'POST',
      '/v1/dm',
      { to: AGENT, text: 'post recovery probe' },
      { authorization: `Bearer ${senderToken}` }
    );
    await waitFor(async () => (await pendingCount(api)) === 1, 'a follow-up DM to park');
    const recovery = await api('POST', `/api/spawned/${AGENT}/flush`);
    if (recovery.flushed !== 1) {
      throw new Error(`The queue did not recover: follow-up flush returned ${JSON.stringify(recovery)}.`);
    }
    outcome = 'fixed';
    signature = 'parked_message_dead_lettered_and_queue_drains';
    details = `The head broker cleared the parked queue after the flush (${detail}). The un-ACKable message is dead-lettered with a distinguishing reason rather than injected into the replacement identity, and a follow-up DM sent afterwards injected normally, so the agent can receive again.`;
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
  process.stderr.write(`${diag.join('').slice(-12_000)}\n`);
  throw error;
} finally {
  for (const child of [broker, engine]) await stop(child);
  await rm(workDir, { recursive: true, force: true });
}

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
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
function engineClient(baseUrl) {
  return async (method, route, body, headers = {}) => {
    const res = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed };
  };
}
function brokerClient(baseUrl) {
  return async (method, route, body) => {
    const res = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-api-key': BROKER_API_KEY },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${text.slice(0, 300)}`);
    return parsed;
  };
}
async function agentRow(eng, wsAuth, name) {
  const listed = await eng('GET', '/v1/agents', undefined, wsAuth);
  return (listed.body?.data ?? []).find((a) => a.name === name) ?? null;
}
async function pendingCount(api) {
  const body = await api('GET', `/api/spawned/${AGENT}/pending`);
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
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}.`);
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
