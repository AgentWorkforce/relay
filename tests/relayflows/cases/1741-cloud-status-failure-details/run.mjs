#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1741-cloud-status-failure-details';
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const targetDir = path.resolve(required('RELAY_PR_PROOF_TARGET_DIR'));
const harnessDir = path.resolve(required('RELAY_PR_PROOF_HARNESS_DIR'));
const resultPath = path.resolve(required('RELAY_PR_PROOF_RESULT_PATH'));
const arm = required('RELAY_PR_PROOF_ARM');
if (arm !== 'base' && arm !== 'head') throw new Error(`Invalid proof arm: ${arm}`);

const expectedSha = required(arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA');
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
  timeout: COMMAND_TIMEOUT_MS,
}).trim();
if (targetSha !== expectedSha) throw new Error(`Target SHA ${targetSha} does not match ${expectedSha}`);
if (!isWithin(harnessDir, fileURLToPath(import.meta.url))) {
  throw new Error('Runner must execute from the exact-head harness checkout.');
}

const probePath = path.join(targetDir, 'packages/cli/src/cli/.relayflow-1741-status.test.ts');
const configPath = path.join(targetDir, '.relayflow-1741-status.vitest.config.mjs');
const observationPath = path.join(targetDir, '.relayflow-1741-status-observation.json');
const generated = [];

const probeSource = String.raw`import { writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getRunStatus: vi.fn() }));
vi.mock('@agent-relay/cloud', async (importOriginal) => ({
  ...(await importOriginal()),
  getRunStatus: mocks.getRunStatus,
}));

import { registerCloudCommands } from './commands/cloud.js';

test('observe cloud status human failure output', async () => {
  const sentinels = [
    'MESSAGE_SECRET_SENTINEL',
    'CAUSE_SECRET_SENTINEL',
    'CHAIN_SECRET_SENTINEL',
    'PROVIDER_OUTPUT_SECRET_SENTINEL',
    'AGENT_OUTPUT_SECRET_SENTINEL',
    'SIGNED_URL_SECRET_SENTINEL',
    'NESTED_ERROR_SECRET_SENTINEL',
  ];
  mocks.getRunStatus.mockResolvedValue({
    runId: 'run-proof-1741',
    status: 'failed',
    failure: {
      phase: 'bootstrap',
      code: 'asset_fetch_failed',
      dispatchType: 'agent.v2',
      occurredAt: '2026-09-23T12:00:01Z',
      sandboxId: 'sbx_123',
      message: sentinels[0],
      cause: sentinels[1],
      causeChain: [sentinels[2]],
      providerOutput: sentinels[3],
      agentOutput: sentinels[4],
      signedUrl: 'https://cloud.invalid/?token=' + sentinels[5],
      result: { error: sentinels[6] },
    },
  });

  const lines = [];
  const program = new Command();
  program.exitOverride();
  registerCloudCommands(program, { log: (...args) => lines.push(args.join(' ')) });
  await program.parseAsync(['cloud', 'status', 'run-proof-1741'], { from: 'user' });

  await writeFile(process.env.RELAY_PR1741_OBSERVATION_PATH, JSON.stringify({
    lines,
    statusCalls: mocks.getRunStatus.mock.calls.map(([runId]) => runId),
    sentinels,
  }), { flag: 'wx' });
});
`;

const configSource = `export default {
  test: {
    environment: 'node',
    include: ['packages/cli/src/cli/.relayflow-1741-status.test.ts'],
    setupFiles: [],
  },
};\n`;

try {
  run('npm', ['ci', '--ignore-scripts'], targetDir, 'dependency installation');
  run('npm', ['run', 'build:core'], targetDir, 'workspace build');
  await create(probePath, probeSource);
  await create(configPath, configSource);
  await assertAbsent(observationPath);
  generated.push(observationPath);
  run('npm', ['exec', '--', 'vitest', 'run', '--config', path.relative(targetDir, configPath)], targetDir,
    'Cloud status probe', { RELAY_PR1741_OBSERVATION_PATH: observationPath });

  const observation = JSON.parse(await readFile(observationPath, 'utf8'));
  const { lines, statusCalls, sentinels } = observation;
  const normalLines = ['Run: run-proof-1741', 'Status: failed'];
  const failureLines = [
    'Failure:',
    '  Phase: bootstrap',
    '  Code: asset_fetch_failed',
    '  Dispatch: agent.v2',
    '  Occurred: 2026-09-23T12:00:01Z',
    '  Sandbox: sbx_123',
  ];
  const invokedStatus = Array.isArray(statusCalls) &&
    JSON.stringify(statusCalls) === JSON.stringify(['run-proof-1741']);
  const safe = Array.isArray(lines) && Array.isArray(sentinels) &&
    sentinels.every((sentinel) => !lines.join('\n').includes(sentinel));
  const baseObserved = invokedStatus && safe &&
    JSON.stringify(lines) === JSON.stringify(normalLines);
  const headObserved = invokedStatus && safe &&
    JSON.stringify(lines) === JSON.stringify([...normalLines, ...failureLines]);

  let outcome;
  let signature;
  let details;
  if (arm === 'base' && baseObserved) {
    outcome = 'bug';
    signature = 'cloud_status_failure_details_missing';
    details = 'The exact base checkout command handler prints Run and Status but omits all structured Failure lines.';
  } else if (arm === 'head' && headObserved) {
    outcome = 'fixed';
    signature = 'cloud_status_safe_failure_details_visible';
    details = 'The exact head checkout command handler prints Run, Status, and all five structural failure fields without unsafe sentinel content.';
  } else {
    throw new Error(`Unexpected ${arm} Cloud status observation: ${JSON.stringify(observation)}`);
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details }, null, 2)}\n`);
} finally {
  for (const file of generated.reverse()) await rm(file, { force: true });
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function create(file, source) {
  await writeFile(file, source, { flag: 'wx', mode: 0o600 });
  generated.push(file);
}

async function assertAbsent(file) {
  try {
    await lstat(file);
    throw new Error(`Refusing to replace existing proof file ${file}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
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
    throw new Error(`${label} exited ${result.status ?? 'null'}:\n${(result.stdout ?? '').slice(-2000)}\n${(result.stderr ?? '').slice(-2000)}`);
  }
}
