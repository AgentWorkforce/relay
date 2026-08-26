import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1609-mounted-sandbox-provisioning-timeout';
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
  'packages/cloud/src/.relayflow-1609-mounted-sandbox-provisioning-timeout.test.ts'
);
const probeObservationPath = path.join(
  targetDir,
  '.relayflow-1609-mounted-sandbox-provisioning-timeout-observation.json'
);
const probeConfigPath = path.join(
  targetDir,
  '.relayflow-1609-mounted-sandbox-provisioning-timeout.vitest.config.mjs'
);

const probeSource = String.raw`import { afterEach, expect, test, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';

const mocks = vi.hoisted(() => ({
  ensureCloudSession: vi.fn(),
  authorizedApiFetch: vi.fn(),
}));

vi.mock('./auth.js', () => ({
  ensureCloudSession: mocks.ensureCloudSession,
  authorizedApiFetch: mocks.authorizedApiFetch,
}));

import { ensureCloudFleetSandbox } from './fleet-sandbox.js';

const auth = {
  accessToken: 'relayflow-probe-access',
  refreshToken: 'relayflow-probe-refresh',
  accessTokenExpiresAt: '2099-01-01T00:00:00Z',
  apiUrl: 'https://relayflow.invalid',
};

afterEach(() => {
  vi.restoreAllMocks();
});

test('observes the production resolution and provisioning request budgets', async () => {
  const observationPath = process.env.RELAY_PR1609_OBSERVATION_PATH;
  if (!observationPath) throw new Error('Missing RELAY_PR1609_OBSERVATION_PATH.');

  mocks.ensureCloudSession.mockResolvedValue({ auth, client: {} });
  mocks.authorizedApiFetch
    .mockResolvedValueOnce({
      response: Response.json({ cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99' }),
      auth,
    })
    .mockResolvedValueOnce({
      response: Response.json(
        {
          outcome: 'provisioned',
          nodeId: 'node-relayflow',
          nodeName: 'daytona-relayflow',
          sandboxId: 'sandbox-relayflow',
          relayWorkspaceId: 'rw_relayflow',
          relayfileMounted: true,
        },
        { status: 201 }
      ),
      auth,
    });

  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
  await expect(
    ensureCloudFleetSandbox({
      workspaceId: 'rw_relayflow',
      requiredCapability: 'spawn:codex',
      mountRelayfile: true,
    })
  ).resolves.toMatchObject({ outcome: 'provisioned', sandboxId: 'sandbox-relayflow' });

  expect(mocks.ensureCloudSession).toHaveBeenCalledTimes(1);
  expect(mocks.authorizedApiFetch).toHaveBeenCalledTimes(2);
  const timeouts = timeoutSpy.mock.calls.map(([timeoutMs]) => timeoutMs);
  await writeFile(observationPath, JSON.stringify({ timeouts }), 'utf8');
});
`;
const probeConfigSource = `export default {
  test: {
    environment: 'node',
    include: ['packages/cloud/src/.relayflow-1609-mounted-sandbox-provisioning-timeout.test.ts'],
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
  await writeFile(probeConfigPath, probeConfigSource, { encoding: 'utf8', flag: 'wx' });
  run(
    'npm',
    ['exec', '--', 'vitest', 'run', '--config', path.relative(targetDir, probeConfigPath)],
    targetDir,
    'production fleet sandbox probe',
    { RELAY_PR1609_OBSERVATION_PATH: probeObservationPath }
  );

  const observation = JSON.parse(await readFile(probeObservationPath, 'utf8'));
  const timeouts = observation?.timeouts;
  let outcome;
  let signature;
  if (sameNumbers(timeouts, [120_000, 120_000])) {
    outcome = 'bug';
    signature = 'resolution_120000_provisioning_120000';
  } else if (sameNumbers(timeouts, [120_000, 480_000])) {
    outcome = 'fixed';
    signature = 'resolution_120000_provisioning_480000';
  } else {
    throw new Error(`Unexpected AbortSignal.timeout observations: ${JSON.stringify(timeouts)}.`);
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({
      version: 1,
      caseId: CASE_ID,
      arm,
      outcome,
      signature,
      details: `Production ensureCloudFleetSandbox called AbortSignal.timeout in order with [${timeouts.join(', ')}] ms.`,
    })}\n`,
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

function sameNumbers(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}
