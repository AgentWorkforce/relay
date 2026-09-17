import { execFileSync, spawn } from 'node:child_process';
import { constants as fsConstants, existsSync } from 'node:fs';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Drives the supplied broker binary's public `POST /api/spawn` against a
// loopback Relaycast fixture whose channel create/join routes answer
// `429 workspace_busy`. The broker path under test is
// `RelaycastHttpClient::ensure_agent_channels`, reached from the HTTP spawn
// handler after worker registration and node binding succeed.

const CASE_ID = '1776-spawn-channel-join-workspace-busy';
const API_KEY = 'br_channel_busy_probe';
const BUSY_CODE = 'workspace_busy';
const BUSY_MESSAGE = 'Workspace write capacity is busy; retry with backoff';
const SKIPPED_MARKER = 'skipped after workspace_busy: engineering';
const RECOVER_BUSY_RESPONSES = 2;
// Head: one initial attempt plus the three-entry backoff table (1s, 2s, 4s).
const HEAD_EXHAUSTED_ATTEMPTS = 4;

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
if (!isWithin(harnessDir, fileURLToPath(import.meta.url))) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

const SCENARIOS = {
  'busy-then-recover': { agent: 'busy-recover-probe', channels: ['general'] },
  'busy-exhausted': { agent: 'busy-exhausted-probe', channels: ['general', 'engineering'] },
};

const probeDir = await mkdtemp(path.join(tmpdir(), 'relayflow-1776-'));
const observations = {};
const startedAt = performance.now();
try {
  for (const mode of Object.keys(SCENARIOS)) {
    observations[mode] = await runScenario(mode);
    console.log(`[${CASE_ID}] ${mode}: ${JSON.stringify(summarize(observations[mode]))}`);
  }
  const recover = observations['busy-then-recover'];
  const exhausted = observations['busy-exhausted'];

  const baseObserved =
    arm === 'base' &&
    // A transient busy fails the spawn on its single attempt.
    recover.createHits.general === 1 &&
    recover.joinHits.general === 0 &&
    !recover.spawnSucceeded &&
    recover.errorText.includes(BUSY_CODE) &&
    !recover.launched &&
    !recover.membershipRecorded &&
    // Saturation: one attempt per channel, and the walk keeps going.
    exhausted.createHits.general === 1 &&
    exhausted.createHits.engineering === 1 &&
    exhausted.joinHits.general === 0 &&
    exhausted.joinHits.engineering === 0 &&
    !exhausted.spawnSucceeded &&
    exhausted.errorText.includes(BUSY_CODE) &&
    !exhausted.errorText.includes('skipped after workspace_busy') &&
    !exhausted.launched;

  const headObserved =
    arm === 'head' &&
    // Two busy responses then recovery: three creates, one join, membership.
    recover.createHits.general === RECOVER_BUSY_RESPONSES + 1 &&
    recover.joinHits.general === 1 &&
    // The 1s and 2s backoffs must elapse between the three creates.
    recover.busySpanMs >= 2_500 &&
    recover.spawnSucceeded &&
    recover.launched &&
    recover.membershipRecorded &&
    recover.listed &&
    // Saturation: exactly one shared budget, second channel never attempted.
    exhausted.createHits.general === HEAD_EXHAUSTED_ATTEMPTS &&
    exhausted.createHits.engineering === 0 &&
    exhausted.joinHits.general === 0 &&
    exhausted.joinHits.engineering === 0 &&
    !exhausted.spawnSucceeded &&
    exhausted.errorText.includes(BUSY_CODE) &&
    exhausted.errorText.includes(SKIPPED_MARKER) &&
    !exhausted.launched &&
    // Backoff 1s + 2s + 4s must actually elapse between the attempts.
    exhausted.busySpanMs >= 6_500;

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'bug';
    signature = 'spawn_channel_join_workspace_busy_fails_without_retry';
    details =
      'Base broker: POST /api/spawn failed after a single 429 workspace_busy on the worker channel create (1 attempt, no join, no launch) even though Relaycast recovered on the next request; under sustained workspace_busy it attempted each of the two channels exactly once and kept walking instead of retrying.';
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'spawn_channel_join_workspace_busy_retried_with_shared_budget';
    details = `Head broker: retried workspace_busy on the worker channel create (3 creates, 1 join) and the spawn succeeded with verified membership and a launched worker; under sustained workspace_busy it made exactly ${HEAD_EXHAUSTED_ATTEMPTS} attempts across the whole spawn (~${Math.round(exhausted.busySpanMs / 1000)}s of backoff), never attempted the second channel, did not launch, and reported "${SKIPPED_MARKER}".`;
  } else {
    throw new Error(
      `Unexpected ${arm} observations: ${JSON.stringify(
        Object.fromEntries(Object.entries(observations).map(([k, v]) => [k, summarize(v, true)]))
      )}`
    );
  }
  console.log(`[${CASE_ID}] ${arm} runtime ${Math.round(performance.now() - startedAt)}ms`);
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
} finally {
  await rm(probeDir, { recursive: true, force: true });
}

