/**
 * relay#1671 — a remote fleet release could surface only "Internal server
 * error" and leave a harness descendant behind after the wrapper exited.
 *
 * The PR-proof runner executes once in each of two fresh Daytona sandboxes:
 * one exact base checkout and one exact head checkout. It executes the sealed
 * broker artifact from that checkout and validates the target's release
 * contract. No production credentials, shared broker, or mutable external
 * roster are involved.
 *
 * This is a two-arm cleanroom lane with a controlled local Relaycast-compatible
 * HTTP engine. It drives the public broker spawn/release API against the exact
 * verified artifact, then checks both the process and engine roster. The live
 * two-node invocation remains covered by the public fleet E2E and Cloud/Finn.
 */
import { execFileSync, spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1671-fleet-release-absence';
const ENGINE_ACTION_DEADLINE_MS = 30_000;
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

const targetName = `release-proof-${arm}`;
const stateDir = path.join(path.dirname(resultPath), `${CASE_ID}-${arm}-state`);
const descendantFile = path.join(stateDir, 'descendant.pid');
const proofEngine = await startProofEngine(targetName);
let broker;
try {
  await mkdir(stateDir, { recursive: true });
  broker = spawn(
    binaryPath,
    [
      'init',
      '--instance-name',
      `proof-node-${arm}`,
      '--workspace-key',
      'rk_live_proof',
      '--api-port',
      '0',
      '--api-bind',
      '127.0.0.1',
      '--state-dir',
      stateDir,
    ],
    {
      cwd: targetDir,
      env: {
        ...process.env,
        HOME: stateDir,
        RELAYCAST_BASE_URL: proofEngine.baseUrl,
        RELAYCAST_WS_URL: proofEngine.baseUrl,
        RELAY_WORKSPACES_JSON: JSON.stringify([{ workspace_id: 'ws_proof', api_key: 'rk_live_proof' }]),
        RELAY_BROKER_API_KEY: 'br_proof',
        AGENT_RELAY_HANDSHAKE_ATTEMPTS: '1',
        AGENT_RELAY_HANDSHAKE_TIMEOUT_MS: '5000',
        RUST_LOG: 'error',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  broker.stderr?.on('data', () => {});
  await waitForLine(broker, '[agent-relay] API listening on ');
  const connection = await waitFor(
    async () => {
      try {
        return JSON.parse(await readFile(path.join(stateDir, 'connection.json'), 'utf8'));
      } catch {
        return null;
      }
    },
    { timeoutMs: 5_000, intervalMs: 50, label: 'artifact broker connection record' }
  );
  const apiBase = connection.url;
  const headers = { authorization: `Bearer ${connection.api_key}`, 'content-type': 'application/json' };

  const spawnResult = await waitFor(
    async () => {
      const result = await brokerRequest(apiBase, '/api/spawn', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: targetName,
          cli: '/bin/sh',
          transport: 'headless',
          agent_token: `at_live_${targetName}`,
          skip_relay_prompt: true,
          harnessConfig: {
            runtime: 'native',
            command: '/bin/sh',
            args: [
              '-c',
              `sh -c "trap '' TERM HUP; while :; do sleep 1; done" & echo $! > ${descendantFile}; wait`,
            ],
            sessionId: `proof-session-${arm}`,
          },
        }),
      });
      return result.status === 503 ? null : result;
    },
    { timeoutMs: 10_000, intervalMs: 100, label: 'artifact broker ready for spawn' }
  );
  if (spawnResult.status >= 300 || spawnResult.body.success === false) {
    throw new Error(`artifact spawn failed: ${JSON.stringify(spawnResult)}`);
  }
  const worker = await waitFor(
    async () => {
      const result = await brokerRequest(apiBase, '/api/spawned', { headers });
      const agents = Array.isArray(result.body.agents) ? result.body.agents : [];
      return agents.find((agent) => agent.name === targetName) ?? null;
    },
    { timeoutMs: 10_000, intervalMs: 100, label: 'artifact worker registered' }
  );
  const descendantPid = await waitFor(
    async () => {
      try {
        const pid = Number((await readFile(descendantFile, 'utf8')).trim());
        return Number.isInteger(pid) && pidAlive(pid) ? pid : null;
      } catch {
        return null;
      }
    },
    { timeoutMs: 5_000, intervalMs: 50, label: 'artifact release probe descendant' }
  );

  const releaseStarted = Date.now();
  const releaseResult = await brokerRequest(
    apiBase,
    `/api/spawned/${encodeURIComponent(targetName)}`,
    {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        reason: 'sealed relayflow release proof',
        generation: spawnResult.body.generation,
      }),
    },
    29_000
  );
  const releaseElapsedMs = Date.now() - releaseStarted;
  if (releaseElapsedMs >= ENGINE_ACTION_DEADLINE_MS) {
    throw new Error(
      `artifact release exceeded the ${ENGINE_ACTION_DEADLINE_MS}ms engine action deadline: ${releaseElapsedMs}ms`
    );
  }
  if (releaseResult.status >= 300 || releaseResult.body.success === false) {
    throw new Error(`artifact release failed: ${JSON.stringify(releaseResult)}`);
  }
  await waitFor(
    async () => {
      const result = await brokerRequest(apiBase, '/api/spawned', { headers });
      return (
        result.status < 300 &&
        result.body.success !== false &&
        Array.isArray(result.body.agents) &&
        !result.body.agents.some((agent) => agent.name === targetName)
      );
    },
    { timeoutMs: 10_000, intervalMs: 100, label: 'artifact broker roster absence' }
  );
  const engineRosterAbsent = !proofEngine.agents.has(targetName);
  const processAbsent = await waitFor(async () => !pidAlive(descendantPid), {
    timeoutMs: 5_000,
    intervalMs: 100,
    label: 'artifact descendant absence',
  }).catch(() => false);

  if (arm === 'base') {
    // The bug is the ghost process, not the roster mutation: base already
    // removes its broker/engine entry while leaving the descendant alive.
    if (processAbsent) {
      throw new Error(
        `base did not reproduce ghost release: ${JSON.stringify({ processAbsent, engineRosterAbsent, workerPid: worker.workerPid, descendantPid })}`
      );
    }
    await observe(
      'fleet_release_can_drop_cause_and_strand_descendants',
      'bug',
      `Exact base broker accepted public DELETE /api/spawned/${targetName} in ${releaseElapsedMs}ms and removed the broker/engine name, but descendant PID ${descendantPid} remained alive.`
    );
  } else {
    if (!processAbsent || !engineRosterAbsent) {
      throw new Error(
        `head did not prove release absence: ${JSON.stringify({ processAbsent, engineRosterAbsent, workerPid: worker.workerPid, descendantPid })}`
      );
    }
    await observe(
      'fleet_release_reports_cause_and_proves_absence',
      'fixed',
      `Exact head broker drove public DELETE /api/spawned/${targetName} in ${releaseElapsedMs}ms; broker roster, controlled Relaycast roster, and descendant PID ${descendantPid} were all absent.`
    );
  }

  if (arm === 'head') {
    // A retry after the terminal release must be a no-op success: it must not
    // recreate a roster entry or resurrect the process identity.
    const repeatedRelease = await brokerRequest(apiBase, `/api/spawned/${encodeURIComponent(targetName)}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        reason: 'sealed idempotency retry',
        generation: spawnResult.body.generation,
      }),
    });
    if (repeatedRelease.status >= 300 || repeatedRelease.body.success === false) {
      throw new Error(`idempotent release retry failed: ${JSON.stringify(repeatedRelease)}`);
    }
    if (proofEngine.agents.has(targetName) || pidAlive(descendantPid)) {
      throw new Error('idempotent release retry resurrected the released process or roster entry');
    }
  }
} finally {
  let probePid = null;
  try {
    const candidate = Number((await readFile(descendantFile, 'utf8')).trim());
    probePid = Number.isInteger(candidate) ? candidate : null;
  } catch {
    // Spawn may fail before the probe can publish its PID.
  }
  if (probePid && pidAlive(probePid)) {
    try {
      process.kill(probePid, 'SIGKILL');
    } catch {
      // The release path may already have reaped it.
    }
  }
  if (broker && !broker.killed) broker.kill('SIGKILL');
  await proofEngine.close();
  await rm(stateDir, { recursive: true, force: true });
}

async function startProofEngine(target) {
  const agents = new Map([
    [
      target,
      {
        id: `agent-${target}`,
        workspace_id: 'ws_proof',
        name: target,
        type: 'agent',
        token: `at_live_${target}`,
        status: 'online',
        persona: null,
        metadata: {},
        channels: [],
      },
    ],
  ]);
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body = {};
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    } catch {
      body = {};
    }
    const pathName = request.url?.split('?')[0] ?? '/';
    if (request.method === 'POST' && pathName === '/v1/agents') {
      const name = body.name ?? 'proof-agent';
      const agent = {
        id: `agent-${name}`,
        workspace_id: 'ws_proof',
        name,
        token: `at_live_${name}`,
        type: 'agent',
        status: 'online',
        persona: null,
        metadata: {},
        channels: [],
        created_at: new Date().toISOString(),
      };
      agents.set(name, agent);
      return sendJson(response, 200, { ok: true, data: agent });
    }
    if (request.method === 'GET' && pathName === '/v1/agent') {
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
      const agent = [...agents.values()].find((candidate) => candidate.token === token) ?? {
        id: 'agent-proof',
        workspace_id: 'ws_proof',
        name: target,
        token,
        status: 'online',
        created_at: new Date().toISOString(),
      };
      agents.set(agent.name, agent);
      return sendJson(response, 200, { ok: true, data: agent });
    }
    if (request.method === 'POST' && pathName === '/v1/agents/release') {
      agents.delete(body.name);
      return sendJson(response, 200, {
        ok: true,
        data: {
          invocation_id: 'proof-release',
          action_name: 'release',
          handler_agent_id: null,
          handler_node_id: null,
          dispatched_node_id: null,
          input: {},
          status: 'completed',
          created_at: new Date().toISOString(),
        },
      });
    }
    const agentPrefix = '/v1/agents/';
    if (
      request.method === 'GET' &&
      pathName.startsWith(agentPrefix) &&
      !pathName.slice(agentPrefix.length).includes('/')
    ) {
      const agent = agents.get(decodeURIComponent(pathName.slice(agentPrefix.length)));
      return agent
        ? sendJson(response, 200, { ok: true, data: agent })
        : sendJson(response, 404, {
            ok: false,
            error: { code: 'agent_not_found', message: 'agent not found' },
          });
    }
    if (pathName === '/v1/channels' || pathName.startsWith('/v1/channels/')) {
      return sendJson(response, 200, { ok: true, data: [] });
    }
    return sendJson(response, 200, { ok: true, data: {} });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    agents,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function brokerRequest(baseUrl, pathname, init = {}, timeoutMs = 5_000) {
  const requestUrl = new URL(pathname, baseUrl);
  if (
    requestUrl.protocol !== 'http:' ||
    requestUrl.hostname !== '127.0.0.1' ||
    !requestUrl.pathname.startsWith('/')
  ) {
    throw new Error(`proof broker URL must be loopback HTTP: ${requestUrl.origin}`);
  }
  const response = await fetch(requestUrl, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === 'object' && error.code === 'ESRCH');
  }
}

function waitForLine(child, prefix) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for broker line ${prefix}; output=${output}`)),
      20_000
    );
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
      const line = output.split(/\r?\n/).find((candidate) => candidate.includes(prefix));
      if (line) {
        clearTimeout(timer);
        resolve(line);
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (!output.includes(prefix)) {
        clearTimeout(timer);
        reject(
          new Error(`broker exited before API startup: code=${code} signal=${signal}; output=${output}`)
        );
      }
    });
  });
}

async function waitFor(fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${opts.label ?? 'condition'}`);
}

async function observe(signature, outcome, details) {
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
  process.stdout.write(`${signature}\n`);
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
  await access(candidate, fsConstants.R_OK | fsConstants.X_OK);
  return candidate;
}

function isWithin(directory, candidate) {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
