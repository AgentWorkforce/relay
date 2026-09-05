import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1656-long-running-agent37-sandbox';
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

const probePath = path.join(targetDir, 'packages/cloud/src/.relayflow-1656-agent37.test.ts');
const observationPath = path.join(targetDir, '.relayflow-1656-agent37-observation.json');
const configPath = path.join(targetDir, '.relayflow-1656-agent37.vitest.config.mjs');

const probeSource = String.raw`import { expect, test, vi } from 'vitest';
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

test('observes profile forwarding and Agent37 attribution', async () => {
  const output = process.env.RELAY_PR1656_OBSERVATION_PATH;
  if (!output) throw new Error('Missing RELAY_PR1656_OBSERVATION_PATH.');
  const auth = {
    accessToken: 'relayflow-probe-access',
    refreshToken: 'relayflow-probe-refresh',
    accessTokenExpiresAt: '2099-01-01T00:00:00Z',
    apiUrl: 'https://relayflow.invalid',
  };
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
          nodeName: 'agent37-relayflow',
          sandboxId: 'sandbox-relayflow',
          relayWorkspaceId: 'rw_relayflow',
          relayfileMounted: false,
          providerId: 'agent37',
        },
        { status: 201 }
      ),
      auth,
    });

  const ready = await ensureCloudFleetSandbox({
    workspaceId: 'rw_relayflow',
    requiredCapability: 'spawn:codex',
    mountRelayfile: false,
    workloadProfile: 'long-running-agent',
  } as any);
  const request = mocks.authorizedApiFetch.mock.calls[1]?.[2];
  expect(request?.body).toEqual(expect.any(String));
  const body = JSON.parse(request.body);
  await writeFile(
    output,
    JSON.stringify({
      workloadProfile: body.workloadProfile ?? null,
      providerId: ready.providerId ?? null,
    }),
    'utf8'
  );
});
`;

const configSource = `export default {
  test: {
    environment: 'node',
    include: ['packages/cloud/src/.relayflow-1656-agent37.test.ts'],
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
  await writeGeneratedFile(configPath, configSource);
  run(
    'npm',
    ['exec', '--', 'vitest', 'run', '--config', path.relative(targetDir, configPath)],
    targetDir,
    'long-running Agent37 probe',
    { RELAY_PR1656_OBSERVATION_PATH: observationPath }
  );

  const observation = JSON.parse(await readFile(observationPath, 'utf8'));
  const cliSource = await readFile(
    path.join(targetDir, 'packages/cli/src/cli/commands/fleet.ts'),
    'utf8'
  );
  const cliRequestsLongRunning = cliSource.includes("workloadProfile: 'long-running-agent'");
  const baseObserved =
    observation.workloadProfile === null && observation.providerId === null && !cliRequestsLongRunning;
  const headObserved =
    observation.workloadProfile === 'long-running-agent' &&
    observation.providerId === 'agent37' &&
    cliRequestsLongRunning;

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'absent';
    signature = 'long_running_profile_and_agent37_attribution_absent';
    details =
      'The base CLI did not request long-running semantics, the Cloud client omitted the profile, and Agent37 attribution was discarded.';
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'long_running_profile_and_agent37_attribution_preserved';
    details =
      'The head CLI requests long-running semantics, the Cloud client forwards that exact profile, and Agent37 attribution is preserved.';
  } else {
    throw new Error(
      `Unexpected long-running Agent37 observation: ${JSON.stringify({
        ...observation,
        cliRequestsLongRunning,
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
    if (!existing.isFile()) throw new Error(`Refusing to replace non-regular file ${targetPath}.`);
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
