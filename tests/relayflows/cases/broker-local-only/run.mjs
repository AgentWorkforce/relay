import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const caseId = 'broker-local-only';
const binary = process.env.RELAY_PR_PROOF_BROKER_BINARY;
assert(binary, 'Set RELAY_PR_PROOF_BROKER_BINARY to the compiled broker');
const arm = process.env.RELAY_PR_PROOF_ARM ?? 'head';
const target = process.env.RELAY_PR_PROOF_TARGET_DIR;
if (target) {
  const sha = execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(sha, process.env[arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA']);
  const harness = path.resolve(process.env.RELAY_PR_PROOF_HARNESS_DIR);
  const relative = path.relative(harness, fileURLToPath(import.meta.url));
  assert(!relative.startsWith('..') && !path.isAbsolute(relative), 'Run the exact-head harness');
}
const dir = await mkdtemp(path.join(tmpdir(), 'broker-local-only-'));
const stateDir = path.join(dir, 'state');
const homeDir = path.join(dir, 'home');
await mkdir(homeDir);
const observations = { unavailable: 0, registrations: [], events: [], unexpected: [] };
let online = false;
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const reply = (status, data) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  if (!online) {
    observations.unavailable++;
    if (
      req.method !== 'POST' ||
      (req.url !== '/v1/agents' && !/^\/v1\/agents\/[^/]+\/events$/.test(req.url))
    ) {
      observations.unexpected.push(`${req.method} ${req.url}`);
    }
    reply(503, { ok: false, error: { code: 'database_overloaded', message: 'deterministic test outage' } });
  } else if (req.method === 'POST' && req.url === '/v1/agents') {
    observations.registrations.push(body.name);
    reply(200, {
      ok: true,
      data: {
        id: 'audit-agent',
        workspace_id: 'test-workspace',
        name: body.name,
        token: 'at_test_local_only',
        status: 'active',
        created_at: '2026-09-09T00:00:00Z',
      },
    });
  } else if (req.method === 'POST' && /^\/v1\/agents\/[^/]+\/events$/.test(req.url)) {
    observations.events.push(body);
    reply(200, {
      ok: true,
      data: {
        id: `audit-${observations.events.length}`,
        agent_id: 'audit-agent',
        type: body.type,
        payload: body.payload,
        created_at: '2026-09-09T00:00:00Z',
      },
    });
  } else {
    observations.unexpected.push(`${req.method} ${req.url}`);
    reply(404, { ok: false, error: { code: 'not_found', message: 'unexpected remote operation' } });
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
// An allowlist avoids inheriting live workspace, fleet, observer, or harness credentials.
const env = {
  PATH: process.env.PATH,
  HOME: homeDir,
  TMPDIR: dir,
  AGENT_RELAY_WORKSPACE_KEY: 'rk_live_test_local_only',
  RELAYCAST_BASE_URL: base,
  RELAY_BASE_URL: base,
  RELAYCAST_WS_URL: base,
  RELAY_BROKER_API_KEY: 'br_test_local_only',
  AGENT_RELAY_TELEMETRY_DISABLED: '1',
  DO_NOT_TRACK: '1',
  AGENT_RELAY_NO_DEBUG_FILES: '1',
};
let child;
let logs = '';
let url;
let exited;
async function start(localOnly, apiBind = '127.0.0.1') {
  logs = '';
  url = undefined;
  child = spawn(
    path.resolve(binary),
    [
      'init',
      '--persist',
      '--state-dir',
      stateDir,
      '--instance-name',
      'outage-test',
      '--api-bind',
      apiBind,
      ...(localOnly ? ['--local-only'] : []),
    ],
    { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  exited = once(child, 'exit');
  child.stdout.on('data', (chunk) => {
    logs += chunk.toString();
    url ??= logs.match(/API listening on (http:\/\/[^\s]+)/)?.[1];
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk.toString();
  });
  child.on('error', () => {});
}
async function poll(probe, description) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    if (child.exitCode !== null) throw new Error(`Broker exited before ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Missing published signal: ${description}`);
}
async function request(route, body) {
  const response = await fetch(`${url}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-api-key': env.RELAY_BROKER_API_KEY, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json();
  return { response, data };
}
async function ready() {
  await poll(async () => {
    if (!url) return false;
    try {
      const { response, data } = await request('/api/status');
      return response.ok && data.mode === 'local_only';
    } catch {
      return false;
    }
  }, 'local runtime readiness');
}
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopping = child;
    stopping.stdin.end();
    stopping.kill('SIGTERM');
    const timer = setTimeout(() => stopping.kill('SIGKILL'), 5_000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
}

let result;
try {
  if (arm === 'base') {
    await start(false);
    const code = await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Base did not surface startup failure')), 60_000).unref()
      ),
    ]);
    assert.notEqual(code[0], 0);
    assert(observations.unavailable > 0);
    assert.match(logs, /failed to initialize relaycast session|failed registering agent/);
    result = { outcome: 'absent', signature: 'relaycast_outage_blocks_local_runtime' };
  } else {
    await start(true, '::1');
    await ready();
    assert.equal(new URL(url).hostname, '[::1]', 'IPv6 API discovery URL is bracketed');
    const connection = JSON.parse(await readFile(path.join(stateDir, 'connection.json'), 'utf8'));
    assert.equal(connection.url, url, 'Persisted discovery URL matches the listening IPv6 API');
    assert.match(logs, /DEGRADED.*LOCAL ONLY/);
    let health = (await request('/health')).data;
    assert.equal(health.status, 'degraded');
    assert.equal(health.relaycastConnected, false);
    const session = (await request('/api/session')).data;
    assert.equal(session.operation_mode, 'local_only');
    assert.equal(session.workspace_key, null);
    assert.equal(session.node_token, null);
    const spawned = await request('/api/spawn', {
      name: 'local-worker',
      cli: 'cat',
      cwd: dir,
      args: [],
      channels: [],
    });
    assert(spawned.response.ok, 'Local spawn succeeds during outage');
    assert.match(spawned.data.warning, /DEGRADED.*LOCAL ONLY/);
    let state = JSON.parse(await readFile(path.join(stateDir, 'state-outage-test.json'), 'utf8'));
    assert.equal(state.agents['local-worker'].initial_task ?? null, null, 'Taskless spawn stays idle');
    for (const [name, task, exitAfterTask] of [
      ['empty-task-worker', '   ', false],
      ['task-worker', 'EXPLICIT_INITIAL_TASK', true],
    ]) {
      const response = await request('/api/spawn', {
        name,
        cli: 'cat',
        cwd: dir,
        args: [],
        channels: [],
        task,
        exit_after_task: exitAfterTask,
      });
      assert(response.response.ok);
      state = JSON.parse(await readFile(path.join(stateDir, 'state-outage-test.json'), 'utf8'));
      if (exitAfterTask) {
        assert.match(state.agents[name].initial_task, /DEGRADED.*LOCAL ONLY/);
        assert.match(state.agents[name].initial_task, /EXPLICIT_INITIAL_TASK/);
        assert.match(state.agents[name].initial_task, /Post-task exit/);
      } else {
        assert.equal(state.agents[name].initial_task ?? null, null, 'Blank task stays idle');
      }
    }
    const unknown = await request('/api/send', { to: 'remote-worker', text: 'must not route' });
    assert(!unknown.response.ok, 'Remote destination is explicitly rejected');
    const sent = await request('/api/send', { to: 'local-worker', text: 'LOCAL_WORK_PROOF', mode: 'steer' });
    assert(sent.response.ok, 'Local work accepted');
    assert.equal(sent.data.delivery_status, 'queued_local');
    assert.equal(sent.data.relaycast_published, false);
    await poll(async () => {
      const snapshot = await request('/api/spawned/local-worker/snapshot');
      return snapshot.response.ok && snapshot.data.screen?.includes('LOCAL_WORK_PROOF');
    }, 'local work rendered in attached PTY');
    const input = await request('/api/input/local-worker', { data: 'LOCAL_ATTACH_PROOF\r' });
    assert(input.response.ok, 'Local terminal input works during outage');
    await poll(
      async () =>
        (await request('/api/spawned/local-worker/snapshot')).data.screen?.includes('LOCAL_ATTACH_PROOF'),
      'local attachment output'
    );
    await poll(async () => observations.unavailable > 0, 'failed background registration');
    const before = (await request('/api/status')).data;
    assert.equal(before.degraded.reconciliation.pending_records, 1);
    assert.equal(before.auth.authenticated, false);
    assert.equal(before.degraded.capabilities.remote_delivery, false);
    // Reopen the same durable state while still disconnected. This checks the
    // record survived a process boundary, not just an in-memory retry.
    await stop();
    await start(true);
    await ready();
    assert.equal((await request('/api/status')).data.degraded.reconciliation.pending_records, 1);
    online = true;
    await poll(
      async () => (await request('/api/status')).data.degraded.reconciliation.pending_records === 0,
      'reconciliation acknowledgement'
    );
    assert.equal(observations.events.length, 1);
    assert.equal(observations.events[0].type, 'local.delivery.queued');
    assert.equal(observations.events[0].payload.event_id, sent.data.event_id);
    assert.equal(observations.events[0].payload.body, 'LOCAL_WORK_PROOF');
    assert(observations.registrations.every((name) => name.startsWith('outage-test-local-')));
    assert.deepEqual(observations.unexpected, [], 'No presence, fleet, message, or remote attach traffic');
    health = (await request('/health')).data;
    assert.equal(health.status, 'degraded');
    assert.equal(health.nodeConnected, false);
    assert.equal(health.relaycastConnected, false);
    const persisted = JSON.parse(
      await readFile(path.join(stateDir, 'state-outage-test.local-outbox.json'), 'utf8')
    );
    assert.equal(persisted.records.length, 0);
    assert(!JSON.stringify(persisted).includes(env.AGENT_RELAY_WORKSPACE_KEY));
    result = { outcome: 'fixed', signature: 'visible_local_runtime_and_reconciled_delivery' };
  }
  const report = {
    version: 1,
    caseId,
    arm,
    ...result,
    details:
      'Published startup/status, local spawn/send, destination rejection, restart persistence, and audit replay signals checked; no elapsed-time assertions.',
  };
  if (process.env.RELAY_PR_PROOF_RESULT_PATH) {
    await mkdir(path.dirname(process.env.RELAY_PR_PROOF_RESULT_PATH), { recursive: true });
    await writeFile(process.env.RELAY_PR_PROOF_RESULT_PATH, JSON.stringify(report) + '\n');
  }
  console.log(JSON.stringify(report));
} catch (error) {
  // Logs use only isolated test credentials; still redact them on failure.
  console.error(
    logs
      .replaceAll(env.AGENT_RELAY_WORKSPACE_KEY, '[REDACTED]')
      .replaceAll(env.RELAY_BROKER_API_KEY, '[REDACTED]')
      .slice(-5000)
  );
  throw error;
} finally {
  await stop();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
