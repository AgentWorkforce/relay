#!/usr/bin/env node

/**
 * Red/green proof for relay#1446 / relay#1822 / relay#1575: `node agent`
 * subcommands must reach a broker started with `--state-dir` from an unrelated
 * working directory.
 *
 * The exact-head harness injects a Vitest probe into each exact target checkout.
 * The probe drives the production Commander registration and the real
 * HarnessDriverClient against a loopback fixture broker whose connection.json
 * lives in a fleet-node style `<node>/state/` directory. A decoy broker named by
 * RELAY_BROKER_URL must never be contacted when --state-dir is explicit.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

const probePath = path.join(targetDir, 'packages/cli/src/cli/.relayflow-1446-state-dir.test.ts');
const configPath = path.join(targetDir, '.relayflow-1446-state-dir.vitest.config.mjs');
const observationPath = path.join(targetDir, '.relayflow-1446-state-dir-observation.json');

const probeSource = String.raw`import fs from 'node:fs';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { test } from 'vitest';

import { registerLocalAgentCommands } from './commands/local-agent.js';

const observationPath = process.env.RELAY_PR1446_OBSERVATION_PATH;

function startBroker(label, requests) {
  const server = http.createServer((req, res) => {
    requests.push({ broker: label, method: req.method, url: req.url, apiKey: req.headers['x-api-key'] ?? null });
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
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function invoke(argv, cwd, env) {
  const logs = [];
  const errors = [];
  const program = new Command();
  program.exitOverride();
  registerLocalAgentCommands(program.command('node'), {
    cwd: () => cwd,
    env,
    log: (...args) => logs.push(args.join(' ')),
    error: (...args) => errors.push(args.join(' ')),
    exit: (code) => {
      throw new Error('cli exit ' + code);
    },
  });
  let error = null;
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return { logs, errors, error };
}

test('observe node agent --state-dir broker selection', async () => {
  const requests = [];
  const broker = await startBroker('node', requests);
  const decoy = await startBroker('decoy', requests);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relayflow-1446-'));
  const nodeDir = path.join(root, 'sf-mini-node');
  const stateDir = path.join(nodeDir, 'state');
  const unrelatedCwd = path.join(root, 'elsewhere');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(unrelatedCwd, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'connection.json'),
    JSON.stringify({ url: 'http://127.0.0.1:' + broker.address().port, api_key: 'proof-node-key', pid: process.pid })
  );
  const env = {
    RELAY_BROKER_URL: 'http://127.0.0.1:' + decoy.address().port,
    RELAY_BROKER_API_KEY: 'decoy-key',
  };
  try {
    const list = await invoke(['node', 'agent', 'list', '--state-dir', stateDir], unrelatedCwd, env);
    const release = await invoke(['node', 'agent', 'release', 'worker', '--state-dir', nodeDir], unrelatedCwd, env);
    await writeFile(observationPath, JSON.stringify({ list, release, requests }), 'utf8');
  } finally {
    broker.close();
    decoy.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
`;

const configSource = `export default {
  test: {
    environment: 'node',
    include: ['packages/cli/src/cli/.relayflow-1446-state-dir.test.ts'],
    setupFiles: [],
  },
};\n`;

try {
  run('npm', ['ci', '--ignore-scripts'], targetDir, 'workspace dependency installation');
  run('npm', ['run', 'build:core'], targetDir, 'workspace package build');
  await writeGeneratedFile(probePath, probeSource);
  await writeGeneratedFile(configPath, configSource);
  run(
    'npm',
    ['exec', '--', 'vitest', 'run', '--config', path.relative(targetDir, configPath)],
    targetDir,
    'state-dir broker selection probe',
    { RELAY_PR1446_OBSERVATION_PATH: observationPath }
  );

  const observation = JSON.parse(await readFile(observationPath, 'utf8'));
  console.log('State-dir broker selection observation:', JSON.stringify(observation));
  const { list, release, requests } = observation;
  const rejected = (result) =>
    typeof result?.error === 'string' && /unknown option '--state-dir'/.test(result.error);
  const baseObserved = rejected(list) && rejected(release) && requests.length === 0;
  const nodeRequests = requests.filter((request) => request.broker === 'node');
  const headObserved =
    list?.error === null &&
    release?.error === null &&
    list.errors.length === 0 &&
    release.errors.length === 0 &&
    list.logs.some((line) => line.includes('"worker"')) &&
    release.logs.includes('Released worker.') &&
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
      "The exact base CLI rejects --state-dir on node agent list and release with unknown option '--state-dir', so a broker started with --state-dir cannot be managed from another directory.";
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'node_agent_state_dir_targets_broker';
    details =
      'The exact head CLI lists and releases through the broker named by --state-dir (both the state dir and its fleet node parent) from an unrelated cwd, authenticating with that broker key and never contacting the RELAY_BROKER_URL decoy.';
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
  await rm(probePath, { force: true });
  await rm(configPath, { force: true });
  await rm(observationPath, { force: true });
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

async function writeGeneratedFile(targetPath, source) {
  try {
    const existing = await lstat(targetPath);
    if (!existing.isFile()) throw new Error(`Refusing to replace non-file ${targetPath}.`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(source, 'utf8');
    await handle.close();
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
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
