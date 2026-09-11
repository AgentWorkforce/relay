import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = 'http-spawn-binding-failure';
const NAME = 'owned-binding-probe';
const API_KEY = 'br_binding_probe';
const required = (key) => {
  if (!process.env[key]) throw new Error(`Missing ${key}`);
  return process.env[key];
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
const relative = path.relative(path.resolve(harnessDir), fileURLToPath(import.meta.url));
assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
await access(binary, 1);
const probe = await mkdtemp(path.join(tmpdir(), 'relayflow-binding-'));
let broker,
  stderr = '';
const sockets = new Set();
const observations = { registrations: 0, bindings: 0, scopeReads: 0, releases: [], launches: 0 };
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
    if (body.name === NAME) observations.registrations++;
    send(201, {
      id: `id_${body.name}`,
      name: body.name,
      workspace_id: 'ws_binding_probe',
      token: `at_fixture_${body.name}`,
      status: 'online',
      created_at: '2026-01-01T00:00:00Z',
    });
  } else if (request.method === 'POST' && /^\/v1\/nodes\/[^/]+\/agents$/.test(pathname)) {
    assert.equal(body.agent_name, NAME);
    observations.bindings++;
    send(503, { code: 'workspace_busy', message: 'binding admission probe' }, false);
  } else if (request.method === 'GET' && pathname === `/v1/agents/${NAME}`) {
    observations.scopeReads++;
    send(200, {
      id: `id_${NAME}`,
      name: NAME,
      workspace_id: 'ws_binding_probe',
      channels: [],
      status: 'online',
      metadata: {},
    });
  } else if (request.method === 'POST' && pathname === '/v1/agents/release') {
    observations.releases.push(body.name);
    send(200, { status: 'completed' });
  } else if (pathname === '/probe-launch') {
    observations.launches++;
    send(200, {});
  } else send(404, { code: 'not_found', message: 'unsupported fixture route' }, false);
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const state = path.join(probe, 'state');
  await mkdir(state);
  // No WebSocket endpoint: force the supported HTTP registration fallback.
  // A probe executable records any launch independently of the spawn response.
  const cli = path.join(probe, 'binding-probe-cli');
  await writeFile(
    cli,
    `#!${process.execPath}\nfetch('${baseUrl}/probe-launch'); setInterval(() => {}, 1000);\n`,
    { mode: 0o700 }
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(RELAY|AGENT_RELAY)/.test(key))
  );
  broker = spawn(
    binary,
    [
      'init',
      '--instance-name',
      'binding-probe-node',
      '--workspace-key',
      'rk_binding_probe',
      '--state-dir',
      state,
      '--api-port',
      '0',
      '--channels',
      '',
    ],
    {
      cwd: probe,
      env: {
        ...env,
        RELAYCAST_BASE_URL: baseUrl,
        RELAY_BROKER_API_KEY: API_KEY,
        RELAY_NODE_ID: 'node_binding_probe',
        RELAY_NODE_TOKEN: 'nt_binding_probe',
        AGENT_RELAY_NO_DEBUG_FILES: '1',
        AGENT_RELAY_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    }
  );
  broker.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-12000);
  });
  let connection;
  for (let i = 0; i < 200; i++) {
    if (broker.exitCode !== null) throw new Error(`Broker exited: ${stderr}`);
    try {
      connection = JSON.parse(await readFile(path.join(state, 'connection.json'), 'utf8'));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert(connection, `No broker API: ${stderr}`);
  const api = async (route, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${connection.port}${route}`, {
      ...options,
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      signal: AbortSignal.timeout(45000),
      redirect: 'error',
    });
    return { status: response.status, body: await response.json() };
  };
  const result = await api('/api/spawn', {
    method: 'POST',
    body: JSON.stringify({ name: NAME, cli, channels: [], cwd: probe }),
  });
  const listing = await api('/api/spawned');
  assert.equal(observations.registrations, 1);
  assert.equal(observations.bindings, 1);
  assert.equal(listing.status, 200);
  if (arm === 'head') {
    assert(result.status >= 400);
    assert(JSON.stringify(result.body).includes('binding admission probe'));
    assert.equal(observations.scopeReads, 0);
    assert.equal(observations.launches, 0);
    assert(!JSON.stringify(listing.body).includes(NAME), 'Failed worker remains in inventory');
  } else {
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert(result.body.warning.includes('binding admission probe'));
    assert.equal(observations.scopeReads, 1);
    assert(JSON.stringify(listing.body).includes(NAME), 'Base did not admit unreachable worker');
    const released = await api(`/api/spawned/${NAME}`, {
      method: 'DELETE',
      body: JSON.stringify({ expected_generation: result.body.generation, delete_identity: true }),
    });
    assert.equal(released.status, 200);
  }
  assert.deepEqual(observations.releases, [NAME]);
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    JSON.stringify({
      version: 1,
      caseId: CASE_ID,
      arm,
      outcome: arm === 'head' ? 'fixed' : 'bug',
      signature: arm === 'head' ? 'binding_failure_rejects_before_launch' : 'binding_failure_continues_spawn',
      details: JSON.stringify({ status: result.status, observations }),
    }) + '\n'
  );
} finally {
  if (broker && broker.exitCode === null) {
    const exited = new Promise((resolve) => broker.once('exit', resolve));
    broker.kill('SIGTERM');
    const timer = setTimeout(() => broker.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timer);
  }
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  await rm(probe, { recursive: true, force: true });
}
