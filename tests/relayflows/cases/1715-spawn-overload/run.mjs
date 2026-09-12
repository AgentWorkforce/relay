import { execFileSync, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const CASE_ID = '1715-spawn-overload';
const BROKER_NAME = 'relayflow-1715-broker';
const BROKER_API_KEY = 'br_relayflow_1715';
const ERROR_CODE = 'database_overloaded';
const ERROR_MESSAGE = 'The database is temporarily overloaded. request_id: relayflow-1715-request';
const ERROR_STATUS = 503;
const WORKSPACE_BUSY_CODE = 'workspace_busy';
const WORKSPACE_BUSY_MESSAGE = 'Workspace write capacity is busy; retry with backoff';
const WORKSPACE_BUSY_STATUS = 429;
const REQUEST_ID = 'relayflow-1715-request';
const RETRY_BACKOFFS_MS = [200, 400];
const RETRY_DELAY_TOLERANCE_MS = 250;
const RETRY_DEADLINE_MS = 3_000;
// Admit the safe create-only registration on attempt 13, beyond the old
// observed maximum of eleven. This proves queue depth is not the retry budget;
// the unsafe typed-503 path still proves bounded failure at three attempts.
const SAFE_AGENT_WORKSPACE_BUSY_ATTEMPTS = 13;
const SAFE_AGENT_WORKSPACE_BUSY_DEADLINE_MS = 15_000;
const UNSAFE_AGENT = 'relayflow-1715-unsafe';
const SAFE_AGENT = 'relayflow-1715-safe';

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

const probeDir = await mkdtemp(path.join(tmpdir(), 'relayflow-1715-'));
const stateDir = path.join(probeDir, 'state');
let relay;
let broker;
let brokerStderr = '';
try {
  await mkdir(stateDir, { recursive: true });
  relay = await startRelayProbe();
  broker = spawn(
    binaryPath,
    [
      'init',
      '--instance-name',
      BROKER_NAME,
      '--workspace-key',
      'rk_relayflow_1715',
      '--state-dir',
      stateDir,
      '--api-port',
      '0',
      '--api-bind',
      '127.0.0.1',
      '--channels',
      '',
    ],
    {
      cwd: probeDir,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: probeDir,
        TMPDIR: probeDir,
        NO_COLOR: '1',
        RELAYCAST_BASE_URL: relay.baseUrl,
        RELAY_BASE_URL: relay.baseUrl,
        RELAY_BROKER_API_KEY: BROKER_API_KEY,
        RELAY_NODE_ID: 'node_relayflow_1715',
        AGENT_RELAY_TELEMETRY_DISABLED: '1',
        RELAY_SKIP_TELEMETRY: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  broker.stderr.on('data', (chunk) => {
    brokerStderr = `${brokerStderr}${chunk}`.slice(-20_000);
  });

  const brokerUrl = await waitForConnection(path.join(stateDir, 'connection.json'), broker);
  const api = (method, pathname, body) =>
    requestJson(`${brokerUrl}${pathname}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-api-key': BROKER_API_KEY,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  await waitFor(
    () => api('GET', '/api/session').then((response) => response.status === 200),
    'broker readiness'
  ).catch((error) => {
    throw new Error(`${error.message}; broker stderr: ${brokerStderr}`);
  });
  // No node token is supplied. The real node-control loop therefore reports
  // its typed `node_token_missing` registration failure to `/api/spawn` while
  // the fake Relaycast remains entirely local and deterministic.

  const unsafe = await api('POST', '/api/spawn', {
    name: UNSAFE_AGENT,
    cli: 'codex',
    transport: 'pty',
  });
  const safe = await api('POST', '/api/spawn', {
    name: SAFE_AGENT,
    cli: 'codex',
    transport: 'headless',
    spawnMode: 'task_exit',
    skipRelayPrompt: true,
    task: 'run the local task',
    harnessConfig: {
      runtime: 'native',
      command: "sh -c 'sleep 1; read -r _; exit 0'",
      sessionId: 'session-safe',
    },
  });

  const unsafeError = typeof unsafe.body?.error === 'string' ? unsafe.body.error : '';
  const spawnedList = (await api('GET', '/api/spawned')).body?.agents ?? [];
  const unsafeNoWorker = spawnedList.every((agent) => agent?.name !== UNSAFE_AGENT);
  const safeNoWorker = spawnedList.every((agent) => agent?.name !== SAFE_AGENT);
  const safeWarning = typeof safe.body?.warning === 'string' ? safe.body.warning : '';
  const safeWorkerPid = spawnedList.find((agent) => agent?.name === SAFE_AGENT)?.workerPid;
  const safeTaskExitCleaned = await waitFor(async () => {
    const agents = (await api('GET', '/api/spawned')).body?.agents ?? [];
    return agents.every((agent) => agent?.name !== SAFE_AGENT);
  }, 'safe task-exit cleanup');
  const registrationTimestamps = [...relay.workerRegistrationTimestamps];
  const retryScheduleBounded = retryScheduleIsBounded(registrationTimestamps, arm);
  const registrationGroupSizes = arm === 'head' ? [3, SAFE_AGENT_WORKSPACE_BUSY_ATTEMPTS] : [3, 3];
  const idempotencyKeysStable = idempotencyKeysAreStable(
    relay.workerRegistrationIdempotencyKeys,
    registrationGroupSizes
  );
  const waiterKeysStable = idempotencyKeysAreStable(
    relay.workerRegistrationWaiterKeys,
    registrationGroupSizes
  );
  const waiterKeysMatchIdempotencyKeys = relay.workerRegistrationWaiterKeys.every(
    (key, index) => key === relay.workerRegistrationIdempotencyKeys[index]
  );
  // The pre-fix SDK reports one POST by omission (no attempts marker), while
  // the broker-owned retry path restamps the terminal detail with the total.
  const markers = (text, status, code, message, attempts, requireAttempts = true) =>
    (status === undefined || text.includes(`(${status})`)) &&
    text.includes(code) &&
    text.includes(message) &&
    text.includes(REQUEST_ID) &&
    (!requireAttempts || text.includes(`attempts: ${attempts}`));

  const baseObserved =
    arm === 'base' &&
    unsafe.status === 500 &&
    safe.status === 500 &&
    markers(unsafeError, ERROR_STATUS, ERROR_CODE, ERROR_MESSAGE, 1, false) &&
    markers(
      typeof safe.body?.error === 'string' ? safe.body.error : '',
      ERROR_STATUS,
      ERROR_CODE,
      ERROR_MESSAGE,
      1,
      false
    ) &&
    unsafeNoWorker === true &&
    safeNoWorker === true &&
    safeTaskExitCleaned === true &&
    retryScheduleBounded === false &&
    idempotencyKeysStable === false &&
    relay.workerRegistrations === 2 &&
    !safe.body?.success;
  const headObserved =
    arm === 'head' &&
    unsafe.status === 500 &&
    markers(unsafeError, ERROR_STATUS, ERROR_CODE, ERROR_MESSAGE, 3, false) &&
    unsafeNoWorker === true &&
    safe.status === 200 &&
    safe.body?.success === true &&
    safe.body?.runtime === 'headless' &&
    safe.body?.pre_registered === true &&
    Number.isInteger(safe.body?.pid) &&
    relay.workerRegistrationResponses.length === 3 + SAFE_AGENT_WORKSPACE_BUSY_ATTEMPTS &&
    relay.workerRegistrationResponses
      .slice(0, 3)
      .every((response) => response.status === ERROR_STATUS && response.code === ERROR_CODE) &&
    relay.workerRegistrationResponses
      .slice(3, -1)
      .every(
        (response) =>
          response.status === WORKSPACE_BUSY_STATUS &&
          response.code === WORKSPACE_BUSY_CODE &&
          response.message === WORKSPACE_BUSY_MESSAGE
      ) &&
    relay.workerRegistrationResponses.at(-1)?.status === 200 &&
    Number.isInteger(safeWorkerPid) &&
    safeWorkerPid > 0 &&
    safeTaskExitCleaned === true &&
    retryScheduleBounded === true &&
    idempotencyKeysStable === true &&
    waiterKeysStable === true &&
    waiterKeysMatchIdempotencyKeys === true &&
    relay.workerRegistrations === 3 + SAFE_AGENT_WORKSPACE_BUSY_ATTEMPTS;

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'bug';
    signature = 'spawn_503_not_retried_and_safe_fallback_missing';
    details = `Base sent one HTTP registration attempt per spawn (${relay.workerRegistrations} total), failed both the unsafe and safe API requests with the typed ${ERROR_STATUS} overload, and created no fallback worker.`;
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'spawn_503_bounded_and_safe_late_admission_is_live';
    details = `Head sent three bounded create-only HTTP registration attempts for the 503 unsafe spawn and admitted the safe headless spawn on attempt ${SAFE_AGENT_WORKSPACE_BUSY_ATTEMPTS} after ${SAFE_AGENT_WORKSPACE_BUSY_ATTEMPTS - 1} typed ${WORKSPACE_BUSY_CODE} responses (${relay.workerRegistrations} total), reused one Idempotency-Key per logical spawn while mirroring it onto X-Workspace-Write-Waiter, kept unsafe PTY closed, and returned a live safe task-exit worker. Timestamped retries stayed within the fixed 200/400ms schedule for 503 (within ${RETRY_DEADLINE_MS}ms) and the finite one-second workspace_busy deadline (within ${SAFE_AGENT_WORKSPACE_BUSY_DEADLINE_MS}ms); persistent bounded exhaustion is covered by broker policy regressions.`;
  } else {
    throw new Error(
      `Unexpected ${arm} spawn observation: ${JSON.stringify({
        arm,
        workerRegistrations: relay.workerRegistrations,
        unsafe,
        safe,
        unsafeNoWorker,
        safeNoWorker,
        safeWorkerPid,
        safeTaskExitCleaned,
        registrationTimestamps,
        retryScheduleBounded,
        idempotencyKeysStable,
        waiterKeysStable,
        waiterKeysMatchIdempotencyKeys,
        checks: {
          unsafeStatus: unsafe.status === 500,
          unsafeMarkers: markers(unsafeError, ERROR_STATUS, ERROR_CODE, ERROR_MESSAGE, 3),
          unsafeNoWorker,
          safeStatus: safe.status === 200,
          safeSuccess: safe.body?.success === true,
          safeRuntime: safe.body?.runtime === 'headless',
          safeNotPreRegistered: safe.body?.pre_registered === false,
          safePid: Number.isInteger(safe.body?.pid),
          safeWarning: markers(
            safeWarning,
            undefined,
            WORKSPACE_BUSY_CODE,
            WORKSPACE_BUSY_MESSAGE,
            arm === 'head' ? SAFE_AGENT_WORKSPACE_BUSY_ATTEMPTS : 3
          ),
          responseShape: relay.workerRegistrationResponses,
          livePid: Number.isInteger(safeWorkerPid) && safeWorkerPid > 0,
          safeTaskExitCleaned,
          retryScheduleBounded,
          idempotencyKeysStable,
          waiterKeysStable,
          waiterKeysMatchIdempotencyKeys,
          count: relay.workerRegistrations === 3 + (arm === 'head' ? SAFE_AGENT_WORKSPACE_BUSY_ATTEMPTS : 3),
        },
        stderr: brokerStderr.slice(-4_000),
      })}`
    );
  }
  await writeObservation(resultPath, { version: 1, caseId: CASE_ID, arm, outcome, signature, details });
} finally {
  if (broker && broker.exitCode === null) {
    broker.kill('SIGTERM');
    await Promise.race([onceExit(broker), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (broker.exitCode === null) broker.kill('SIGKILL');
  }
  await relay?.close();
  await rm(probeDir, { recursive: true, force: true });
}

async function startRelayProbe() {
  const sockets = new Set();
  const state = {
    workerRegistrations: 0,
    workerRegistrationTimestamps: [],
    workerRegistrationIdempotencyKeys: [],
    workerRegistrationWaiterKeys: [],
    workerRegistrationResponses: [],
  };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    } catch {
      sendJson(response, 400, { ok: false, error: { code: 'invalid_json', message: 'invalid JSON' } });
      return;
    }
    const pathname = new URL(request.url ?? '/', 'http://relayflow.invalid').pathname;
    if (request.method === 'POST' && pathname === '/v1/agents') {
      if (body?.name !== BROKER_NAME) {
        state.workerRegistrations += 1;
        state.workerRegistrationTimestamps.push(Date.now());
        state.workerRegistrationIdempotencyKeys.push(request.headers['idempotency-key'] ?? null);
        state.workerRegistrationWaiterKeys.push(request.headers['x-workspace-write-waiter'] ?? null);
        const safeAttempt =
          state.workerRegistrationResponses.filter((entry) => entry.name === body?.name).length + 1;
        const workspaceBusy =
          arm === 'head' && body?.name === SAFE_AGENT && safeAttempt < SAFE_AGENT_WORKSPACE_BUSY_ATTEMPTS;
        const admitted =
          arm === 'head' && body?.name === SAFE_AGENT && safeAttempt === SAFE_AGENT_WORKSPACE_BUSY_ATTEMPTS;
        const status = admitted ? 200 : workspaceBusy ? WORKSPACE_BUSY_STATUS : ERROR_STATUS;
        const code = admitted ? 'created' : workspaceBusy ? WORKSPACE_BUSY_CODE : ERROR_CODE;
        const message = admitted ? 'created' : workspaceBusy ? WORKSPACE_BUSY_MESSAGE : ERROR_MESSAGE;
        state.workerRegistrationResponses.push({ name: body?.name, status, code, message });
        // Exercise both overload contracts: the unsafe spawn receives the
        // existing 503 database_overloaded response, while the safe spawn
        // receives the production-shaped 429 workspace_busy response.
        if (admitted) {
          sendJson(response, 200, {
            ok: true,
            data: {
              id: `agent_${SAFE_AGENT}`,
              workspace_id: 'ws_relayflow_1715',
              agent_name: SAFE_AGENT,
              name: SAFE_AGENT,
              token: `at_${SAFE_AGENT}`,
              status: 'active',
              created_at: '2026-09-10T00:00:00Z',
            },
          });
        } else {
          sendJson(
            response,
            status,
            { ok: false, error: { code, message } },
            {
              ...(workspaceBusy ? { 'retry-after': '0' } : {}),
              'x-request-id': REQUEST_ID,
            }
          );
        }
        return;
      }
      sendJson(response, 200, {
        ok: true,
        data: {
          id: 'agent_relayflow_1715_broker',
          workspace_id: 'ws_relayflow_1715',
          agent_name: BROKER_NAME,
          name: BROKER_NAME,
          token: 'at_relayflow_1715_broker',
          status: 'active',
          created_at: '2026-09-10T00:00:00Z',
        },
      });
      return;
    }
    if (pathname.includes('/members')) {
      sendJson(response, 200, {
        ok: true,
        data: [
          {
            id: `agent_${SAFE_AGENT}`,
            agent_id: `agent_${SAFE_AGENT}`,
            name: SAFE_AGENT,
            agent_name: SAFE_AGENT,
            role: 'member',
            channel_id: 'channel_relayflow_1715',
            channel_name: 'general',
            status: 'active',
            joined_at: '2026-09-10T00:00:00Z',
            created_at: '2026-09-10T00:00:00Z',
          },
        ],
      });
      return;
    }
    if (request.method === 'GET' && pathname.startsWith('/v1/channels/')) {
      const channelName = decodeURIComponent(pathname.split('/').at(-1) ?? 'general');
      sendJson(response, 200, {
        ok: true,
        data: {
          id: `channel_${channelName}`,
          name: channelName,
          workspace_id: 'ws_relayflow_1715',
          created_at: '2026-09-10T00:00:00Z',
          members: [
            {
              agent_id: `agent_${SAFE_AGENT}`,
              agent_name: SAFE_AGENT,
              role: 'member',
              joined_at: '2026-09-10T00:00:00Z',
            },
          ],
        },
      });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      data: {
        id: 'resource_relayflow_1715',
        agent_id: `agent_${SAFE_AGENT}`,
        agent_name: SAFE_AGENT,
        name: 'relayflow-1715-resource',
        node_id: 'node_relayflow_1715',
        node_name: BROKER_NAME,
        node_kind: 'local',
        node_role: 'broker',
        status: 'active',
        session_ref: null,
        priority: 0,
        created_at: '2026-09-10T00:00:00Z',
        updated_at: null,
        channels: [
          { id: 'channel_general', name: 'general' },
          { id: 'channel_engineering', name: 'engineering' },
        ],
      },
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address.');
  return {
    ...state,
    get workerRegistrations() {
      return state.workerRegistrations;
    },
    get workerRegistrationTimestamps() {
      return state.workerRegistrationTimestamps;
    },
    get workerRegistrationIdempotencyKeys() {
      return state.workerRegistrationIdempotencyKeys;
    },
    get workerRegistrationWaiterKeys() {
      return state.workerRegistrationWaiterKeys;
    },
    get workerRegistrationResponses() {
      return state.workerRegistrationResponses;
    },
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(value));
}

async function requestJson(url, options) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error(
      `request ${options.method ?? 'GET'} ${url} failed: ${error.message}; broker stderr: ${brokerStderr}`
    );
  }
  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    body = { raw };
  }
  return { status: response.status, body };
}

async function waitForConnection(connectionPath, child) {
  return waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Broker exited during startup: ${brokerStderr}`);
    try {
      const connection = JSON.parse(await readFile(connectionPath, 'utf8'));
      const url = new URL(connection.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\d+$/.test(url.port)) return false;
      return `http://127.0.0.1:${Number(url.port)}`;
    } catch {
      return false;
    }
  }, 'connection metadata');
}

async function waitFor(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function writeObservation(observationPath, value) {
  await mkdir(path.dirname(observationPath), { recursive: true });
  await writeFile(observationPath, `${JSON.stringify(value)}\n`, 'utf8');
}

function onceExit(child) {
  return new Promise((resolve) => child.once('exit', resolve));
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

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function retryScheduleIsBounded(timestamps, proofArm) {
  // Unsafe spawn: 3 attempts on the fixed 200/400ms transient-5xx schedule.
  // Safe spawn (head only): the proven eleven-attempt `workspace_busy`
  // budget at a flat one-second cooldown between attempts.
  const safeAttempts = proofArm === 'head' ? SAFE_AGENT_WORKSPACE_BUSY_ATTEMPTS : 3;
  if (timestamps.length !== 3 + safeAttempts) return false;

  const unsafeElapsed = timestamps[2] - timestamps[0];
  if (unsafeElapsed > RETRY_DEADLINE_MS) return false;
  for (let retry = 0; retry < RETRY_BACKOFFS_MS.length; retry += 1) {
    const delta = timestamps[retry + 1] - timestamps[retry];
    if (
      delta < RETRY_BACKOFFS_MS[retry] - 50 ||
      delta > RETRY_BACKOFFS_MS[retry] + RETRY_DELAY_TOLERANCE_MS
    ) {
      return false;
    }
  }

  const safeStart = 3;
  const safeElapsed = timestamps[safeStart + safeAttempts - 1] - timestamps[safeStart];
  if (safeElapsed > SAFE_AGENT_WORKSPACE_BUSY_DEADLINE_MS) return false;
  const expectedSafeBackoff = proofArm === 'head' ? 1_000 : RETRY_BACKOFFS_MS[0];
  for (let retry = 0; retry < safeAttempts - 1; retry += 1) {
    const delta = timestamps[safeStart + retry + 1] - timestamps[safeStart + retry];
    if (proofArm === 'head') {
      if (delta < expectedSafeBackoff - 100 || delta > expectedSafeBackoff + RETRY_DELAY_TOLERANCE_MS) {
        return false;
      }
    } else if (
      delta < RETRY_BACKOFFS_MS[retry] - 50 ||
      delta > RETRY_BACKOFFS_MS[retry] + RETRY_DELAY_TOLERANCE_MS
    ) {
      return false;
    }
  }
  return true;
}

function idempotencyKeysAreStable(keys, groupSizes) {
  const total = groupSizes.reduce((sum, size) => sum + size, 0);
  if (keys.length !== total || keys.some((key) => typeof key !== 'string' || key.length === 0)) {
    return false;
  }
  const starts = [];
  let offset = 0;
  for (const size of groupSizes) {
    starts.push(offset);
    offset += size;
  }
  return (
    new Set(starts.map((start) => keys[start])).size === starts.length &&
    starts.every((start, index) =>
      keys.slice(start, start + groupSizes[index]).every((key) => key === keys[start])
    )
  );
}
