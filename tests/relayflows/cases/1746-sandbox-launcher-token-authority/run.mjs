/**
 * relay#1746 — after Cloud selects a Relaycast target, Fleet must use the
 * workspace key only to register/release a temporary launcher and the scoped
 * launcher token only to dispatch. The generated probe drives the real Fleet
 * command and invokes the target checkout's real SDK client constructor, so a
 * permissive test double cannot hide the SDK's dual-credential rejection.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1746-sandbox-launcher-token-authority';
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

const probePath = path.join(targetDir, 'packages/cli/src/.relayflow-1746-launcher-token.test.ts');
const observationPath = path.join(targetDir, '.relayflow-1746-launcher-token-observation.json');
const configPath = path.join(targetDir, '.relayflow-1746-launcher-token.vitest.config.mjs');

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
    include: ['packages/cli/src/.relayflow-1746-launcher-token.test.ts'],
    setupFiles: [],
  },
};
`;

const probeSource = String.raw`import { expect, test, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { createHash } from 'node:crypto';

vi.mock('./cli/lib/broker-lifecycle.js', () => ({
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

import { registerFleetCommands } from './cli/commands/fleet.js';
import { createAgentRelay as createRealAgentRelay } from './cli/lib/sdk-client.js';

test('sandbox dispatch constructs an agent client with exactly one authority', async () => {
  const output = process.env.RELAY_PR1746_OBSERVATION_PATH;
  if (!output) throw new Error('Missing RELAY_PR1746_OBSERVATION_PATH.');
  vi.stubEnv('RELAY_AGENT_TOKEN', undefined);

  const placement = {
    spawn: vi.fn(async () => ({
      invocationId: 'inv_relayflow_1746',
      node: { name: 'daytona-worker' },
    })),
  };
  let constructorOptions: Record<string, unknown> | undefined;
  let createdWorkspaceRelay: typeof workspaceRelay | undefined;
  const createAgentRelay = vi.fn((options: Record<string, unknown>) => {
    constructorOptions = options;
    // Exercise the target checkout's real credential exclusivity guard. The
    // resulting client is not used for network access; placement is replaced
    // only after construction succeeds.
    createRealAgentRelay({ ...options, env: {} });
    return { messaging: { placement } };
  });
  const register = vi.fn(async () => ({ token: 'at_live_launcher' }));
  const release = vi.fn(async () => ({ released: true, deleted: true }));
  const workspaceRelay = {
    workspace: {
      info: vi.fn(async () => ({ id: 'rw_relayflow' })),
      register,
      release,
    },
  };
  let workspaceRelayOptions: Record<string, unknown> | undefined;
  const createWorkspaceRelay = vi.fn((options: Record<string, unknown>) => {
    workspaceRelayOptions = options;
    createdWorkspaceRelay = workspaceRelay;
    return workspaceRelay;
  });
  const cliErrors: string[] = [];
  const program = new Command();
  program.exitOverride();
  registerFleetCommands(program, {
    sdk: {
      createAgentRelay: createAgentRelay as never,
      createWorkspaceRelay: createWorkspaceRelay as never,
      createWorkspace: vi.fn() as never,
      log: vi.fn(),
      error: (...args: unknown[]) => cliErrors.push(args.join(' ')),
      exit: (() => {
        throw new Error('__relayflow_exit__');
      }) as never,
    },
    ensureCloudFleetSandbox: vi.fn(async () => ({
      outcome: 'reused' as const,
      cloudWorkspaceId: 'cloud-workspace',
      nodeId: 'node-daytona',
      nodeName: 'daytona-worker',
      status: 'online',
      activeAgents: 0,
      maxAgents: 1,
      providerId: 'daytona' as const,
      relaycastTarget: {
        route: 'canonical' as const,
        baseUrl: 'https://cast.agentrelay.com',
        workspaceId: 'rw_relayflow',
        relaycastApiKey: 'rk_live_cloud_target',
      },
    })),
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

  let commandOutcome = 'success';
  try {
    await program.parseAsync(
      [
        'fleet',
        'spawn',
        'opencode',
        '--sandbox',
        '--sandbox-provider',
        'daytona',
        '--no-sandbox-relayfile',
        '--workspace-id',
        'rw_relayflow',
        '--name',
        'cheap-reviewer',
        '--task',
        'Review the candidate',
        '--workspace-key',
        'rk_live_test',
      ],
      { from: 'user' }
    );
  } catch (error) {
    if (error instanceof Error && error.message === '__relayflow_exit__') {
      commandOutcome = 'error';
    } else {
      throw error;
    }
  }

  expect(createAgentRelay).toHaveBeenCalledTimes(1);
  expect(createWorkspaceRelay).toHaveBeenCalledTimes(1);
  expect(createdWorkspaceRelay).toBe(workspaceRelay);
  expect(workspaceRelay.workspace.register).toBe(register);
  expect(workspaceRelay.workspace.release).toBe(release);
  expect(hashValue(constructorOptions?.token)).toBe(hashValue('at_live_launcher'));
  expect(hashValue(constructorOptions?.baseUrl)).toBe(hashValue('https://cast.agentrelay.com'));
  expect(hashValue(workspaceRelayOptions?.workspaceKey)).toBe(hashValue('rk_live_cloud_target'));
  expect(hashValue(workspaceRelayOptions?.baseUrl)).toBe(hashValue('https://cast.agentrelay.com'));
  await writeFile(
    output,
    JSON.stringify({
      commandOutcome,
      cliError: cliErrors.join('\n'),
      hasWorkspaceKey:
        typeof constructorOptions?.workspaceKey === 'string' && constructorOptions.workspaceKey.length > 0,
      tokenHash: hashValue(constructorOptions?.token),
      workspaceKeyHash: hashValue(workspaceRelayOptions?.workspaceKey),
      baseUrlHash: hashValue(constructorOptions?.baseUrl),
      placementCalls: placement.spawn.mock.calls.length,
      registerCalls: register.mock.calls.length,
      releaseCalls: release.mock.calls.length,
      workspaceRelayCalls: createWorkspaceRelay.mock.calls.length,
      workspaceRelayBaseUrlHash: hashValue(workspaceRelayOptions?.baseUrl),
      sameWorkspaceRelayInstance: createdWorkspaceRelay === workspaceRelay,
    }),
    'utf8'
  );
});

function hashValue(value) {
  return typeof value === 'string' ? 'sha256:' + createHash('sha256').update(value).digest('hex') : null;
}
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
    'sandbox launcher authority probe',
    PROBE_TIMEOUT_MS,
    { RELAY_PR1746_OBSERVATION_PATH: observationPath }
  );

  const observation = JSON.parse(await readFile(observationPath, 'utf8'));
  const sharedLifecycleObserved =
    observation.tokenHash === hashValue('at_live_launcher') &&
    observation.baseUrlHash === hashValue('https://cast.agentrelay.com') &&
    observation.registerCalls === 1 &&
    observation.releaseCalls === 1 &&
    observation.workspaceRelayCalls === 1 &&
    observation.workspaceKeyHash === hashValue('rk_live_cloud_target') &&
    observation.workspaceRelayBaseUrlHash === hashValue('https://cast.agentrelay.com') &&
    observation.sameWorkspaceRelayInstance === true;
  const baseObserved =
    sharedLifecycleObserved &&
    observation.commandOutcome === 'error' &&
    observation.hasWorkspaceKey === true &&
    observation.placementCalls === 0 &&
    observation.cliError.includes('Pass either --workspace-key or --token, not both.');
  const headObserved =
    sharedLifecycleObserved &&
    observation.commandOutcome === 'success' &&
    observation.hasWorkspaceKey === false &&
    observation.placementCalls === 1 &&
    observation.cliError === '';

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'bug';
    signature = 'sandbox_dispatch_rejected_for_dual_credentials';
    details =
      'The real Fleet command registered and released its temporary launcher, but passed both the Cloud workspace key and launcher token into the real SDK constructor; the exclusivity guard rejected dispatch before placement.';
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'sandbox_dispatch_uses_scoped_launcher_token_only';
    details =
      'The real Fleet command kept workspace-key authority on launcher registration/release and constructed the placement client with only the scoped launcher token plus Cloud-selected Relaycast origin.';
  } else {
    throw new Error(`Unexpected sandbox launcher authority observation: ${JSON.stringify(observation)}.`);
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

function hashValue(value) {
  return typeof value === 'string' ? `sha256:${createHash('sha256').update(value).digest('hex')}` : null;
}
