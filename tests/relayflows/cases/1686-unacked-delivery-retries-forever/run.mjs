/**
 * relay#1686 — a delivery the recipient never acknowledges retries forever and
 * is never reported.
 *
 * `retry_pending_delivery` had exactly two terminal conditions:
 * `failed_attempts >= MAX_DELIVERY_RETRIES` and "recipient gone". The first
 * gates on *consecutive handoff failures*, and every successful write resets
 * that counter to zero. `attempts` is cumulative but was bounded by nothing.
 * So a delivery whose handoff keeps succeeding and which is never acknowledged
 * had no terminal state at all: it retried forever, emitted no
 * `message_delivery_failed`, and never reached the dead-letter store. From
 * outside the broker the whole condition is invisible — which is what makes
 * "an agent that goes idle stops receiving" so hard to see.
 *
 * The recipient here is a real PTY worker whose child never reads its stdin.
 * That matters, because a healthy PTY worker cannot produce this shape: after
 * the injection write is confirmed, the broker's own pty_worker acknowledges
 * the delivery either on echo verification or on its timeout fallback. The
 * acknowledgement is withheld only while the *write itself* has not completed —
 * "a wedged drainer blocks in this arm instead of emitting a false
 * `delivery_injected`" (pty_worker.rs). A child that never reads leaves the tty
 * input queue full after a few kilobytes, so a body far larger than that queue
 * wedges the drainer for the life of the case. Meanwhile every retry's handoff
 * — a send on the worker's command channel, not the tty write — keeps
 * succeeding, which is precisely the counter reset that disarms the existing
 * cap.
 *
 * Observed through `GET /api/status` (pending deliveries, with their attempt
 * counts) and `GET /api/dead-letters`, both of which exist on either arm.
 *
 * Base: after a full minute the delivery is still pending, its attempts have
 *       climbed, and the dead-letter store is empty. Nothing terminal, nothing
 *       reported.
 * Head: the delivery leaves the pending map at its acknowledgement deadline and
 *       lands in the dead-letter store with a reason naming the condition, and
 *       `message_delivery_failed` is what put it there.
 *
 * The deadline is set to `DEADLINE_MS` through `AGENT_RELAY_DELIVERY_MAX_AGE_MS`
 * so the case does not have to sit through the 30-minute default. Both arms get
 * the identical environment; the base broker has no such variable and ignores
 * it, which is itself part of what is being shown.
 *
 * Control: both arms must first observe the delivery pending with at least one
 * attempt recorded. Without that, a head result of "not pending any more" could
 * equally mean the message was delivered normally, and a base result of "no
 * dead letters" could mean the broker never accepted the message at all.
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { ensureEngine, startEngine } from '../1593-parked-agent-orphaned-receipt/relaycast-engine.mjs';

const CASE_ID = '1686-unacked-delivery-retries-forever';
const AGENT = 'deaf-probe';
const BROKER_API_KEY = 'rk_proof_broker_api_key';
const READY_TIMEOUT_MS = 90_000;

/** Acknowledgement budget both arms are configured with. */
const DEADLINE_MS = 10_000;
/**
 * How long the head broker is given to act on that budget. The deadline is
 * swept on the broker's 500ms maintenance tick, so this is generous by an order
 * of magnitude.
 */
const HEAD_WINDOW_MS = 45_000;
/**
 * How long the base broker is watched for any terminal outcome. Six times the
 * deadline and four times the head window: if a bound existed anywhere in the
 * base broker's retry path, it would have fired well inside this.
 */
const BASE_WINDOW_MS = 60_000;
/**
 * Message body size. The tty input queue is a few kilobytes, so a body this
 * size cannot be written to a child that never reads, and the injection write
 * never completes.
 */
const BODY_BYTES = 96 * 1024;

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

const workDir = await mkdtemp(path.join(tmpdir(), 'relayflow-1686-'));
const engineDir = path.join(workDir, 'engine');
const stateDir = path.join(workDir, 'state');
const binDir = path.join(workDir, 'bin');
await mkdir(stateDir, { recursive: true });
await mkdir(binDir, { recursive: true });

