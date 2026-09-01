import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1630-scoped-relayfile-sandbox-mount';
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

const probePath = path.join(
  targetDir,
  'packages/cloud/src/.relayflow-1630-scoped-relayfile-sandbox-mount.test.ts'
);
const probeObservationPath = path.join(
  targetDir,
  '.relayflow-1630-scoped-relayfile-sandbox-mount-observation.json'
);
const probeConfigPath = path.join(
  targetDir,
  '.relayflow-1630-scoped-relayfile-sandbox-mount.vitest.config.mjs'
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

test('observes exact Relayfile subtree forwarding', async () => {
  const observationPath = process.env.RELAY_PR1630_OBSERVATION_PATH;
  if (!observationPath) throw new Error('Missing RELAY_PR1630_OBSERVATION_PATH.');

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
          nodeName: 'scoped-relayflow',
          sandboxId: 'sandbox-relayflow',
          relayWorkspaceId: 'rw_relayflow',
          relayfileMounted: true,
          providerId: 'daytona',
        },
        { status: 201 }
      ),
      auth,
    });

  await ensureCloudFleetSandbox({
    workspaceId: 'rw_relayflow',
    requiredCapability: 'spawn:claude',
    mountRelayfile: true,
    relayfilePaths: ['/live-review/run-123/**', '/live-review/run-123/reviews/**'],
  });

  const ensureRequest = mocks.authorizedApiFetch.mock.calls[1]?.[2];
  expect(ensureRequest?.body).toEqual(expect.any(String));
  const ensureBody = JSON.parse(ensureRequest.body);

  await writeFile(
    observationPath,
    JSON.stringify({ relayfilePaths: ensureBody.relayfilePaths ?? null }),
    'utf8'
  );
});
`;

const probeConfigSource = `export default {
  test: {
    environment: 'node',
    include: ['packages/cloud/src/.relayflow-1630-scoped-relayfile-sandbox-mount.test.ts'],
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
    'Relayfile subtree forwarding probe',
    { RELAY_PR1630_OBSERVATION_PATH: probeObservationPath }
  );

  const observation = JSON.parse(await readFile(probeObservationPath, 'utf8'));
  const cliSource = await readFile(path.join(targetDir, 'packages/cli/src/cli/commands/fleet.ts'), 'utf8');
  const cliHasScopedMountFlag = cliSource.includes("'--sandbox-relayfile-path <path...>'");
  const requestedPaths = ['/live-review/run-123/**', '/live-review/run-123/reviews/**'];
  const baseObserved = observation.relayfilePaths === null && !cliHasScopedMountFlag;
  const headObserved =
    JSON.stringify(observation.relayfilePaths) === JSON.stringify(requestedPaths) && cliHasScopedMountFlag;

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'absent';
    signature = 'relayfile_sandbox_paths_not_forwarded';
    details =
      'The base Cloud client dropped requested Relayfile subtrees and the fleet spawn CLI exposed no scoped-mount flag.';
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'relayfile_sandbox_paths_forwarded';
    details =
      'The head Cloud client forwarded the exact requested Relayfile subtrees and the fleet spawn CLI exposed the scoped-mount flag.';
  } else {
    throw new Error(
      `Unexpected scoped Relayfile mount observation: ${JSON.stringify({
        ...observation,
        cliHasScopedMountFlag,
      })}.`
    );
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
