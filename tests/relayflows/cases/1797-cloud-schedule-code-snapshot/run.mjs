import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1797-cloud-schedule-code-snapshot';
const PREPARED_RUN_ID = '11111111-1111-4111-8111-111111111111';
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

const probePath = path.join(targetDir, 'packages/cloud/src/.relayflow-1797-schedule-snapshot.test.ts');
const probeObservationPath = path.join(targetDir, '.relayflow-1797-schedule-snapshot-observation.json');
const probeConfigPath = path.join(targetDir, '.relayflow-1797-schedule-snapshot.vitest.config.mjs');

// The probe drives the target checkout's public Cloud SDK `scheduleWorkflow`
// against a fake Cloud API (only the authenticated fetch is replaced) and
// records every request it makes: whether it prepares a run scope, what it
// uploads, and what it stores in the schedule.
const probeSource = String.raw`import { test, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const mocks = vi.hoisted(() => ({
  ensureAuthenticated: vi.fn(),
  authorizedApiFetch: vi.fn(),
}));

vi.mock('./auth.js', () => ({
  ensureAuthenticated: mocks.ensureAuthenticated,
  authorizedApiFetch: mocks.authorizedApiFetch,
}));

import { scheduleWorkflow } from './workflows.js';

const PREPARED_RUN_ID = ${JSON.stringify(PREPARED_RUN_ID)};
const workflowYaml = [
  'version: "1.0"',
  'name: relayflow-proof-schedule',
  'swarm:',
  '  pattern: dag',
  'agents: []',
  'workflows: []',
].join('\n');

test('observes the code snapshot a created schedule carries', async () => {
  const observationPath = process.env.RELAY_PR1797_OBSERVATION_PATH;
  if (!observationPath) throw new Error('Missing RELAY_PR1797_OBSERVATION_PATH.');

  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'relayflow-1797-'));
  try {
    await writeFile(path.join(projectDir, 'drive.yaml'), workflowYaml);
    await writeFile(path.join(projectDir, 'marker.txt'), 'relayflow-1797-snapshot-marker\n');
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    const auth = {
      accessToken: 'relayflow-proof-access',
      refreshToken: 'relayflow-proof-refresh',
      accessTokenExpiresAt: '2099-01-01T00:00:00Z',
      apiUrl: 'https://relayflow.invalid',
    };
    mocks.ensureAuthenticated.mockResolvedValue(auth);

    const requests = [];
    const uploads = [];
    const scheduleBodies = [];
    mocks.authorizedApiFetch.mockImplementation(async (_auth, requestPath, init) => {
      const method = init?.method ?? 'GET';
      requests.push(method + ' ' + requestPath);
      if (requestPath === '/api/v1/workflows/prepare') {
        return {
          auth,
          response: Response.json({
            runId: PREPARED_RUN_ID,
            s3Credentials: {
              backend: 'cloud-api',
              accessKeyId: 'cloud-api',
              secretAccessKey: 'cloud-api',
              sessionToken: 'relayflow-proof-session',
              bucket: 'relayflow-proof-bucket',
              prefix: 'user-relayflow-proof/' + PREPARED_RUN_ID,
            },
            s3CodeKey: 'code.tar.gz',
            workflowStorage: { backend: 'cloud-api' },
          }),
        };
      }
      if (requestPath.startsWith('/api/v1/workflows/runs/') && method === 'PUT') {
        const bytes = Buffer.from(init.body);
        let archiveText = '';
        try {
          archiveText = gunzipSync(bytes).toString('latin1');
        } catch {
          archiveText = '';
        }
        uploads.push({
          path: requestPath,
          bytes: bytes.length,
          containsWorkflow: archiveText.includes('drive.yaml'),
          containsMarker: archiveText.includes('relayflow-1797-snapshot-marker'),
        });
        return { auth, response: Response.json({ ok: true }) };
      }
      if (requestPath === '/api/v1/workflows/schedules' && method === 'POST') {
        scheduleBodies.push(JSON.parse(String(init.body)));
        return {
          auth,
          response: Response.json(
            {
              schedule: {
                id: 'schedule-relayflow-proof',
                relaycronScheduleId: 'relaycron-relayflow-proof',
                userId: 'user-relayflow-proof',
                workspaceId: 'workspace-relayflow-proof',
                organizationId: 'organization-relayflow-proof',
                name: 'relayflow-proof',
                description: null,
                scheduleType: 'cron',
                cronExpression: '0 * * * *',
                scheduledAt: null,
                timezone: 'UTC',
                status: 'active',
                lastTriggeredRunId: null,
                lastTriggeredAt: null,
                createdAt: '2098-01-01T00:00:00.000Z',
                updatedAt: '2098-01-01T00:00:00.000Z',
              },
            },
            { status: 201 }
          ),
        };
      }
      throw new Error('unexpected Cloud request: ' + method + ' ' + requestPath);
    });

    await scheduleWorkflow(path.join(projectDir, 'drive.yaml'), {
      apiUrl: auth.apiUrl,
      cron: '0 * * * *',
      name: 'relayflow-proof',
    });
    const fileRequests = requests.splice(0);
    const fileUploads = uploads.splice(0);
    const fileWorkflowRequest = scheduleBodies[0]?.workflowRequest ?? {};

    await scheduleWorkflow(workflowYaml, {
      apiUrl: auth.apiUrl,
      fileType: 'yaml',
      cron: '0 * * * *',
      name: 'relayflow-proof-inline',
    });
    requests.splice(0);
    uploads.splice(0);
    const inlineWorkflowRequest = scheduleBodies[1]?.workflowRequest ?? {};

    const authBeforeInvalidAt = mocks.ensureAuthenticated.mock.calls.length;
    let invalidAtError = null;
    try {
      await scheduleWorkflow(path.join(projectDir, 'drive.yaml'), {
        apiUrl: auth.apiUrl,
        at: 'next tuesday',
      });
    } catch (error) {
      invalidAtError = error instanceof Error ? error.message : String(error);
    }

    await writeFile(
      observationPath,
      JSON.stringify({
        fileRequests,
        fileUploads,
        fileWorkflowRequest: {
          s3CodeKey: fileWorkflowRequest.s3CodeKey ?? null,
          codeSourceRunId: fileWorkflowRequest.codeSourceRunId ?? null,
          workflowPath: fileWorkflowRequest.workflowPath ?? null,
        },
        inlineWorkflowRequest: {
          s3CodeKey: inlineWorkflowRequest.s3CodeKey ?? null,
          codeSourceRunId: inlineWorkflowRequest.codeSourceRunId ?? null,
          hasWorkflowPath: Object.prototype.hasOwnProperty.call(inlineWorkflowRequest, 'workflowPath'),
        },
        invalidAt: {
          error: invalidAtError,
          requests: requests.length,
          auth: mocks.ensureAuthenticated.mock.calls.length - authBeforeInvalidAt,
        },
      }),
      'utf8'
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
`;

