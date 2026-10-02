#!/usr/bin/env node

/**
 * Red/green proof for relay#1446 / relay#1822 / relay#1575: `node agent`
 * subcommands must reach a broker started with `--state-dir` from an unrelated
 * working directory.
 *
 * Each exact target checkout is built, and its real `agent-relay` binary is run
 * from an unrelated directory against a loopback fixture broker whose
 * connection.json lives in a fleet-node style `<node>/state/` directory. A
 * decoy broker named by RELAY_BROKER_URL must never be contacted when
 * --state-dir is explicit.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1446-state-dir-broker-selection';
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
const resultPath = path.resolve(requiredValue('RELAY_PR_PROOF_RESULT_PATH'));
const arm = requiredValue('RELAY_PR_PROOF_ARM');
if (arm !== 'base' && arm !== 'head') {
  throw new Error(`RELAY_PR_PROOF_ARM must be base or head, received ${JSON.stringify(arm)}.`);
}

const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
if (!expectedSha) throw new Error(`Missing expected ${arm} SHA.`);
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
  timeout: COMMAND_TIMEOUT_MS,
}).trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
}

const runnerPath = fileURLToPath(import.meta.url);
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

const cliEntry = path.join(targetDir, 'packages/cli/dist/cli/index.js');

run('npm', ['ci', '--ignore-scripts'], targetDir, 'workspace dependency installation');
run('npm', ['run', 'build:core'], targetDir, 'workspace package build');

const requests = [];
const broker = await startBroker('node', requests);
const decoy = await startBroker('decoy', requests);
const root = await mkdtemp(path.join(os.tmpdir(), 'relayflow-1446-'));
try {
  const nodeDir = path.join(root, 'sf-mini-node');
  const stateDir = path.join(nodeDir, 'state');
  const unrelatedCwd = path.join(root, 'elsewhere');
  const home = path.join(root, 'home');
  await mkdir(stateDir, { recursive: true });
  await mkdir(path.join(unrelatedCwd, '.git'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(
    path.join(stateDir, 'connection.json'),
    JSON.stringify({
      url: `http://127.0.0.1:${broker.address().port}`,
      api_key: 'proof-node-key',
      pid: process.pid,
    })
  );
  // The real CLI binary, from an unrelated checkout, with ambient env naming a decoy broker.
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    AGENT_RELAY_TELEMETRY_DISABLED: '1',
    DO_NOT_TRACK: '1',
    RELAY_BROKER_URL: `http://127.0.0.1:${decoy.address().port}`,
    RELAY_BROKER_API_KEY: 'decoy-key',
  };
  const list = await runCli(['node', 'agent', 'list', '--state-dir', stateDir], unrelatedCwd, env);
  const release = await runCli(
    ['node', 'agent', 'release', 'worker', '--state-dir', nodeDir],
    unrelatedCwd,
    env
  );
  const observation = { list, release, requests };
  console.log('State-dir broker selection observation:', JSON.stringify(observation));

  const rejected = (result) => result.code !== 0 && /unknown option '--state-dir'/.test(result.stderr);
  const baseObserved = rejected(list) && rejected(release) && requests.length === 0;
  const nodeRequests = requests.filter((request) => request.broker === 'node');
  const headObserved =
    list.code === 0 &&
    release.code === 0 &&
    list.stdout.includes('"worker"') &&
    release.stdout.includes('Released worker.') &&
    requests.every((request) => request.broker === 'node' && request.apiKey === 'proof-node-key') &&
    nodeRequests.some((request) => request.method === 'GET' && request.url === '/api/spawned') &&
    nodeRequests.some((request) => request.method === 'DELETE' && request.url === '/api/spawned/worker');

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'bug';
    signature = 'node_agent_state_dir_rejected';
    details =
      "The exact base agent-relay binary rejects --state-dir on node agent list and release with unknown option '--state-dir', so a broker started with --state-dir cannot be managed from another directory.";
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'node_agent_state_dir_targets_broker';
    details =
      'The exact head agent-relay binary lists and releases through the broker named by --state-dir (both the state dir and its fleet node parent) from an unrelated cwd, authenticating with that broker key and never contacting the RELAY_BROKER_URL decoy.';
  } else {
    throw new Error(`Unexpected state-dir broker selection observation: ${JSON.stringify(observation)}.`);
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details }, null, 2)}\n`,
    'utf8'
  );
} finally {
  broker.close();
  decoy.close();
  await rm(root, { recursive: true, force: true });
}

/** Loopback fixture broker answering the two endpoints list and release use. */
function startBroker(label, log) {
  const server = http.createServer((req, res) => {
    log.push({ broker: label, method: req.method, url: req.url, apiKey: req.headers['x-api-key'] ?? null });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/spawned') {
      res.end(JSON.stringify({ agents: [{ name: 'worker' }] }));
      return;
    }
    if (req.method === 'DELETE' && req.url === '/api/spawned/worker') {
      res.end(JSON.stringify({ name: 'worker' }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Run the built CLI asynchronously so the in-process fixture brokers can answer it. */
function runCli(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), COMMAND_TIMEOUT_MS);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) });
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

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function run(command, args, cwd, label, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${label} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${label} exited ${result.status ?? 'null'}:\n${(result.stdout ?? '').slice(-2000)}\n${(result.stderr ?? '').slice(-2000)}`
    );
  }
}
