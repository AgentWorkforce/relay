import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1712-cloud-launch-timeout';
const LAUNCH_TIMEOUT_MS = 900_000;
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

const probePath = path.join(targetDir, 'packages/cloud/dist/.relayflow-1712-launch-timeout.test.mjs');
const probeConfigPath = path.join(targetDir, '.relayflow-1712-launch-timeout.vitest.config.mjs');
const probeObservationPath = path.join(targetDir, '.relayflow-1712-launch-timeout-observation.json');

const probeSource = String.raw`import { test, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';

const mocks = vi.hoisted(() => ({
  ensureAuthenticated: vi.fn(),
  authorizedApiFetch: vi.fn(),
}));

vi.mock('./auth.js', () => ({
  ensureAuthenticated: (...args) => mocks.ensureAuthenticated(...args),
  authorizedApiFetch: (...args) => mocks.authorizedApiFetch(...args),
}));

import { runWorkflow, scheduleWorkflow } from './index.js';

const workflow = [
  'version: "1.0"',
  'name: launch-timeout-proof',
  'swarm:',
  '  pattern: dag',
  'agents: []',
  'workflows: []',
].join('\n');

test('observes explicit launch timeout forwarding on the compiled public client', async () => {
  const observationPath = process.env.RELAY_PR1712_OBSERVATION_PATH;
  if (!observationPath) throw new Error('Missing RELAY_PR1712_OBSERVATION_PATH.');

  const auth = { accessToken: 'relayflow-proof-access' };
  const schedule = {
    id: 'schedule-launch-timeout-proof',
    relaycronScheduleId: 'relaycron-launch-timeout-proof',
    userId: 'user-launch-timeout-proof',
    workspaceId: 'workspace-launch-timeout-proof',
    organizationId: 'organization-launch-timeout-proof',
    name: 'launch-timeout-proof',
    description: null,
    scheduleType: 'once',
    cronExpression: null,
    scheduledAt: '2099-01-01T00:00:00.000Z',
    timezone: 'UTC',
    status: 'active',
    lastTriggeredRunId: null,
    lastTriggeredAt: null,
    createdAt: '2098-01-01T00:00:00.000Z',
    updatedAt: '2098-01-01T00:00:00.000Z',
  };
  const requests = [];
  mocks.ensureAuthenticated.mockResolvedValue(auth);
  mocks.authorizedApiFetch.mockImplementation(async (_auth, requestPath, init) => {
    requests.push({ requestPath, body: JSON.parse(String(init?.body ?? '{}')) });
    if (requestPath === '/api/v1/workflows/run') {
      return { auth, response: Response.json({ runId: 'run-launch-timeout-proof', status: 'queued' }) };
    }
    if (requestPath === '/api/v1/workflows/schedules') {
      return { auth, response: Response.json({ schedule }) };
    }
    throw new Error('Unexpected Cloud request path: ' + requestPath);
  });

  await runWorkflow(workflow, {
    apiUrl: 'https://relayflow.invalid',
    fileType: 'yaml',
    syncCode: false,
    launchTimeoutMs: ${LAUNCH_TIMEOUT_MS},
  });
  await scheduleWorkflow(workflow, {
    apiUrl: 'https://relayflow.invalid',
    fileType: 'yaml',
    at: '2099-01-01T00:00:00.000Z',
    launchTimeoutMs: ${LAUNCH_TIMEOUT_MS},
  });

  const runRequest = requests.find(({ requestPath }) => requestPath === '/api/v1/workflows/run');
  const scheduleRequest = requests.find(({ requestPath }) => requestPath === '/api/v1/workflows/schedules');
  await writeFile(
    observationPath,
    JSON.stringify({
      runLaunchTimeoutMs: runRequest?.body?.launchTimeoutMs ?? null,
      scheduleLaunchTimeoutMs: scheduleRequest?.body?.workflowRequest?.launchTimeoutMs ?? null,
    }),
    'utf8'
  );
});
`;

const probeConfigSource = `export default {
  test: {
    environment: 'node',
    include: ['packages/cloud/dist/.relayflow-1712-launch-timeout.test.mjs'],
    setupFiles: [],
  },
};\n`;

try {
  run(
    'npm',
    ['ci', '--ignore-scripts', '--workspace', 'packages/cloud', '--include-workspace-root=false'],
    targetDir,
    'Cloud workspace dependency installation'
  );
  run('npm', ['run', 'build:config'], targetDir, 'configuration package build');
  run('npm', ['run', 'build:cloud'], targetDir, 'Cloud package build');

  await writeGeneratedFile(probePath, probeSource);
  await writeGeneratedFile(probeConfigPath, probeConfigSource);
  run(
    'npm',
    ['exec', '--', 'vitest', 'run', '--config', path.relative(targetDir, probeConfigPath)],
    targetDir,
    'Compiled Cloud public API launch-timeout probe',
    {
      CLOUD_API_KEY: '',
      RELAY_PR1712_OBSERVATION_PATH: probeObservationPath,
    }
  );

  const observation = JSON.parse(await readFile(probeObservationPath, 'utf8'));
  console.log('RelayFlow proof observation:', JSON.stringify(observation));
  const baseObserved =
    observation.runLaunchTimeoutMs === null && observation.scheduleLaunchTimeoutMs === null;
  const headObserved =
    observation.runLaunchTimeoutMs === LAUNCH_TIMEOUT_MS &&
    observation.scheduleLaunchTimeoutMs === LAUNCH_TIMEOUT_MS;

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'bug';
    signature = 'launch_timeout_not_forwarded';
    details =
      'The compiled base Cloud public client accepted explicit launchTimeoutMs options but omitted the budget from both run and schedule request bodies.';
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'launch_timeout_forwarded';
    details =
      'The compiled head Cloud public client forwarded the explicit 900000ms launch budget for both run and schedule requests; the inline YAML was validated but never executed as untrusted workflow source.';
  } else {
    throw new Error(`Unexpected launch-timeout observation: ${JSON.stringify(observation)}.`);
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
} finally {
  await rm(probePath, { force: true });
  await rm(probeConfigPath, { force: true });
  await rm(probeObservationPath, { force: true });
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
    if (!existing.isFile()) {
      throw new Error(`Refusing to replace non-regular generated file ${targetPath}.`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const temporaryPath = `${targetPath}.tmp-${process.pid}`;
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(source, 'utf8');
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function run(command, args, cwd, label, extraEnv = {}) {
  const completed = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (completed.error) throw new Error(`${label} could not start: ${completed.error.message}`);
  if (completed.status !== 0) {
    throw new Error(
      `${label} failed with ${
        completed.signal ? `signal ${completed.signal}` : `exit code ${completed.status ?? 'unknown'}`
      }.`
    );
  }
}
