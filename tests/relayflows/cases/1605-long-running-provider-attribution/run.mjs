#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1605-long-running-provider-attribution';
const arm = requiredValue('RELAY_PR_PROOF_ARM');
const targetDir = path.resolve(requiredValue('RELAY_PR_PROOF_TARGET_DIR'));
const harnessDir = path.resolve(requiredValue('RELAY_PR_PROOF_HARNESS_DIR'));
const resultPath = requiredValue('RELAY_PR_PROOF_RESULT_PATH');
if (arm !== 'base' && arm !== 'head') throw new Error('RelayFlow proof arm must be base or head');

const expectedSha = requiredValue(arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA');
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}`);
}
const runnerPath = fileURLToPath(import.meta.url);
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('RelayFlow runner must execute from the exact-head harness checkout');
}

const probePath = path.join(
  targetDir,
  'packages/cloud/src/.relayflow-1605-long-running-provider-attribution.test.ts'
);
const observationPath = path.join(
  targetDir,
  '.relayflow-1605-long-running-provider-attribution-observation.json'
);
const configPath = path.join(
  targetDir,
  '.relayflow-1605-long-running-provider-attribution.vitest.config.mjs'
);

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

const auth = {
  accessToken: 'relayflow-access',
  refreshToken: 'relayflow-refresh',
  accessTokenExpiresAt: '2099-01-01T00:00:00Z',
  apiUrl: 'https://relayflow.invalid',
};

test('observes semantic request routing and provider attribution', async () => {
  const observationPath = process.env.RELAY_PR1605_OBSERVATION_PATH;
  if (!observationPath) throw new Error('Missing RELAY_PR1605_OBSERVATION_PATH');
  mocks.ensureCloudSession.mockResolvedValue({ auth, client: {} });
  mocks.authorizedApiFetch
    .mockResolvedValueOnce({
      response: Response.json({ cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99' }),
      auth,
    })
    .mockResolvedValueOnce({
      response: Response.json({
        outcome: 'provisioned',
        nodeId: 'node-agent37-proof',
        nodeName: 'agent37-proof',
        sandboxId: 'sandbox-agent37-proof',
        relayWorkspaceId: 'rw_agent37_proof',
        relayfileMounted: true,
        providerId: 'agent37',
      }, { status: 201 }),
      auth,
    });

  const request = {
    workspaceId: 'rw_agent37_proof',
    requiredCapability: 'spawn:codex',
    mountRelayfile: true,
    forceProvision: true,
    workloadProfile: 'long-running-agent',
  } as Parameters<typeof ensureCloudFleetSandbox>[0] & Record<string, unknown>;
  const result = await ensureCloudFleetSandbox(request);
  expect(mocks.authorizedApiFetch).toHaveBeenCalledTimes(2);
  const ensureCall = mocks.authorizedApiFetch.mock.calls[1];
  const body = JSON.parse(String(ensureCall?.[2]?.body ?? '{}'));
  const providerId = (result as unknown as { providerId?: string }).providerId;
  await writeFile(observationPath, JSON.stringify({ body, providerId }), 'utf8');
});
`;
const configSource = `export default { test: { environment: 'node', include: ['packages/cloud/src/.relayflow-1605-long-running-provider-attribution.test.ts'], setupFiles: [] } };\n`;

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
    'semantic fleet request probe',
    { RELAY_PR1605_OBSERVATION_PATH: observationPath }
  );

  const observation = JSON.parse(await readFile(observationPath, 'utf8'));
  const fixed =
    observation?.body?.workloadProfile === 'long-running-agent' && observation?.providerId === 'agent37';
  const absent = observation?.body?.workloadProfile === undefined && observation?.providerId === undefined;
  if (!fixed && !absent) {
    throw new Error(`Unexpected semantic routing observation: ${JSON.stringify(observation)}`);
  }
  const outcome = fixed ? 'fixed' : 'absent';
  const signature = fixed
    ? 'long_running_profile_with_agent37_attribution'
    : 'semantic_profile_and_attribution_absent';
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify(
      {
        version: 1,
        caseId: CASE_ID,
        arm,
        outcome,
        signature,
        details: fixed
          ? 'Cloud request carried long-running-agent and the normalized result retained Agent37 attribution.'
          : 'Cloud request omitted semantic workload intent and discarded provider attribution.',
      },
      null,
      2
    )}\n`,
    'utf8'
  );
} finally {
  await rm(probePath, { force: true });
  await rm(configPath, { force: true });
  await rm(observationPath, { force: true });
}

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
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
      }`
    );
  }
}