async function runScenario(mode) {
  const { agent, channels } = SCENARIOS[mode];
  const scenarioDir = path.join(probeDir, mode);
  const state = path.join(scenarioDir, 'state');
  await mkdir(state, { recursive: true });

  const fixture = {
    createHits: {},
    joinHits: {},
    createTimes: [],
    otherCreates: [],
    memberships: new Map(),
    releases: [],
    unhandled: [],
  };
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body = {};
    if (chunks.length) {
      try {
        body = JSON.parse(Buffer.concat(chunks));
      } catch {
        body = {};
      }
    }
    const pathname = new URL(request.url, 'http://fixture.invalid').pathname;
    const send = (status, data, ok = true, headers = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(JSON.stringify(ok ? { ok, data } : { ok, error: data }));
    };
    const agentMembership = (name) => {
      if (!fixture.memberships.has(name)) fixture.memberships.set(name, new Set());
      return fixture.memberships.get(name);
    };
    let match;
    if (request.method === 'POST' && pathname === '/v1/agents') {
      send(201, {
        id: `id_${body.name}`,
        name: body.name,
        workspace_id: 'ws_channel_busy_probe',
        token: `at_fixture_${body.name}`,
        status: 'online',
        created_at: '2026-01-01T00:00:00Z',
      });
    } else if (request.method === 'POST' && (match = pathname.match(/^\/v1\/nodes\/([^/]+)\/agents$/))) {
      send(201, {
        id: `binding_${body.agent_name}`,
        agent_id: `id_${body.agent_name}`,
        agent_name: body.agent_name,
        node_id: 'node_channel_busy_probe',
        node_name: decodeURIComponent(match[1]),
        node_kind: 'broker',
        node_role: 'primary',
        status: 'active',
        session_ref: null,
        priority: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: null,
      });
    } else if (request.method === 'POST' && pathname === '/v1/channels' && callerOf(request) !== agent) {
      // The broker's own startup channel reconciliation (as itself, not the
      // worker) is outside the path under test: admit it and tally separately.
      const channel = String(body.name);
      fixture.otherCreates.push(`${callerOf(request) ?? 'unknown'}:${channel}`);
      send(201, {
        id: `ch_${channel}`,
        workspace_id: 'ws_channel_busy_probe',
        name: channel,
        channel_type: 0,
        topic: null,
        metadata: {},
        created_by: null,
        created_at: '2026-01-01T00:00:00Z',
        is_archived: false,
        member_count: 0,
      });
    } else if (request.method === 'POST' && pathname === '/v1/channels') {
      const channel = String(body.name);
      const attempt = (fixture.createHits[channel] = (fixture.createHits[channel] ?? 0) + 1);
      fixture.createTimes.push(performance.now());
      const totalCreates = fixture.createTimes.length;
      const busy =
        mode === 'busy-exhausted' || (mode === 'busy-then-recover' && totalCreates <= RECOVER_BUSY_RESPONSES);
      if (busy) {
        send(429, { code: BUSY_CODE, message: BUSY_MESSAGE }, false, { 'retry-after': '2' });
      } else {
        // Recovered admission; `attempt` > 1 proves this channel was replayed.
        void attempt;
        send(201, {
          id: `ch_${channel}`,
          workspace_id: 'ws_channel_busy_probe',
          name: channel,
          channel_type: 0,
          topic: null,
          metadata: {},
          created_by: null,
          created_at: '2026-01-01T00:00:00Z',
          is_archived: false,
          member_count: 0,
        });
      }
    } else if (request.method === 'POST' && (match = pathname.match(/^\/v1\/channels\/([^/]+)\/join$/))) {
      const channel = decodeURIComponent(match[1]);
      const joiner = callerOf(request) ?? 'unknown';
      if (joiner === agent) fixture.joinHits[channel] = (fixture.joinHits[channel] ?? 0) + 1;
      agentMembership(joiner).add(channel);
      send(200, { channel, joined: true });
    } else if (request.method === 'GET' && (match = pathname.match(/^\/v1\/channels\/([^/]+)\/members$/))) {
      const channel = decodeURIComponent(match[1]);
      const members = [...fixture.memberships.entries()]
        .filter(([, set]) => set.has(channel))
        .map(([name]) => ({
          agent_id: `id_${name}`,
          agent_name: name,
          role: 'member',
          joined_at: '2026-01-01T00:00:00Z',
        }));
      send(200, members);
    } else if (request.method === 'GET' && (match = pathname.match(/^\/v1\/agents\/([^/]+)$/))) {
      const name = decodeURIComponent(match[1]);
      send(200, {
        id: `id_${name}`,
        name,
        workspace_id: 'ws_channel_busy_probe',
        channels: [...agentMembership(name)].map((channel) => ({ name: channel })),
        status: 'online',
        metadata: {},
      });
    } else if (request.method === 'POST' && pathname === '/v1/agents/release') {
      fixture.releases.push(body.name);
      send(200, { status: 'completed' });
    } else if (request.method === 'PATCH' && /^\/v1\/agents\/[^/]+$/.test(pathname)) {
      send(200, {});
    } else {
      fixture.unhandled.push(`${request.method} ${pathname}`);
      send(404, { code: 'not_found', message: 'unsupported fixture route' }, false);
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  // Harmless probe executable: records that the broker launched it, then idles.
  const cli = path.join(scenarioDir, 'channel-busy-probe-cli');
  const launchMarker = path.join(scenarioDir, 'launched');
  await writeFile(
    cli,
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(launchMarker)}, 'started\\n'); setInterval(() => {}, 1000);\n`,
    { mode: 0o700 }
  );

  let broker;
  let stdout = '';
  let stderr = '';
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(RELAY|AGENT_RELAY)/.test(key))
    );
    // No WebSocket endpoint: the broker uses the HTTP registration fallback.
    broker = spawn(
      binaryPath,
      [
        'init',
        '--instance-name',
        `channel-busy-${mode}`,
        '--workspace-key',
        'rk_channel_busy_probe',
        '--state-dir',
        state,
        '--api-port',
        '0',
        '--channels',
        '',
      ],
      {
        cwd: scenarioDir,
        env: {
          ...env,
          HOME: scenarioDir,
          RELAYCAST_BASE_URL: baseUrl,
          RELAY_BROKER_API_KEY: API_KEY,
          RELAY_NODE_ID: 'node_channel_busy_probe',
          RELAY_NODE_TOKEN: 'nt_channel_busy_probe',
          AGENT_RELAY_NO_DEBUG_FILES: '1',
          AGENT_RELAY_TELEMETRY_DISABLED: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    broker.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-16000);
    });
    broker.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-16000);
    });

    let apiPort;
    for (let i = 0; i < 300 && !apiPort; i++) {
      if (broker.exitCode !== null) throw new Error(`Broker exited during startup: ${stderr.slice(-3000)}`);
      const announced = stdout.match(/API listening on http:\/\/127\.0\.0\.1:([1-9]\d{0,4})(?:\s|$)/);
      if (announced && Number(announced[1]) <= 65535) apiPort = Number(announced[1]);
      else await sleep(100);
    }
    if (!apiPort) throw new Error(`No broker loopback API announcement: ${stderr.slice(-3000)}`);

    const api = async (route, options = {}) => {
      const response = await fetch(`http://127.0.0.1:${apiPort}${route}`, {
        ...options,
        headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
        signal: AbortSignal.timeout(60_000),
        redirect: 'error',
      });
      const raw = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { raw };
      }
      return { status: response.status, body: parsed };
    };
    let ready = false;
    for (let i = 0; i < 300 && !ready; i++) {
      if (broker.exitCode !== null) throw new Error(`Broker exited before readiness: ${stderr.slice(-3000)}`);
      ready = (await api('/api/session').catch(() => ({ status: 0 }))).status === 200;
      if (!ready) await sleep(100);
    }
    if (!ready) throw new Error(`Broker API did not become ready: ${stderr.slice(-3000)}`);

    const spawnStarted = performance.now();
    const result = await api('/api/spawn', {
      method: 'POST',
      body: JSON.stringify({ name: agent, cli, channels, cwd: scenarioDir }),
    });
    const spawnMs = performance.now() - spawnStarted;
    const spawnSucceeded = result.status === 200 && result.body?.success === true;
    if (spawnSucceeded) {
      // A successful launch writes its marker promptly; allow it to appear.
      for (let i = 0; i < 100 && !existsSync(launchMarker); i++) await sleep(50);
    } else {
      // A rejected spawn must not launch anything during a settling window.
      await sleep(1_500);
    }
    const listing = await api('/api/spawned');
    const listed = listing.status === 200 && JSON.stringify(listing.body).includes(agent);
    const launched = existsSync(launchMarker);
    if (spawnSucceeded) {
      const released = await api(`/api/spawned/${agent}`, {
        method: 'DELETE',
        body: JSON.stringify({ expected_generation: result.body.generation, delete_identity: true }),
      });
      if (released.status !== 200) {
        throw new Error(`Cleanup of ${agent} failed: ${released.status} ${JSON.stringify(released.body)}`);
      }
    }
    const memberSet = fixture.memberships.get(agent) ?? new Set();
    const busySpanMs =
      fixture.createTimes.length > 1 ? fixture.createTimes.at(-1) - fixture.createTimes[0] : 0;
    return {
      spawnStatus: result.status,
      spawnSucceeded,
      errorText: spawnSucceeded ? '' : JSON.stringify(result.body),
      spawnMs,
      launched,
      listed,
      membershipRecorded: channels.every((channel) => memberSet.has(channel)),
      // Zero-fill every scenario channel so "never attempted" is an explicit 0.
      createHits: Object.fromEntries(channels.map((c) => [c, fixture.createHits[c] ?? 0])),
      joinHits: Object.fromEntries(channels.map((c) => [c, fixture.joinHits[c] ?? 0])),
      otherCreates: [...fixture.otherCreates],
      busySpanMs,
      releases: [...fixture.releases],
      unhandled: [...new Set(fixture.unhandled)],
      stderrTail: stderr.slice(-3000),
    };
  } finally {
    await stopProcess(broker);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

function summarize(value, verbose = false) {
  const { stderrTail, ...rest } = value;
  return {
    ...rest,
    spawnMs: Math.round(rest.spawnMs),
    busySpanMs: Math.round(rest.busySpanMs),
    errorText: rest.errorText.slice(0, 1_500),
    ...(verbose ? { stderrTail: stderrTail.slice(-1_500) } : {}),
  };
}

/** Agent name bound to the fixture-issued bearer token (`at_fixture_<name>`). */
function callerOf(request) {
  const token = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  return token.startsWith('at_fixture_') ? token.slice('at_fixture_'.length) : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Stop only a child this case started and wait until it has exited. */
async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await exited;
  clearTimeout(timer);
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
function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
