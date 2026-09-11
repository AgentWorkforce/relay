// Proves #1603 through the real public fleet-control path. The local fake is
// deliberately transport-only: HTTP registration/events plus /v1/node/ws.
// It drives action.invoke, launches a real disposable child, holds the first
// event request open after persistence, kills the broker, then enables HTTP
// success for the restarted broker's replay.
//
// >256 backlog replenishment and retention pressure remain unit-level proof in
// runtime/tests.rs and crash_insights.rs; this live case does not claim them.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1603-hosted-exit-durable-delivery';
const AGENT_NAME = 'relayflow-1603-live-child';
const INSTANCE_NAME = 'relayflow-1603-live-broker';
const INVOCATION_ID = 'relayflow-1603-live-invocation';
const EXIT_WINDOW_MS = 15_000;
const REPLAY_WINDOW_MS = 15_000;
const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
const binaryPath = await requiredExecutable('RELAY_PR_PROOF_BROKER_BINARY');
const resultPath = requiredValue('RELAY_PR_PROOF_RESULT_PATH');
const arm = requiredValue('RELAY_PR_PROOF_ARM');

if (!['base', 'head'].includes(arm)) throw new Error(`Unexpected proof arm ${JSON.stringify(arm)}.`);
const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
if (!expectedSha) throw new Error(`Missing expected ${arm} SHA.`);
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (targetSha !== expectedSha)
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
if (!isWithin(harnessDir, fileURLToPath(import.meta.url)))
  throw new Error('Runner must execute from the exact-head harness checkout.');

