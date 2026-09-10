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
const REQUEST_ID = 'relayflow-1715-request';
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
      command: 'cat',
      sessionId: 'session-safe',
    },
  });

  const unsafeError = typeof unsafe.body?.error === 'string' ? unsafe.body.error : '';
  const spawnedList = (await api('GET', '/api/spawned')).body?.agents ?? [];
  const unsafeNoWorker = spawnedList.every((agent) => agent?.name !== UNSAFE_AGENT);
  const safeWarning = typeof safe.body?.warning === 'string' ? safe.body.warning : '';
  const safeWorkerPid = spawnedList.find((agent) => agent?.name === SAFE_AGENT)?.workerPid;
  const markers = (text, attempts) =>
    text.includes(`(${ERROR_STATUS})`) &&
    text.includes(ERROR_CODE) &&
    text.includes(REQUEST_ID) &&
    text.includes(`attempts: ${attempts}`);

  const baseObserved =
    arm === 'base' &&
    unsafe.status === 500 &&
    safe.status === 500 &&
    markers(unsafeError, 1) &&
    markers(typeof safe.body?.error === 'string' ? safe.body.error : '', 1) &&
    unsafeNoWorker === true &&
    relay.workerRegistrations === 2 &&
    !safe.body?.success;
  const headObserved =
    arm === 'head' &&
    unsafe.status === 500 &&
    markers(unsafeError, 3) &&
    unsafeNoWorker === true &&
    safe.status === 200 &&
    safe.body?.success === true &&
    safe.body?.runtime === 'headless' &&
    safe.body?.pre_registered === false &&
    Number.isInteger(safe.body?.pid) &&
    markers(safeWarning, 3) &&
    Number.isInteger(safeWorkerPid) &&
    safeWorkerPid > 0 &&
    relay.workerRegistrations === 6;

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'bug';
    signature = 'spawn_503_not_retried_and_safe_fallback_missing';
    details = `Base sent one HTTP registration attempt per spawn (${relay.workerRegistrations} total), failed both the unsafe and safe API requests with the typed ${ERROR_STATUS} overload, and created no fallback worker.`;
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'spawn_503_retried_and_safe_fallback_is_live';
    details = `Head sent three bounded HTTP registration attempts for each spawn (${relay.workerRegistrations} total), kept unsafe PTY closed, and returned a live safe headless task-exit worker with the preserved overload warning.`;
  } else {
    throw new Error(
      `Unexpected ${arm} spawn observation: ${JSON.stringify({
        arm,
        workerRegistrations: relay.workerRegistrations,
        unsafe,
        safe,
        unsafeNoWorker,
        safeWorkerPid,
        checks: {
          unsafeStatus: unsafe.status === 500,
          unsafeMarkers: markers(unsafeError, 3),
          unsafeNoWorker,
          safeStatus: safe.status === 200,
          safeSuccess: safe.body?.success === true,
          safeRuntime: safe.body?.runtime === 'headless',
          safeNotPreRegistered: safe.body?.pre_registered === false,
          safePid: Number.isInteger(safe.body?.pid),
          safeWarning: markers(safeWarning, 3),
          livePid: Number.isInteger(safeWorkerPid) && safeWorkerPid > 0,
          count: relay.workerRegistrations === 6,
        },
        stderr: brokerStderr.slice(-4_000),
      })}`
    );
  }
  await writeObservation(resultPath, { version: 1, caseId: CASE_ID, arm, outcome, signature, details });
} finally {
  if (broker && broker.exitCode === null) {
    broker.kill('SIGTERM');
    await Promise.race([
      onceExit(broker),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (broker.exitCode === null) broker.kill('SIGKILL');
  }
  await relay?.close();
  await rm(probeDir, { recursive: true, force: true });
}

async function startRelayProbe() {
  const sockets = new Set();
  const state = { workerRegistrations: 0 };
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
        sendJson(response, ERROR_STATUS, {
          ok: false,
          error: { code: ERROR_CODE, message: ERROR_MESSAGE },
        }, { 'x-request-id': REQUEST_ID });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        data: {
          id: 'agent_relayflow_1715_broker',
          workspace_id: 'ws_relayflow_1715',
          name: BROKER_NAME,
          token: 'at_relayflow_1715_broker',
          status: 'active',
          created_at: '2026-09-10T00:00:00Z',
        },
      });
      return;
    }
    sendJson(response, 200, { ok: true, data: {} });
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
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
