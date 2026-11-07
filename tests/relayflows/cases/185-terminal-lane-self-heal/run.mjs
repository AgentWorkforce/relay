import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '185-terminal-lane-self-heal';
const FIRST_GENERATION = 41;
const SECOND_GENERATION = 42;
const REDIAL_WINDOW_MS = 5_000;
const QUIET_WINDOW_MS = 1_000;

const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
const binaryPath = path.resolve(requiredValue('RELAY_PR_PROOF_BROKER_BINARY'));
const resultPath = path.resolve(requiredValue('RELAY_PR_PROOF_RESULT_PATH'));
const arm = requiredValue('RELAY_PR_PROOF_ARM');
if (arm !== 'base' && arm !== 'head') throw new Error(`Invalid proof arm ${JSON.stringify(arm)}.`);

const expectedSha = requiredValue(arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA');
const headSha = requiredValue('RELAY_PR_PROOF_HEAD_SHA');
if (shaAt(targetDir) !== expectedSha || shaAt(harnessDir) !== headSha) {
  throw new Error('Exact target/harness SHA mismatch.');
}
const runnerPath = fileURLToPath(import.meta.url);
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

const binarySha256 = createHash('sha256')
  .update(await readFile(binaryPath))
  .digest('hex');
const scratch = await mkdtemp(path.join(tmpdir(), 'relayflow-terminal-self-heal-'));
const stateDir = path.join(scratch, 'state');
await mkdir(stateDir);

const sockets = new Set();
const terminalSockets = [];
let controlSocket;
let controlConnections = 0;
let controlFrames = 0;
let nodeRegistered = false;
let fixtureError;
let broker;
let brokerStderr = '';

const server = http.createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const pathname = new URL(request.url, 'http://proof.invalid').pathname;
    if (request.method !== 'POST' || pathname !== '/v1/agents') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'no route' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        ok: true,
        data: {
          id: 'agent_terminal_self_heal_proof',
          workspace_id: 'ws_terminal_self_heal_proof',
          name: 'relayflow-terminal-self-heal',
          token: 'at_terminal_self_heal_proof',
          status: 'active',
          created_at: '2026-09-21T00:00:00Z',
        },
      })
    );
  } catch (error) {
    fixtureError = error;
    response.destroy();
  }
});

server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('error', () => {});
  socket.once('close', () => sockets.delete(socket));
});

