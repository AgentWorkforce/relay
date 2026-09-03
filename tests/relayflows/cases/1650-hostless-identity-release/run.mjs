/**
 * Explicit broker removal first stops the local worker and queues its fleet
 * deregistration, then releases the Relaycast identity. The base broker omitted
 * delete_agent, so Relaycast had to dispatch the release to a live host that no
 * longer existed. SDK retries then hid the decisive agent_host_unavailable as
 * "Max retries exceeded" and DELETE /api/spawned returned 500 forever.
 *
 * This proof uses the exact compiled broker and its public HTTP API. The target
 * worker is deliberately already absent, matching the repeated production
 * failure. A deterministic Relaycast double rejects hostless non-delete release
 * and accepts destructive local completion. The observation is the broker's
 * response plus the exact release wire bodies; no source inspection decides the
 * result.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1650-hostless-identity-release';
const AGENT_NAME = 'already-gone-release-probe';
const API_KEY = 'br_relayflow_1650';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
const binaryPath = await requiredExecutable('RELAY_PR_PROOF_BROKER_BINARY');
const resultPath = requiredValue('RELAY_PR_PROOF_RESULT_PATH');
const arm = requiredValue('RELAY_PR_PROOF_ARM');
const brokerPort = await reservePort();

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

const probeDir = await mkdtemp(path.join(tmpdir(), 'relayflow-1650-'));
const stateDir = path.join(probeDir, 'state');
const releaseBodies = [];
const sockets = new Set();
let broker;
let brokerStderr = '';
const relaycast = http.createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://relayflow.invalid').pathname;
  let body;
  try {
    body = await readJson(request);
  } catch {
    sendJson(response, 400, {
      ok: false,
      error: { code: 'invalid_json', message: 'Request body must be valid JSON.' },
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/v1/agents') {
    sendJson(response, 200, {
      ok: true,
      data: {
        id: 'agent_relayflow_1650_broker',
        workspace_id: 'ws_relayflow_1650',
        name: body?.name ?? 'relayflow-1650-broker',
        token: 'at_relayflow_1650_broker',
        status: 'active',
        created_at: '2026-09-04T00:00:00.000Z',
      },
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/v1/agents/release') {
    releaseBodies.push(body);
    if (body?.name !== AGENT_NAME) {
      sendJson(response, 400, {
        ok: false,
        error: { code: 'invalid_agent', message: 'Unexpected release target.' },
      });
      return;
    }
    if (body?.delete_agent !== true) {
      sendJson(response, 503, {
        ok: false,
        error: {
          code: 'agent_host_unavailable',
          message: `Agent "${body?.name}" has no live host node; cannot dispatch release`,
        },
      });
      return;
    }
    sendJson(response, 201, {
      ok: true,
      data: {
        invocation_id: 'inv_release_relayflow_1650',
        action_name: 'release',
        handler_agent_id: null,
        handler_node_id: null,
        dispatched_node_id: null,
        input: body,
        status: 'completed',
        created_at: '2026-09-04T00:00:00.000Z',
      },
    });
    return;
  }

  // Startup registration, presence, channel setup, and shutdown bookkeeping
  // are outside this case's release contract.
  sendJson(response, 200, { ok: true, data: {} });
});
relaycast.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});
relaycast.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.destroy();
    return;
  }
  const accept = createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
});

try {
  await mkdir(stateDir, { recursive: true });
  await new Promise((resolve) => relaycast.listen(0, '127.0.0.1', resolve));
  const address = relaycast.address();
  if (!address || typeof address === 'string') throw new Error('Expected Relaycast TCP address.');
  const relaycastUrl = `http://127.0.0.1:${address.port}`;

  broker = spawn(
    binaryPath,
    [
      'init',
      '--instance-name',
      'relayflow-1650-broker',
      '--workspace-key',
      'rk_relayflow_1650',
      '--state-dir',
      stateDir,
      '--api-port',
      String(brokerPort),
      '--channels',
      '',
    ],
    {
      cwd: probeDir,
      env: {
        ...process.env,
        RELAYCAST_BASE_URL: relaycastUrl,
        RELAY_BROKER_API_KEY: API_KEY,
        RELAY_NODE_ID: 'node_relayflow_1650',
        RELAY_NODE_TOKEN: 'nt_relayflow_1650',
        AGENT_RELAY_NO_DEBUG_FILES: '1',
        RELAY_SKIP_TELEMETRY: '1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    }
  );
  broker.stderr.on('data', (chunk) => {
    brokerStderr = `${brokerStderr}${chunk}`.slice(-16_000);
  });

  const brokerUrl = `http://127.0.0.1:${brokerPort}`;
  await waitFor(
    async () => {
      const response = await fetch(`${brokerUrl}/api/session`, {
        headers: { 'x-api-key': API_KEY },
        signal: AbortSignal.timeout(2_000),
      });
      return response.status === 200;
    },
    30_000,
    'broker API readiness'
  );
  const response = await fetch(`${brokerUrl}/api/spawned/${encodeURIComponent(AGENT_NAME)}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ reason: 'relayflow hostless identity release proof' }),
    signal: AbortSignal.timeout(30_000),
  });
  const responseText = await response.text();
  let responseBody;
  try {
    responseBody = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Broker release response was not JSON: ${JSON.stringify({ status: response.status, responseText })}`
    );
  }

  const allNonDelete = releaseBodies.length > 0 && releaseBodies.every((body) => body?.delete_agent !== true);
  const allDestructive =
    releaseBodies.length > 0 && releaseBodies.every((body) => body?.delete_agent === true);
  const baseObserved =
    response.status === 500 &&
    responseBody?.success === false &&
    String(responseBody?.error).includes('Max retries exceeded') &&
    allNonDelete;
  const headObserved =
    response.status === 200 &&
    responseBody?.success === true &&
    responseBody?.name === AGENT_NAME &&
    allDestructive;

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'bug';
    signature = 'hostless_release_exhausts_retries';
    details = `The exact base broker sent ${releaseBodies.length} non-delete release requests for an already-gone worker; Relaycast rejected the hostless dispatch and DELETE /api/spawned returned 500 with Max retries exceeded.`;
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'hostless_identity_release_succeeds';
    details = `The exact head broker sent delete_agent=true for the already-gone worker; Relaycast completed the identity release locally and DELETE /api/spawned returned 200 success.`;
  } else {
    throw new Error(
      `Unexpected hostless release observation: ${JSON.stringify({
        arm,
        httpStatus: response.status,
        responseBody,
        releaseBodies,
        brokerStderr,
      })}`
    );
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
  process.stdout.write(`${signature}\n`);
} finally {
  if (broker && broker.exitCode === null) {
    broker.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => broker.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (broker.exitCode === null) broker.kill('SIGKILL');
  }
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => relaycast.close(resolve));
  await rm(probeDir, { recursive: true, force: true });
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

async function waitFor(probe, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}: ${brokerStderr}`
  );
}

async function reservePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected broker TCP address.');
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
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