const probeDir = await mkdtemp(path.join(tmpdir(), 'relayflow-1603-live-'));
const stateDir = path.join(probeDir, 'state');
const childExitProofPath = path.join(probeDir, 'real-child-exit-code');
const childProofNonce = randomUUID();
const childSessionRef = `relayflow-1603-live-session-${childProofNonce}`;
let relaycast;
let firstBroker;
let replayBroker;
let successfulSpawnActionResult;
let realChildExit;
let realChildExitProof;
let brokerChildLifecycle;
try {
  relaycast = await startFakeRelaycast({
    childExitProofPath,
    childProofNonce,
    childSessionRef,
  });
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: probeDir,
    TMPDIR: probeDir,
    NO_COLOR: '1',
    RELAYCAST_BASE_URL: relaycast.baseUrl,
    RELAY_NODE_TOKEN: 'nt_relayflow_1603',
    RELAY_NODE_ID: 'node_relayflow_1603',
    AGENT_RELAY_WORKSPACE_KEY: 'rk_relayflow_1603',
    AGENT_RELAY_STARTUP_DEBUG: '1',
    AGENT_RELAY_TELEMETRY_DISABLED: '1',
  };
  firstBroker = startBroker({ binaryPath, cwd: probeDir, stateDir, env });
  await waitFor(
    () => relaycast.observations().spawnRequests === 1,
    EXIT_WINDOW_MS,
    'fleet action.invoke was not sent'
  );
  await waitFor(
    () => relaycast.successfulSpawnActionResult(),
    EXIT_WINDOW_MS,
    'fleet spawn never returned a successful action.result for the invocation'
  );
  successfulSpawnActionResult = relaycast.successfulSpawnActionResult();
  await waitFor(
    async () => {
      realChildExit = await expectedChildExit(stateDir);
      realChildExitProof = await childExitProof(childExitProofPath, childProofNonce, childSessionRef);
      brokerChildLifecycle = relaycast.expectedChildLifecycle();
      return Boolean(realChildExit || realChildExitProof) && brokerChildLifecycle;
    },
    EXIT_WINDOW_MS,
    'the fleet-spawned child never recorded the expected exit code 23'
  );
  await waitFor(
    () => relaycast.observations().eventAttempts === 1,
    EXIT_WINDOW_MS,
    'real child exit never reached Relaycast publication'
  );
  const beforeRestart = await crashInsights(stateDir);
  const pending = beforeRestart.records.find((record) => record.agent_name === AGENT_NAME);
  if (!expectedChildExitRecord(pending) || pending.hosted_delivery !== 'pending' || !pending.generation) {
    throw diagnostic('The real pre-restart exit was not durably Pending.', {
      beforeRestart,
      pending,
      relaycast: relaycast.observations(),
      firstBroker,
    });
  }

  // The first request is deliberately unanswered: persistence has happened,
  // but no HTTP success exists. Cross a real process restart boundary now.
  await stopBroker(firstBroker, 'SIGKILL');
  firstBroker = undefined;
  await relaycast.enableDelivery();
  replayBroker = startBroker({ binaryPath, cwd: probeDir, stateDir, env });
  await waitFor(
    () => relaycast.observations().eventAttempts === 2,
    REPLAY_WINDOW_MS,
    'restart did not replay the pending hosted exit'
  );
  await waitFor(
    async () => {
      const state = await crashInsights(stateDir);
      return state.records.some(
        (record) =>
          expectedChildExitRecord(record) &&
          record.generation === pending.generation &&
          record.hosted_delivery === 'delivered'
      );
    },
    REPLAY_WINDOW_MS,
    'HTTP 200 did not mark the real exit Delivered'
  );
  const final = relaycast.observations();
  const afterRestart = await crashInsights(stateDir);
  const expectedDedupeKey = `${AGENT_NAME}::${pending.generation}`;
  const dedupeKeys = final.eventBodies.map((body) => body?.payload?.dedupe_key);
  if (
    final.spawnRequests !== 1 ||
    final.eventAttempts !== 2 ||
    !successfulSpawnActionResult ||
    !brokerChildLifecycle ||
    !final.eventBodies.every((body) =>
      expectedAgentExitedEvent(body, pending.generation, expectedDedupeKey)
    ) ||
    !dedupeKeys.every((key) => key === expectedDedupeKey)
  ) {
    throw diagnostic('Unexpected live fleet-control replay observation.', {
      final,
      beforeRestart,
      afterRestart,
      firstBroker,
      replayBroker,
    });
  }
  await writeResult(
    'fixed',
    'live_fleet_child_exit_persists_then_replays_once_after_restart',
    `A public /v1/node/ws action.invoke returned successful action.result, launched a real disposable child, and recorded its exit code 23 as Pending before Relaycast HTTP was available. After killing and restarting the exact broker on the same state, it replayed exactly the persisted generation as agent_exited with dedupe_key ${expectedDedupeKey} and became Delivered only after a fake Relaycast HTTP 200.`
  );
} catch (error) {
  // Pre-fix binaries legitimately lack the durable-outbox code, so they do
  // not make the first event request. They may also lack the durable crash
  // record; in that arm only, accept the nonce-bound, child-owned exit marker
  // after the exact action result and broker lifecycle prove the same invocation.
  if (
    arm === 'base' &&
    relaycast?.observations().eventAttempts === 0 &&
    relaycast.observations().spawnRequests === 1 &&
    successfulSpawnActionResult &&
    brokerChildLifecycle &&
    (expectedChildExitRecord(realChildExit) || realChildExitProof)
  ) {
    await writeResult(
      'bug',
      'live_exit_never_enters_durable_hosted_outbox',
      'The base broker returned successful action.result for the public fleet spawn and the real disposable child proved exit code 23, but the broker never published its hosted exit.'
    );
  } else {
    throw diagnostic(error.message, {
      relaycast: relaycast?.observations(),
      firstBroker: firstBroker?.logs(),
      replayBroker: replayBroker?.logs(),
    });
  }
} finally {
  await stopBroker(firstBroker, 'SIGKILL');
  await stopBroker(replayBroker, 'SIGKILL');
  await relaycast?.close();
  await rm(probeDir, { recursive: true, force: true });
}

