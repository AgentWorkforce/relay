/**
 * relay#1670 — the broker ACKs a fleet delivery it never surfaced.
 *
 * `FleetDeliveryBook::observe` returns `DeliveryDecision::Gap` when a `deliver`
 * frame lands past a hole in the agent's sequence: the book cannot place it, so
 * the agent never sees it. `plan_fleet_delivery` nonetheless mapped `Gap` to
 * `Acknowledge`, so the broker emitted a `delivery.ack` frame for a message it
 * had just dropped — and did so with no log line at any level. The head routes
 * `Gap` to `RejectWithoutAck` and logs the rejection with its reason and
 * sequence.
 *
 * What this case does NOT claim: it is not a reproduction of the 2026-09-05
 * outage where agents go permanently deaf. The ACK a base broker sends here
 * carries `acked_up_to_seq` — the floor already in effect — so it advances
 * nothing, and whether the engine retires the un-surfaced frame on receiving it
 * is engine-side behaviour this repository cannot observe. The observable, and
 * the only thing asserted, is the frame itself: the base broker reports
 * progress on a delivery it dropped, the head broker says nothing.
 *
 * Observed on the node-control wire, because that is where the behaviour lives.
 * A real `@relaycast/engine` supplies workspace bootstrap, node enrolment and
 * agent registration; a transparent tap in front of it forwards every frame
 * untouched and adds exactly two powers — inject a `deliver` with a chosen
 * sequence number (a real engine will not produce a forward hole on demand) and
 * record the `delivery.ack` frames the broker sends back.
 *
 * The agent is put in `manual_flush` so the sequence under test does not depend
 * on PTY echo timing: frame 1 is received and queued (establishing the cursor
 * position) without producing an ACK on either arm, which leaves the ACK stream
 * silent and makes the gap ACK unambiguous when it appears.
 *
 *   1. deliver seq=1  -> queued, cursor position established, no ACK (both arms)
 *   2. deliver seq=3  -> a forward hole. THE OBSERVATION.
 *                        base: a delivery.ack appears.  head: none does.
 *   3. deliver seq=1 again (same msg_id) -> a duplicate, which BOTH arms must
 *                        ACK. This is the control: without it, a head result of
 *                        "no ACK" could just as well mean the socket died or the
 *                        broker stopped reading. The case fails as
 *                        infrastructure if this ACK does not arrive.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';

import { ensureEngine, startEngine } from '../1593-parked-agent-orphaned-receipt/relaycast-engine.mjs';
import { startNodeControlTap } from './node-control-tap.mjs';

const execFile = promisify(execFileCb);

const CASE_ID = '1670-gap-delivery-never-acked';
const AGENT = 'gap-probe';
const BROKER_API_KEY = 'rk_proof_broker_api_key';
const READY_TIMEOUT_MS = 90_000;
/**
 * How long a base broker's gap ACK is given to appear. It is emitted from the
 * same task that processed the frame, with no I/O in between, so this is
 * generous by two orders of magnitude — and the duplicate control afterwards
 * proves the ACK path was alive throughout the window regardless.
 */
const GAP_WINDOW_MS = 8_000;

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

const workDir = await mkdtemp(path.join(tmpdir(), 'relayflow-1670-'));
const engineDir = path.join(workDir, 'engine');
const stateDir = path.join(workDir, 'state');
await mkdir(stateDir, { recursive: true });

const diag = [];
const log = (line) => diag.push(`${String(line).trimEnd()}\n`);
let engine;
let broker;
let tap;

