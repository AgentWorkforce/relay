import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1665-immutable-fleet-snapshot';
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const CLI_TIMEOUT_MS = 60_000;
const SNAPSHOT_ID = 'snap_immutable_candidate_1665';
const MANIFEST_SHA256 = 'a'.repeat(64);
const WRONG_MANIFEST_SHA256 = 'b'.repeat(64);
const RELAY_WORKSPACE_ID = 'rw_proof01';
const CLOUD_WORKSPACE_ID = '50587328-441d-4acb-b8f3-dbe1b3c5de99';
const EXACT_NODE_NAME = 'snapshot-match-node';
const MISMATCH_NODE_NAME = 'snapshot-mismatch-node';
const EXACT_SANDBOX_ID = 'sandbox-snapshot-match';
const MISMATCH_SANDBOX_ID = 'sandbox-snapshot-mismatch';
const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
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

const probeDir = await mkdtemp(path.join(tmpdir(), 'relayflow-1665-'));
const serverPath = path.join(probeDir, 'fake-fleet-control-plane.mjs');
const statePath = path.join(probeDir, 'requests.json');
const cliHome = path.join(probeDir, 'home');
const serverSource = String.raw`import fs from 'node:fs';
import http from 'node:http';

const [statePath, snapshotId, manifestSha256, wrongManifestSha256] = process.argv.slice(2);
if (!statePath || !snapshotId || !manifestSha256 || !wrongManifestSha256) {
  throw new Error('fake Fleet control plane requires state and snapshot arguments');
}

const RELAY_WORKSPACE_ID = ${JSON.stringify(RELAY_WORKSPACE_ID)};
const CLOUD_WORKSPACE_ID = ${JSON.stringify(CLOUD_WORKSPACE_ID)};
const EXACT_NODE_NAME = ${JSON.stringify(EXACT_NODE_NAME)};
const MISMATCH_NODE_NAME = ${JSON.stringify(MISMATCH_NODE_NAME)};
const EXACT_SANDBOX_ID = ${JSON.stringify(EXACT_SANDBOX_ID)};
const MISMATCH_SANDBOX_ID = ${JSON.stringify(MISMATCH_SANDBOX_ID)};
const WORKSPACE_KEY = 'rk_relayflow_1665_workspace';
const AGENT_TOKEN = 'at_relayflow_1665_agent';
const CLOUD_TOKEN = 'cloud_relayflow_1665_access';
const state = { requests: [] };

function persist() {
  fs.writeFileSync(statePath, JSON.stringify(state));
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function sendRelay(response, data) {
  sendJson(response, 200, { ok: true, data });
}

function reject(response, status, message, relay = false) {
  sendJson(
    response,
    status,
    relay ? { ok: false, error: { code: 'not_found', message } } : { error: message }
  );
}

function bearer(request) {
  return request.headers.authorization ?? '';
}

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let body = null;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        reject(response, 400, 'invalid JSON');
        return;
      }
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const entry = { method: request.method, path: url.pathname, body };
    state.requests.push(entry);
    persist();

    if (request.method === 'GET' && url.pathname === '/v1/workspace') {
      if (bearer(request) !== 'Bearer ' + WORKSPACE_KEY) {
        reject(response, 401, 'wrong workspace credential', true);
        return;
      }
      sendRelay(response, { id: RELAY_WORKSPACE_ID, name: 'relayflow-1665' });
      return;
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/api/v1/workspaces/' + RELAY_WORKSPACE_ID + '/resolve'
    ) {
      if (bearer(request) !== 'Bearer ' + CLOUD_TOKEN) {
        reject(response, 401, 'wrong Cloud credential');
        return;
      }
      sendJson(response, 200, { cloudWorkspaceId: CLOUD_WORKSPACE_ID });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/fleet/nodes/sandbox/ensure') {
      if (bearer(request) !== 'Bearer ' + CLOUD_TOKEN) {
        reject(response, 401, 'wrong Cloud credential');
        return;
      }
      const mismatch = body?.name === MISMATCH_NODE_NAME;
      const nodeName = mismatch ? MISMATCH_NODE_NAME : EXACT_NODE_NAME;
      const sandboxId = mismatch ? MISMATCH_SANDBOX_ID : EXACT_SANDBOX_ID;
      sendJson(response, 201, {
        outcome: 'provisioned',
        nodeId: 'node-snapshot-proof',
        nodeName,
        sandboxId,
        relayWorkspaceId: RELAY_WORKSPACE_ID,
        relayfileMounted: true,
        relayfileMountPath: '/workspace',
        providerId: 'daytona',
        snapshotId,
        snapshotManifestSha256: mismatch ? wrongManifestSha256 : manifestSha256,
      });
      return;
    }

    if (
      request.method === 'DELETE' &&
      url.pathname === '/api/v1/fleet/nodes/sandbox/' + MISMATCH_SANDBOX_ID
    ) {
      if (bearer(request) !== 'Bearer ' + CLOUD_TOKEN) {
        reject(response, 401, 'wrong Cloud credential');
        return;
      }
      sendJson(response, 200, { sandboxId: MISMATCH_SANDBOX_ID, providerId: 'daytona', deleted: true });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/nodes/' + EXACT_NODE_NAME) {
      if (bearer(request) !== 'Bearer ' + AGENT_TOKEN) {
        reject(response, 401, 'wrong agent credential', true);
        return;
      }
      sendRelay(response, {
        id: 'node-snapshot-proof',
        node_id: 'node-snapshot-proof',
        name: EXACT_NODE_NAME,
        status: 'online',
        live: true,
        handlers_live: true,
        capabilities: [{ name: 'spawn:codex', kind: 'spawn' }],
        max_agents: 1,
        active_agents: 0,
        tags: ['cloud:node-type:daytona-jit'],
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/actions/spawn/invoke') {
      if (bearer(request) !== 'Bearer ' + AGENT_TOKEN) {
        reject(response, 401, 'wrong agent credential', true);
        return;
      }
      sendRelay(response, {
        invocation_id: 'inv_snapshot_proof',
        action_name: 'spawn',
        dispatched_node_id: 'node-snapshot-proof',
        status: 'invoked',
        input: body?.input ?? {},
      });
      return;
    }

    reject(response, 404, 'unexpected proof endpoint ' + request.method + ' ' + url.pathname, url.pathname.startsWith('/v1/'));
  });
});

persist();
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address.');
  process.stdout.write(JSON.stringify({ port: address.port }) + '\n');
});

process.once('SIGTERM', () => server.close(() => process.exit(0)));
`;

