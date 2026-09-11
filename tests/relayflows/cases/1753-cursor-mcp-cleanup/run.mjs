import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1753-cursor-mcp-cleanup';
const targetDir = requiredValue('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredValue('RELAY_PR_PROOF_HARNESS_DIR');
const binaryPath = requiredExecutable('RELAY_PR_PROOF_BROKER_BINARY');
const resultPath = requiredValue('RELAY_PR_PROOF_RESULT_PATH');
const arm = requiredValue('RELAY_PR_PROOF_ARM');

if (arm !== 'base' && arm !== 'head') {
  throw new Error(`RELAY_PR_PROOF_ARM must be base or head, received ${JSON.stringify(arm)}.`);
}

const expectedSha = arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
if (!expectedSha) throw new Error(`Missing expected ${arm} SHA.`);
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
}

const runnerPath = fileURLToPath(import.meta.url);
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

const workDir = await mkdtemp(path.join(tmpdir(), 'relayflow-1753-'));
const stateDir = path.join(workDir, 'state');
const logsDir = path.join(workDir, 'logs');
const cwd = path.join(workDir, 'cwd');
await mkdir(stateDir, { recursive: true });
await mkdir(logsDir, { recursive: true });
await mkdir(path.join(cwd, '.cursor'), { recursive: true });

const original = Buffer.from('{"mcpServers":{"filesystem":{}}}\n', 'utf8');
const cursorPath = path.join(cwd, '.cursor', 'mcp.json');
await writeFile(cursorPath, original);

const relaycast = await startRelaycastStub();
const brokerEnv = {
  PATH: process.env.PATH,
  HOME: workDir,
  TMPDIR: workDir,
  NO_COLOR: '1',
  RELAY_BASE_URL: relaycast.baseUrl,
  RELAYCAST_BASE_URL: relaycast.baseUrl,
  RELAY_API_KEY: relaycast.workspaceKey,
  RELAY_WORKSPACE_KEY: relaycast.workspaceKey,
  RELAY_NODE_TOKEN: relaycast.nodeToken,
  RELAY_NODE_ID: relaycast.nodeId,
  RELAY_BROKER_API_KEY: 'rk_proof_broker_api_key',
  RELAY_SKIP_TELEMETRY: '1',
  RUST_LOG: 'info',
};

let broker;
let brokerUrl;
try {
  broker = spawn(binaryPath, ['init', '--api-port', '0', '--api-bind', '127.0.0.1', '--state-dir', stateDir], {
    cwd: workDir,
    env: brokerEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const connectionPath = path.join(stateDir, 'connection.json');
  brokerUrl = await waitFor(async () => {
    if (broker.exitCode !== null) throw new Error(`broker exited early with code ${broker.exitCode}`);
    const connection = JSON.parse(await readFile(connectionPath, 'utf8'));
    return connection.url;
  }, 30_000, 'broker connection');

  const api = brokerClient(brokerUrl);
  await waitFor(() => api('GET', '/api/status').then(() => true), 10_000, 'broker api');

  const workerName = 'cursor-cleanup-worker';
  const spawnResponse = await api('POST', '/api/spawn', {
    name: workerName,
    cli: 'cursor',
    transport: 'pty',
    cwd,
    task: 'exercise Cursor MCP state cleanup',
    args: [],
  });
  if (spawnResponse.status >= 300) {
    throw new Error(`spawn failed: ${JSON.stringify(spawnResponse.body).slice(0, 500)}`);
  }

  const generated = await waitFor(async () => {
    const contents = await readFile(cursorPath, 'utf8').catch(() => null);
    if (!contents) return null;
    return contents.includes('${env:RELAY_API_KEY}') ? contents : null;
  }, 20_000, 'Cursor MCP file to be generated');

  const beforeCrash = generated;
  process.kill(broker.pid, 'SIGKILL');
  await waitFor(
    async () => {
      if (broker.exitCode === null) return null;
      return true;
    },
    10_000,
    'broker crash'
  );

  broker = spawn(binaryPath, ['init', '--api-port', '0', '--api-bind', '127.0.0.1', '--state-dir', stateDir], {
    cwd: workDir,
    env: brokerEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  brokerUrl = await waitFor(async () => {
    if (broker.exitCode !== null) throw new Error(`broker restarted but exited with code ${broker.exitCode}`);
    const connection = JSON.parse(await readFile(connectionPath, 'utf8'));
    return connection.url;
  }, 30_000, 'broker restart');

  const restartedApi = brokerClient(brokerUrl);
  await waitFor(() => restartedApi('GET', '/api/status').then(() => true), 10_000, 'restarted broker api');

  const releaseResponse = await restartedApi('DELETE', `/api/spawned/${workerName}`);
  if (releaseResponse.status >= 300) {
    throw new Error(`release failed: ${JSON.stringify(releaseResponse.body).slice(0, 500)}`);
  }

  const afterRelease = await readFile(cursorPath, 'utf8').catch(() => null);
  const journalPath = path.join(logsDir, '.cursor-mcp-leases.json');
  const journalAfter = await readFile(journalPath, 'utf8').catch(() => null);

  let outcome;
  let signature;
  let details;
  if (afterRelease === beforeCrash && journalAfter) {
    outcome = 'bug';
    signature = 'cursor_mcp_state_leaks_or_survives_crash';
    details = 'The base broker left the generated Cursor MCP file in place after a crash/restart/release cycle and retained cleanup state instead of restoring the original file or removing the lease record.';
  } else if (afterRelease === original.toString('utf8') && !journalAfter) {
    outcome = 'fixed';
    signature = 'cursor_mcp_state_restores_or_removes_cleanly';
    details = 'The head broker restored the original Cursor MCP file on release after restart and removed the retained lease state.';
  } else {
    throw new Error(
      `Unexpected Cursor MCP cleanup observation: ${JSON.stringify({ beforeCrash, afterRelease, journalAfter })}`
    );
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`);
} finally {
  if (broker?.pid) {
    try {
      process.kill(broker.pid, 'SIGKILL');
    } catch {}
  }
  await relaycast?.close().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function requiredExecutable(name) {
  const value = requiredValue(name);
  execFileSync(value, ['--version'], { stdio: 'ignore' });
  return value;
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function brokerClient(baseUrl) {
  return async (method, url, body) => {
    const response = await fetch(new URL(url, baseUrl), {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
    };
  };
}

async function startRelaycastStub() {
  const workspaceKey = 'rk_live_relayflow_1753';
  const nodeToken = 'at_live_relayflow_1753';
  const nodeId = 'node_relayflow_1753';
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const body = bodyText ? JSON.parse(bodyText) : {};
    let payload;
    if (request.method === 'POST' && request.url === '/v1/workspaces') {
      payload = { ok: true, data: { api_key: workspaceKey, id: 'rw_relayflow_1753' } };
    } else if (request.method === 'POST' && request.url === '/v1/nodes') {
      payload = {
        ok: true,
        data: { token: nodeToken, id: nodeId, name: body.name ?? 'node_relayflow_1753' },
      };
    } else if (request.method === 'GET' && request.url === '/api/status') {
      payload = { ok: true, data: { status: 'ok' } };
    } else {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: request.url } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('relaycast stub failed to bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    workspaceKey,
    nodeToken,
    nodeId,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
