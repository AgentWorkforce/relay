import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const target = required('RELAY_PR_PROOF_TARGET_DIR');
const harness = required('RELAY_PR_PROOF_HARNESS_DIR');
const binary = required('RELAY_PR_PROOF_BROKER_BINARY');
const resultPath = required('RELAY_PR_PROOF_RESULT_PATH');
const arm = required('RELAY_PR_PROOF_ARM');
assert.ok(['base', 'head'].includes(arm));

const gitSha = (directory) =>
  execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(
  gitSha(target),
  required(arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA')
);
assert.equal(gitSha(harness), required('RELAY_PR_PROOF_HEAD_SHA'));
const relativeRunner = path.relative(harness, fileURLToPath(import.meta.url));
assert.ok(relativeRunner && !relativeRunner.startsWith('..') && !path.isAbsolute(relativeRunner));

const root = await mkdtemp(path.join(tmpdir(), 'relayflow-d1-pressure-'));
const state = path.join(root, 'state');
await mkdir(state);
const sockets = new Set();
const sessions = [];
let broker;
let protocolError;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function createFrameReader(socket, onText) {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      if (buffered.length < 2) return;
      const opcode = buffered[0] & 0x0f;
      const masked = (buffered[1] & 0x80) !== 0;
      let length = buffered[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffered.length < offset + 2) return;
        length = buffered.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffered.length < offset + 8) return;
        length = Number(buffered.readBigUInt64BE(offset));
        offset += 8;
      }
      let mask;
      if (masked) {
        if (buffered.length < offset + 4) return;
        mask = buffered.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffered.length < offset + length) return;
      const payload = Buffer.from(buffered.subarray(offset, offset + length));
      buffered = buffered.subarray(offset + length);
      if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      if (opcode === 0x1) onText(payload.toString('utf8'));
      if (opcode === 0x9) socket.write(encodeFrame(0x0a, payload));
    }
  };
}

function sendJson(socket, message) {
  socket.write(encodeFrame(0x1, JSON.stringify(message)));
}

const server = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    const url = request.url.split('?')[0];
    const send = (data) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, data }));
    };
    if (request.method === 'POST' && url === '/v1/agents') {
      let parsed = {};
      try {
        parsed = JSON.parse(body || '{}');
      } catch {}
      send({
        id: 'agt_d1_pressure_proof',
        workspace_id: 'ws_d1_pressure_proof',
        name: parsed.name ?? 'broker',
        token: 'at_d1_pressure_proof',
        status: 'online',
        created_at: '2026-10-03T00:00:00.000Z',
      });
      return;
    }
    if (url === '/v1/agents' || url === '/v1/channels') {
      send([]);
      return;
    }
    send({});
  });
});

server.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  sockets.add(socket);
  socket.on('error', () => {});
  if (request.url.split('?')[0] !== '/v1/node/ws') return;

  const session = {
    closed: false,
    registrationFrames: [],
    inventoryFrames: [],
    registrationTimes: [],
    inventoryTimes: [],
  };
  sessions.push(session);
  const markClosed = () => {
    session.closed = true;
    sockets.delete(socket);
  };
  socket.on('close', markClosed);
  socket.on('end', () => {
    markClosed();
    socket.end();
  });
  socket.on(
    'data',
    createFrameReader(socket, (text) => {
      if (protocolError) return;
      try {
        const frame = JSON.parse(text);
        if (frame.type === 'node.register') {
          session.registrationFrames.push(frame);
          session.registrationTimes.push(Date.now());
          if (session.registrationFrames.length === 1) {
            sendJson(socket, {
              v: 1,
              id: frame.id,
              type: 'error',
              ok: false,
              code: 'd1_pressure',
              message: 'Node liveness retry pending',
            });
          } else {
            assert.deepEqual(frame, session.registrationFrames[0]);
            assert.ok(session.registrationTimes[1] - session.registrationTimes[0] >= 750);
            sendJson(socket, { v: 1, id: frame.id, type: 'reply', ok: true, data: {} });
          }
        } else if (frame.type === 'inventory.sync') {
          session.inventoryFrames.push(frame);
          session.inventoryTimes.push(Date.now());
          if (session.inventoryFrames.length === 1) {
            sendJson(socket, {
              v: 1,
              id: frame.id,
              type: 'error',
              ok: false,
              code: 'd1_pressure',
              message: 'Node liveness retry pending',
            });
          } else {
            assert.deepEqual(frame, session.inventoryFrames[0]);
            assert.ok(session.inventoryTimes[1] - session.inventoryTimes[0] >= 750);
            sendJson(socket, { v: 1, id: frame.id, type: 'reply', ok: true, data: {} });
          }
        }
      } catch (error) {
        protocolError = error;
      }
    })
  );
});

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  broker = spawn(
    binary,
    [
      'init',
      '--instance-name',
      'd1-pressure-proof',
      '--api-port',
      '0',
      '--api-bind',
      '127.0.0.1',
      '--state-dir',
      state,
    ],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        TMPDIR: root,
        RELAY_API_KEY: 'rk_local_d1_pressure_proof',
        RELAYCAST_BASE_URL: `http://127.0.0.1:${port}`,
        RELAY_BASE_URL: `http://127.0.0.1:${port}`,
        RELAY_NODE_TOKEN: 'nt_local_d1_pressure_proof',
        RELAY_TELEMETRY_DISABLED: '1',
        RELAY_SKIP_TELEMETRY: '1',
      },
    }
  );
  let spawnFailed = false;
  broker.once('error', () => {
    spawnFailed = true;
  });
  broker.stdout.resume();
  broker.stderr.resume();

  let outcome;
  let signature;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (protocolError) throw protocolError;
    if (spawnFailed) throw new Error('Broker artifact could not be started.');
    if (broker.exitCode !== null) throw new Error(`Broker exited before evidence: ${broker.exitCode}`);
    const first = sessions[0];
    if (first?.closed && first.registrationFrames.length === 1) {
      outcome = 'bug';
      signature = 'd1_pressure_replaces_control_socket';
      break;
    }
    if (first && !first.closed && first.registrationFrames.length >= 2 && first.inventoryFrames.length >= 2) {
      outcome = 'fixed';
      signature = 'd1_pressure_retries_same_control_socket';
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!outcome) throw new Error('No terminal D1-pressure retry discriminator observed within 120s.');

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    JSON.stringify({
      version: 1,
      caseId: '204-d1-pressure-control-retry',
      arm,
      outcome,
      signature,
      details:
        outcome === 'bug'
          ? 'The broker replaced a healthy control socket after the correlated registration d1_pressure response.'
          : 'The broker retried identical registration and inventory frames after bounded delay on one open control socket.',
      sessions: sessions.map((session) => ({
        closed: session.closed,
        registrationCount: session.registrationFrames.length,
        inventoryCount: session.inventoryFrames.length,
        registrationRetryDelayMs:
          session.registrationTimes.length > 1
            ? session.registrationTimes[1] - session.registrationTimes[0]
            : null,
        inventoryRetryDelayMs:
          session.inventoryTimes.length > 1 ? session.inventoryTimes[1] - session.inventoryTimes[0] : null,
      })),
    }) + '\n'
  );
  console.log(signature);
} finally {
  if (broker && broker.exitCode === null) {
    broker.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => broker.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (broker.exitCode === null) broker.kill('SIGKILL');
  }
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
