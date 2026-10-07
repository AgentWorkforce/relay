/**
 * RelayFlow proof for definitive pre-allocation capacity rejection handling.
 *
 * The probe presents the production Cloud client with the stable capacity 503
 * contract. The base conservatively reports an unknown outcome and retains the
 * caller's replay identity; the head proves no sandbox was created, exposes
 * safe aggregate counts, and withholds cleanup authority.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1916-sandbox-capacity-rejection';
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

const probePath = path.join(
  targetDir,
  'packages/cloud/src/.relayflow-1916-sandbox-capacity-rejection.test.ts'
);
const observationPath = path.join(targetDir, '.relayflow-1916-sandbox-capacity-rejection-observation.json');
const configPath = path.join(targetDir, '.relayflow-1916-sandbox-capacity-rejection.vitest.config.mjs');

const probeSource = String.raw`import { writeFile } from 'node:fs/promises';
import { test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureCloudSession: vi.fn(),
  authorizedApiFetch: vi.fn(),
}));

vi.mock('./auth.js', () => ({
  ensureCloudSession: mocks.ensureCloudSession,
  authorizedApiFetch: mocks.authorizedApiFetch,
}));

import {
  CloudFleetSandboxProvisionError,
  ensureCloudFleetSandbox,
} from './fleet-sandbox.js';

const auth = {
  accessToken: 'relayflow-probe-access',
  refreshToken: 'relayflow-probe-refresh',
  accessTokenExpiresAt: '2099-01-01T00:00:00Z',
  apiUrl: 'https://relayflow.invalid',
};

test('observes capacity rejection classification', async () => {
  const observationPath = process.env.RELAY_PR1916_OBSERVATION_PATH;
  if (!observationPath) throw new Error('Missing RELAY_PR1916_OBSERVATION_PATH.');

  mocks.ensureCloudSession.mockResolvedValue({ auth, client: {} });
  mocks.authorizedApiFetch
    .mockResolvedValueOnce({
      response: Response.json({ cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99' }),
      auth,
    })
    .mockResolvedValueOnce({
      response: Response.json(
        {
          error: 'Sandbox capacity is exhausted before allocation; no sandbox was created',
          code: 'sandbox_capacity_exhausted',
          capacity: [{ provider: 'agent37', current: 14, limit: 10 }],
          retryable: true,
          no_sandbox_created: true,
        },
        { status: 503 }
      ),
      auth,
    });

  const error = await ensureCloudFleetSandbox({
    workspaceId: 'rw_relayflow',
    requiredCapability: 'spawn:codex',
    sandboxId: 'sbx_123e4567-e89b-42d3-a456-426614174000',
    name: 'fleet-sandbox-123e4567-e89b-42d3-a456-426614174000',
    providerId: 'agent37',
    forceProvision: true,
    workloadProfile: 'long-running-agent',
  }).catch((caught) => caught);

  await writeFile(
    observationPath,
    JSON.stringify({
      provisionError: error instanceof CloudFleetSandboxProvisionError,
      message: String(error),
      code: error?.code ?? null,
      sandboxId: error?.sandboxId ?? null,
      outcomeUnknown: error?.outcomeUnknown ?? null,
      noSandboxCreated: error?.noSandboxCreated ?? null,
      retryable: error?.retryable ?? null,
      capacity: error?.capacity ?? null,
    }),
    'utf8'
  );
});
`;

const configSource = `export default {
  test: {
    environment: 'node',
    include: ['packages/cloud/src/.relayflow-1916-sandbox-capacity-rejection.test.ts'],
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

  await writeFile(probePath, probeSource, { encoding: 'utf8', flag: 'wx' });
  await writeFile(configPath, configSource, { encoding: 'utf8', flag: 'wx' });
  run(
    'npm',
    ['exec', '--', 'vitest', 'run', '--config', path.relative(targetDir, configPath)],
    targetDir,
    'capacity rejection probe',
    { RELAY_PR1916_OBSERVATION_PATH: observationPath }
  );

  const observation = JSON.parse(await readFile(observationPath, 'utf8'));
  const baseObserved =
    observation.provisionError === true &&
    observation.code === null &&
    observation.sandboxId === 'sbx_123e4567-e89b-42d3-a456-426614174000' &&
    observation.outcomeUnknown === true &&
    observation.noSandboxCreated === null &&
    observation.retryable === null &&
    observation.capacity === null;
  const headObserved =
    observation.provisionError === true &&
    observation.code === 'sandbox_capacity_exhausted' &&
    observation.sandboxId === null &&
    observation.outcomeUnknown === false &&
    observation.noSandboxCreated === true &&
    observation.retryable === true &&
    JSON.stringify(observation.capacity) ===
      JSON.stringify([{ provider: 'agent37', current: 14, limit: 10 }]) &&
    observation.message.includes('agent37: 14 current / 10 limit') &&
    observation.message.includes('No sandbox was created');

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'bug';
    signature = 'capacity_503_reported_as_unknown';
    details =
      'The base treats a complete pre-allocation capacity response as unknown and retains the caller replay identity.';
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'capacity_503_definitive_no_sandbox_created';
    details =
      'The head reports provider counts, proves no sandbox was created, and retains no cleanup identity.';
  } else {
    throw new Error(`Unexpected capacity rejection observation: ${JSON.stringify(observation)}.`);
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
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

function run(command, args, cwd, label, extraEnv = {}) {
  const completed = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'inherit', 'inherit'],
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
