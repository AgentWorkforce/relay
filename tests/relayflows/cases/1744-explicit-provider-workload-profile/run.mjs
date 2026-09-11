/**
 * relay#1744 — an explicit Daytona or E2B Fleet sandbox must not inherit the
 * 8 CPU / 16 GiB / 20 GiB Agent37 workload profile that those providers cannot
 * satisfy. The probe drives the real `fleet spawn --sandbox` command into the
 * real Cloud client and observes only the Cloud HTTP boundary. It also drives
 * the explicit Agent37 path so the fix cannot silently weaken that provider's
 * deliberate heavy-resource contract.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1744-explicit-provider-workload-profile';
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

const probePath = path.join(
  targetDir,
  'packages/cloud/src/.relayflow-1744-explicit-provider-profile.test.ts'
);
const observationPath = path.join(targetDir, '.relayflow-1744-explicit-provider-profile-observation.json');
const configPath = path.join(targetDir, '.relayflow-1744-explicit-provider-profile.vitest.config.mjs');

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
    include: ['packages/cloud/src/.relayflow-1744-explicit-provider-profile.test.ts'],
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

vi.mock('./auth.js', () => ({
  ensureCloudSession: mocks.ensureCloudSession,
  authorizedApiFetch: mocks.authorizedApiFetch,
}));

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
        broker_version: '12.0.0',
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

import { ensureCloudFleetSandbox } from './fleet-sandbox.js';
import { registerFleetCommands } from '../../cli/src/cli/commands/fleet.js';

const auth = {
  accessToken: 'relayflow-probe-access',
  refreshToken: 'relayflow-probe-refresh',
  accessTokenExpiresAt: '2099-01-01T00:00:00Z',
  apiUrl: 'https://relayflow.invalid',
};
const cloudWorkspaceId = '50587328-441d-4acb-b8f3-dbe1b3c5de99';
const targets = {
  daytona: {
    route: 'canonical',
    baseUrl: 'https://cast.agentrelay.com',
    workspaceId: 'rw_relayflow',
    relaycastApiKey: 'rk_live_daytona_target',
  },
  e2b: {
    route: 'canonical',
    baseUrl: 'https://cast.agentrelay.com',
    workspaceId: 'rw_relayflow',
    relaycastApiKey: 'rk_live_e2b_target',
  },
  agent37: {
    route: 'agent37-isolated',
    baseUrl: 'https://agent37-cast.agentrelay.com',
    workspaceId: 'rw_relayflow',
    relaycastApiKey: 'rk_live_agent37_target',
  },
} as const;

test('explicit provider selection emits the provider-compatible Cloud workload profile', async () => {
  const output = process.env.RELAY_PR1744_OBSERVATION_PATH;
  if (!output) throw new Error('Missing RELAY_PR1744_OBSERVATION_PATH.');

  mocks.ensureCloudSession.mockResolvedValue({ auth, client: {} });
  const profiles: Record<string, unknown> = {};

  for (const provider of ['daytona', 'e2b', 'agent37'] as const) {
    const callsBefore = mocks.authorizedApiFetch.mock.calls.length;
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId }),
        auth,
      })
      .mockResolvedValueOnce({
        response: Response.json({
          outcome: 'reused',
          cloudWorkspaceId,
          nodeId: 'node-' + provider,
          nodeName: provider + '-worker',
          status: 'online',
          activeAgents: 0,
          maxAgents: 1,
          relayWorkspaceId: 'rw_relayflow',
          relayfileMounted: false,
          providerId: provider,
          relaycastTarget: targets[provider],
        }),
        auth,
      });

    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn(() => ({
          messaging: {
            placement: {
              spawn: vi.fn(async () => ({
                invocationId: 'inv_' + provider,
                node: { name: provider + '-worker' },
              })),
            },
          },
        })) as never,
        createWorkspaceRelay: vi.fn(() => ({
          workspace: {
            info: vi.fn(async () => ({ id: 'rw_relayflow' })),
            register: vi.fn(async () => ({ token: 'at_launcher_' + provider })),
            release: vi.fn(async () => ({ released: true, deleted: true })),
          },
        })) as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      ensureCloudFleetSandbox,
      resolveWorkspaceSelection: () => ({
        key: 'rk_live_test',
        source: 'project',
        origin: '/tmp/relayflow/workspace-key.json',
        workspaceId: 'rw_relayflow',
      }),
      persistWorkspaceRelaycastTarget: () => true,
      deleteCloudFleetSandbox: vi.fn(async () => undefined),
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as never);

    await program.parseAsync(
      [
        'fleet',
        'spawn',
        'codex',
        '--sandbox',
        '--sandbox-provider',
        provider,
        '--no-sandbox-relayfile',
        '--workspace-id',
        'rw_relayflow',
        '--name',
        provider + '-worker',
        '--task',
        'Observe provider workload profile',
        '--workspace-key',
        'rk_live_test',
        '--token',
        'at_live_lead',
      ],
      { from: 'user' }
    );

    const providerCalls = mocks.authorizedApiFetch.mock.calls.slice(callsBefore);
    expect(providerCalls).toHaveLength(2);
    const ensureRequest = providerCalls[1]?.[2];
    expect(ensureRequest?.method).toBe('POST');
    expect(ensureRequest?.body).toEqual(expect.any(String));
    const ensureBody = JSON.parse(ensureRequest.body);
    expect(ensureBody.providerId).toBe(provider);
    profiles[provider] = ensureBody.workloadProfile ?? null;
  }

  await writeFile(output, JSON.stringify({ profiles }), 'utf8');
});
`;

try {
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
    'explicit provider workload profile probe',
    PROBE_TIMEOUT_MS,
    { RELAY_PR1744_OBSERVATION_PATH: observationPath }
  );

  const observation = JSON.parse(await readFile(observationPath, 'utf8'));
  const baseObserved =
    observation.profiles?.daytona === 'long-running-agent' &&
    observation.profiles?.e2b === 'long-running-agent' &&
    observation.profiles?.agent37 === 'long-running-agent';
  const headObserved =
    observation.profiles?.daytona === 'standard-long-running-agent' &&
    observation.profiles?.e2b === 'standard-long-running-agent' &&
    observation.profiles?.agent37 === 'long-running-agent';

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'bug';
    signature = 'explicit_legacy_providers_receive_impossible_heavy_profile';
    details =
      'The real Fleet CLI sent long-running-agent for explicit Daytona, E2B, and Agent37 requests, making the legacy providers unroutable against their measured resource envelopes.';
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'explicit_provider_profiles_are_routable_and_agent37_stays_heavy';
    details =
      'The real Fleet CLI sent standard-long-running-agent for explicit Daytona and E2B requests while preserving long-running-agent for explicit Agent37.';
  } else {
    throw new Error(`Unexpected explicit-provider workload profiles: ${JSON.stringify(observation)}.`);
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
