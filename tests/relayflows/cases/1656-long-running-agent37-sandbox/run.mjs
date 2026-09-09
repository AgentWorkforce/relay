/**
 * relay#1656 — `agent-relay fleet spawn --sandbox` must ask Cloud for
 * long-running semantics and must clean up against the provider Cloud actually
 * chose.
 *
 * The claim has two halves and they live in different packages, so the probe
 * runs them as one chain rather than as two independent assertions:
 *
 *   `fleet spawn --sandbox` (packages/cli)
 *      -> ensureCloudFleetSandbox   (packages/cloud, REAL)
 *      -> POST /fleet/nodes/sandbox/ensure   <- workloadProfile observed here
 *      <- Cloud answers `providerId: agent37`
 *      -> deleteCloudFleetSandbox   (packages/cloud, REAL)
 *      -> DELETE /fleet/nodes/sandbox/<id>   <- providerId observed here
 *
 * The ONLY stub between the command line and those two request bodies is the
 * Cloud network boundary (`packages/cloud/src/auth.js`). The flag parsing, the
 * spawn handler, the Cloud client's request construction, its provider parsing,
 * and the CLI's cleanup call are all the target checkout's own code.
 *
 * An earlier revision of this case asserted the CLI half with
 * `cliSource.includes("workloadProfile: 'long-running-agent'")` and called
 * `ensureCloudFleetSandbox` directly with that profile hardcoded. Both reviewers
 * were right to reject it: a source grep passes on a dead branch or a comment,
 * and hardcoding the profile proves only that the client forwards whatever it is
 * handed. Nothing there exercised `--sandbox`, and nothing exercised cleanup
 * attribution. Neither shortcut survives here — the profile is never written by
 * the probe, and the provider is never written by the probe.
 *
 * The probe deliberately requests NO `--sandbox-provider`. That is the feature:
 * Cloud picks the provider, and `agent37` must survive back out into cleanup.
 * Dispatch is then failed on purpose, because the cleanup call is what carries
 * the attribution.
 *
 * Base: the CLI sends no workload profile, and `agent37` is not a provider the
 * Cloud client will parse, so it is dropped and cleanup names no provider.
 * Head: the profile reaches the ensure body and `agent37` reaches the delete
 * body.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1656-long-running-agent37-sandbox';
// Separate budgets, both inside case.json's 900s per-arm deadline. The install
// and the probe are very different jobs and a shared cap sizes neither: a
// timeout on either is an INFRASTRUCTURE failure, which cannot report red or
// green, so the install must never be able to starve the probe of its budget.
// Measured in Cloud on this case: install 18s, probe 2s. These are ~25x that.
const INSTALL_TIMEOUT_MS = 8 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5 * 60 * 1000;
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

// Workspace packages the probe's import graph reaches. The root vitest config
// aliases these to `src` so tests run against a fresh checkout without a build;
// the probe needs the same mapping, and it must be the same mapping, or
// `./auth.js` inside fleet-sandbox.ts and the mock below would resolve to two
// different modules and the network would not actually be stubbed.
const probeConfigSource = `import path from 'node:path';

const workspacePackages = [
  'cloud',
  'config',
  'fleet',
  'harness-driver',
  'harnesses',
  'policy',
  'sdk',
  'session',
  'utils',
];

export default {
  resolve: {
    alias: workspacePackages.flatMap((name) => {
      const sourceRoot = path.resolve(process.cwd(), 'packages', name, 'src');
      return [
        { find: new RegExp('^@agent-relay/' + name + '/(.+)$'), replacement: sourceRoot + '/$1' },
        { find: '@agent-relay/' + name, replacement: path.join(sourceRoot, 'index.ts') },
      ];
    }),
  },
  test: {
    environment: 'node',
    include: ['packages/cloud/src/.relayflow-1656-agent37.test.ts'],
    setupFiles: [],
  },
};
`;

const probeSource = String.raw`import { expect, test, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  ensureCloudSession: vi.fn(),
  authorizedApiFetch: vi.fn(),
}));

// The Cloud network boundary -- the only thing this probe stubs. Everything
// between the argv below and the request bodies read at the end is the target
// checkout's own code.
vi.mock('./auth.js', () => ({
  ensureCloudSession: mocks.ensureCloudSession,
  authorizedApiFetch: mocks.authorizedApiFetch,
}));

// 'fleet' commands read a local broker session at import/dispatch time. Neither
// is part of the claim under test and neither exists in a Cloud sandbox.
vi.mock('../../cli/src/cli/lib/broker-lifecycle.js', () => ({
  readBrokerConnection: vi.fn(() => ({ url: 'http://127.0.0.1:1', api_key: 'k', pid: 1, port: 1 })),
}));

vi.mock('@agent-relay/harness-driver', async (importOriginal) => ({
  ...(await importOriginal()),
  HarnessDriverClient: class {
    async getSession() {
      return {
        workspace_key: 'rk_probe_secret',
        node_token: 'nt_probe_secret',
        node_id: 'node_1',
        node_name: 'live-node',
        broker_version: '9.2.3',
        protocol_version: 2,
        mode: 'persist',
        uptime_secs: 1,
      };
    }
    async listAgents() {
      return [];
    }
    async listFleetInventory() {
      return { nodeName: 'live-node', agents: [] };
    }
    disconnect() {}
  },
}));

// The REAL Cloud client and the REAL CLI command registration, both from
// RELAY_PR_PROOF_TARGET_DIR.
import { deleteCloudFleetSandbox, ensureCloudFleetSandbox } from './fleet-sandbox.js';
import { registerFleetCommands } from '../../cli/src/cli/commands/fleet.js';

const CLOUD_WORKSPACE_ID = '50587328-441d-4acb-b8f3-dbe1b3c5de99';
const auth = {
  accessToken: 'relayflow-probe-access',
  refreshToken: 'relayflow-probe-refresh',
  accessTokenExpiresAt: '2099-01-01T00:00:00Z',
  apiUrl: 'https://relayflow.invalid',
};

test('fleet spawn --sandbox reaches Cloud with a profile and cleans up by returned provider', async () => {
  const output = process.env.RELAY_PR1656_OBSERVATION_PATH;
  if (!output) throw new Error('Missing RELAY_PR1656_OBSERVATION_PATH.');

  mocks.ensureCloudSession.mockResolvedValue({ auth, client: {} });
  mocks.authorizedApiFetch
    // 1. workspace resolution
    .mockResolvedValueOnce({ response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }), auth })
    // 2. provisioning. Cloud selects agent37 on its own; the command line below
    //    never names a provider, which is the whole point of the feature.
    .mockResolvedValueOnce({
      response: Response.json(
        {
          outcome: 'provisioned',
          nodeId: 'node-relayflow',
          nodeName: 'agent37-relayflow',
          sandboxId: 'sandbox-relayflow',
          relayWorkspaceId: 'rw_relayflow',
          relayfileMounted: true,
          relayfileMountPath: '/workspace',
          providerId: 'agent37',
        },
        { status: 201 }
      ),
      auth,
    })
    // 3. cleanup, triggered by the deliberate dispatch failure below
    .mockResolvedValueOnce({
      response: Response.json({ sandboxId: 'sandbox-relayflow', deleted: true }),
      auth,
    });

  const errors: string[] = [];
  const program = new Command();
  program.exitOverride();
  registerFleetCommands(program, {
    sdk: {
      // Dispatch fails on purpose: the cleanup call is what carries provider
      // attribution, and it only happens on this path.
      createAgentRelay: vi.fn(() => ({
        messaging: {
          placement: {
            spawn: vi.fn(async () => {
              throw new Error('dispatch failed');
            }),
          },
        },
      })) as never,
      createWorkspaceRelay: vi.fn(() => ({
        workspace: { info: vi.fn(async () => ({ id: 'rw_relayflow' })) },
      })) as never,
      createWorkspace: vi.fn() as never,
      log: vi.fn(),
      error: (...args: unknown[]) => errors.push(args.join(' ')),
      exit: (() => {
        throw new Error('__exit__');
      }) as never,
    },
    ensureCloudFleetSandbox,
    deleteCloudFleetSandbox,
    createFleetWorkspaceClient: vi.fn() as never,
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as never);

  await expect(
    program.parseAsync(
      [
        'fleet',
        'spawn',
        'codex',
        '--sandbox',
        '--name',
        'sandbox-worker',
        '--task',
        'Work',
        '--workspace-key',
        'rk_live_test',
        '--token',
        'at_live_lead',
      ],
      { from: 'user' }
    )
  ).rejects.toThrow('__exit__');

  // The command really ran and really failed dispatch; without this a probe
  // that never reached the sandbox path could report a false base.
  expect(errors.join('\n')).toContain('dispatch failed');

  const ensureRequest = mocks.authorizedApiFetch.mock.calls[1]?.[2];
  const deleteRequest = mocks.authorizedApiFetch.mock.calls[2]?.[2];
  expect(ensureRequest?.body).toEqual(expect.any(String));
  expect(deleteRequest?.body).toEqual(expect.any(String));
  const ensureBody = JSON.parse(ensureRequest.body);
  const deleteBody = JSON.parse(deleteRequest.body);

  await writeFile(
    output,
    JSON.stringify({
      ensureWorkloadProfile: ensureBody.workloadProfile ?? null,
      ensureProviderId: ensureBody.providerId ?? null,
      deleteProviderId: deleteBody.providerId ?? null,
      dispatchFailureObserved: errors.join('\n').includes('dispatch failed'),
    }),
    'utf8'
  );
});
`;

try {
  // The probe drives the CLI, so the whole workspace is installed rather than
  // packages/cloud alone. No package build is needed: the config above resolves
  // every `@agent-relay/*` import to its TypeScript source.
  run(
    'npm',
    ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    targetDir,
    'workspace dependency installation',
    INSTALL_TIMEOUT_MS
  );

  await writeGeneratedFile(probePath, probeSource);
  await writeGeneratedFile(configPath, probeConfigSource);
  run(
    'npm',
    ['exec', '--', 'vitest', 'run', '--config', path.relative(targetDir, configPath)],
    targetDir,
    'long-running Agent37 CLI probe',
    PROBE_TIMEOUT_MS,
    { RELAY_PR1656_OBSERVATION_PATH: observationPath }
  );

  const observation = JSON.parse(await readFile(observationPath, 'utf8'));
  if (observation.dispatchFailureObserved !== true) {
    throw new Error('The probe did not reach the sandbox dispatch path, so it observed nothing.');
  }
  // The command line named no provider on either arm. If this ever stops being
  // true the case is proving provider pinning, not capability routing.
  if (observation.ensureProviderId !== null) {
    throw new Error(
      `The CLI pinned a provider (${JSON.stringify(observation.ensureProviderId)}); this case must route without one.`
    );
  }

  const baseObserved = observation.ensureWorkloadProfile === null && observation.deleteProviderId === null;
  const headObserved =
    observation.ensureWorkloadProfile === 'long-running-agent' && observation.deleteProviderId === 'agent37';

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'absent';
    signature = 'long_running_profile_and_agent37_attribution_absent';
    details =
      'fleet spawn --sandbox reached Cloud with no workload profile in the ensure request, and the agent37 provider Cloud returned was dropped, so cleanup named no provider.';
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'long_running_profile_and_agent37_attribution_preserved';
    details =
      "fleet spawn --sandbox reached Cloud with workloadProfile 'long-running-agent' in the ensure request without pinning a provider, and the agent37 provider Cloud returned was carried into the cleanup request.";
  } else {
    throw new Error(`Unexpected long-running Agent37 observation: ${JSON.stringify(observation)}.`);
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
  process.stdout.write(`${signature}\n`);
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

function run(command, args, cwd, label, timeoutMs, extraEnv = {}) {
  const completed = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: timeoutMs,
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