function startBroker({ binaryPath, cwd, stateDir, env }) {
  const child = spawn(
    binaryPath,
    ['init', '--instance-name', INSTANCE_NAME, '--channels', 'general', '--persist', '--state-dir', stateDir],
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return { child, logs: () => ({ stdout: stdout.slice(-4_000), stderr: stderr.slice(-4_000) }) };
}
async function stopBroker(broker, signal) {
  if (!broker?.child || broker.child.exitCode !== null) return;
  broker.child.kill(signal);
  await Promise.race([new Promise((resolve) => broker.child.once('exit', resolve)), sleep(5_000)]);
  if (broker.child.exitCode === null) broker.child.kill('SIGKILL');
}
async function crashInsights(directory) {
  return JSON.parse(await readFile(path.join(directory, 'crash-insights.json'), 'utf8'));
}
async function expectedChildExit(directory) {
  try {
    const insights = await crashInsights(directory);
    return insights.records.find(expectedChildExitRecord);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}
async function childExitProof(proofPath, nonce, sessionRef) {
  try {
    const marker = JSON.parse(await readFile(proofPath, 'utf8'));
    return (
      marker?.nonce === nonce &&
      marker.invocation_id === INVOCATION_ID &&
      marker.session_ref === sessionRef &&
      marker.status === 23 &&
      Number.isSafeInteger(marker.pid) &&
      marker.pid > 1
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
function expectedChildExitRecord(record) {
  return (
    record?.agent_name === AGENT_NAME &&
    record.spawn_invocation_id === INVOCATION_ID &&
    record.exit_code === 23
  );
}
function expectedAgentExitedEvent(body, generation, dedupeKey) {
  return (
    body?.type === 'agent_exited' &&
    hasExactKeys(body, ['type', 'payload']) &&
    hasExactKeys(body.payload, [
      'code',
      'signal',
      'reason',
      'generation',
      'workspace_id',
      'spawn_invocation_id',
      'fleet_node_name',
      'became_ready',
      'spawned_at',
      'ready_at',
      'exited_at',
      'dedupe_key',
    ]) &&
    body.payload?.spawn_invocation_id === INVOCATION_ID &&
    body.payload?.code === 23 &&
    body.payload?.generation === generation &&
    body.payload?.dedupe_key === dedupeKey
  );
}
function hasExactKeys(value, expectedKeys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}
async function writeResult(outcome, signature, details) {
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
}

/** Minimal Relaycast HTTP plus raw WebSocket fake; no production test hooks. */
async function startFakeRelaycast({ childExitProofPath, childProofNonce, childSessionRef }) {
  let spawnRequests = 0;
  let actionSent = false;
  let deliveryAvailable = false;
  const heldResponses = new Set();
  const eventBodies = [];
  const controlMessages = [];
  const actionResults = [];
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    const body = await requestBody(request);
    if (request.method === 'POST' && request.url === '/v1/agents') {
      return json(response, 200, {
        ok: true,
        data: {
          id: 'a_relayflow_broker',
          workspace_id: 'ws_relayflow_1603',
          name: INSTANCE_NAME,
          token: 'at_relayflow_broker',
          status: 'online',
          created_at: '2025-01-01T00:00:00Z',
        },
      });
    }
    if (request.method === 'GET' && request.url === `/v1/agents/${AGENT_NAME}`) {
      return json(response, 200, {
        ok: true,
        data: { id: 'a_relayflow_live_child', name: AGENT_NAME, channels: [] },
      });
    }
    if (request.method === 'POST' && request.url === `/v1/agents/${AGENT_NAME}/events`) {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      eventBodies.push(parsed);
      if (!deliveryAvailable) {
        heldResponses.add(response);
        response.once('close', () => heldResponses.delete(response));
        return;
      }
      return json(response, 200, {
        ok: true,
        data: {
          id: 'evt_relayflow_1603',
          agent_id: 'a_relayflow_live_child',
          type: 'agent_exited',
          payload: parsed?.payload ?? {},
          created_at: '2025-01-01T00:00:01Z',
        },
      });
    }
    return json(response, 404, { ok: false, error: { code: 'not_found', message: request.url } });
  });
  server.on('upgrade', (request, socket) => {
    if (!request.url?.startsWith('/v1/node/ws')) return socket.destroy();
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') return socket.destroy();
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let frame;
      while ((frame = takeFrame(buffer))) {
        buffer = buffer.subarray(frame.consumed);
        if (frame.opcode === 8) return socket.end();
        if (frame.opcode === 9) {
          socket.write(serverFrame(10, frame.payload));
          continue;
        }
        if (frame.opcode !== 1) continue;
        let message;
        try {
          message = JSON.parse(frame.payload.toString('utf8'));
        } catch {
          continue;
        }
        controlMessages.push(message);
        if (message.type === 'action.result') actionResults.push(message);
        if (message.type === 'agent.register')
          sendJson(socket, {
            type: 'reply',
            v: 1,
            id: message.id,
            ok: true,
            data: {
              agent_id: 'a_relayflow_live_child',
              token: 'at_relayflow_live_child',
              name: AGENT_NAME,
              delivery_ack_seq: 0,
            },
          });
        if (message.type === 'agent.deregister')
          sendJson(socket, { type: 'reply', v: 1, id: message.id, ok: true, data: {} });
        if (message.type === 'node.register' && !actionSent) {
          actionSent = true;
          spawnRequests += 1;
          sendJson(socket, {
            type: 'action.invoke',
            v: 1,
            invocation_id: INVOCATION_ID,
            action: 'spawn',
            agent_name: AGENT_NAME,
            input: {
              name: AGENT_NAME,
              cli: 'claude',
              channels: [],
              harnessConfig: {
                runtime: 'native',
                command: '/bin/sh',
                args: ['-c', childExitCommand(childExitProofPath, childProofNonce, childSessionRef)],
                sessionId: childSessionRef,
              },
            },
          });
        }
      }
    });
    socket.once('close', () => sockets.delete(socket));
    socket.once('error', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    observations: () => ({
      spawnRequests,
      eventAttempts: eventBodies.length,
      eventBodies,
      actionSent,
      deliveryAvailable,
      controlMessages,
      actionResults,
      heldResponseCount: heldResponses.size,
    }),
    successfulSpawnActionResult: () =>
      actionResults.some(
        (result) =>
          result.invocation_id === INVOCATION_ID &&
          result.output?.spawned === true &&
          result.output?.name === AGENT_NAME &&
          result.error === undefined
      ),
    expectedChildLifecycle: () => {
      const registrationIndex = controlMessages.findIndex(
        (message) =>
          message.type === 'agent.register' &&
          message.name === AGENT_NAME &&
          message.invocation_id === INVOCATION_ID &&
          message.session_ref === childSessionRef
      );
      if (registrationIndex < 0) return false;
      const lifecycle = controlMessages.slice(registrationIndex + 1);
      const activeInventoryIndex = lifecycle.findIndex(
        (message) =>
          message.type === 'inventory.sync' &&
          message.agents?.some(
            (agent) =>
              agent.name === AGENT_NAME &&
              agent.invocation_id === INVOCATION_ID &&
              agent.session_ref === childSessionRef
          )
      );
      return (
        activeInventoryIndex >= 0 &&
        lifecycle
          .slice(activeInventoryIndex + 1)
          .some(
            (message) =>
              message.type === 'inventory.sync' && !message.agents?.some((agent) => agent.name === AGENT_NAME)
          )
      );
    },
    enableDelivery: async () => {
      deliveryAvailable = true;
      destroyHeldResponses(heldResponses);
    },
    close: async () => {
      destroyHeldResponses(heldResponses);
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
function childExitCommand(markerPath, nonce, sessionRef) {
  return `trap 'status=$?; printf "{\\"nonce\\":\\"${nonce}\\",\\"invocation_id\\":\\"${INVOCATION_ID}\\",\\"session_ref\\":\\"${sessionRef}\\",\\"status\\":%s,\\"pid\\":%s}\\n" "$status" "$$" > "${markerPath}"' 0; sleep 2; exit 23`;
}
function destroyHeldResponses(responses) {
  for (const response of responses) {
    if (!response.destroyed) response.destroy();
  }
  responses.clear();
}
function sendJson(socket, value) {
  socket.write(serverFrame(1, Buffer.from(JSON.stringify(value))));
}
function serverFrame(opcode, payload) {
  const length = payload.length;
  if (length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
  if (length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }
  throw new Error('RelayFlow fake frame unexpectedly exceeds 64KiB.');
}
function takeFrame(buffer) {
  if (buffer.length < 2) return null;
  const masked = Boolean(buffer[1] & 0x80);
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  if (length === 127 || !masked || buffer.length < offset + 4 + length) return null;
  const key = buffer.subarray(offset, offset + 4);
  const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
  for (let index = 0; index < payload.length; index += 1) payload[index] ^= key[index % 4];
  return { opcode: buffer[0] & 0x0f, payload, consumed: offset + 4 + length };
}
function requestBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}
async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error(message);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function diagnostic(message, extra) {
  return new Error(
    `${message} ${JSON.stringify(extra, (_, value) => (typeof value === 'function' ? value() : value)).slice(-12_000)}`
  );
}
function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}
function requiredDirectory(name) {
  return path.resolve(requiredValue(name));
}
async function requiredExecutable(name) {
  const value = path.resolve(requiredValue(name));
  await access(value, fsConstants.X_OK);
  return value;
}
function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
