import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1640-cloud-relayflow-version';
const RELAYFLOW_VERSION = 'v2';
const UNSUPPORTED_SCHEDULE_ERROR =
  'Relayflow v2 schedules are not supported; omit --relayflow-version or use v1.';
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
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

const probePath = path.join(targetDir, 'packages/cloud/src/.relayflow-1640-version.test.ts');
const probeObservationPath = path.join(targetDir, '.relayflow-1640-version-observation.json');
const probeConfigPath = path.join(targetDir, '.relayflow-1640-version.vitest.config.mjs');

const probeSource = String.raw`import { test, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';

const mocks = vi.hoisted(() => ({
  ensureAuthenticated: vi.fn(),
  authorizedApiFetch: vi.fn(),
  readFile: vi.fn(async () => {
    const error = new Error('relayflow proof inline workflow is not a file');
    Object.assign(error, { code: 'ENOENT' });
    throw error;
  }),
}));

vi.mock('./auth.js', () => ({
  ensureAuthenticated: mocks.ensureAuthenticated,
  authorizedApiFetch: mocks.authorizedApiFetch,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...actual, readFile: mocks.readFile },
  };
});

import { runWorkflow, scheduleWorkflow } from './workflows.js';

const workflow = [
  'version: "1.0"',
  'swarm:',
  '  pattern: dag',
  'agents: []',
  'workflows: []',
].join('\n');

test('observes v2 immediate-run forwarding and fail-closed v2 scheduling', async () => {
  const observationPath = process.env.RELAY_PR1640_OBSERVATION_PATH;
  if (!observationPath) throw new Error('Missing RELAY_PR1640_OBSERVATION_PATH.');

  const auth = {
    accessToken: 'relayflow-proof-access',
    refreshToken: 'relayflow-proof-refresh',
    accessTokenExpiresAt: '2099-01-01T00:00:00Z',
    apiUrl: 'https://relayflow.invalid',
  };
  mocks.ensureAuthenticated.mockResolvedValue(auth);
  const scheduleResponse = () => ({
    response: Response.json({
      schedule: {
        id: 'schedule-relayflow-proof',
        relaycronScheduleId: 'relaycron-relayflow-proof',
        userId: 'user-relayflow-proof',
        workspaceId: 'workspace-relayflow-proof',
        organizationId: 'organization-relayflow-proof',
        name: 'relayflow-proof',
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
      },
    }),
    auth,
  });
  mocks.authorizedApiFetch
    .mockResolvedValueOnce({
      response: Response.json({ runId: 'run-relayflow-proof', status: 'queued' }),
      auth,
    })
    .mockResolvedValueOnce(scheduleResponse())
    .mockResolvedValueOnce(scheduleResponse());

  await runWorkflow(workflow, {
    apiUrl: auth.apiUrl,
    fileType: 'yaml',
    syncCode: false,
    relayflowVersion: ${JSON.stringify(RELAYFLOW_VERSION)},
  });
  await scheduleWorkflow(workflow, {
    apiUrl: auth.apiUrl,
    fileType: 'yaml',
    at: '2099-01-01T00:00:00.000Z',
  });

  const runRequest = mocks.authorizedApiFetch.mock.calls[0]?.[2];
  const omittedScheduleRequest = mocks.authorizedApiFetch.mock.calls[1]?.[2];
  const runBody = JSON.parse(String(runRequest?.body ?? '{}'));
  const omittedScheduleBody = JSON.parse(String(omittedScheduleRequest?.body ?? '{}'));
  const beforeV2Schedule = {
    auth: mocks.ensureAuthenticated.mock.calls.length,
    filesystem: mocks.readFile.mock.calls.length,
    network: mocks.authorizedApiFetch.mock.calls.length,
  };

  let v2ScheduleError = null;
  let v2ScheduleAccepted = false;
  try {
    await scheduleWorkflow(workflow, {
      apiUrl: auth.apiUrl,
      fileType: 'yaml',
      at: '2099-01-01T00:00:00.000Z',
      relayflowVersion: ${JSON.stringify(RELAYFLOW_VERSION)},
    });
    v2ScheduleAccepted = true;
  } catch (error) {
    v2ScheduleError = error instanceof Error ? error.message : String(error);
  }

  const afterV2Schedule = {
    auth: mocks.ensureAuthenticated.mock.calls.length,
    filesystem: mocks.readFile.mock.calls.length,
    network: mocks.authorizedApiFetch.mock.calls.length,
  };
  const acceptedV2ScheduleRequest = mocks.authorizedApiFetch.mock.calls[2]?.[2];
  const acceptedV2ScheduleBody = JSON.parse(String(acceptedV2ScheduleRequest?.body ?? '{}'));

  await writeFile(
    observationPath,
    JSON.stringify({
      runRelayflowVersion: runBody.relayflowVersion ?? null,
      omittedScheduleRelayflowVersion:
        omittedScheduleBody.workflowRequest?.relayflowVersion ?? null,
      v2ScheduleAccepted,
      v2ScheduleError,
      acceptedV2ScheduleRelayflowVersion:
        acceptedV2ScheduleBody.workflowRequest?.relayflowVersion ?? null,
      v2ScheduleSideEffectDeltas: {
        auth: afterV2Schedule.auth - beforeV2Schedule.auth,
        filesystem: afterV2Schedule.filesystem - beforeV2Schedule.filesystem,
        network: afterV2Schedule.network - beforeV2Schedule.network,
      },
    }),
    'utf8'
  );
});
`;

