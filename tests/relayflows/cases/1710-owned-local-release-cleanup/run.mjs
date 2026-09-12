import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1710-owned-local-release-cleanup';
const BROKER_API_KEY = 'rk_relayflow_1710';
const WORKSPACE_KEY = 'rk_relayflow_1710';
const NODE_ID = 'node_relayflow_1710';
const NODE_TOKEN = 'nt_relayflow_1710';
const WORKSPACE_ID = 'ws_relayflow_1710';
const OWNED_NAME = 'relayflow-1710-owned';
const CALLER_OWNED_NAME = 'relayflow-1710-caller-owned';

const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
const binaryPath = await requiredExecutable('RELAY_PR_PROOF_BROKER_BINARY');
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

const probeDir = await mkdtemp(path.join(tmpdir(), 'relayflow-1710-'));
const stateDir = path.join(probeDir, 'state');
await mkdir(stateDir, { recursive: true });

const relaycast = await startFakeRelaycast();
let broker;
try {
  broker = spawn(
    binaryPath,
    ['init', '--instance-name', 'relayflow-1710-broker', '--api-port', '0', '--api-bind', '127.0.0.1', '--state-dir', stateDir, '--channels', ''],
    {
      cwd: probeDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: probeDir,
        TMPDIR: probeDir,
        NO_COLOR: '1',
        RUST_LOG: 'info',
        RELAYCAST_BASE_URL: relaycast.baseUrl,
        RELAY_BASE_URL: relaycast.baseUrl,
        RELAYCAST_WS_URL: relaycast.baseUrl,
        RELAY_API_KEY: WORKSPACE_KEY,
        RELAY_WORKSPACE_KEY: WORKSPACE_KEY,
        AGENT_RELAY_WORKSPACE_KEY: WORKSPACE_KEY,
        RELAY_BROKER_API_KEY: BROKER_API_KEY,
        RELAY_NODE_ID: NODE_ID,
        RELAY_NODE_TOKEN: NODE_TOKEN,
        AGENT_RELAY_TELEMETRY_DISABLED: '1',
        DO_NOT_TRACK: '1',
      },
    }
  );

  const brokerUrl = await waitForConnection(stateDir, broker);
  const api = async (pathname, { timeoutMs = 15_000, ...options } = {}) => {
    const response = await fetch(`${brokerUrl}${pathname}`, {
      ...options,
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'x-api-key': BROKER_API_KEY,
        ...(options.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = { raw };
    }
    return { status: response.status, body };
  };

  await waitFor(async () => (await api('/api/status', { timeoutMs: 2_000 })).status === 200, 30_000, 'broker readiness');

  const ownedGeneration = await spawnWorker(api, OWNED_NAME);
  await waitFor(async () => (await liveWorkerNames(api)).includes(OWNED_NAME), 20_000, 'owned worker to appear');

  const ownedRelease = await releaseWorker(api, OWNED_NAME, {
    expected_generation: ownedGeneration,
    delete_identity: true,
  });
  const ownedDeleted = ownedRelease.status === 200 && ownedRelease.body?.process === 'stopped' && ownedRelease.body?.identity === 'deleted';
  if (!ownedDeleted) {
    await writeResult({
      arm,
      outcome: 'bug',
      signature: 'release_outcome_not_machine_readable',
      details: `The broker completed an owned release request, but the public response did not surface separate machine-readable process and identity outcomes: ${JSON.stringify(ownedRelease.body)}`,
    });
  }

  if (ownedDeleted) {
    await waitFor(async () => !(await liveWorkerNames(api)).includes(OWNED_NAME), 20_000, 'owned worker to disappear after release');

  const repeatRelease = await releaseWorker(api, OWNED_NAME, {
    expected_generation: ownedGeneration,
    delete_identity: true,
  });
  assert.equal(repeatRelease.status, 200);
  assert.equal(repeatRelease.body?.process, 'stopped');
  assert.equal(repeatRelease.body?.identity, 'deleted');
  assert.equal(relaycast.state.releaseRequests.length, 1);
  assert.equal(relaycast.state.releaseRequests[0]?.delete_agent, true);

  const replacementGeneration = await spawnWorker(api, OWNED_NAME);
  assert.notEqual(replacementGeneration, ownedGeneration);
  await waitFor(async () => (await liveWorkerNames(api)).includes(OWNED_NAME), 20_000, 'replacement worker to appear');

  const replacementRelease = await releaseWorker(api, OWNED_NAME, {
    expected_generation: replacementGeneration,
    delete_identity: true,
  });
  assert.equal(replacementRelease.status, 200);
  assert.equal(replacementRelease.body?.process, 'stopped');
  assert.equal(replacementRelease.body?.identity, 'deleted');
  assert.equal(relaycast.state.releaseRequests.length, 2);
  assert.equal(relaycast.state.releaseRequests[1]?.delete_agent, true);

  await waitFor(async () => !(await liveWorkerNames(api)).includes(OWNED_NAME), 20_000, 'replacement worker to disappear after release');

  const callerRetained = await releaseWorker(api, CALLER_OWNED_NAME, {
    reason: 'caller-owned release proof',
    delete_identity: false,
  });
  assert.equal(callerRetained.status, 200);
  assert.equal(callerRetained.body?.process, 'stopped');
  assert.equal(callerRetained.body?.identity, 'retained');
  assert.equal(relaycast.state.releaseRequests.length, 3);
  // Caller-owned release may omit the deletion flag entirely; the proof only
  // needs to confirm that it did not request identity deletion.
  assert.notEqual(relaycast.state.releaseRequests[2]?.delete_agent, true);

  const callerRefusal = await releaseWorker(api, CALLER_OWNED_NAME, {
    expected_generation: '00000000-0000-0000-0000-000000000000',
    delete_identity: true,
  });
  assert.equal(callerRefusal.status, 500);
  assert.match(JSON.stringify(callerRefusal.body), /refusing/i);
  assert.equal(relaycast.state.releaseRequests.length, 3);

  await writeResult({
    arm,
    outcome: 'fixed',
    signature: 'owned_release_deletes_exactly_and_repeats_safely',
    details:
      'The exact attested broker binary deleted an owned worker identity with separate process and identity fields, repeated the same release idempotently without a second Relaycast deletion, allowed a replacement generation to clean up independently, and retained/refused caller-owned releases through the public HTTP API.',
  });
  }
} finally {
  if (broker && broker.exitCode === null) {
    broker.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => broker.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (broker.exitCode === null) broker.kill('SIGKILL');
  }
  await relaycast.close();
  await rm(probeDir, { recursive: true, force: true });
}

async function spawnWorker(api, name) {
  const response = await api('/api/spawn', {
    method: 'POST',
    body: JSON.stringify({
      name,
      cli: 'cat',
      cwd: process.cwd(),
      channels: [],
      transport: 'pty',
      skip_relay_prompt: true,
    }),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body?.success, true, JSON.stringify(response.body));
  assert.equal(typeof response.body?.generation, 'string');
  return response.body.generation;
}

async function releaseWorker(api, name, body) {
  return api(`/api/spawned/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    body: JSON.stringify(body),
  });
}

async function liveWorkerNames(api) {
  const response = await api('/api/spawned', { timeoutMs: 5_000 });
  const agents = response.body?.agents;
  return Array.isArray(agents) ? agents.map((agent) => agent?.name).filter(Boolean) : [];
}

async function startFakeRelaycast() {
  const state = {
    registrations: 0,
    releaseRequests: [],
    nodeFrames: [],
    nodeSocket: undefined,
  };

  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://relayflow.invalid').pathname;
    const body = await readJson(request).catch(() => undefined);

    if (request.method === 'POST' && pathname === '/v1/agents') {
      state.registrations += 1;
      sendJson(response, 200, {
        ok: true,
        data: {
          id: 'agent_relayflow_1710_broker',
          workspace_id: WORKSPACE_ID,
          name: body?.name ?? 'relayflow-1710-broker',
          token: 'at_relayflow_1710_broker',
          status: 'active',
          created_at: '2026-09-12T00:00:00.000Z',
        },
      });
      return;
    }

    if (request.method === 'POST' && /^\/v1\/nodes\/[^/]+\/agents$/.test(pathname)) {
      sendJson(response, 200, {
        ok: true,
        data: {
          id: `binding_${state.registrations}`,
          agent_id: 'agent_relayflow_1710_broker',
          agent_name: body?.agent_name ?? body?.name ?? 'relayflow-1710-broker',
          node_id: NODE_ID,
          node_name: 'relayflow-1710-broker',
          node_kind: 'local',
          node_role: 'broker',
          status: 'active',
          session_ref: body?.session_ref ?? null,
          priority: body?.priority ?? 0,
          created_at: '2026-09-12T00:00:00.000Z',
          updated_at: null,
        },
      });
      return;
    }

    if (request.method === 'GET' && pathname.startsWith('/v1/agents/')) {
      const name = decodeURIComponent(pathname.slice('/v1/agents/'.length));
      sendJson(response, 200, {
        ok: true,
        data: {
          id: `agent_${name.replaceAll('-', '_')}`,
          workspace_id: WORKSPACE_ID,
          name,
          type: 'agent',
          status: 'active',
          persona: null,
          metadata: {},
          channels: [],
        },
      });
      return;
    }

    if (request.method === 'POST' && pathname === '/v1/agents/release') {
      state.releaseRequests.push(body ?? {});
      sendJson(response, 200, {
        ok: true,
        data: {
          invocation_id: `invocation_release_${state.releaseRequests.length}`,
          action_name: 'release',
          handler_agent_id: null,
          handler_node_id: null,
          dispatched_node_id: null,
          input: { name: body?.name ?? '' },
          status: 'completed',
          created_at: '2026-09-12T00:00:00.000Z',
        },
      });
      return;
    }

    if (request.method === 'POST' && pathname === '/v1/dm') {
      sendJson(response, 200, {
        ok: true,
        data: {
          conversation_id: 'dm_relayflow_1710',
          message: {
            id: `msg_${state.registrations}`,
            agent_id: 'agent_relayflow_1710_broker',
            agent_name: 'relayflow-1710-broker',
            text: body?.text ?? '',
            injection_mode: body?.mode ?? 'wait',
          },
          created_at: '2026-09-12T00:00:00.000Z',
        },
      });
      return;
    }

    if (request.method === 'POST' && pathname === '/v1/channels/general/messages') {
      sendJson(response, 200, { ok: true, data: {} });
      return;
    }

    sendJson(response, 200, { ok: true, data: {} });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  server.on('upgrade', (request, socket, head) => {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const pathname = new URL(request.url ?? '/', 'http://relayflow.invalid').pathname;
    if (pathname !== '/v1/node/ws') {
      socket.destroy();
      return;
    }
    attachFrameReader(
      socket,
      (frame) => {
        if (frame.opcode === 0x9) {
          sendFrame(socket, 0x0a, frame.payload);
          return;
        }
        if (frame.opcode !== 0x1) return;
        const message = JSON.parse(frame.payload.toString('utf8'));
        state.nodeFrames.push(message);
        if (message.type === 'agent.register') {
          sendText(socket, {
            type: 'reply',
            v: 1,
            id: message.id,
            ok: true,
            data: {
              agent_id: 'agent_relayflow_1710_node',
              token: 'at_relayflow_1710_node',
              name: message.name,
              delivery_ack_seq: 0,
            },
          });
        }
      },
      head
    );
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected Relaycast TCP address.');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function waitForConnection(stateDir, child) {
  let lastError;
  return waitFor(
    async () => {
      if (child.exitCode !== null) {
        throw new Error(`Broker exited during startup (${child.exitCode}).`);
      }
      try {
        const connection = JSON.parse(await readFile(path.join(stateDir, 'connection.json'), 'utf8'));
        const url = new URL(connection.url);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
          throw new Error(`Broker connection URL is not a plain loopback origin: ${url.origin}`);
        }
        return `http://127.0.0.1:${Number(url.port)}`;
      } catch (error) {
        lastError = error;
        return false;
      }
    },
    30_000,
    `connection metadata (${lastError?.message ?? 'not written'})`
  );
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}.`);
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

function attachFrameReader(socket, onFrame, initialData = Buffer.alloc(0)) {
  let buffered = Buffer.from(initialData);
  const consume = (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (true) {
      const decoded = decodeFrame(buffered);
      if (!decoded) return;
      buffered = buffered.subarray(decoded.consumed);
      onFrame(decoded);
    }
  };
  socket.on('data', consume);
  if (buffered.length > 0) consume(Buffer.alloc(0));
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return undefined;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    const wideLength = buffer.readBigUInt64BE(2);
    if (wideLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame is too large.');
    length = Number(wideLength);
    offset = 10;
  }
  let mask;
  if (masked) {
    if (buffer.length < offset + 4) return undefined;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return undefined;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  return { opcode, payload, consumed: offset + length };
}

function sendText(socket, value) {
  if (!socket || socket.destroyed) return false;
  sendFrame(socket, 0x1, Buffer.from(JSON.stringify(value)));
  return true;
}

function sendFrame(socket, opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

async function writeResult({ arm, outcome, signature, details }) {
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
}

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function requiredDirectory(name) {
  return path.resolve(requiredValue(name));
}

async function requiredExecutable(name) {
  const candidate = path.resolve(requiredValue(name));
  try {
    await access(candidate, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    throw new Error(`${name} must name a readable executable file.`);
  }
  return candidate;
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