let server;
try {
  await mkdir(cliHome, { recursive: true, mode: 0o700 });
  await writeFile(serverPath, serverSource, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await writeFile(statePath, `${JSON.stringify({ requests: [] })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });

  run('npm', ['ci', '--ignore-scripts'], targetDir, 'workspace dependency installation', buildEnvironment());
  run('npm', ['run', 'build:core'], targetDir, 'production CLI build', buildEnvironment());

  server = spawn(
    process.execPath,
    [serverPath, statePath, SNAPSHOT_ID, MANIFEST_SHA256, WRONG_MANIFEST_SHA256],
    {
      cwd: probeDir,
      env: buildEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const { port, getStderr } = await waitForServerReady(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const cliPath = path.join(targetDir, 'packages/cli/dist/cli/index.js');
  const commonArgs = [
    cliPath,
    'fleet',
    'spawn',
    'codex',
    '--sandbox',
    '--sandbox-provider',
    'daytona',
    '--sandbox-snapshot',
    SNAPSHOT_ID,
    '--sandbox-snapshot-manifest-sha256',
    MANIFEST_SHA256,
    '--task',
    'Prove immutable Fleet candidate binding',
    '--workspace-key',
    'rk_relayflow_1665_workspace',
    '--token',
    'at_relayflow_1665_agent',
    '--base-url',
    baseUrl,
    '--no-confirm',
  ];
  const cliEnv = {
    ...buildEnvironment(),
    HOME: cliHome,
    AGENT_RELAY_HOME: path.join(cliHome, '.agent-relay'),
    AGENT_RELAY_DATA_DIR: path.join(cliHome, '.agent-relay-data'),
    AGENT_RELAY_SKIP_UPDATE_CHECK: '1',
    AGENT_RELAY_TELEMETRY_DISABLED: '1',
    DO_NOT_TRACK: '1',
    CLOUD_API_URL: baseUrl,
    CLOUD_API_ACCESS_TOKEN: 'cloud_relayflow_1665_access',
    CLOUD_API_REFRESH_TOKEN: 'cloud_relayflow_1665_refresh',
    CLOUD_API_ACCESS_TOKEN_EXPIRES_AT: '2099-01-01T00:00:00.000Z',
    CLOUD_API_REFRESH_TOKEN_EXPIRES_AT: '2099-01-02T00:00:00.000Z',
  };

  const matching = invokeCli(
    [...commonArgs, '--name', 'snapshot-match-worker', '--sandbox-name', EXACT_NODE_NAME],
    targetDir,
    cliEnv
  );

  if (arm === 'base') {
    const state = await readState(statePath);
    const baseObserved =
      matching.status !== 0 &&
      matching.stderr.includes('unknown option') &&
      matching.stderr.includes('--sandbox-snapshot') &&
      state.requests.length === 0;
    if (!baseObserved) {
      throw new Error(
        `Unexpected base CLI observation: ${JSON.stringify({
          status: matching.status,
          signal: matching.signal,
          stdout: matching.stdout.slice(-2_000),
          stderr: matching.stderr.slice(-2_000),
          requests: state.requests,
          serverStderr: getStderr().slice(-2_000),
        })}.`
      );
    }
    await writeObservation(
      'absent',
      'immutable_fleet_snapshot_selector_absent',
      'The exact base production CLI rejected --sandbox-snapshot as an unknown option before contacting either Relaycast or Cloud.'
    );
  } else {
    const mismatching = invokeCli(
      [...commonArgs, '--name', 'snapshot-mismatch-worker', '--sandbox-name', MISMATCH_NODE_NAME],
      targetDir,
      cliEnv
    );
    const state = await readState(statePath);
    const successfulOutput = matching.status === 0 ? parseCliJson(matching.stdout, 'matching spawn') : null;
    const exactEnsure = state.requests.find(
      (request) =>
        request.method === 'POST' &&
        request.path === '/api/v1/fleet/nodes/sandbox/ensure' &&
        request.body?.name === EXACT_NODE_NAME
    );
    const mismatchEnsure = state.requests.find(
      (request) =>
        request.method === 'POST' &&
        request.path === '/api/v1/fleet/nodes/sandbox/ensure' &&
        request.body?.name === MISMATCH_NODE_NAME
    );
    const spawnInvoke = state.requests.find(
      (request) => request.method === 'POST' && request.path === '/v1/actions/spawn/invoke'
    );
    const mismatchCleanup = state.requests.find(
      (request) =>
        request.method === 'DELETE' && request.path === `/api/v1/fleet/nodes/sandbox/${MISMATCH_SANDBOX_ID}`
    );
    const ensureBound = (request) =>
      request?.body?.workspaceId === CLOUD_WORKSPACE_ID &&
      request.body.requiredCapability === 'spawn:codex' &&
      request.body.maxAgents === 1 &&
      request.body.mountRelayfile === true &&
      request.body.providerId === 'daytona' &&
      request.body.snapshotId === SNAPSHOT_ID &&
      request.body.snapshotManifestSha256 === MANIFEST_SHA256 &&
      request.body.forceProvision === true &&
      request.body.waitTimeoutMs === 90_000;
    const requestSequence = state.requests.map((request) => `${request.method} ${request.path}`);
    const expectedRequestSequence = [
      'GET /v1/workspace',
      `GET /api/v1/workspaces/${RELAY_WORKSPACE_ID}/resolve`,
      'POST /api/v1/fleet/nodes/sandbox/ensure',
      `GET /v1/nodes/${EXACT_NODE_NAME}`,
      'POST /v1/actions/spawn/invoke',
      'GET /v1/workspace',
      `GET /api/v1/workspaces/${RELAY_WORKSPACE_ID}/resolve`,
      'POST /api/v1/fleet/nodes/sandbox/ensure',
      `DELETE /api/v1/fleet/nodes/sandbox/${MISMATCH_SANDBOX_ID}`,
    ];
    const headObserved =
      matching.status === 0 &&
      successfulOutput?.sandbox?.providerId === 'daytona' &&
      successfulOutput?.sandbox?.snapshotId === SNAPSHOT_ID &&
      successfulOutput?.sandbox?.snapshotManifestSha256 === MANIFEST_SHA256 &&
      successfulOutput?.invocation?.invocationId === 'inv_snapshot_proof' &&
      ensureBound(exactEnsure) &&
      ensureBound(mismatchEnsure) &&
      spawnInvoke?.body?.input?.node === EXACT_NODE_NAME &&
      spawnInvoke?.body?.input?.target_node === EXACT_NODE_NAME &&
      spawnInvoke?.body?.input?.worker_cwd === '/workspace' &&
      state.requests.filter(
        (request) => request.method === 'POST' && request.path === '/v1/actions/spawn/invoke'
      ).length === 1 &&
      mismatching.status !== 0 &&
      mismatching.stderr.includes(
        'Cloud did not prove the requested immutable snapshot and manifest digest.'
      ) &&
      mismatchCleanup?.body?.workspaceId === CLOUD_WORKSPACE_ID &&
      mismatchCleanup?.body?.providerId === 'daytona' &&
      JSON.stringify(requestSequence) === JSON.stringify(expectedRequestSequence);
    if (!headObserved) {
      throw new Error(
        `Unexpected head CLI observation: ${JSON.stringify({
          matching: {
            status: matching.status,
            signal: matching.signal,
            stdout: matching.stdout.slice(-2_000),
            stderr: matching.stderr.slice(-2_000),
          },
          mismatching: {
            status: mismatching.status,
            signal: mismatching.signal,
            stdout: mismatching.stdout.slice(-2_000),
            stderr: mismatching.stderr.slice(-2_000),
          },
          requests: state.requests,
          serverStderr: getStderr().slice(-2_000),
        })}.`
      );
    }
    await writeObservation(
      'fixed',
      'immutable_fleet_snapshot_bound_and_fail_closed',
      'The exact head production CLI forwarded the Daytona snapshot and manifest digest, exposed the attested pair in successful spawn output, refused a mismatched Cloud attestation before dispatch, and deleted the rejected sandbox.'
    );
  }
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

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function buildEnvironment() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'CI']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function run(command, args, cwd, label, env) {
  const completed = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (completed.error) throw new Error(`${label} could not start: ${completed.error.message}`);
  if (completed.status !== 0) {
    throw new Error(
      `${label} failed with ${
        completed.signal ? `signal ${completed.signal}` : `exit code ${completed.status ?? 'unknown'}`
      }: ${`${completed.stdout ?? ''}${completed.stderr ?? ''}`.slice(-4_000)}`
    );
  }
  return completed;
}

function invokeCli(args, cwd, env) {
  const completed = spawnSync(process.execPath, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
  });
  if (completed.error) {
    throw new Error(`production Fleet CLI could not complete: ${completed.error.message}`);
  }
  return {
    status: completed.status,
    signal: completed.signal,
    stdout: completed.stdout ?? '',
    stderr: completed.stderr ?? '',
  };
}

function waitForServerReady(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('fake Fleet control plane did not start')), 10_000);
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
        resolve({ port: ready.port, getStderr: () => stderr });
      } catch (error) {
        reject(new Error(`fake Fleet control plane emitted invalid readiness: ${error.message}`));
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `fake Fleet control plane exited before readiness (${signal ?? code ?? 'unknown'}): ${stderr}`
        )
      );
    });
  });
}

async function readState(file) {
  const state = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(state?.requests)) throw new Error('fake Fleet control plane state is invalid');
  return state;
}

function parseCliJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} emitted invalid JSON: ${error.message}; output=${value.slice(-2_000)}`);
  }
}

async function writeObservation(outcome, signature, details) {
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' }
  );
}
