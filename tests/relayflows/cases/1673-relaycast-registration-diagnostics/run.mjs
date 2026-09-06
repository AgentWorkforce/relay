import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1673-relaycast-registration-diagnostics';
const RETRY_AFTER_SECONDS = 5;
const NO_TERMINAL_SLEEP_MAX_MS = 4_000;
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

const probeDir = await mkdtemp(path.join(tmpdir(), 'relayflow-1673-'));
const serverPath = path.join(probeDir, 'registration-503.mjs');
const serverSource = String.raw`import http from 'node:http';

let requestCount = 0;
const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/observations') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ requestCount }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/agents') {
    response.writeHead(404).end();
    return;
  }
  requestCount += 1;
  request.resume();
  request.once('end', () => {
    response.writeHead(503, {
      'content-type': 'application/json',
      'retry-after': '${RETRY_AFTER_SECONDS}',
      'x-request-id': 'relayflow-1673-request',
    });
    response.end(JSON.stringify({
      ok: false,
      error: {
        code: 'registration_backend_overloaded',
        message: 'relayflow deterministic registration failure',
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
  const commandEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: probeDir,
    TMPDIR: probeDir,
    NO_COLOR: '1',
  };
  const startedAt = Date.now();
  const completed = spawnSync(
    binaryPath,
    [
      'mcp-args',
      '--register',
      '--cli',
      'codex',
      '--agent-name',
      'relayflow-1673-agent',
      '--api-key',
      'rk_relayflow_1673',
      '--base-url',
      `http://127.0.0.1:${port}`,
      '--cwd',
      targetDir,
    ],
    {
      cwd: targetDir,
      encoding: 'utf8',
      timeout: 45_000,
      // Do not inherit runner credentials. The explicit fake key and base URL
      // above are the only registration inputs available to this real binary.
      env: commandEnv,
    }
  );
  const elapsedMs = Date.now() - startedAt;
  const observations = await readObservations(port);
  const commandStderr = completed.stderr ?? '';

  if (completed.error) {
    throw new Error(`compiled mcp-args probe could not complete: ${completed.error.message}`);
  }

  const baseObserved =
    completed.status !== 0 &&
    observations.requestCount >= 2 &&
    commandStderr.includes('Max retries exceeded') &&
    !commandStderr.includes('registration_backend_overloaded') &&
    !commandStderr.includes('request_id: relayflow-1673-request');
  const headObserved =
    completed.status !== 0 &&
    observations.requestCount === 1 &&
    elapsedMs < NO_TERMINAL_SLEEP_MAX_MS &&
    [
      '(503)',
      'registration_backend_overloaded',
      'relayflow deterministic registration failure',
      'request_id: relayflow-1673-request',
      'attempts: 1',
    ].every((marker) => commandStderr.includes(marker));

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'bug';
    signature = 'registration_503_replayed_and_diagnostic_lost';
    details = `The base broker sent ${observations.requestCount} unsafe registration POSTs in ${elapsedMs}ms and ended with Max retries exceeded, without the terminal 503 diagnostic.`;
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'registration_503_diagnostic_preserved_without_replay';
    details = `The head broker sent one unsafe registration POST and returned the terminal 503 code, message, request ID, and attempts in ${elapsedMs}ms without sleeping for Retry-After: ${RETRY_AFTER_SECONDS}.`;
  } else {
    throw new Error(
      `Unexpected compiled registration observation: ${JSON.stringify({
        arm,
        status: completed.status,
        signal: completed.signal,
        elapsedMs,
        requestCount: observations.requestCount,
        stdout: (completed.stdout ?? '').slice(-2_000),
        stderr: `${serverStderr}${commandStderr}`.slice(-2_000),
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
  if (!response.ok) throw new Error(`registration probe observation endpoint returned ${response.status}`);
  const observation = await response.json();
  if (!Number.isInteger(observation?.requestCount) || observation.requestCount < 0) {
    throw new Error(`registration probe returned invalid request count ${JSON.stringify(observation)}`);
  }
  return observation;
}

function waitForServerReady(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('registration probe server did not start')), 10_000);
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
        reject(new Error(`registration probe server emitted invalid readiness: ${error.message}`));
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `registration probe server exited before readiness (${signal ?? code ?? 'unknown'}): ${stderr}`
        )
      );
    });
  });
}