try {
  const serveBin = await ensureEngine(engineDir, log);
  // The tap needs a WebSocket server. The proof sandbox has no node_modules at
  // the repo root, so install it beside the engine and load it by path.
  log('installing ws for the node-control tap');
  await execFile('npm', ['install', 'ws@8.18.3', '--no-audit', '--no-fund'], {
    cwd: engineDir,
    maxBuffer: 32 * 1024 * 1024,
  });
  const wsNamespace = await import(pathToFileURL(path.join(engineDir, 'node_modules/ws/index.js')).href);
  const wsModule = wsNamespace.default ?? wsNamespace;

  const enginePort = await freePort();
  const engineUrl = `http://127.0.0.1:${enginePort}`;
  engine = await startEngine(serveBin, engineDir, enginePort, log);
  const eng = engineClient(engineUrl);
  await waitFor(async () => {
    if (engine.exitCode !== null) throw new Error(`engine exited with code ${engine.exitCode}`);
    await fetch(engineUrl);
    return true;
  }, 'the Relaycast engine to accept connections');

  // Real workspace, real node registration — set up directly against the
  // engine; only the broker's own traffic goes through the tap.
  const ws = await eng('POST', '/v1/workspaces', { name: 'relayflow-1670' });
  const workspaceKey = ws.body?.data?.api_key;
  if (!workspaceKey) throw new Error(`workspace create failed: ${JSON.stringify(ws.body).slice(0, 300)}`);
  const wsAuth = { authorization: `Bearer ${workspaceKey}` };

  const nodeId = `node_relayflow_1670_${Date.now()}`;
  const nodeReg = await eng(
    'POST',
    '/v1/nodes',
    {
      node_id: nodeId,
      name: 'relayflow-1670-node',
      kind: 'ws',
      role: 'broker',
      capabilities: [],
      max_agents: 8,
      version: 'relayflow/1670',
    },
    wsAuth
  );
  const nodeToken = nodeReg.body?.data?.token;
  if (!nodeToken) throw new Error(`node mint failed: ${JSON.stringify(nodeReg.body).slice(0, 300)}`);

  tap = await startNodeControlTap(enginePort, wsModule, log);

  // The broker must not inherit this process's own Relaycast credentials, or it
  // authenticates against production instead of the engine under test.
  broker = spawn(
    binaryPath,
    ['init', '--api-port', '0', '--api-bind', '127.0.0.1', '--state-dir', stateDir],
    {
      cwd: workDir,
      env: {
        PATH: process.env.PATH,
        HOME: workDir,
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        RELAY_BASE_URL: tap.baseUrl,
        RELAYCAST_BASE_URL: tap.baseUrl,
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

  // The broker publishes its bound port in connection.json — a contract, unlike
  // its log output.
  const brokerUrl = await waitFor(async () => {
    if (broker.exitCode !== null) throw new Error(`broker exited early with code ${broker.exitCode}`);
    const connection = JSON.parse(await readFile(path.join(stateDir, 'connection.json'), 'utf8'));
    const url = new URL(connection.url);
    const port = Number(url.port);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !Number.isInteger(port) ||
      port <= 0 ||
      port > 65535
    ) {
      throw new Error(`bad connection url ${connection.url}`);
    }
    // Rebuilt from the validated parts instead of forwarding the file's own
    // string: the port number is the only thing connection.json gets to
    // contribute to a request, so no scheme, host, credentials or path from
    // the file can reach fetch().
    return `http://127.0.0.1:${port}`;
  }, 'the broker connection file to publish its bound API port');
  const api = brokerClient(brokerUrl);
  await waitFor(() => api('GET', '/api/status').then(() => true), 'the broker API to answer');

  // A live worker, registered through the real engine, and holding its inbound
  // queue so the ACK stream stays silent until the case makes it speak.
  await api('POST', '/api/spawn', { name: AGENT, cli: 'cat', transport: 'pty' });
  const agentId = await waitFor(
    () => tap.agentIdFor(AGENT),
    'the broker to register the agent with the engine'
  );
  log(`agent ${AGENT} registered as ${agentId}`);
  await api('PUT', `/api/spawned/${AGENT}/delivery-mode`, { mode: 'manual_flush' });

  // 1. A contiguous first frame. `observe` adopts it, `commit_received` seeds
  //    the cursor, and manual_flush holds it — so no ACK, on either arm.
  tap.sendToBroker(deliverFrame(agentId, 1, 'msg-gap-probe-1', 'first frame'));
  await waitFor(async () => (await pendingCount(api)) === 1, 'the first frame to reach the worker queue');
  const acksBeforeGap = tap.acks.length;

  // 2. The observation: a frame past a hole. Frame 2 never arrives.
  tap.sendToBroker(deliverFrame(agentId, 3, 'msg-gap-probe-3', 'frame past the hole'));
  await sleep(GAP_WINDOW_MS);
  const gapAcks = tap.acks.slice(acksBeforeGap);

  // The gapped frame must not have been surfaced on either arm — that is the
  // premise the ACK is wrong about, not the difference between the arms.
  const pendingAfterGap = await pendingCount(api);
  if (pendingAfterGap !== 1) {
    throw new Error(
      `The gapped frame was surfaced to the worker (pending=${pendingAfterGap}); this case observes nothing.`
    );
  }

  // 3. The control. A duplicate is ACKed by both arms, so this proves the ACK
  //    path was alive across the window above. Without it, "no ACK" on head
  //    would be indistinguishable from a dead socket.
  const acksBeforeControl = tap.acks.length;
  tap.sendToBroker(deliverFrame(agentId, 1, 'msg-gap-probe-1', 'duplicate control'));
  await waitFor(
    () => tap.acks.length > acksBeforeControl,
    'the duplicate control frame to be acknowledged (the ACK path must be alive)',
    20_000
  );
  log(`control ack observed: ${JSON.stringify(tap.acks.at(-1))}`);

  const detail = `agent ${agentId}; acks during the gap window = ${JSON.stringify(gapAcks.map((a) => a.upToSeq))}; pending after gap = ${pendingAfterGap}; control ack = ${JSON.stringify(tap.acks.at(-1)?.upToSeq)}`;

  let outcome;
  let signature;
  let details;
  if (gapAcks.length > 0) {
    outcome = 'bug';
    signature = 'gap_delivery_acked_without_surfacing';
    details = `The base broker acknowledged a delivery it never surfaced (${detail}). The frame past the hole was dropped — the worker queue still holds only the first message — yet a delivery.ack went back to the engine for it.`;
  } else {
    outcome = 'fixed';
    signature = 'gap_delivery_withholds_ack';
    details = `The head broker sent no delivery.ack for the frame it could not place (${detail}). The frame was dropped exactly as before, but nothing was reported about it, and the duplicate control frame sent afterwards was acknowledged normally — so the silence is a decision, not a stalled connection.`;
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
  if (tap) await tap.stop().catch(() => {});
  for (const child of [broker, engine]) await stop(child);
  await rm(workDir, { recursive: true, force: true });
}

function deliverFrame(agentId, seq, msgId, text) {
  return {
    type: 'deliver',
    v: 1,
    agent: AGENT,
    agent_id: agentId,
    delivery_id: `delivery-${msgId}-${seq}`,
    msg_id: msgId,
    seq,
    mode: 'wait',
    payload: {
      type: 'message.created',
      data: { id: msgId, agent_name: 'proof-sender', text, to: AGENT },
    },
  };
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
