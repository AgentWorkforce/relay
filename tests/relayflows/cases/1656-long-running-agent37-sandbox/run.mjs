/**
 * relay#1656 — `agent-relay fleet spawn --sandbox` must ask Cloud for
 * long-running semantics with a one-to-one sandbox identity, preserve the
 * provider Cloud actually chose, and retain an explicitly replayable identity
 * when a later local output failure occurs.
 *
 * The claim has two halves and they live in different packages, so the probe
 * runs them as one chain rather than as two independent assertions:
 *
 *   `fleet spawn --sandbox` (packages/cli)
 *      -> ensureCloudFleetSandbox   (packages/cloud, REAL)
 *      -> POST /fleet/nodes/sandbox/ensure   <- identity/profile observed here
 *      <- Cloud answers `providerId: agent37`
 *      -> deleteCloudFleetSandbox   (packages/cloud, REAL)
 *      -> DELETE /fleet/nodes/sandbox/<id>   <- providerId observed here
 *
 * The Cloud network boundary (`packages/cloud/src/auth.js`) is stubbed, as is
 * the separate repository-materialization prerequisite added after this case
 * was written. The flag parsing, spawn handler, sandbox request construction,
 * provider parsing, and cleanup call are all the target checkout's own code.
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
 * After dispatch succeeds, the probe captures the CLI's JSON output and makes
 * that output sink fail on purpose. This observes the normalized Cloud response
 * and drives the same command into cleanup, where provider attribution is used.
 *
 * Base: the CLI sends no sandbox identity, while the existing long-running
 * profile and Cloud-selected `agent37` response and cleanup attribution are
 * present. Head: an explicit replay
 * `sbx_<UUID>` identity, deterministic node name, and long-running profile
 * reach the ensure body, while the exact public identity reaches cleanup and
 * the separate physical provider sandbox ID is returned as evidence. Base does
 * not know the replay flags, so it remains the negative arm.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1656-long-running-agent37-sandbox';
const REPLAY_SANDBOX_ID = 'sbx_123e4567-e89b-42d3-a456-426614174000';
const REPLAY_SANDBOX_NAME = 'fleet-sandbox-123e4567-e89b-42d3-a456-426614174000';
const PROVIDER_SANDBOX_ID = 'provider-sandbox-relayflow';
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
const targetOrigin = execFileSync('git', ['-C', targetDir, 'remote', 'get-url', 'origin'], {
  encoding: 'utf8',
}).trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
}

const runnerPath = fileURLToPath(import.meta.url);
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

// The CLI correctly refuses to create a sandbox from a dirty checkout. Run the
// generated Vitest probe in a disposable exact-SHA clone, and ignore only the
// three generated probe artifacts there so the cleanliness guard observes the
// candidate source rather than the test harness itself.
const scratchRoot = await mkdtemp(path.join(tmpdir(), 'relayflow-1656-target-'));
const workingDir = path.join(scratchRoot, 'target');
const probePath = path.join(workingDir, 'packages/cloud/src/.relayflow-1656-agent37.test.ts');
const observationPath = path.join(workingDir, '.relayflow-1656-agent37-observation.json');
const configPath = path.join(workingDir, '.relayflow-1656-agent37.vitest.config.mjs');

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
  materializeCloudRelayfileRepository: vi.fn(),
  persistWorkspaceRelaycastTarget: vi.fn(() => true),
  resolveWorkspaceSelection: vi.fn(() => ({ workspaceId: 'rw_relayflow' })),
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
const REPLAY_SANDBOX_ID = 'sbx_123e4567-e89b-42d3-a456-426614174000';
const REPLAY_SANDBOX_NAME = 'fleet-sandbox-123e4567-e89b-42d3-a456-426614174000';
const PROVIDER_SANDBOX_ID = 'provider-sandbox-relayflow';
const auth = {
  accessToken: 'relayflow-probe-access',
  refreshToken: 'relayflow-probe-refresh',
  accessTokenExpiresAt: '2099-01-01T00:00:00Z',
  apiUrl: 'https://relayflow.invalid',
};

test('fleet spawn --sandbox replays and retains an exact provider-attributed identity', async () => {
  const output = process.env.RELAY_PR1656_OBSERVATION_PATH;
  if (!output) throw new Error('Missing RELAY_PR1656_OBSERVATION_PATH.');
  const proofArm = process.env.RELAY_PR_PROOF_ARM;

  mocks.ensureCloudSession.mockResolvedValue({ auth, client: {} });
  mocks.materializeCloudRelayfileRepository.mockResolvedValue({
    cloudWorkspaceId: CLOUD_WORKSPACE_ID,
    repository: 'AgentWorkforce/relay',
    revision: process.env.RELAY_PR_PROOF_TARGET_SHA,
    filesWritten: 1,
    sourceProfile: 'complete-v1',
    contentRoot: '/github/repos/AgentWorkforce/relay/contents',
    sentinelPath: '/github/repos/AgentWorkforce/relay/.relayfile/clone.json',
  });
  const provisionedResponse = {
    outcome: 'provisioned',
    nodeId: 'node-relayflow',
    nodeName: REPLAY_SANDBOX_NAME,
    sandboxId: REPLAY_SANDBOX_ID,
    providerSandboxId: PROVIDER_SANDBOX_ID,
    relayWorkspaceId: 'rw_relayflow',
    relaycastTarget: {
      route: 'agent37-isolated',
      baseUrl: 'https://agent37-cast.agentrelay.com',
      workspaceId: 'rw_relayflow',
      relaycastApiKey: 'rk_live_relayflow_probe',
    },
    relayfileMounted: true,
    relayfileMountPath: '/workspace',
    providerId: 'agent37',
  };
  mocks.authorizedApiFetch
    // 1. workspace resolution
    .mockResolvedValueOnce({ response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }), auth })
    // 2. provisioning. Cloud selects agent37 on its own; the command line below
    //    never names a provider, which is the whole point of the feature.
    .mockResolvedValueOnce({
      response: Response.json(
        provisionedResponse,
        { status: 201 }
      ),
      auth,
    })
    // 3. cleanup, triggered by the deliberate output-sink failure below
    .mockResolvedValueOnce({
      response: Response.json({ sandboxId: REPLAY_SANDBOX_ID, deleted: true }),
      auth,
    });

  const errors: string[] = [];
  // A progress line ahead of the JSON result proves the observation does not
  // depend on the result being the first (or only) CLI output call.
  const cliOutput: string[] = ['Preparing sandbox dispatch'];
  const replayArgs =
    process.env.RELAY_PR_PROOF_ARM === 'head'
      ? ['--sandbox-id', REPLAY_SANDBOX_ID, '--sandbox-name', REPLAY_SANDBOX_NAME]
      : [];
  const program = new Command();
  program.exitOverride();
  registerFleetCommands(program, {
    sdk: {
      createAgentRelay: vi.fn(() => ({
        messaging: {
          placement: {
            spawn: vi.fn(async () => ({
              invocationId: 'inv_relayflow',
              node: { name: REPLAY_SANDBOX_NAME },
            })),
          },
        },
      })) as never,
      createWorkspaceRelay: vi.fn(() => ({
        workspace: {
          info: vi.fn(async () => ({ id: 'rw_relayflow' })),
          register: vi.fn(async () => ({ token: 'at_relayflow_launcher' })),
          release: vi.fn(async () => undefined),
        },
      })) as never,
      createWorkspace: vi.fn() as never,
      // Capture the real CLI serialization, then fail so this same invocation
      // exercises cleanup without sourcing evidence from the network mock.
      log: (...args: unknown[]) => {
        const line = args.join(' ');
        cliOutput.push(line);
        let candidate: { sandbox?: { sandboxId?: unknown } } | null = null;
        try {
          candidate = JSON.parse(line);
        } catch {
          // Auxiliary CLI output is allowed; only the sandbox result drives cleanup.
        }
        if (candidate?.sandbox?.sandboxId === REPLAY_SANDBOX_ID) {
          throw new Error('CLI output sink failed after capture');
        }
      },
      error: (...args: unknown[]) => errors.push(args.join(' ')),
      exit: (() => {
        throw new Error('__exit__');
      }) as never,
    },
    ensureCloudFleetSandbox,
    materializeCloudRelayfileRepository: mocks.materializeCloudRelayfileRepository,
    deleteCloudFleetSandbox,
    resolveWorkspaceSelection: mocks.resolveWorkspaceSelection,
    persistWorkspaceRelaycastTarget: mocks.persistWorkspaceRelaycastTarget,
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
        ...replayArgs,
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

  // The command really reached successful dispatch and serialized its result;
  // without this a probe that never reached the sandbox path could report a false base.
  expect(errors.join('\n')).toContain('CLI output sink failed after capture');
  const sandboxResults = cliOutput.flatMap((line) => {
    try {
      const candidate = JSON.parse(line);
      return candidate?.sandbox?.sandboxId === REPLAY_SANDBOX_ID ? [candidate] : [];
    } catch {
      return [];
    }
  });
  if (sandboxResults.length !== 1) {
    throw new Error(
      'Expected exactly one serialized sandbox result, found ' +
        String(sandboxResults.length) +
        '.'
    );
  }

  const ensureCall = mocks.authorizedApiFetch.mock.calls.find(
    (call) => call[1] === '/api/v1/fleet/nodes/sandbox/ensure'
  );
  const deleteCall = mocks.authorizedApiFetch.mock.calls.find(
    (call) => String(call[1]).startsWith('/api/v1/fleet/nodes/sandbox/') && call[2]?.method === 'DELETE'
  );
  const ensureRequest = ensureCall?.[2];
  const deleteRequest = deleteCall?.[2];
  expect(ensureRequest?.body).toEqual(expect.any(String));
  if (proofArm === 'head') expect(deleteCall).toBeUndefined();
  else expect(deleteRequest?.body).toEqual(expect.any(String));
  const ensureBody = JSON.parse(ensureRequest.body);
  const deleteBody = deleteRequest?.body ? JSON.parse(deleteRequest.body) : {};
  const [cliResult] = sandboxResults;

  await writeFile(
    output,
    JSON.stringify({
      ensureWorkloadProfile: ensureBody.workloadProfile ?? null,
      ensureSandboxId: ensureBody.sandboxId ?? null,
      ensureForceProvision: ensureBody.forceProvision ?? null,
      ensureName: ensureBody.name ?? null,
      ensureProviderId: ensureBody.providerId ?? null,
      responseSandboxId: cliResult.sandbox?.sandboxId ?? null,
      responseProviderSandboxId: cliResult.sandbox?.providerSandboxId ?? null,
      responseProviderId: cliResult.sandbox?.providerId ?? null,
      responseNodeName: cliResult.sandbox?.nodeName ?? null,
      cleanupAttempted: deleteCall !== undefined,
      deleteSandboxId:
        decodeURIComponent(String(deleteCall?.[1] ?? '').split('/').pop() ?? '') || null,
      deleteProviderId: deleteBody.providerId ?? null,
      relaycastTargetPersisted: mocks.persistWorkspaceRelaycastTarget.mock.calls.length === 1,
      outputFailureObserved: errors.join('\n').includes('CLI output sink failed after capture'),
    }),
    'utf8'
  );
});
`;

try {
  run(
    'git',
    ['clone', '--quiet', '--shared', '--no-checkout', targetDir, workingDir],
    targetDir,
    'clone exact target into disposable workspace',
    INSTALL_TIMEOUT_MS
  );
  run(
    'git',
    ['-C', workingDir, 'checkout', '--quiet', '--detach', expectedSha],
    workingDir,
    'checkout exact target in disposable workspace',
    INSTALL_TIMEOUT_MS
  );
  run(
    'git',
    ['-C', workingDir, 'remote', 'set-url', 'origin', targetOrigin],
    workingDir,
    'preserve target GitHub origin in disposable workspace',
    INSTALL_TIMEOUT_MS
  );
  // pull_request workflows execute GitHub's synthetic merge commit. It is an
  // exact hosted candidate, but it is fetched through refs/pull/*/merge rather
  // than an origin/* remote-tracking branch. Model the pushed precondition in
  // the disposable probe clone without changing the candidate checkout.
  run(
    'git',
    ['-C', workingDir, 'update-ref', 'refs/remotes/origin/relayflow-proof', expectedSha],
    workingDir,
    'mark exact hosted candidate as origin-tracked in disposable workspace',
    INSTALL_TIMEOUT_MS
  );
  await appendFile(
    path.join(workingDir, '.git/info/exclude'),
    [
      '',
      '.relayflow-1656-agent37-observation.json',
      '.relayflow-1656-agent37.vitest.config.mjs',
      'packages/cloud/src/.relayflow-1656-agent37.test.ts',
      '',
    ].join('\n'),
    'utf8'
  );

  // The probe drives the CLI, so the whole workspace is installed rather than
  // packages/cloud alone. No package build is needed: the config above resolves
  // every `@agent-relay/*` import to its TypeScript source.
  run(
    'npm',
    ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    workingDir,
    'workspace dependency installation',
    INSTALL_TIMEOUT_MS
  );

  await writeGeneratedFile(probePath, probeSource);
  await writeGeneratedFile(configPath, probeConfigSource);
  run(
    'npm',
    ['exec', '--', 'vitest', 'run', '--config', path.relative(workingDir, configPath)],
    workingDir,
    'long-running Agent37 CLI probe',
    PROBE_TIMEOUT_MS,
    { RELAY_PR1656_OBSERVATION_PATH: observationPath }
  );

  const observation = JSON.parse(await readFile(observationPath, 'utf8'));
  if (observation.outputFailureObserved !== true) {
    throw new Error('The probe did not serialize the CLI sandbox result, so it observed nothing.');
  }
  if (arm === 'head' && observation.relaycastTargetPersisted !== true) {
    throw new Error("The head did not persist Cloud's Relaycast target before dispatch.");
  }
  // The command line named no provider on either arm. If this ever stops being
  // true the case is proving provider pinning, not capability routing.
  if (observation.ensureProviderId !== null) {
    throw new Error(
      `The CLI pinned a provider (${JSON.stringify(observation.ensureProviderId)}); this case must route without one.`
    );
  }

  const baseObserved =
    observation.ensureSandboxId === null &&
    observation.ensureWorkloadProfile === 'long-running-agent' &&
    observation.responseSandboxId === REPLAY_SANDBOX_ID &&
    observation.responseProviderSandboxId === null &&
    observation.responseProviderId === 'agent37' &&
    observation.responseNodeName === REPLAY_SANDBOX_NAME &&
    observation.cleanupAttempted === true &&
    observation.deleteSandboxId === REPLAY_SANDBOX_ID &&
    observation.deleteProviderId === 'agent37';
  const sandboxIdentityObserved =
    typeof observation.ensureSandboxId === 'string' &&
    /^sbx_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      observation.ensureSandboxId
    ) &&
    observation.ensureName === `fleet-sandbox-${observation.ensureSandboxId.slice('sbx_'.length)}` &&
    observation.ensureForceProvision === true;
  const replayIdentityObserved =
    observation.ensureSandboxId === REPLAY_SANDBOX_ID && observation.ensureName === REPLAY_SANDBOX_NAME;
  const headObserved =
    observation.ensureWorkloadProfile === 'long-running-agent' &&
    sandboxIdentityObserved &&
    replayIdentityObserved &&
    observation.responseSandboxId === REPLAY_SANDBOX_ID &&
    observation.responseProviderSandboxId === PROVIDER_SANDBOX_ID &&
    observation.responseProviderId === 'agent37' &&
    observation.responseNodeName === REPLAY_SANDBOX_NAME &&
    observation.cleanupAttempted === false &&
    observation.deleteSandboxId === null &&
    observation.deleteProviderId === null;

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'absent';
    signature = 'long_running_profile_replay_identity_absent_agent37_attribution_preserved';
    details =
      "fleet spawn --sandbox reached Cloud with the existing long-running profile and Cloud's agent37 response, but without a caller-declared sandbox identity; the one-to-one replay identity and separately observed providerSandboxId are absent while agent37 cleanup attribution remains preserved.";
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'long_running_profile_replay_identity_retained_and_agent37_attribution_preserved';
    details =
      "fleet spawn --sandbox replayed the exact caller-declared sbx_<UUID>/fleet-sandbox-<UUID> identity with workloadProfile 'long-running-agent' and forceProvision true without pinning a provider; Cloud echoed the public identity, returned a separate providerSandboxId with agent37 attribution, and a later local output failure did not delete the explicitly retained sandbox.";
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
  await rm(scratchRoot, { recursive: true, force: true });
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
