import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1969-owned-cleanup-conflict';
const NAME = 'owned-conflict-probe';
const GENERATION = '11111111-1111-4111-8111-111111111111';
const TOKEN_HASH = 'bec092bff160b23541205064ab9f4485d6c2089760b1bb4e5f5ce19f0274aad3';
const API_KEY = 'br_owned_conflict_probe';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const targetDir = required('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = required('RELAY_PR_PROOF_HARNESS_DIR');
const binary = required('RELAY_PR_PROOF_BROKER_BINARY');
const resultPath = required('RELAY_PR_PROOF_RESULT_PATH');
const arm = required('RELAY_PR_PROOF_ARM');
assert.ok(arm === 'base' || arm === 'head');
assert.equal(
  execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  required(arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA')
);
const relativeRunner = path.relative(path.resolve(harnessDir), fileURLToPath(import.meta.url));
assert.ok(relativeRunner && !relativeRunner.startsWith('..') && !path.isAbsolute(relativeRunner));
await access(binary, 1);

const probeDir = await mkdtemp(path.join(tmpdir(), 'relayflow-owned-conflict-'));
const sockets = new Set();
let broker;
let stdout = '';
let stderr = '';
let guardedReleaseCount = 0;

const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
  const pathname = new URL(request.url, 'http://fixture.invalid').pathname;
  const send = (status, value, ok = true) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(ok ? { ok: true, data: value } : { ok: false, error: value }));
  };

  if (request.method === 'POST' && pathname === '/v1/agents') {
    send(201, {
      id: `id_${body.name}`,
      workspace_id: 'ws_owned_conflict_probe',
      name: body.name,
      token: `at_fixture_${body.name}`,
      status: 'online',
      created_at: '2026-01-01T00:00:00Z',
    });
    return;
  }
  if (request.method === 'POST' && pathname === '/v1/agents/release') {
    assert.equal(body.name, NAME);
    assert.equal(body.delete_agent, true);
    assert.equal(body.expected_token_hash, TOKEN_HASH);
    guardedReleaseCount += 1;
    send(
      409,
      {
        code: 'agent_release_generation_conflict',
        message: 'the worker name belongs to a replacement generation',
      },
      false
    );
    return;
  }
  if (request.method === 'POST' && pathname === '/v1/agents/release-exact') {
    assert.equal(body.name, NAME);
    assert.equal(body.expected_agent_id, `id_${NAME}`);
    assert.equal(body.delete_agent, true);
    assert.equal(body.expected_token_hash, TOKEN_HASH);
    assert.ok(request.headers['idempotency-key']);
    guardedReleaseCount += 1;
    send(
      409,
      {
        code: 'agent_identity_mismatch',
        message: 'the immutable identity was replaced',
      },
      false
    );
    return;
  }
  send(404, { code: 'not_found', message: 'unsupported fixture route' }, false);
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});
server.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.on(
    'data',
    createFrameReader((frame) => {
      if (frame.type === 'node.register' || frame.type === 'inventory.sync' || frame.id) {
        socket.write(
          encodeTextFrame(JSON.stringify({ v: 1, type: 'reply', id: frame.id, ok: true, data: {} }))
        );
      }
    })
  );
});

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const stateDir = path.join(probeDir, 'state');
  await mkdir(stateDir);
  await writeFile(
    path.join(stateDir, 'owned-cleanups.json'),
    JSON.stringify({
      [NAME]: {
        generation: GENERATION,
        expected_token_hash: TOKEN_HASH,
        agent_id: `id_${NAME}`,
      },
    })
  );

  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(RELAY|AGENT_RELAY)/.test(key))
  );
  broker = spawn(
    binary,
    [
      'init',
      '--instance-name',
      'owned-conflict-probe-node',
      '--workspace-key',
      'rk_owned_conflict_probe',
      '--state-dir',
      stateDir,
      '--api-port',
      '0',
      '--channels',
      '',
    ],
    {
      cwd: probeDir,
      env: {
        ...cleanEnv,
        RELAYCAST_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        RELAY_BROKER_API_KEY: API_KEY,
        RELAY_NODE_ID: 'node_owned_conflict_probe',
        RELAY_NODE_TOKEN: 'nt_owned_conflict_probe',
        AGENT_RELAY_NO_DEBUG_FILES: '1',
        AGENT_RELAY_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  broker.stdout.on('data', (chunk) => {
    stdout = (stdout + chunk).slice(-12000);
  });
  broker.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-12000);
  });

  const apiPort = await waitForApiPort();
  const api = async (route, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${apiPort}${route}`, {
      ...options,
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      signal: AbortSignal.timeout(45_000),
      redirect: 'error',
    });
    const raw = await response.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { raw };
    }
    return { status: response.status, body };
  };
  await waitFor(async () => (await api('/api/session')).status === 200, 'broker API readiness');

  const released = await api(`/api/spawned/${NAME}`, {
    method: 'DELETE',
    body: JSON.stringify({ expected_generation: GENERATION, delete_identity: true }),
  });
  assert.ok(guardedReleaseCount >= 1, 'The restored cleanup never reached the guarded release endpoint.');

  let outcome;
  let signature;
  let details;
  if (
    released.status === 200 &&
    released.body?.process === 'stopped' &&
    released.body?.identity === 'deleted'
  ) {
    outcome = 'fixed';
    signature = 'owned_cleanup_conflict_releases_name';
    details =
      'The exact head broker treated the token-hash generation conflict as terminal for the retired generation, released custody, and completed the generation-matched API request.';
  } else {
    assert.ok(released.status >= 400, JSON.stringify(released));
    assert.match(JSON.stringify(released.body), /cleanup unconfirmed|generation conflict/i);
    outcome = 'bug';
    signature = 'owned_cleanup_conflict_retains_name';
    details =
      'The exact base broker treated the durable generation conflict as retryable, returned an unconfirmed cleanup error, and retained worker-name custody.';
  }
  assert.equal(outcome, arm === 'head' ? 'fixed' : 'bug');

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
} finally {
  await stopProcess(broker);
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  await rm(probeDir, { recursive: true, force: true });
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

async function waitForApiPort() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (broker.exitCode !== null) throw new Error(`Broker exited before API startup: ${stderr}`);
    const match = stdout.match(/API listening on http:\/\/127\.0\.0\.1:([1-9]\d{0,4})(?:\s|$)/);
    if (match) return Number(match[1]);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Broker did not announce its API port: ${stderr}`);
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (broker.exitCode !== null) throw new Error(`Broker exited before ${label}: ${stderr}`);
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}: ${stderr}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
  await exited;
  clearTimeout(timer);
}

function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function createFrameReader(onFrame) {
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
      let mask;
      if (masked) {
        if (buffer.length < offset + 4) return;
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);
      if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      if (opcode === 0x1) onFrame(JSON.parse(payload.toString('utf8')));
    }
  };
}
