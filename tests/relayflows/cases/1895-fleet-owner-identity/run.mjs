import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1895-fleet-owner-identity';
const WORKER = 'owner-proof-worker';
const API_KEY = 'br_owner_proof';
const OWNER = {
  cloud_user_id: 'User-1',
  cloud_workspace_id: null,
  owner_hash: '72e7a0d15b2efd5aa47b550f3c67b400d685f8350187cc122bca3910e93d087d',
};
const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
};
const targetDir = required('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = required('RELAY_PR_PROOF_HARNESS_DIR');
const binary = required('RELAY_PR_PROOF_BROKER_BINARY');
const resultPath = required('RELAY_PR_PROOF_RESULT_PATH');
const arm = required('RELAY_PR_PROOF_ARM');
assert(['base', 'head'].includes(arm));
assert.equal(
  execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  required(arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA')
);
assert.equal(
  execFileSync('git', ['-C', harnessDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  required('RELAY_PR_PROOF_HEAD_SHA')
);
const relativeRunner = path.relative(path.resolve(harnessDir), fileURLToPath(import.meta.url));
assert(relativeRunner && !relativeRunner.startsWith('..') && !path.isAbsolute(relativeRunner));
await access(binary, 1);

const root = await mkdtemp(path.join(tmpdir(), 'relayflow-owner-identity-'));
const state = path.join(root, 'state');
const sockets = new Set();
const observations = { creates: [], patches: [], releases: [] };
let broker;
let stdout = '';
let stderr = '';

const identity = (name, token) => ({
  id: `id_${name}`,
  workspace_id: 'ws_owner_proof',
  name,
  ...(token ? { token } : {}),
  status: 'online',
  created_at: '2026-10-04T00:00:00Z',
});
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
  const pathname = new URL(request.url, 'http://fixture.invalid').pathname;
  const send = (status, data, ok = true) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(ok ? { ok, data } : { ok, error: data }));
  };

  if (request.method === 'POST' && pathname === '/v1/agents') {
    if (body.name === WORKER) observations.creates.push(body);
    send(201, identity(body.name, `at_owner_${body.name}`));
  } else if (request.method === 'POST' && /^\/v1\/nodes\/[^/]+\/agents$/.test(pathname)) {
    send(200, {
      id: 'binding-owner-proof',
      agent_id: `id_${body.agent_name}`,
      agent_name: body.agent_name,
      node_id: 'node-owner-proof',
      node_name: 'owner-proof-node',
      node_kind: 'local',
      node_role: 'broker',
      status: 'active',
      session_ref: null,
      priority: 0,
      created_at: '2026-10-04T00:00:00Z',
      updated_at: null,
    });
  } else if (request.method === 'GET' && pathname === '/v1/agent') {
    send(200, identity(WORKER));
  } else if (request.method === 'GET' && pathname === `/v1/agents/${WORKER}`) {
    send(200, { ...identity(WORKER), channels: [], metadata: {} });
  } else if (request.method === 'GET' && (pathname === '/v1/agents' || pathname === '/v1/channels')) {
    send(200, []);
  } else if (request.method === 'PATCH' && pathname === `/v1/agents/${WORKER}`) {
    observations.patches.push(body);
    send(200, { ...identity(WORKER), metadata: body.metadata ?? {} });
  } else if (request.method === 'POST' && pathname === '/v1/agents/release') {
    observations.releases.push(body.name);
    send(200, { status: 'completed' });
  } else {
    send(404, { code: 'not_found', message: 'unsupported fixture route' }, false);
  }
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});

try {
  await mkdir(state);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const cli = path.join(root, 'owner-proof-cli');
  await writeFile(cli, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(RELAY|AGENT_RELAY)/.test(key))
  );
  broker = spawn(
    binary,
    [
      'init',
      '--instance-name',
      'owner-proof-node',
      '--workspace-key',
      'rk_owner_proof',
      '--state-dir',
      state,
      '--api-port',
      '0',
      '--channels',
      '',
    ],
    {
      cwd: root,
      env: {
        ...cleanEnv,
        RELAYCAST_BASE_URL: baseUrl,
        RELAY_BROKER_API_KEY: API_KEY,
        RELAY_NODE_ID: 'node_owner_proof',
        RELAY_NODE_TOKEN: 'nt_owner_proof',
        AGENT_RELAY_ENROLLED_OWNER_METADATA: JSON.stringify(OWNER),
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

  let apiPort;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (broker.exitCode !== null) throw new Error(`Broker exited before readiness: ${stderr}`);
    const match = stdout.match(/API listening on http:\/\/127\.0\.0\.1:([1-9]\d{0,4})(?:\s|$)/);
    if (match) {
      apiPort = Number(match[1]);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(Number.isInteger(apiPort) && apiPort <= 65535, `No broker API announcement: ${stderr}`);
  const api = async (route, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${apiPort}${route}`, {
      ...options,
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      signal: AbortSignal.timeout(45000),
      redirect: 'error',
    });
    const raw = await response.text();
    return { status: response.status, body: raw ? JSON.parse(raw) : {} };
  };
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await api('/api/session')).status === 200) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(ready, `Broker API did not become ready: ${stderr}`);

  const spawned = await api('/api/spawn', {
    method: 'POST',
    body: JSON.stringify({ name: WORKER, cli, cwd: root, channels: [], skipRelayPrompt: true }),
  });
  assert.equal(spawned.status, 200, JSON.stringify(spawned.body));
  assert.equal(spawned.body.success, true);
  for (let attempt = 0; attempt < 100 && observations.patches.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(observations.creates.length, 1);
  assert.equal(observations.patches.length, arm === 'head' ? 1 : 0);
  const initial = observations.creates[0].metadata ?? {};
  if (arm === 'head') {
    const repaired = observations.patches[0].metadata ?? {};
    assert.deepEqual(
      Object.fromEntries(Object.keys(OWNER).map((key) => [key, initial[key]])),
      OWNER,
      'initial POST must atomically carry the exact trusted owner fields'
    );
    assert.deepEqual(
      Object.fromEntries(Object.keys(OWNER).map((key) => [key, repaired[key]])),
      OWNER,
      'later PATCH must preserve null and replace all trusted owner fields'
    );
  } else {
    for (const key of Object.keys(OWNER)) {
      assert.equal(Object.hasOwn(initial, key), false, `base unexpectedly created ${key}`);
    }
  }

  const released = await api(`/api/spawned/${WORKER}`, {
    method: 'DELETE',
    body: JSON.stringify({ expected_generation: spawned.body.generation, delete_identity: true }),
  });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.deepEqual(observations.releases, [WORKER]);
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    JSON.stringify({
      version: 1,
      caseId: CASE_ID,
      arm,
      outcome: arm === 'head' ? 'fixed' : 'absent',
      signature: arm === 'head' ? 'fleet_owner_identity_propagated' : 'fleet_owner_identity_absent',
      details:
        arm === 'head'
          ? 'Initial agent POST and later PATCH carried the exact trusted owner trio, including a null Cloud workspace id.'
          : 'The same trusted enrollment identity reached neither initial agent registration nor any later metadata PATCH.',
    }) + '\n'
  );
} finally {
  await stopProcess(broker);
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