const probeConfigSource = `export default {
  test: {
    environment: 'node',
    include: ['packages/cloud/src/.relayflow-1640-version.test.ts'],
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
    'Relayflow version forwarding probe',
    {
      CLOUD_API_KEY: '',
      RELAY_PR1640_OBSERVATION_PATH: probeObservationPath,
    }
  );

  const observation = JSON.parse(await readFile(probeObservationPath, 'utf8'));
  console.log('Relayflow proof observation:', JSON.stringify(observation));
  const baseObserved =
    observation.runRelayflowVersion === null &&
    observation.omittedScheduleRelayflowVersion === null &&
    observation.v2ScheduleAccepted === true &&
    observation.v2ScheduleError === null &&
    observation.acceptedV2ScheduleRelayflowVersion === null &&
    observation.v2ScheduleSideEffectDeltas?.auth === 1 &&
    observation.v2ScheduleSideEffectDeltas?.filesystem === 1 &&
    observation.v2ScheduleSideEffectDeltas?.network === 1;
  const headObserved =
    observation.runRelayflowVersion === RELAYFLOW_VERSION &&
    observation.omittedScheduleRelayflowVersion === null &&
    observation.v2ScheduleAccepted === false &&
    observation.v2ScheduleError === UNSUPPORTED_SCHEDULE_ERROR &&
    observation.acceptedV2ScheduleRelayflowVersion === null &&
    observation.v2ScheduleSideEffectDeltas?.auth === 0 &&
    observation.v2ScheduleSideEffectDeltas?.filesystem === 0 &&
    observation.v2ScheduleSideEffectDeltas?.network === 0;

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'absent';
    signature = 'relayflow_version_not_forwarded';
    details =
      'The base Cloud SDK omitted explicit v2 from the immediate-run request, accepted an omitted-selector schedule, and treated explicit v2 scheduling as an unvalidated option.';
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'relayflow_v2_run_forwarded_and_schedule_refused';
    details =
      `The head Cloud SDK forwarded explicit v2 for the immediate run, preserved omitted-selector scheduling, and refused explicit v2 scheduling with the exact unsupported error before auth, filesystem, or network access.`;
  } else {
    throw new Error(`Unexpected Relayflow version observation: ${JSON.stringify(observation)}.`);
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

  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(source, 'utf8');
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true });
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
