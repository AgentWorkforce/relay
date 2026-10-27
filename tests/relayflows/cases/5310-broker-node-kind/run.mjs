// Reuses the dependency-free HTTP/RFC6455 stand-in from relay#1593's
// registration-gate case. Observes the spawn capabilities the broker declares
// in its first node.register frame: Cloud (cloud#5310) refuses an unclaimed node
// whose spawn capabilities state no metadata.configured.node_kind.
// Exercise the exact provided broker artifact; no source compilation or edits.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const required = (name) => {
  const v = process.env[name];
  if (!v) throw Error(`Missing ${name}`);
  return v;
};
const target = required('RELAY_PR_PROOF_TARGET_DIR');
const harness = required('RELAY_PR_PROOF_HARNESS_DIR');
const binary = required('RELAY_PR_PROOF_BROKER_BINARY');
const resultPath = required('RELAY_PR_PROOF_RESULT_PATH');
const arm = required('RELAY_PR_PROOF_ARM');
assert.ok(['base', 'head'].includes(arm));
const gitSha = (dir) => execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(
  gitSha(target),
  required(arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA')
);
assert.equal(gitSha(harness), required('RELAY_PR_PROOF_HEAD_SHA'));
const relative = path.relative(harness, fileURLToPath(import.meta.url));
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
const root = await mkdtemp(path.join(tmpdir(), 'relayflow-node-kind-'));
const state = path.join(root, 'state');
await mkdir(state);
const sockets = new Set();
let registration = null;
let broker;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function createFrameReader(onText) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        length = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }
      let mask = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      if (opcode === 0x1) onText(payload.toString('utf8'));
    }
  };
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
        id: 'agt_relayflow_broker',
        workspace_id: 'ws_relayflow',
        name: parsed.name ?? 'broker',
        token: 'at_relayflow_broker',
        status: 'online',
        created_at: '2026-09-01T00:00:00.000Z',
      });
      return;
    }
    if (url === '/v1/agents' || url === '/v1/channels') {
      send([]);
      return;
    }
    if (url.startsWith('/v1/agents/')) {
      send({ id: 'agt_relayflow_other', name: 'other', status: 'offline', metadata: {} });
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
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
      accept +
      '\r\n\r\n'
  );
  sockets.add(socket);
  socket.on('error', () => {});
  socket.on('close', () => sockets.delete(socket));
  if (request.url.split('?')[0] !== '/v1/node/ws') return;
  socket.on(
    'data',
    createFrameReader((text) => {
      const frame = JSON.parse(text);
      if (frame.type !== 'node.register') return;
      // Keep only capability names and their declared node_kind.
      registration ??= (frame.capabilities ?? []).map((capability) => ({
        name: capability.name,
        nodeKind: capability.metadata?.configured?.node_kind ?? null,
      }));
      socket.write(
        encodeTextFrame(JSON.stringify({ v: 1, type: 'reply', id: frame.id, ok: true, data: {} }))
      );
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
      'node-kind-proof',
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
        HOME: root,
        TMPDIR: root,
        RELAY_API_KEY: 'rk_local_node_kind_proof',
        RELAYCAST_BASE_URL: `http://127.0.0.1:${port}`,
        RELAY_BASE_URL: `http://127.0.0.1:${port}`,
        RELAY_NODE_TOKEN: 'nt_local_node_kind_proof',
        RELAY_TELEMETRY_DISABLED: '1',
        RELAY_SKIP_TELEMETRY: '1',
      },
    }
  );
  let spawnFailed = false;
  broker.once('error', () => {
    spawnFailed = true;
  });
  // Drain output without retaining peer bodies, credentials or other runtime data.
  broker.stdout.resume();
  broker.stderr.resume();
  const deadline = Date.now() + 120000;
  while (!registration && Date.now() < deadline) {
    if (spawnFailed) throw Error('Broker artifact could not be started.');
    if (broker.exitCode !== null) throw Error(`Broker exited before evidence: ${broker.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!registration) throw Error('No node.register frame observed within 120s.');
  const spawnCapabilities = registration.filter((capability) => capability.name.startsWith('spawn:'));
  // Both arms must advertise spawn capacity, or the observation proves nothing.
  if (spawnCapabilities.length === 0) throw Error('node.register advertised no spawn capabilities.');
  let outcome, signature;
  if (spawnCapabilities.every((capability) => capability.nodeKind === null)) {
    outcome = 'absent';
    signature = 'spawn_capabilities_state_no_node_kind';
  } else if (spawnCapabilities.every((capability) => capability.nodeKind === 'broker')) {
    // Non-spawn capabilities must not gain a spawn-placement declaration.
    assert.ok(registration.every((c) => c.name.startsWith('spawn:') || c.nodeKind === null));
    outcome = 'fixed';
    signature = 'spawn_capabilities_declare_broker_node_kind';
  } else {
    throw Error(`Inconsistent spawn node_kind declarations: ${JSON.stringify(spawnCapabilities)}`);
  }
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    JSON.stringify({
      version: 1,
      caseId: '5310-broker-node-kind',
      arm,
      outcome,
      signature,
      details:
        'The peer accepts the first node.register and records each capability name with its metadata.configured.node_kind. Base advertises spawn:<harness> with no node_kind, so Cloud placement refuses the unclaimed node. Head declares node_kind "broker" on every spawn capability and on nothing else.',
      registration,
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
