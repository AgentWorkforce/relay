import { execFileSync, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = 'workspace-busy-startup-retry-429';
const INSTANCE_NAME = 'relayflow-workspace-busy-429';
const HANDSHAKE_MARKER = 'connect_relay completed';
const BUSY_CODE = 'workspace_busy';
const UNRELATED_CODE = 'registration_rate_limited';
const REQUEST_ID = 'relayflow-workspace-busy-429-request';
const STARTUP_WINDOW_MS = 60_000;

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

const probeDir = await mkdtemp(path.join(tmpdir(), 'relayflow-workspace-busy-429-'));
const serverPath = path.join(probeDir, 'relaycast-admission-probe.mjs');
const serverSource = String.raw`import http from 'node:http';
const mode = process.argv[2];
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
    const workspaceBusy = mode === 'busy-success' || mode === 'busy-exhaustion';
    const shouldReject =
      mode === 'unrelated-429' ||
      (workspaceBusy && (mode === 'busy-exhaustion' || attempt === 1));
    if (shouldReject) {
      const code = mode === 'unrelated-429' ? '${UNRELATED_CODE}' : '${BUSY_CODE}';
      response.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '0',
        'x-request-id': '${REQUEST_ID}',
      });
      response.end(JSON.stringify({
        ok: false,
        error: {
          code,
          message: code === '${BUSY_CODE}' ? 'workspace admission is busy' : 'registration rate limit exceeded',
        },
      }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      ok: true,
      data: {
        id: 'a_relayflow_workspace_busy_429',
        workspace_id: 'ws_relayflow_workspace_busy_429',
        name: '${INSTANCE_NAME}',
        token: 'at_live_relayflow_workspace_busy_429',
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

const observations = {};
try {
  await writeFile(serverPath, serverSource, { encoding: 'utf8', mode: 0o600 });
  for (const mode of ['busy-success', 'unrelated-429', 'busy-exhaustion']) {
    observations[mode] = await runScenario(mode);
  }
  const success = observations['busy-success'];
  const unrelated = observations['unrelated-429'];
  const exhaustion = observations['busy-exhaustion'];
  const baseObserved =
    arm === 'base' &&
    success.registrationCount === 1 &&
    !success.timedOut &&
    !success.stderr.includes(HANDSHAKE_MARKER) &&
    success.stderr.includes('status: 429') &&
    success.stderr.includes(BUSY_CODE) &&
    success.stderr.includes('attempts: 1') &&
    unrelated.registrationCount === 1 &&
    !unrelated.timedOut &&
    !unrelated.stderr.includes(HANDSHAKE_MARKER) &&
    unrelated.stderr.includes(UNRELATED_CODE) &&
    exhaustion.registrationCount === 1 &&
    !exhaustion.timedOut &&
    !exhaustion.stderr.includes(HANDSHAKE_MARKER) &&
    exhaustion.stderr.includes('status: 429') &&
    exhaustion.stderr.includes('workspace admission is busy') &&
    exhaustion.stderr.includes('attempts: 1');
  const headObserved =
    arm === 'head' &&
    success.registrationCount === 2 &&
    success.stderr.includes(HANDSHAKE_MARKER) &&
    !success.timedOut &&
    unrelated.registrationCount === 1 &&
    !unrelated.timedOut &&
    !unrelated.stderr.includes(HANDSHAKE_MARKER) &&
    unrelated.stderr.includes(UNRELATED_CODE) &&
    exhaustion.registrationCount === 3 &&
    !exhaustion.timedOut &&
    !exhaustion.stderr.includes(HANDSHAKE_MARKER) &&
    exhaustion.stderr.includes(BUSY_CODE) &&
    exhaustion.stderr.includes('status: 429') &&
    exhaustion.stderr.includes('workspace admission is busy') &&
    exhaustion.stderr.includes('attempts: 3');
  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'bug';
    signature = 'startup_429_workspace_busy_not_retried';
    details =
      'The base broker treated the exact 429 workspace_busy admission response as terminal; unrelated 429s were terminal and no startup replay occurred.';
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'startup_429_workspace_busy_retried_safely';
    details =
      'The head broker retried workspace_busy once to complete startup, kept an unrelated 429 terminal, and exhausted workspace_busy at three request attempts without replaying the complete handshake.';
  } else {
    throw new Error(
      `Unexpected workspace admission observations: ${JSON.stringify(summarize(observations))}`
    );
  }
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
  const server = spawn(process.execPath, [serverPath, mode], {
    cwd: probeDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const { port, stderr: serverStderr } = await waitForServerReady(server);
    const observed = await runBrokerStartup({
      binaryPath,
      cwd: probeDir,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: probeDir,
        TMPDIR: probeDir,
        NO_COLOR: '1',
        RELAYCAST_BASE_URL: `http://127.0.0.1:${port}`,
        AGENT_RELAY_WORKSPACE_KEY: 'rk_relayflow_workspace_busy_429',
        AGENT_RELAY_STARTUP_DEBUG: '1',
        AGENT_RELAY_TELEMETRY_DISABLED: '1',
      },
    });
    const { registrationCount } = await readObservations(port);
    return { ...observed, registrationCount, serverStderr };
  } finally {
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => server.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
  }
}

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
      resolve({ ...result, stdout, stderr });
    };
    const timer = setTimeout(() => finish({ status: null, signal: null, timedOut: true }), STARTUP_WINDOW_MS);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.includes(HANDSHAKE_MARKER)) finish({ timedOut: false });
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`compiled broker probe could not start: ${error.message}`));
    });
    child.once('exit', (status, signal) => finish({ status, signal, timedOut: false }));
  });
}

async function waitForServerReady(server) {
  let stdout = '';
  let stderr = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Relaycast probe did not start: ${stderr || stdout || 'timeout'}`)),
      10_000
    );
    server.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const line = stdout.split('\n').find(Boolean);
      if (!line) return;
      try {
        const parsed = JSON.parse(line);
        clearTimeout(timer);
        resolve({ ...parsed, stderr });
      } catch {
        // Wait for a complete JSON line.
      }
    });
    server.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    server.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once('exit', (code, signal) => {
      if (code !== null || signal !== null) {
        clearTimeout(timer);
        reject(new Error(`Relaycast probe exited before ready: ${code ?? signal}`));
      }
    });
  });
}

async function readObservations(port) {
  const response = await fetch(`http://127.0.0.1:${port}/observations`);
  if (!response.ok) throw new Error(`Observation endpoint returned HTTP ${response.status}.`);
  const value = await response.json();
  if (!Number.isInteger(value.registrationCount)) {
    throw new Error('Observation endpoint returned an invalid registration count.');
  }
  return value;
}

function summarize(values) {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      {
        registrationCount: value.registrationCount,
        timedOut: value.timedOut,
        status: value.status,
        stdout: value.stdout.slice(-1_000),
        stderr: value.stderr.slice(-2_000),
      },
    ])
  );
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