server.on('upgrade', (request, socket, initialData) => {
  try {
    acceptWebSocket(request, socket);
    const pathname = new URL(request.url, 'http://proof.invalid').pathname;
    const isControl = pathname === '/v1/node/ws';
    const isTerminal = pathname === '/v1/node/terminal/ws';
    if (isControl) {
      controlConnections += 1;
      controlSocket = socket;
    }
    if (isTerminal) terminalSockets.push(socket);

    attachFrameReader(
      socket,
      (frame) => {
        try {
          if (frame.opcode === 0x9) {
            sendFrame(socket, 0xa, frame.payload);
            return;
          }
          if (frame.opcode !== 0x1 || !isControl) return;
          controlFrames += 1;
          const message = JSON.parse(frame.payload.toString('utf8'));
          if (message.type === 'node.register') nodeRegistered = true;
          if ((message.type === 'node.register' || message.type === 'inventory.sync') && message.id) {
            sendText(socket, { v: 1, type: 'reply', id: message.id, ok: true, data: {} });
          }
        } catch (error) {
          fixtureError = error;
        }
      },
      initialData
    );
  } catch (error) {
    fixtureError = error;
    socket.destroy();
  }
});

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const relaycastBaseUrl = `http://127.0.0.1:${server.address().port}`;
  broker = spawn(
    binaryPath,
    [
      'init',
      '--instance-name',
      'relayflow-terminal-self-heal',
      '--workspace-key',
      'rk_terminal_self_heal_proof',
      '--state-dir',
      stateDir,
      '--api-port',
      '0',
      '--channels',
      '',
    ],
    {
      cwd: scratch,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: scratch,
        TMPDIR: scratch,
        RELAYCAST_BASE_URL: relaycastBaseUrl,
        RELAY_BASE_URL: relaycastBaseUrl,
        RELAY_AGENT_TYPE: 'human',
        RELAY_AGENT_IDENTITY_KEY: 'relayflow-terminal-self-heal-fixture',
        RELAY_NODE_ID: 'node_terminal_self_heal_proof',
        RELAY_NODE_TOKEN: 'nt_terminal_self_heal_proof',
        RELAY_BROKER_API_KEY: 'br_terminal_self_heal_proof',
        AGENT_RELAY_NO_DEBUG_FILES: '1',
        AGENT_RELAY_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    }
  );
  broker.once('error', (error) => {
    fixtureError = error;
  });
  broker.stderr.on('data', (chunk) => {
    brokerStderr = `${brokerStderr}${chunk}`.slice(-8_000);
  });

  await waitFor(
    () => nodeRegistered && controlConnections === 1 && terminalSockets.length === 1,
    'initial control and terminal lanes'
  );

  // The terminal socket remains physically open but is logically absent from
  // Relaycast's lane registry. Only the additive control frame can repair it.
  sendText(controlSocket, {
    v: 1,
    type: 'terminal.reconnect_requested',
    generation: FIRST_GENERATION,
  });
  await waitForOptional(() => terminalSockets.length >= 2, REDIAL_WINDOW_MS);

  sendText(controlSocket, {
    v: 1,
    type: 'terminal.reconnect_requested',
    generation: SECOND_GENERATION,
  });
  await waitForOptional(() => terminalSockets.length >= 3, REDIAL_WINDOW_MS);

  // A replay of the same generation must not create another dial loop.
  sendText(controlSocket, {
    v: 1,
    type: 'terminal.reconnect_requested',
    generation: SECOND_GENERATION,
  });
  await new Promise((resolve) => setTimeout(resolve, QUIET_WINDOW_MS));

  if (fixtureError) throw fixtureError;
  if (broker.exitCode !== null) {
    throw new Error(`Broker exited early (${broker.exitCode}): ${brokerStderr}`);
  }

  const baseObserved =
    terminalSockets.length === 1 && controlConnections === 1 && nodeRegistered && controlFrames > 0;
  const headObserved =
    terminalSockets.length === 3 && controlConnections === 1 && nodeRegistered && controlFrames > 0;

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'bug';
    signature = 'terminal_generation_advance_leaves_dark_lane_attached';
    details =
      'The exact base broker kept its original terminal WebSocket after two increasing reconnect generations while the same node-control connection remained live.';
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'terminal_generation_advance_redials_once_per_generation';
    details =
      'The exact head broker replaced the terminal WebSocket once for each increasing generation, ignored a duplicate generation, and kept the original node-control connection live.';
  } else {
    throw new Error(
      `Unexpected terminal self-heal observation: ${JSON.stringify({
        arm,
        terminalConnections: terminalSockets.length,
        controlConnections,
        controlFrames,
        nodeRegistered,
        stderr: brokerStderr,
      })}`
    );
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify(
      {
        version: 1,
        caseId: CASE_ID,
        arm,
        outcome,
        signature,
        details,
        evidence: {
          targetSha: expectedSha,
          harnessSha: headSha,
          binarySha256,
          terminalConnections: terminalSockets.length,
          controlConnections,
        },
      },
      null,
      2
    )}\n`
  );
} finally {
  if (broker && broker.exitCode === null) {
    broker.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => broker.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (broker.exitCode === null) broker.kill('SIGKILL');
  }
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function requiredDirectory(name) {
  return path.resolve(requiredValue(name));
}

function shaAt(directory) {
  return execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function acceptWebSocket(request, socket) {
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string') throw new Error('Missing WebSocket key.');
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
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
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  }
  return { opcode, payload, consumed: offset + length };
}

function sendText(socket, value) {
  if (!socket || socket.destroyed) throw new Error('Control socket is not writable.');
  sendFrame(socket, 0x1, Buffer.from(JSON.stringify(value)));
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

async function waitFor(predicate, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fixtureError) throw fixtureError;
    if (broker?.exitCode !== null) throw new Error(`Broker exited while waiting for ${description}.`);
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForOptional(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fixtureError) throw fixtureError;
    if (broker?.exitCode !== null) throw new Error('Broker exited during terminal reconnect observation.');
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
