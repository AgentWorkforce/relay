import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1710-owned-local-release-cleanup';
const NAME = 'owned-retired-probe';
const GENERATION = '11111111-1111-4111-8111-111111111111';
const STALE_GENERATION = '22222222-2222-4222-8222-222222222222';
const TOKEN_HASH = 'bec092bff160b23541205064ab9f4485d6c2089760b1bb4e5f5ce19f0274aad3';
const API_KEY = 'br_owned_cleanup_probe';
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
const probe = await mkdtemp(path.join(tmpdir(), 'relayflow-owned-cleanup-'));
let broker,
  stderr = '',
  stdout = '';
let allowDelete = false;
const pendingDeletes = [];
const sockets = new Set();
const observations = { guarded: [], routed: [], deleted: 0 };
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
    send(201, {
      id: `id_${body.name}`,
      name: body.name,
      workspace_id: 'ws_owned_cleanup_probe',
      token: `at_fixture_${body.name}`,
      status: 'online',
      created_at: '2026-01-01T00:00:00Z',
    });
  } else if (request.method === 'POST' && pathname === '/v1/agents/release') {
    if (body.delete_agent === true && body.expected_token_hash === TOKEN_HASH && body.name === NAME) {
      observations.guarded.push(body);
      const complete = () => {
        observations.deleted++;
        send(200, { status: 'completed' });
      };
      if (allowDelete) complete();
      else pendingDeletes.push(complete);
    } else {
      observations.routed.push(body);
      send(503, { code: 'node_unavailable', message: 'owned worker host is unavailable' }, false);
    }
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
  // An already-exited owned worker with a pending durable cleanup. No live
  // host node exists. Both exact binaries receive the same persisted input.
  await writeFile(
    path.join(state, 'owned-cleanups.json'),
    JSON.stringify({
      [NAME]: { generation: GENERATION, expected_token_hash: TOKEN_HASH, agent_id: null },
    })
  );
  // Explicit environment: no credentials, loader overrides, or live service
  // configuration from the proof worker may reach the tested executable.
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: probe,
    TMPDIR: probe,
    NO_COLOR: '1',
  };
  broker = spawn(
    binary,
    [
      'init',
      '--instance-name',
      'owned-cleanup-probe-node',
      '--workspace-key',
      'rk_owned_cleanup_probe',
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
        RELAY_NODE_ID: 'node_owned_cleanup_probe',
        RELAY_NODE_TOKEN: 'nt_owned_cleanup_probe',
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
  for (let i = 0; i < 200; i++) {
    if (broker.exitCode !== null) throw new Error(`Broker exited: ${stderr}`);
    const announced = stdout.match(/API listening on http:\/\/127\.0\.0\.1:([1-9]\d{0,4})(?:\s|$)/);
    if (announced) {
      const parsed = Number(announced[1]);
      assert(Number.isInteger(parsed) && parsed <= 65535, 'Invalid loopback API port');
      apiPort = parsed;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(apiPort, `No broker loopback API announcement: ${stderr}`);
  const api = async (route, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${apiPort}${route}`, {
      ...options,
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      signal: AbortSignal.timeout(45000),
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
  let apiReady = false;
  for (let i = 0; i < 200; i++) {
    if (broker.exitCode !== null) throw new Error(`Broker exited before readiness: ${stderr}`);
    if ((await api('/api/session')).status === 200) {
      apiReady = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(apiReady, `Broker API did not become ready: ${stderr}`);
  const release = (name, body = {}) =>
    api(`/api/spawned/${name}`, {
      method: 'DELETE',
      body: JSON.stringify(body),
    });
  // Explicit stale/caller-owned deletes must fail without touching identities.
  const stale = await release(NAME, { expected_generation: STALE_GENERATION, delete_identity: true });
  assert(stale.status >= 400, 'Stale generation was accepted');
  const caller = await release('caller-owned-probe', { delete_identity: true });
  assert(caller.status >= 400, 'Unowned identity deletion was accepted');
  assert.equal(observations.deleted, 0);
  assert.equal(observations.routed.length, 0);

  let releaseSettled = false;
  const releasing = release(NAME).then((result) => {
    releaseSettled = true;
    return result;
  });
  if (pendingDeletes.length) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(releaseSettled, false, 'Release acknowledged before guarded cleanup completed');
  }
  // Let the name-only request join the pending operation before acknowledging
  // its exact-token deletion. The API response itself is the completion gate.
  allowDelete = true;
  for (const complete of pendingDeletes.splice(0)) complete();
  const result = await releasing;
  let outcome, signature, details;
  if (result.status === 200 && result.body.process === 'stopped' && result.body.identity === 'deleted') {
    assert.equal(observations.deleted, 1, 'Expected one exact-token deletion');
    assert.equal(observations.guarded.length, 1);
    assert.equal(observations.routed.length, 0, 'Owned release routed through unavailable host');
    const repeated = await release(NAME);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.process, 'stopped');
    assert.equal(repeated.body.identity, 'deleted');
    assert.equal(observations.deleted, 1, 'Repeat deleted the identity again');
    assert.equal(observations.guarded.length, 1);
    assert.equal(observations.routed.length, 0);
    outcome = 'fixed';
    signature = 'owned_release_deletes_exactly_and_repeats_safely';
    details =
      'Exact compiled broker restored retired-generation custody, rejected stale and unowned deletes, completed one token-hash guarded deletion without a host node, and returned an idempotent name-only retry.';
  } else {
    // Only the known host-routing failure proves red. Startup, missing binaries,
    // timeouts, malformed responses, or unrelated API errors fail the runner.
    assert.equal(observations.deleted, 0);
    assert.equal(observations.guarded.length, 0);
    assert.equal(observations.routed.length, 1);
    assert.equal(observations.routed[0].name, NAME);
    assert.notEqual(observations.routed[0].delete_agent, true);
    assert.equal(observations.routed[0].expected_token_hash, undefined);
    assert(result.status >= 400);
    assert.match(JSON.stringify(result.body), /owned worker host is unavailable/);
    outcome = 'bug';
    signature = 'owned_release_routes_to_unavailable_host';
    details =
      'Exact compiled broker sent an unguarded host-routed release for the retired worker and returned the fixture node_unavailable failure; no identity was deleted.';
  }
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    JSON.stringify({
      version: 1,
      caseId: CASE_ID,
      arm,
      outcome,
      signature,
      details,
    }) + '\n'
  );
} finally {
  await stopProcess(broker);
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  await rm(probe, { recursive: true, force: true });
}

/** Stop only a child this case started and wait until it has exited. */
async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  await exited;
  clearTimeout(timer);
}
