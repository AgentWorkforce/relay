/**
 * relay#1678 — whether a node-control `deliver` frame reaches the broker is
 * not observable on a running broker.
 *
 * A silent agent has one first question: did the engine's `deliver` frame get
 * here at all? On the base broker nothing can answer it. The delivery book has
 * no introspection, and every step of the inbound path reports itself only
 * through `tracing` — so a broker started without `RUST_LOG` (which is how
 * brokers actually run) emits nothing. The only way to get evidence is to
 * restart the broker with logging on, which discards the in-memory cursors
 * that hold the evidence. That is the gap this case pins.
 *
 * Base: `GET /api/node-delivery` does not exist. Arrival is unobservable.
 * Head: the endpoint reports frame counters, the delivery book's verdict on
 * each frame, and where the frame ended up.
 *
 * The broker here is started with RUST_LOG DELIBERATELY UNSET. An instrument
 * that only works when logging is already on would not have helped, so the
 * case proves the endpoint under the condition it was built for.
 *
 * The head arm is not satisfied by the endpoint merely answering. It takes a
 * control read first — node control connected, the agent registered and idle,
 * no message sent — and requires the deliver count to be zero there and
 * non-zero only after a real DM crosses a real engine. Without that control a
 * counter stuck at 1, or one incremented by registration traffic, would pass.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { ensureEngine, startEngine } from './relaycast-engine.mjs';

const CASE_ID = '1678-node-delivery-introspection';
const AGENT = 'deliver-probe-agent';
const BROKER_API_KEY = 'rk_proof_broker_api_key';

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

const workDir = await mkdtemp(path.join(tmpdir(), 'relayflow-1678-'));
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

  const ws = await eng('POST', '/v1/workspaces', { name: 'relayflow-1678' });
  const workspaceKey = ws.body?.data?.api_key;
  if (!workspaceKey) {
    throw new Error(`workspace create failed: ${JSON.stringify(ws.body).slice(0, 300)}`);
  }
  const wsAuth = { authorization: `Bearer ${workspaceKey}` };

  const nodeId = `node_relayflow_1678_${Date.now()}`;
  const nodeReg = await eng(
    'POST',
    '/v1/nodes',
    {
      node_id: nodeId,
      name: 'relayflow-1678-node',
      kind: 'ws',
      role: 'broker',
      capabilities: [],
      max_agents: 8,
      version: 'relayflow/1678',
    },
    wsAuth
  );
  const nodeToken = nodeReg.body?.data?.token;
  if (!nodeToken) throw new Error(`node mint failed: ${JSON.stringify(nodeReg.body).slice(0, 300)}`);

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
        // RUST_LOG is deliberately absent — see the file header.
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let brokerOutput = '';
  broker.stdout.on('data', (d) => {
    brokerOutput += d;
    log(`[broker] ${d}`);
  });
  broker.stderr.on('data', (d) => {
    brokerOutput += d;
    log(`[broker] ${d}`);
  });

  const brokerUrl = await waitFor(async () => {
    if (broker.exitCode !== null) throw new Error(`broker exited early with code ${broker.exitCode}`);
    const connection = JSON.parse(await readFile(path.join(stateDir, 'connection.json'), 'utf8'));
    const url = new URL(connection.url);
    if (url.hostname !== '127.0.0.1' || !Number(url.port)) {
      throw new Error(`bad connection url ${connection.url}`);
    }
    return connection.url;
  }, 'the broker connection file to publish its bound API port');
  const api = brokerClient(brokerUrl);
  await waitFor(() => api('GET', '/api/status').then(() => true), 'the broker API to answer');

  // A live worker, registered with the real engine and idle.
  await api('POST', '/api/spawn', { name: AGENT, cli: 'cat', transport: 'pty' });
  await waitFor(async () => {
    const row = await eng('GET', '/v1/agents', undefined, wsAuth);
    const list = row.body?.data?.agents ?? row.body?.data ?? [];
    return Array.isArray(list) && list.some((entry) => entry.name === AGENT);
  }, 'the agent to register with the real engine');

  const probe = () => api('GET', '/api/node-delivery');
  const first = await probe().catch((error) => ({ __error: String(error) }));

  let outcome;
  let signature;
  let details;

  if (first.__error) {
    // Base: no endpoint. Confirm the absence is specific to this route and not
    // a dead broker, or the arm would "pass" against a broker that never came
    // up at all.
    if (!/\b404\b/.test(first.__error)) {
      throw new Error(`Expected a 404 from the introspection route, got: ${first.__error}`);
    }
    const status = await api('GET', '/api/status');
    if (typeof status.agent_count !== 'number') {
      throw new Error(`Control failed: /api/status did not answer normally: ${JSON.stringify(status).slice(0, 200)}`);
    }
    // And the base broker really is mute, which is why nothing else can answer.
    outcome = 'absent';
    signature = 'deliver_frame_arrival_is_unobservable';
    details =
      `The base broker has no GET /api/node-delivery (${first.__error.slice(0, 160)}), while ` +
      `GET /api/status answers normally with ${status.agent_count} agent(s). With RUST_LOG unset ` +
      `the broker emitted ${brokerOutput.length} bytes total on stdout+stderr, so whether a ` +
      `deliver frame reached it cannot be established without a restart that destroys the cursors.`;
  } else {
    // Head. Control first: connected, agent registered and idle, nothing sent.
    await waitFor(async () => (await probe()).connected === true, 'node control to connect');
    await sleep(2_000);
    const before = await probe();
    if (before.frames.deliver !== 0) {
      throw new Error(
        `Control failed: ${before.frames.deliver} deliver frame(s) counted before any message was sent. ` +
          'A counter that is already non-zero here proves nothing about the DM below.'
      );
    }
    if (before.socket.text_frames <= 0) {
      throw new Error(
        `Control failed: the socket counted ${before.socket.text_frames} inbound frames while ` +
          'node control reports connected, so the frame counter is not wired to the socket.'
      );
    }

    const sender = await eng('POST', '/v1/agents', { name: 'proof-sender', type: 'agent' }, wsAuth);
    const senderToken = sender.body?.data?.token;
    if (!senderToken) {
      throw new Error(`sender create failed: ${JSON.stringify(sender.body).slice(0, 300)}`);
    }
    await eng(
      'POST',
      '/v1/dm',
      { to: AGENT, text: 'deliver frame probe' },
      { authorization: `Bearer ${senderToken}` }
    );

    const after = await waitFor(async () => {
      const current = await probe();
      return current.frames.deliver > 0 ? current : null;
    }, 'the deliver frame to be counted by the broker');

    // Arrival alone is half the question; the endpoint must also say where the
    // frame went, or it cannot answer "at what point did it stop".
    const entry = after.recent_delivers?.find((row) => row.msg_id && row.decision);
    if (!entry) {
      throw new Error(`No recent delivery was recorded: ${JSON.stringify(after).slice(0, 400)}`);
    }
    if (entry.agent !== AGENT) {
      throw new Error(`Recorded delivery names ${entry.agent}, expected ${AGENT}.`);
    }
    if (!entry.disposition) {
      throw new Error(
        `The frame was counted but its outcome was not recorded: ${JSON.stringify(entry)}.`
      );
    }
    if (after.socket.text_frames <= before.socket.text_frames) {
      throw new Error(
        `Socket frame counter did not advance across the DM ` +
          `(${before.socket.text_frames} -> ${after.socket.text_frames}).`
      );
    }

    outcome = 'fixed';
    signature = 'deliver_frame_arrival_is_observable';
    details =
      `GET /api/node-delivery answered with RUST_LOG unset (the broker emitted ${brokerOutput.length} ` +
      `bytes on stdout+stderr for the whole run). Deliver frames counted 0 before any message was ` +
      `sent — with node control connected, the agent registered and idle, and ` +
      `${before.socket.text_frames} inbound socket frames already tallied — and ` +
      `${after.frames.deliver} after one real DM through the engine. The frame is reported as ` +
      `agent=${entry.agent} seq=${entry.seq} payload_type=${entry.payload_type} ` +
      `decision=${entry.decision} disposition=${entry.disposition}, so both "did it arrive" and ` +
      `"where did it stop" are answerable without restarting the broker.`;
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
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${BROKER_API_KEY}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  };
}
async function waitFor(check, what, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ''}.`);
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(5_000).then(() => child.kill('SIGKILL')),
  ]);
}
