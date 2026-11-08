/**
 * A broker's node-control websocket can be connected before the Cloud REST
 * lookup used by `--node <name>` can resolve its advertised name. The base CLI
 * reports that local name without qualification. The fixed CLI checks the
 * same name-addressability endpoint as attach and labels a 404 as LOCAL-ONLY.
 *
 * This proof builds the exact target checkout, runs its public `node status`
 * command, and supplies a small HTTP peer that behaves as both the local
 * broker API and Cloud: local status is connected as `chief-sfm-final`, while
 * `GET /v1/nodes/chief-sfm-final` returns the production `node_not_found` 404.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = 'node-status-cloud-registration';
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
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

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), `relayflow-${CASE_ID}-`));
const cloudRequests = [];
const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.method === 'GET' && request.url === '/api/status') {
    response.end(
      JSON.stringify({
        agent_count: 20,
        node_connected: true,
        node_delivery: { token_present: true, connected: true },
      })
    );
    return;
  }
  if (request.method === 'GET' && request.url === '/api/session') {
    response.end(
      JSON.stringify({
        broker_version: '11.10.2',
        protocol_version: 1,
        workspace_key: 'rk_live_relayflowproof1234',
        relay_base_url: serverBaseUrl,
        node_id: 'node_local',
        node_name: 'chief-sfm-final',
        mode: 'broker',
        uptime_secs: 60,
      })
    );
    return;
  }
  if (
    (request.method === 'GET' && request.url === '/v1/nodes/chief-sfm-final') ||
    (request.method === 'POST' && request.url === '/v1/nodes/chief-sfm-final/terminal/sessions')
  ) {
    cloudRequests.push(`${request.method} ${request.url}`);
    response.statusCode = 404;
    response.end(JSON.stringify({ ok: false, error: { code: 'node_not_found', message: 'Node not found' } }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ ok: false, error: { code: 'not_found' } }));
});

let serverBaseUrl;
try {
  runSync('npm', ['ci', '--ignore-scripts'], targetDir, 'workspace dependency installation');
  for (const step of [
    'build:session',
    'build:config',
    'build:cloud',
    'build:utils',
    'build:policy',
    'build:sdk',
    'build:harness-driver',
    'build:harnesses',
    'build:integration-prompts',
    'build:evals',
    'build:fleet',
    'build:cli',
  ]) {
    runSync('npm', ['run', step], targetDir, `${step} build`);
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Proof server did not bind a TCP port.');
  serverBaseUrl = `http://127.0.0.1:${address.port}`;

  const stateDir = path.join(temporaryRoot, 'state');
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, 'connection.json'),
    `${JSON.stringify({
      url: serverBaseUrl,
      port: address.port,
      api_key: 'br_relayflow',
      pid: process.pid,
      workspace_source: 'project',
    })}\n`,
    'utf8'
  );

  const cliEntry = path.join(targetDir, 'packages/cli/dist/cli/index.js');
  const command = await runAsync(
    process.execPath,
    [cliEntry, 'node', 'status', '--state-dir', stateDir],
    targetDir,
    'public node status probe',
    {
      AGENT_RELAY_HOME: path.join(temporaryRoot, 'home'),
      RELAY_SKIP_TELEMETRY: '1',
    }
  );
  const output = `${command.stdout}${command.stderr}`;
  const attach = await runAsync(
    process.execPath,
    [
      cliEntry,
      'node',
      'agent',
      'attach',
      'relayflow-agent',
      '--node',
      'chief-sfm-final',
      '--mode',
      'view',
      '--workspace-key',
      'rk_live_relayflowproof1234',
    ],
    targetDir,
    'public attach --node probe',
    {
      AGENT_RELAY_HOME: path.join(temporaryRoot, 'home'),
      RELAY_SKIP_TELEMETRY: '1',
      RELAY_BASE_URL: serverBaseUrl,
    },
    [1]
  );
  const attachOutput = `${attach.stdout}${attach.stderr}`;
  const baseObserved =
    output.includes('Node delivery: CONNECTED') &&
    output.includes('Node: chief-sfm-final (node_local)') &&
    !output.includes('LOCAL-ONLY') &&
    attachOutput.includes('Control-plane node lookup found no matching record') &&
    !attachOutput.includes('--ssh-host <host> --state-dir <path>') &&
    sameRequests(cloudRequests, ['POST /v1/nodes/chief-sfm-final/terminal/sessions']);
  const headObserved =
    output.includes('Node delivery: CONNECTED') &&
    output.includes('Node: chief-sfm-final (node_local; LOCAL-ONLY, not Cloud-registered)') &&
    output.includes('--ssh-host <host> --state-dir <path>') &&
    attachOutput.includes('Control-plane node lookup found no matching record') &&
    attachOutput.includes('--ssh-host <host> --state-dir <path>') &&
    sameRequests(cloudRequests, [
      'GET /v1/nodes/chief-sfm-final',
      'POST /v1/nodes/chief-sfm-final/terminal/sessions',
    ]);

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'bug';
    signature = 'node_status_advertises_unreachable_cloud_name';
    details =
      'The exact-base public CLI advertised chief-sfm-final without checking Cloud, and attach --node returned node_not_found without the SSH/state-dir fallback.';
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'node_status_labels_unreachable_name_local_only';
    details =
      'The exact-head public CLI labeled the Cloud-missing name LOCAL-ONLY, and attach --node returned node_not_found with the SSH/state-dir fallback.';
  } else {
    throw new Error(
      `Unexpected observation (Cloud requests: ${JSON.stringify(cloudRequests)}): ` +
        `status=${output.slice(-1_000)} attach=${attachOutput.slice(-1_000)}`
    );
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
  process.stdout.write(`${output.trim()}\n${attachOutput.trim()}\n${signature}\n`);
} finally {
  await new Promise((resolve) => server.close(() => resolve()));
  await rm(temporaryRoot, { recursive: true, force: true });
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

function runSync(command, args, cwd, label) {
  const completed = execFileSync(command, args, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: COMMAND_TIMEOUT_MS,
  });
  return completed;
}

function runAsync(command, args, cwd, label, extraEnv = {}, expectedExitCodes = [0]) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${label} timed out after ${COMMAND_TIMEOUT_MS}ms.`));
    }, COMMAND_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`${label} could not start: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (!expectedExitCodes.includes(code)) {
        reject(
          new Error(
            `${label} failed with ${signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`}: ` +
              `${stderr || stdout}`.slice(-2_000)
          )
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function sameRequests(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}
