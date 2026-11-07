import { execFileSync, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1700-broker-startup-transient-relaycast-retry';
// One transient failure, then health. This is the shape publish run
// 34099838274 hit: a single 503 from a loaded Relaycast, not an outage.
const TRANSIENT_STATUS = 503;
const ERROR_CODE = 'database_overloaded';
const ERROR_MESSAGE = 'The database is temporarily overloaded.';
const REQUEST_ID = 'relayflow-1700-request';
const INSTANCE_NAME = 'relayflow-1700-agent';
// The whole handshake, retries included, must land far inside this.
const STARTUP_WINDOW_MS = 60_000;
// Emitted by connect_relay once registration and the workspace session are
// established. Only the head arm can reach it.
const HANDSHAKE_MARKER = 'connect_relay completed';
// The terminal diagnostic PR #1673 added and this change must preserve.
const TERMINAL_DIAGNOSTIC_MARKERS = [
  `(status: ${TRANSIENT_STATUS}`,
  ERROR_CODE,
  ERROR_MESSAGE,
  `request_id: ${REQUEST_ID}`,
];

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

const runnerPath = fileURLToPath(import.meta.url);
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

const probeDir = await mkdtemp(path.join(tmpdir(), 'relayflow-1700-'));
const serverPath = path.join(probeDir, 'flaky-relaycast.mjs');
const serverSource = String.raw`import http from 'node:http';

let registrationCount = 0;
const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/observations') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ registrationCount }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/agents') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'no route' } }));
    return;
  }
  registrationCount += 1;
  const attempt = registrationCount;
  request.resume();
  request.once('end', () => {
    if (attempt === 1) {
      response.writeHead(${TRANSIENT_STATUS}, {
        'content-type': 'application/json',
        'retry-after': '0',
        'x-request-id': '${REQUEST_ID}',
      });
      response.end(JSON.stringify({
        ok: false,
        error: { code: '${ERROR_CODE}', message: '${ERROR_MESSAGE}' },
      }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      ok: true,
      data: {
        id: 'a_relayflow_1700',
        workspace_id: 'ws_relayflow_1700',
        name: '${INSTANCE_NAME}',
        token: 'at_live_relayflow_1700',
        status: 'online',
        created_at: '2025-01-01T00:00:00Z',
      },
    }));
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address.');
  process.stdout.write(JSON.stringify({ port: address.port }) + '\n');
});
process.once('SIGTERM', () => server.close(() => process.exit(0)));
`;

let server;
try {
  await writeFile(serverPath, serverSource, { encoding: 'utf8', mode: 0o600 });
  server = spawn(process.execPath, [serverPath], {
    cwd: probeDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const { port, stderr: serverStderr } = await waitForServerReady(server);

  const startedAt = Date.now();
  const observed = await runBrokerStartup({
    binaryPath,
    cwd: probeDir,
    // Do not inherit runner credentials. The explicit fake workspace key and
    // base URL below are the only Relaycast inputs this real binary gets.
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: probeDir,
      TMPDIR: probeDir,
      NO_COLOR: '1',
      RELAYCAST_BASE_URL: `http://127.0.0.1:${port}`,
      AGENT_RELAY_WORKSPACE_KEY: 'rk_relayflow_1700',
      AGENT_RELAY_STARTUP_DEBUG: '1',
      AGENT_RELAY_TELEMETRY_DISABLED: '1',
    },
  });
  const elapsedMs = Date.now() - startedAt;
  const { registrationCount } = await readObservations(port);
  const stderr = observed.stderr;

  // The base broker returns the first 503 straight out of the handshake, so it
  // never sends a second registration and never reaches connect_relay.
  const baseObserved =
    registrationCount === 1 &&
    !stderr.includes(HANDSHAKE_MARKER) &&
    stderr.includes('attempts: 1') &&
    TERMINAL_DIAGNOSTIC_MARKERS.every((marker) => stderr.includes(marker));
  // The head broker replays the transient once and completes the handshake.
  const headObserved = registrationCount === 2 && stderr.includes(HANDSHAKE_MARKER) && !observed.timedOut;

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'bug';
    signature = 'startup_503_exits_broker_without_retry';
    details = `The base broker sent one registration POST, took the transient ${TRANSIENT_STATUS} as terminal after ${elapsedMs}ms, and exited without reaching ${HANDSHAKE_MARKER}.`;
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'startup_503_retried_and_handshake_completes';
    // `registrationCount` gates this branch above and is deliberately not
    // interpolated here: the observation file must not carry a value read off
    // the probe socket, only the verdict that value was checked against.
    details = `The head broker replayed the transient ${TRANSIENT_STATUS} once, sending a second registration POST, and completed the Relaycast handshake in ${elapsedMs}ms.`;
  } else {
    throw new Error(
      `Unexpected compiled startup observation: ${JSON.stringify({
        arm,
        status: observed.status,
        signal: observed.signal,
        timedOut: observed.timedOut,
        elapsedMs,
        registrationCount,
        stdout: observed.stdout.slice(-2_000),
        stderr: `${serverStderr}${stderr}`.slice(-2_000),
      })}.`
    );
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  await rm(probeDir, { recursive: true, force: true });
}

/**
 * `init` is a long-lived server: on the fixed arm it keeps running once the
 * handshake succeeds. Settle as soon as the handshake marker appears or the
 * process exits, so neither arm has to wait out a wall-clock timeout, and
 * always stop the child before returning.
 */
function runBrokerStartup({ binaryPath, cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ['init', '--instance-name', INSTANCE_NAME, '--channels', 'general'], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ stdout, stderr, status: null, signal: null, timedOut: true }),
      STARTUP_WINDOW_MS
    );
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.includes(HANDSHAKE_MARKER)) {
        finish({ stdout, stderr, status: null, signal: null, timedOut: false });
      }
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`compiled broker probe could not start: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      finish({ stdout, stderr, status: code, signal, timedOut: false });
    });
  });
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

async function readObservations(port) {
  const response = await fetch(`http://127.0.0.1:${port}/observations`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`startup probe observation endpoint returned ${response.status}`);
  }
  const observation = await response.json();
  if (!Number.isInteger(observation?.registrationCount) || observation.registrationCount < 0) {
    throw new Error(`startup probe returned an invalid count ${JSON.stringify(observation)}`);
  }
  return observation;
}

function waitForServerReady(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('startup probe server did not start')), 10_000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        const ready = JSON.parse(stdout.slice(0, newline));
        if (!Number.isInteger(ready.port) || ready.port <= 0) {
          throw new Error(`invalid port ${JSON.stringify(ready.port)}`);
        }
        resolve({ port: ready.port, stderr });
      } catch (error) {
        reject(new Error(`startup probe server emitted invalid readiness: ${error.message}`));
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(`startup probe server exited before readiness (${signal ?? code ?? 'unknown'}): ${stderr}`)
      );
    });
  });
}