const probeConfigSource = `export default {
  test: {
    environment: 'node',
    include: ['packages/cloud/src/.relayflow-1797-schedule-snapshot.test.ts'],
    setupFiles: [],
  },
};\n`;

const uploadPath = `/api/v1/workflows/runs/${PREPARED_RUN_ID}/storage/code.tar.gz`;

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
    'Cloud schedule code snapshot probe',
    {
      CLOUD_API_KEY: '',
      RELAY_PR1797_OBSERVATION_PATH: probeObservationPath,
    }
  );

  const observation = JSON.parse(await readFile(probeObservationPath, 'utf8'));
  console.log('Schedule snapshot observation:', JSON.stringify(observation));
  const baseObserved =
    JSON.stringify(observation.fileRequests) === JSON.stringify(['POST /api/v1/workflows/schedules']) &&
    observation.fileUploads.length === 0 &&
    observation.fileWorkflowRequest.s3CodeKey === null &&
    observation.fileWorkflowRequest.codeSourceRunId === null &&
    observation.fileWorkflowRequest.workflowPath === null;
  const headObserved =
    JSON.stringify(observation.fileRequests) ===
      JSON.stringify([
        'POST /api/v1/workflows/prepare',
        `PUT ${uploadPath}`,
        'POST /api/v1/workflows/schedules',
      ]) &&
    observation.fileUploads.length === 1 &&
    observation.fileUploads[0].path === uploadPath &&
    observation.fileUploads[0].containsWorkflow === true &&
    observation.fileUploads[0].containsMarker === true &&
    observation.fileWorkflowRequest.s3CodeKey === 'code.tar.gz' &&
    observation.fileWorkflowRequest.codeSourceRunId === PREPARED_RUN_ID &&
    observation.fileWorkflowRequest.workflowPath === 'drive.yaml' &&
    observation.inlineWorkflowRequest.s3CodeKey === 'code.tar.gz' &&
    observation.inlineWorkflowRequest.codeSourceRunId === PREPARED_RUN_ID &&
    observation.inlineWorkflowRequest.hasWorkflowPath === false &&
    observation.invalidAt.error === 'Invalid date for --at: next tuesday' &&
    observation.invalidAt.requests === 0 &&
    observation.invalidAt.auth === 0;

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'bug';
    signature = 'schedule_submitted_without_code_snapshot';
    details =
      'The base Cloud SDK created the schedule with a single POST and no prepare, no archive upload, and no s3CodeKey or codeSourceRunId, so every scheduled fire ran without a code tree.';
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'schedule_uploads_immutable_code_snapshot';
    details =
      'The head Cloud SDK prepared a run scope, uploaded a code.tar.gz containing the project files, and stored s3CodeKey, codeSourceRunId and the workflow path in the schedule; an inline workflow carried the snapshot without a workflow path, and an invalid --at failed before authentication or any Cloud request.';
  } else {
    throw new Error(`Unexpected schedule snapshot observation: ${JSON.stringify(observation)}.`);
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
