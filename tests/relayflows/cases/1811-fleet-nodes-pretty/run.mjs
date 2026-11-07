#!/usr/bin/env node

/**
 * Red/green proof for `agent-relay fleet nodes list --pretty`.
 *
 * The exact-head harness injects a Vitest probe into each exact target checkout.
 * The probe drives the production Commander registration with a mocked workspace
 * transport, so it observes command parsing, option routing, API filters, offline
 * inclusion, and the final human-readable table without needing live credentials.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1811-fleet-nodes-pretty';
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

const probePath = path.join(targetDir, 'packages/cli/src/cli/.relayflow-1811-fleet-nodes.test.ts');
const configPath = path.join(targetDir, '.relayflow-1811-fleet-nodes.vitest.config.mjs');
const observationPath = path.join(targetDir, '.relayflow-1811-fleet-nodes-observation.json');

const probeSource = String.raw`import { writeFile } from 'node:fs/promises';

import { Command } from 'commander';
import { test } from 'vitest';

import { registerFleetCommands } from './commands/fleet.js';

const observationPath = process.env.RELAY_PR1811_OBSERVATION_PATH;

function nodeRecord() {
  return {
    id: 'node_proof_1811',
    name: 'sf-mini',
    status: 'offline',
    live: false,
    handlersLive: false,
    activeAgents: 2,
    maxAgents: 15,
    version: 'relay-broker/proof',
    lastHeartbeatAt: new Date().toISOString(),
    capabilities: [],
    tags: [],
  };
}

async function invoke(argv) {
  const calls = [];
  const logs = [];
  const warnings = [];
  const nodes = {
    list: async (filters) => {
      calls.push(filters);
      return [nodeRecord()];
    },
  };
  const program = new Command();
  program.enablePositionalOptions();
  program.exitOverride();
  registerFleetCommands(program, {
    resolveSandboxRepository: () => undefined,
    sdk: {
      createAgentRelay: () => {
        throw new Error('unused createAgentRelay');
      },
      createWorkspaceRelay: (options) => {
        calls.push({ workspace: options });
        return { nodes };
      },
      createWorkspace: () => {
        throw new Error('unused createWorkspace');
      },
      log: () => undefined,
      error: () => undefined,
      exit: (code) => {
        throw new Error('unexpected SDK exit ' + code);
      },
    },
    log: (...args) => logs.push(args.join(' ')),
    warn: (...args) => warnings.push(args.join(' ')),
    error: () => undefined,
    exit: (code) => {
      throw new Error('unexpected CLI exit ' + code);
    },
  });

  let error = null;
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return { calls, logs, warnings, error };
}

test('observe fleet nodes pretty behavior', async () => {
  const childOptions = await invoke([
    'fleet',
    'nodes',
    'list',
    '--name',
    'sf-mini',
    '--capability',
    'spawn:codex',
    '--all',
    '--pretty',
    '--workspace-key',
    'rk_live_child',
  ]);
  const shortForm = await invoke([
    'fleet',
    'nodes',
    '--workspace-key',
    'rk_live_parent',
    '--name',
    'sf-mini',
    '--capability',
    'spawn:codex',
    '--all',
    '--pretty',
  ]);

  await writeFile(
    observationPath,
    JSON.stringify({ childOptions, shortForm }),
    'utf8'
  );
});
`;

const configSource = `export default {
  test: {
    environment: 'node',
    include: ['packages/cli/src/cli/.relayflow-1811-fleet-nodes.test.ts'],
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
    'fleet nodes pretty probe',
    { RELAY_PR1811_OBSERVATION_PATH: observationPath }
  );

  const observation = JSON.parse(await readFile(observationPath, 'utf8'));
  console.log('Fleet nodes pretty proof observation:', JSON.stringify(observation));
  const results = [observation.childOptions, observation.shortForm];
  const baseObserved = results.every(
    (result) => typeof result?.error === 'string' && result.logs?.length === 0
  );
  const headObserved = results.every((result, index) => {
    const output = result?.logs?.[0] ?? '';
    const expectedWorkspace = index === 0 ? 'rk_live_child' : 'rk_live_parent';
    return (
      result?.error === null &&
      result.logs.length === 1 &&
      result.warnings.length === 0 &&
      output.includes('NODE') &&
      output.includes('NODE ID') &&
      output.includes('LIVE') &&
      output.includes('HANDLERS') &&
      output.includes('LAST HEARTBEAT') &&
      output.includes('sf-mini') &&
      output.includes('node_proof_1811') &&
      output.includes('2/15') &&
      output.includes('relay-broker/proof') &&
      output.split(/\s+/).includes('no') &&
      /\b\d+[smhd] ago\b/.test(output) &&
      result.calls.some((call) => call?.workspace?.workspaceKey === expectedWorkspace) &&
      result.calls.some((call) => call?.name === 'sf-mini' && call?.capability === 'spawn:codex')
    );
  });

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'absent';
    signature = 'fleet_nodes_pretty_absent';
    details =
      'The exact base CLI rejects both the fleet nodes list --pretty and fleet nodes --pretty forms and emits no table.';
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'fleet_nodes_pretty_lists_nodes';
    details =
      'The exact head CLI accepts the list and short forms, preserves workspace and API filters, includes requested offline history, and emits the NODE table with identity, liveness, handler health, capacity, version, and heartbeat columns.';
  } else {
    throw new Error(`Unexpected fleet nodes pretty observation: ${JSON.stringify(observation)}.`);
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