const diag = [];
const log = (line) => diag.push(`${String(line).trimEnd()}\n`);
let engine;
let broker;

try {
  // The deaf recipient: it announces itself so the worker reaches readiness,
  // then never reads a byte of stdin for the rest of the case.
  const wedgedCliPath = path.join(binDir, 'wedged');
  await writeFile(
    wedgedCliPath,
    ['#!/bin/sh', "printf 'RELAYFLOW_1686_READY\\n'", 'while :; do sleep 3600; done', ''].join('\n'),
    { encoding: 'utf8', mode: 0o700 }
  );
  await chmod(wedgedCliPath, 0o700);

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

  const ws = await eng('POST', '/v1/workspaces', { name: 'relayflow-1686' });
  const workspaceKey = ws.body?.data?.api_key;
  if (!workspaceKey) {
    throw new Error(`workspace create failed: ${JSON.stringify(ws.body).slice(0, 300)}`);
  }
  const wsAuth = { authorization: `Bearer ${workspaceKey}` };

  const nodeId = `node_relayflow_1686_${Date.now()}`;
  const nodeReg = await eng(
    'POST',
    '/v1/nodes',
    {
      node_id: nodeId,
      name: 'relayflow-1686-node',
      kind: 'ws',
      role: 'broker',
      capabilities: [],
      max_agents: 8,
      version: 'relayflow/1686',
    },
    wsAuth
  );
  const nodeToken = nodeReg.body?.data?.token;
  if (!nodeToken) {
    throw new Error(`node mint failed: ${JSON.stringify(nodeReg.body).slice(0, 300)}`);
  }

  // The broker must not inherit this process's own Relaycast credentials, or it
  // authenticates against production instead of the engine under test.
  broker = spawn(
    binaryPath,
    ['init', '--api-port', '0', '--api-bind', '127.0.0.1', '--state-dir', stateDir],
    {
      cwd: workDir,
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
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
        // No injection pacing: the whole body is offered to the tty in one
        // write, so the wedge is immediate rather than drip-fed.
        RELAY_INJECT_RATE_MS: '0',
        // The head broker's acknowledgement budget. The base broker has no such
        // setting and ignores it.
        AGENT_RELAY_DELIVERY_MAX_AGE_MS: String(DEADLINE_MS),
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
    if (broker.exitCode !== null) {
      throw new Error(`broker exited early with code ${broker.exitCode}`);
    }
    const connection = JSON.parse(await readFile(path.join(stateDir, 'connection.json'), 'utf8'));
    const url = new URL(connection.url);
    if (url.hostname !== '127.0.0.1' || !Number(url.port)) {
      throw new Error(`bad connection url ${connection.url}`);
    }
    return connection.url;
  }, 'the broker connection file to publish its bound API port');
  const api = brokerClient(brokerUrl);
  await waitFor(() => api('GET', '/api/status').then(() => true), 'the broker API to answer');

  await api('POST', '/api/spawn', {
    name: AGENT,
    cli: 'wedged',
    transport: 'pty',
    skip_relay_prompt: true,
  });
  await waitFor(async () => {
    const listed = await eng('GET', '/v1/agents', undefined, wsAuth);
    return (listed.body?.data ?? []).some((agent) => agent.name === AGENT);
  }, 'the agent to register with the real engine');

  // A real DM through the engine, large enough that it cannot be written to a
  // child that never reads.
  const sender = await eng('POST', '/v1/agents', { name: 'proof-sender', type: 'agent' }, wsAuth);
  const senderToken = sender.body?.data?.token;
  if (!senderToken) {
    throw new Error(`sender create failed: ${JSON.stringify(sender.body).slice(0, 300)}`);
  }
  const body = `relay-1686 unacked probe ${'x'.repeat(BODY_BYTES)}`;
  const dm = await eng(
    'POST',
    '/v1/dm',
    { to: AGENT, text: body },
    { authorization: `Bearer ${senderToken}` }
  );
  if (dm.status >= 300) {
    throw new Error(`DM failed: ${dm.status} ${JSON.stringify(dm.body).slice(0, 300)}`);
  }

  // Control, on both arms: the broker accepted the message as a retryable
  // delivery and has attempted it. Everything below reads as "no bound" or "a
  // bound fired" only because this held first.
  const tracked = await waitFor(async () => {
    const entry = await pendingEntry(api);
    return entry && Number(entry.attempts) >= 1 ? entry : null;
  }, 'the DM to become a pending delivery with a recorded attempt');
  const deliveryId = String(tracked.delivery_id);
  log(`delivery ${deliveryId} pending with ${tracked.attempts} attempt(s)`);

  const startedAt = Date.now();
  const window = arm === 'head' ? HEAD_WINDOW_MS : BASE_WINDOW_MS;
  let terminal = null;
  let lastAttempts = Number(tracked.attempts);
  while (Date.now() - startedAt < window) {
    const dead = await deadLetter(api, deliveryId);
    if (dead) {
      terminal = { dead, elapsedMs: Date.now() - startedAt };
      break;
    }
    const entry = await pendingEntry(api);
    if (entry) {
      lastAttempts = Number(entry.attempts);
    } else {
      // Gone from pending with nothing in the dead-letter store: either it was
      // delivered normally (the premise did not hold) or it was dropped
      // silently. Neither is an outcome this case may report.
      throw new Error(
        `Delivery ${deliveryId} left the pending map without a dead letter after ${
          Date.now() - startedAt
        }ms — the wedged-recipient premise did not hold, or the delivery was dropped silently.`
      );
    }
    await sleep(1_000);
  }

  let outcome;
  let signature;
  let details;
  if (!terminal) {
    if (arm === 'head') {
      throw new Error(
        `The head broker left delivery ${deliveryId} pending for ${window}ms with ${lastAttempts} attempts and no dead letter, despite a ${DEADLINE_MS}ms acknowledgement budget.`
      );
    }
    if (lastAttempts < 1) {
      throw new Error(`Delivery ${deliveryId} recorded no attempts; the retry path never ran.`);
    }
    outcome = 'bug';
    signature = 'unacked_delivery_retries_without_bound';
    details = `The base broker retried delivery ${deliveryId} for ${window}ms to a recipient that acknowledged nothing, reaching ${lastAttempts} attempts. It never became terminal: no message_delivery_failed, no dead letter. Every handoff write succeeded, which resets failed_attempts to zero, so the retry cap can never fire and the cumulative attempts are bounded by nothing.`;
  } else {
    if (arm === 'base') {
      throw new Error(
        `The base broker dead-lettered ${deliveryId} after ${terminal.elapsedMs}ms: ${JSON.stringify(
          terminal.dead
        ).slice(0, 400)}. The defect under test is that it never becomes terminal.`
      );
    }
    const reason = String(terminal.dead.reason ?? '');
    if (!reason.includes('unacknowledged')) {
      throw new Error(
        `The head broker dead-lettered ${deliveryId} for the wrong reason (${JSON.stringify(
          reason
        )}). A cap that reports a handoff failure would misdiagnose a recipient that accepted every write.`
      );
    }
    if (await pendingEntry(api)) {
      throw new Error(`Delivery ${deliveryId} is dead-lettered and still pending; it can still spin.`);
    }
    outcome = 'fixed';
    signature = 'unacked_delivery_dead_lettered_at_its_deadline';
    details = `The head broker made delivery ${deliveryId} terminal ${terminal.elapsedMs}ms after it went unacknowledged, against a ${DEADLINE_MS}ms budget. It is out of the pending map and in the dead-letter store with reason ${JSON.stringify(
      reason
    )}, where node deadletters can requeue it — rather than retrying forever with nothing reported.`;
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
async function pendingEntry(api) {
  const status = await api('GET', '/api/status');
  const pending = Array.isArray(status.pending) ? status.pending : [];
  return pending.find((entry) => entry.worker_name === AGENT) ?? null;
}
async function deadLetter(api, deliveryId) {
  const body = await api('GET', '/api/dead-letters');
  const entries = Array.isArray(body.dead_letters)
    ? body.dead_letters
    : Array.isArray(body.entries)
      ? body.entries
      : [];
  return entries.find((entry) => (entry.delivery_id ?? entry.delivery?.delivery_id) === deliveryId) ?? null;
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
