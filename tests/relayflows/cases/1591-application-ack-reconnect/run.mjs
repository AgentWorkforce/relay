import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BROKER_NAME, BROKER_TYPE, BROKER_IDENTITY, brokerHttpResponse } from './http-fixture.mjs';

const CASE_ID = '1591-application-ack-reconnect';
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const arm = required('RELAY_PR_PROOF_ARM');
if (!['base', 'head'].includes(arm)) throw new Error('Invalid proof arm');
const targetDir = path.resolve(required('RELAY_PR_PROOF_TARGET_DIR'));
const harnessDir = path.resolve(required('RELAY_PR_PROOF_HARNESS_DIR'));
const expectedSha = required(arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA');
const headSha = required('RELAY_PR_PROOF_HEAD_SHA');
const shaAt = (directory) =>
  execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (shaAt(targetDir) !== expectedSha || shaAt(harnessDir) !== headSha)
  throw new Error('Exact target/harness SHA mismatch');
if (fileURLToPath(import.meta.url) !== path.join(harnessDir, 'tests/relayflows/cases', CASE_ID, 'run.mjs'))
  throw new Error('Runner must come from exact-head harness');
const binary = path.resolve(required('RELAY_PR_PROOF_BROKER_BINARY'));
const binarySha256 = createHash('sha256')
  .update(await readFile(binary))
  .digest('hex');
const resultPath = path.resolve(required('RELAY_PR_PROOF_RESULT_PATH'));
const scratch = await mkdtemp(path.join(tmpdir(), 'relayflow-inventory-ack-'));
const stateDir = path.join(scratch, 'state');
await mkdir(stateDir);
const sockets = new Set();
const connections = [];
const started = performance.now();
let broker;
let stderr = '';
let fixtureError;
const server = http.createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    const pathname = new URL(request.url, 'http://proof.invalid').pathname;
    const result = brokerHttpResponse(request.method, pathname, body);
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result.body));
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
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.destroy();
    return;
  }
  const accept = createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  const isNode = new URL(request.url, 'http://proof.invalid').pathname === '/v1/node/ws';
  const connection = {
    connectedMs: performance.now() - started,
    pongs: 0,
    inventory: 0,
    acknowledgements: 0,
    heartbeats: 0,
  };
  if (isNode) connections.push(connection);
  attachFrameReader(
    socket,
    (frame) => {
      try {
        if (frame.opcode === 0x9) {
          sendFrame(socket, 0xa, frame.payload);
          if (isNode) connection.pongs++;
          return;
        }
        if (frame.opcode !== 0x1 || !isNode) return;
        const message = JSON.parse(frame.payload);
        if (message.type === 'node.heartbeat') connection.heartbeats++;
        if (message.type === 'node.register') {
          sendText(socket, { v: 1, type: 'reply', id: message.id ?? 'legacy-register', ok: true, data: {} });
        }
        if (message.type === 'inventory.sync') {
          connection.inventory++;
          // Accept the initial inventory, then stall only the first session's
          // application. Its transport continues answering every ping. A new
          // session is healthy so an unnecessary reconnect loop is observable.
          if (connection !== connections[0] || connection.inventory === 1) {
            sendText(socket, {
              v: 1,
              type: 'reply',
              id: message.id ?? 'legacy-inventory',
              ok: true,
              data: { reconciled: 0 },
            });
            connection.acknowledgements++;
          }
        }
      } catch (error) {
        fixtureError = error;
      }
    },
    initialData
  );
});
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  broker = spawn(
    binary,
    [
      'init',
      '--instance-name',
      BROKER_NAME,
      '--workspace-key',
      'rk_proof',
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
        ...process.env,
        RELAYCAST_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        RELAY_AGENT_TYPE: BROKER_TYPE,
        RELAY_AGENT_IDENTITY_KEY: BROKER_IDENTITY,
        RELAY_NODE_ID: 'node_proof_inventory_ack',
        RELAY_NODE_TOKEN: 'nt_proof',
        RELAY_BROKER_API_KEY: 'br_proof',
        AGENT_RELAY_NO_DEBUG_FILES: '1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    }
  );
  broker.once('error', (error) => {
    fixtureError = error;
  });
  broker.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8000);
  });
  // Uses production 60s inventory cadence and 120s application deadline. No
  // source rewriting or Cargo is permitted in the protected artifact runner.
  const deadline = performance.now() + 150_000;
  while (performance.now() < deadline) {
    if (fixtureError) throw fixtureError;
    if (broker.exitCode !== null) throw new Error(`Broker exited (${broker.exitCode}): ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const first = connections[0];
  if (
    !first ||
    first.inventory < 2 ||
    first.pongs < 6 ||
    first.acknowledgements !== 1 ||
    first.heartbeats < 6
  ) {
    throw new Error(`Application/transport fixture controls missing: ${JSON.stringify(connections)}`);
  }
  const reconnected = connections.length === 2;
  if (connections.length > 2) throw new Error('Healthy replacement unexpectedly reconnected again');
  if (reconnected) {
    const gap = connections[1].connectedMs - first.connectedMs;
    if (gap < 110_000 || gap > 145_000 || connections[1].acknowledgements < 1) {
      throw new Error(`Unexpected reconnect timing/readiness: ${JSON.stringify(connections)}`);
    }
  }
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify(
      {
        version: 1,
        caseId: CASE_ID,
        arm,
        outcome: reconnected ? 'fixed' : 'bug',
        signature: reconnected ? 'application_ack_stall_reconnects' : 'application_ack_stall_not_detected',
        details:
          'Exact broker artifact against loopback HTTP/WebSocket fixture; initial inventory accepted, later inventory acknowledgements withheld while pongs continue for 150 seconds.',
        evidence: { targetSha: expectedSha, harnessSha: headSha, binarySha256, connections },
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
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (broker.exitCode === null) broker.kill('SIGKILL');
  }
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
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
