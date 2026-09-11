import { Command } from 'commander';
import nodeFs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  brokerIdentityPath,
  persistBrokerIdentity,
  readBrokerIdentities,
  readBrokerProcessIdentity,
} from '../lib/broker-process-identity.js';
import { readProjectWorkspaceKey, readProjectWorkspaceSession } from '../lib/project-workspace-key.js';

const sdkStatusClient = {
  getStatus: vi.fn(async () => ({ agent_count: 0, pending_delivery_count: 0 })),
  getSession: vi.fn(
    async () =>
      ({ workspace_key: '' }) as {
        workspace_key?: string;
        node_id?: string;
        node_name?: string;
      }
  ),
  disconnect: vi.fn(() => undefined),
};

const harnessConnectMock = vi.hoisted(() => vi.fn());

vi.mock('@agent-relay/harness-driver', () => ({
  HarnessDriverClient: Object.assign(
    vi.fn(function () {
      return sdkStatusClient;
    }),
    { connect: harnessConnectMock }
  ),
}));

const telemetryMocks = vi.hoisted(() => ({
  track: vi.fn(),
}));

const isolatedWorkspaceHome = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'relay-core-test-home-'));

vi.mock('../telemetry/index.js', () => ({
  track: telemetryMocks.track,
}));

vi.mock('../lib/reflex-capture.js', () => ({
  startReflexCapture: vi.fn(() => ({ stop: vi.fn(async () => undefined) })),
}));

vi.mock('@agent-relay/fleet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-relay/fleet')>();
  return {
    ...actual,
    startServeNode: vi.fn(() => ({ stop: vi.fn(async () => undefined), done: Promise.resolve() })),
  };
});

beforeEach(() => {
  sdkStatusClient.getStatus.mockReset();
  sdkStatusClient.getStatus.mockResolvedValue({ agent_count: 0, pending_delivery_count: 0 });
  sdkStatusClient.getSession.mockReset();
  sdkStatusClient.getSession.mockResolvedValue({ workspace_key: '' });
  sdkStatusClient.disconnect.mockClear();
  harnessConnectMock.mockReset();
  telemetryMocks.track.mockClear();
});

afterAll(() => {
  nodeFs.rmSync(isolatedWorkspaceHome, { recursive: true, force: true });
});

import {
  registerCoreCommands,
  registerCoreMaintenance,
  type CoreDependencies,
  type CoreFileSystem,
  type CoreRelay,
  type CoreTeamsConfig,
  type SpawnedProcess,
} from './core.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

function connectionFile(
  pid: number,
  url = 'http://127.0.0.1:3889',
  apiKey = 'br_secret',
  workspaceSource?: string
): string {
  return JSON.stringify({
    url,
    port: Number(new URL(url).port || '0'),
    api_key: apiKey,
    pid,
    ...(workspaceSource ? { workspace_source: workspaceSource } : {}),
  });
}

function createSpawnedProcessMock(overrides: Partial<SpawnedProcess> = {}): SpawnedProcess {
  return {
    pid: 9001,
    killed: false,
    kill: vi.fn(() => undefined),
    unref: vi.fn(() => undefined),
    ...overrides,
  };
}

function createRelayMock(overrides: Partial<CoreRelay> = {}): CoreRelay {
  return {
    spawn: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({ agent_count: 0, pending_delivery_count: 0 })),
    shutdown: vi.fn(async () => undefined),
    brokerPid: 222,
    workspaceKey: 'rk_live_defaultkey01',
    ...overrides,
  };
}

function createFsMock(initialFiles: Record<string, string> = {}): CoreFileSystem {
  const files = new Map(Object.entries(initialFiles));

  return {
    realpathSync: vi.fn((p: string) => p),
    statSync: vi.fn(() => ({ dev: 256n, ino: 9876n, ctimeNs: 1000000001n, mtimeNs: 1000000001n })),
    existsSync: vi.fn((filePath: string) => files.has(filePath)),
    readFileSync: vi.fn((filePath: string) => files.get(filePath) ?? ''),
    writeFileSync: vi.fn((filePath: string, data: string) => {
      files.set(filePath, String(data));
    }),
    renameSync: vi.fn((oldPath: string, newPath: string) => {
      const data = files.get(oldPath);
      files.delete(oldPath);
      if (data !== undefined) files.set(newPath, data);
    }),
    unlinkSync: vi.fn((filePath: string) => {
      files.delete(filePath);
    }),
    readdirSync: vi.fn((directory: string) =>
      [...files.keys()]
        .filter((file) => nodePath.dirname(file) === directory)
        .map((file) => nodePath.basename(file))
    ),
    mkdirSync: vi.fn(() => undefined),
    rmSync: vi.fn((filePath: string) => {
      files.delete(filePath);
    }),
    accessSync: vi.fn(() => undefined),
  };
}

// eslint-disable-next-line complexity
function createHarness(options?: {
  fs?: CoreFileSystem;
  relay?: CoreRelay;
  createRelay?: CoreDependencies['createRelay'];
  teamsConfig?: CoreTeamsConfig | null;
  env?: NodeJS.ProcessEnv;
  spawnedProcess?: SpawnedProcess;
  spawnImpl?: CoreDependencies['spawnProcess'];
  execCommand?: CoreDependencies['execCommand'];
  killImpl?: CoreDependencies['killProcess'];
  nowImpl?: CoreDependencies['now'];
  sleepImpl?: CoreDependencies['sleep'];
  holdOpen?: CoreDependencies['holdOpen'];
  execPath?: string;
  cliScript?: string;
  argv?: string[];
  checkForUpdatesResult?: Awaited<ReturnType<CoreDependencies['checkForUpdates']>>;
  configureDependencies?: (deps: CoreDependencies) => void;
}) {
  const projectRoot = '/tmp/project';
  const dataDir = '/tmp/project/.agentworkforce/relay';
  const relaySockPath = '/tmp/project/.agentworkforce/relay/relay.sock';
  const connectionPath = '/tmp/project/.agentworkforce/relay/connection.json';
  const runtimePath = '/tmp/project/.agentworkforce/relay/runtime.json';

  const fs = options?.fs ?? createFsMock();
  const relay = options?.relay ?? createRelayMock();
  const spawnedProcess = options?.spawnedProcess ?? createSpawnedProcessMock();
  const env = options?.env ?? {};
  env.AGENT_RELAY_DISABLE_IMPLICIT_FLEET_NODE ??= '1';
  env.AGENT_RELAY_HOME ??= isolatedWorkspaceHome;

  const exit = vi.fn((code: number) => {
    throw new ExitSignal(code);
  }) as unknown as CoreDependencies['exit'];

  const deps: CoreDependencies = {
    getProjectPaths: vi.fn(() => ({
      projectRoot,
      dataDir,
      teamDir: '/tmp/project/.agentworkforce/relay/teams',
      dbPath: '/tmp/project/.agentworkforce/relay/messages.db',
      projectId: 'project',
    })),
    loadTeamsConfig: vi.fn(() => options?.teamsConfig ?? null),
    createRelay: options?.createRelay ?? vi.fn(() => relay),
    spawnProcess:
      options?.spawnImpl ?? (vi.fn(() => spawnedProcess) as unknown as CoreDependencies['spawnProcess']),
    execCommand:
      options?.execCommand ??
      vi.fn(async (command) => {
        const pid = relay.brokerPid;
        const name =
          vi.mocked(deps.createRelay).mock.calls.at(-1)?.[2]?.trim() ||
          deps.env.AGENT_RELAY_BROKER_NAME?.trim() ||
          'project';
        const state = deps.env.AGENT_RELAY_STATE_DIR || dataDir;
        const lock = `${state}/broker-${name.replace(/[^\p{Alphabetic}\p{Number}-]/gu, '-')}.lock`;
        if (command === `LC_ALL=C TZ=UTC ps -p ${pid} -o lstart=`)
          return { stdout: 'Thu Sep 10 18:00:00 2026\n', stderr: '' };
        if (command === `lsof -nP -a -p ${pid} -d txt -FfDi`)
          return { stdout: `p${pid}\nftxt\nD0x100\ni1234\n`, stderr: '' };
        if (command === `lsof -nP -a -p ${pid} -FfnDi`)
          return { stdout: `p${pid}\nf10\nD0x100\ni9876\nn${lock}\n`, stderr: '' };
        return { stdout: '', stderr: '' };
      }),
    killProcess: options?.killImpl ?? vi.fn(() => undefined),
    fs,
    generateAgentName: vi.fn(() => 'AutoAgent'),
    checkForUpdates: vi.fn(
      async () => options?.checkForUpdatesResult ?? { updateAvailable: false, latestVersion: '1.2.3' }
    ) as unknown as CoreDependencies['checkForUpdates'],
    getVersion: vi.fn(() => '1.2.3'),
    env,
    argv: options?.argv ?? ['node', '/tmp/agent-relay.js', 'up'],
    execPath: options?.execPath ?? '/usr/bin/node',
    cliScript: options?.cliScript ?? '/tmp/agent-relay.js',
    pid: 4242,
    now: options?.nowImpl ?? vi.fn(() => Date.now()),
    isPortInUse: vi.fn(async () => false),
    sleep: options?.sleepImpl ?? vi.fn(async () => undefined),
    onSignal: vi.fn(() => undefined),
    holdOpen: options?.holdOpen ?? vi.fn(async () => undefined),
    log: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    warn: vi.fn(() => undefined),
    exit,
  };

  options?.configureDependencies?.(deps);
  const program = new Command();
  registerCoreCommands(program, deps);

  return {
    program,
    deps,
    relay,
    fs,
    connectionPath,
    runtimePath,
    relaySockPath,
    dataDir,
  };
}

async function runCommand(program: Command, args: string[]): Promise<number | undefined> {
  try {
    await program.parseAsync(args, { from: 'user' });
    return undefined;
  } catch (err: any) {
    if (err instanceof ExitSignal) {
      return err.code;
    }
    if (typeof err?.exitCode === 'number') {
      return err.exitCode;
    }
    throw err;
  }
}

describe('registerCoreCommands', () => {
  it('registers core commands on the program', () => {
    const { program } = createHarness();
    const commandNames = program.commands.map((cmd) => cmd.name());

    expect(commandNames).toEqual(
      expect.arrayContaining(['up', 'down', 'status', 'metrics', 'deadletters', 'redeliver'])
    );
    expect(commandNames).not.toEqual(expect.arrayContaining(['bridge', 'uninstall', 'version', 'update']));
  });

  it('up forwards --broker-name to createRelay', async () => {
    const relay = createRelayMock({
      getStatus: vi.fn(async () => ({ agent_count: 1, pending_delivery_count: 0 })),
    });
    const { program, deps } = createHarness({ relay });

    const exitCode = await runCommand(program, ['up', '--broker-name', 'relayfile-dev']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelay).toHaveBeenCalledWith('/tmp/project', 3889, 'relayfile-dev', undefined);
  });

  it('up --verbose forwards the flag to createRelay and logs startup step markers', async () => {
    const relay = createRelayMock({
      getStatus: vi.fn(async () => ({ agent_count: 1, pending_delivery_count: 0 })),
    });
    const { program, deps } = createHarness({ relay });

    const exitCode = await runCommand(program, ['up', '--verbose']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelay).toHaveBeenCalledWith('/tmp/project', 3889, 'project', true);
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringMatching(/^\[verbose\] Resolving a free API port starting near/)
    );
    expect(deps.log).toHaveBeenCalledWith(expect.stringMatching(/^\[verbose\] API port resolved: 3889/));
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringMatching(/^\[verbose\] Broker status check passed\.$/)
    );
  });

  it('up exits early when connection metadata points to a running process', async () => {
    const connectionPath = '/tmp/project/.agentworkforce/relay/connection.json';
    const fs = createFsMock({ [connectionPath]: connectionFile(3030) });
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 3030 && signal === 0) {
        return;
      }
      throw new Error('unexpected kill check');
    });
    const relay = createRelayMock();
    const { program, deps } = createHarness({ fs, killImpl, relay });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith('Broker already running for this project (pid: 3030).');
    expect(deps.error).toHaveBeenCalledWith(
      'Run `agent-relay status` to inspect it, then `agent-relay down` to stop it.'
    );
    expect(relay.getStatus).not.toHaveBeenCalled();
  });

  it('up reports actionable lock guidance when startup fails with broker lock error', async () => {
    const relay = createRelayMock({
      getStatus: vi.fn(async () => {
        throw new Error(
          'broker exited (code=1, signal=null): Error: another broker instance is already running in this directory (/tmp/project/.agentworkforce/relay)'
        );
      }),
    });
    const { program, deps } = createHarness({ relay });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith(
      'Broker already running for this project (lock: /tmp/project/.agentworkforce/relay).'
    );
    expect(deps.error).toHaveBeenCalledWith(
      'Run `agent-relay status` to inspect it, then `agent-relay down` to stop it.'
    );
    expect(deps.error).toHaveBeenCalledWith(
      'If it still fails, run `agent-relay down --force` to clear stale runtime files.'
    );
  });

  it('up auto-spawns agents from teams config', async () => {
    const relay = createRelayMock({
      getStatus: vi.fn(async () => ({
        agent_count: 0,
        pending_delivery_count: 0,
        node_connected: true,
        node_delivery: { token_present: true, connected: true },
      })),
    });
    const { program } = createHarness({
      relay,
      teamsConfig: {
        team: 'platform',
        autoSpawn: true,
        agents: [{ name: 'WorkerA', cli: 'codex', task: 'Ship tests' }],
      },
    });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBeUndefined();
    expect(relay.spawn).toHaveBeenCalledWith({
      name: 'WorkerA',
      cli: 'codex',
      channels: ['general'],
      task: 'Ship tests',
      team: 'platform',
    });
  });

  it('up refuses auto-spawn when node delivery is down', async () => {
    let now = 0;
    const relay = createRelayMock({
      getStatus: vi.fn(async () => ({
        agent_count: 0,
        pending_delivery_count: 0,
        node_connected: false,
        node_delivery: { token_present: false, connected: false },
      })),
    });
    const { program, deps } = createHarness({
      relay,
      teamsConfig: {
        team: 'platform',
        autoSpawn: true,
        agents: [{ name: 'WorkerA', cli: 'codex', task: 'Ship tests' }],
      },
      nowImpl: vi.fn(() => {
        const current = now;
        now += 10_000;
        return current;
      }),
    });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBe(1);
    expect(relay.spawn).not.toHaveBeenCalled();
    expect(relay.shutdown).toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalledWith(
      'Refusing to auto-spawn agents because broker node delivery is not connected.'
    );
    expect(deps.error).toHaveBeenCalledWith('Node delivery: DOWN (no node token)');
  });

  it('up probes for a free API port before spawning the broker', async () => {
    const relay = createRelayMock();
    const { program, deps } = createHarness({ relay });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBeUndefined();
    // Port probing happens before createRelay — only one broker is spawned
    expect(deps.createRelay).toHaveBeenCalledTimes(1);
    // API port = base port (3888) + 1 = 3889
    expect(deps.createRelay).toHaveBeenCalledWith('/tmp/project', 3889, 'project', undefined);
    expect(relay.getStatus).toHaveBeenCalledTimes(1);
  });

  it('up lets the broker atomically bind an OS-assigned API port when configured with port zero', async () => {
    const relay = createRelayMock({ apiPort: 43123 });
    const { program, deps } = createHarness({
      relay,
      env: { AGENT_RELAY_BROKER_PORT: '0' },
    });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBeUndefined();
    expect(deps.isPortInUse).not.toHaveBeenCalled();
    expect(deps.createRelay).toHaveBeenCalledWith('/tmp/project', 0, 'project', undefined);
    expect(deps.log).toHaveBeenCalledWith('Relay API: http://localhost:43123');
  });

  it('up shuts down a port-zero broker that does not report its assigned API port', async () => {
    const relay = createRelayMock({ apiPort: undefined });
    const { program, deps } = createHarness({
      relay,
      env: { AGENT_RELAY_BROKER_PORT: '0' },
    });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBe(1);
    expect(relay.shutdown).toHaveBeenCalledTimes(1);
    expect(deps.error).toHaveBeenCalledWith(
      'Failed to start broker: Broker started without reporting its OS-assigned API port.'
    );
  });

  it('up shuts down a port-zero broker when startup status validation rejects', async () => {
    const relay = createRelayMock({
      apiPort: 43123,
      getStatus: vi.fn(async () => {
        throw new Error('startup status unavailable');
      }),
    });
    const { program, deps } = createHarness({
      relay,
      env: { AGENT_RELAY_BROKER_PORT: '0' },
    });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBe(1);
    expect(relay.shutdown).toHaveBeenCalledTimes(1);
    expect(deps.error).toHaveBeenCalledWith('Failed to start broker: startup status unavailable');
  });

  it('up shuts down a fixed-port broker when startup status validation rejects', async () => {
    const relay = createRelayMock({
      getStatus: vi.fn(async () => {
        throw new Error('startup status unavailable');
      }),
    });
    const { program, deps } = createHarness({ relay });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBe(1);
    expect(relay.shutdown).toHaveBeenCalledTimes(1);
    expect(deps.error).toHaveBeenCalledWith('Failed to start broker: startup status unavailable');
  });

  it('up enables the local broker API', async () => {
    const relay = createRelayMock();
    const { program, deps } = createHarness({ relay });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelay).toHaveBeenCalledTimes(1);
    expect(deps.createRelay).toHaveBeenCalledWith('/tmp/project', 3889, 'project', undefined);
    expect(relay.getStatus).toHaveBeenCalledTimes(1);
  });

  it('up --background detaches for headless sessions', async () => {
    const spawnedProcess = createSpawnedProcessMock();
    let now = 0;
    const fs = createFsMock();
    const sleepImpl = vi.fn(async (ms: number) => {
      now += ms;
      fs.writeFileSync('/tmp/project/.agentworkforce/relay/connection.json', connectionFile(4242));
    });
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if ((pid === 9001 || pid === 4242) && signal === 0) return;
      throw new Error('unexpected kill check');
    });
    const { program, deps, relay } = createHarness({
      fs,
      spawnedProcess,
      killImpl,
      nowImpl: vi.fn(() => now),
      sleepImpl,
      configureDependencies: enableBackgroundIdentity,
    });

    const exitCode = await runCommand(program, ['up', '--background']);

    expect(exitCode).toBe(0);
    expect(deps.spawnProcess).toHaveBeenCalledWith(
      '/usr/bin/node',
      ['/tmp/agent-relay.js', 'up', '--background-child'],
      {
        detached: true,
        stdio: 'ignore',
        env: deps.env,
      }
    );
    expect(spawnedProcess.unref).toHaveBeenCalled();
    expect(sleepImpl).toHaveBeenCalledWith(500);
    expect(sdkStatusClient.getStatus).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith('Broker started.');
    expect(deps.log).toHaveBeenCalledWith('Broker PID: 4242');
    expect(deps.log).toHaveBeenCalledWith('Stop with: agent-relay down');
    expect(relay.getStatus).not.toHaveBeenCalled();
  });

  it('up --background preserves state and workspace args in the detached child', async () => {
    const spawnedProcess = createSpawnedProcessMock();
    let now = 0;
    const fs = createFsMock();
    const stateDir = '/tmp/custom-agent-relay-state';
    const sleepImpl = vi.fn(async (ms: number) => {
      now += ms;
      fs.writeFileSync(`${stateDir}/connection.json`, connectionFile(5151));
    });
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if ((pid === 9001 || pid === 5151) && signal === 0) return;
      throw new Error('unexpected kill check');
    });
    const { program, deps } = createHarness({
      fs,
      spawnedProcess,
      killImpl,
      nowImpl: vi.fn(() => now),
      sleepImpl,
      configureDependencies: (deps) => enableBackgroundIdentity(deps, 'relayfile-dev', stateDir, 5151),
    });
    deps.argv = [
      'node',
      '/tmp/agent-relay.js',
      'up',
      '--background',
      '--state-dir',
      stateDir,
      '--workspace-key',
      'rk_live_customflag77',
      '--broker-name',
      'relayfile-dev',
    ];

    const exitCode = await runCommand(program, [
      'up',
      '--background',
      '--state-dir',
      stateDir,
      '--workspace-key',
      'rk_live_customflag77',
      '--broker-name',
      'relayfile-dev',
    ]);

    expect(exitCode).toBe(0);
    // The key reaches the detached child via env only — its argv (visible in
    // `ps` for the daemon's whole lifetime) must never carry it.
    expect(deps.spawnProcess).toHaveBeenCalledWith(
      '/usr/bin/node',
      [
        '/tmp/agent-relay.js',
        'up',
        '--state-dir',
        stateDir,
        '--broker-name',
        'relayfile-dev',
        '--background-child',
      ],
      {
        detached: true,
        stdio: 'ignore',
        env: deps.env,
      }
    );
    expect(deps.env.RELAY_WORKSPACE_KEY).toBe('rk_live_customflag77');
    expect(deps.env.RELAY_API_KEY).toBe('rk_live_customflag77');
    expect(deps.env.AGENT_RELAY_WORKSPACE_SOURCE).toBe('flag');
    expect(deps.env.AGENT_RELAY_STATE_DIR).toBe(stateDir);
    expect(deps.log).toHaveBeenCalledWith('Broker started.');
    expect(deps.log).toHaveBeenCalledWith('Broker PID: 5151');
  });

  it('up --state-dir records the workspace key in the default project dir, not the state dir', async () => {
    // SDK commands (fleet nodes, …) read the key from the default project data
    // dir and never accept --state-dir, so a redirected broker state dir must
    // NOT be where the key lands — otherwise those commands miss it.
    const stateDir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'relay-statedir-'));
    const relay = createRelayMock({ workspaceKey: 'rk_statedir_regression' });
    const { program } = createHarness({ relay });

    try {
      const exitCode = await runCommand(program, [
        'up',
        '--state-dir',
        stateDir,
        '--workspace-key',
        'rk_statedir_regression',
      ]);

      expect(exitCode).toBeUndefined();
      // Persisted at the default project data dir (the harness's mocked path)…
      expect(readProjectWorkspaceKey('/tmp/project/.agentworkforce/relay')).toBe('rk_statedir_regression');
      // …and NOT in the redirected state dir.
      expect(readProjectWorkspaceKey(stateDir)).toBeUndefined();
    } finally {
      nodeFs.rmSync(stateDir, { recursive: true, force: true });
      // The key is written to the real default project dir; clean it up so it
      // doesn't leak into other tests running in this process.
      nodeFs.rmSync('/tmp/project/.agentworkforce/relay/workspace-key.json', { force: true });
    }
  });

  it('up --background preserves an enrolled identity through a Bun standalone re-exec', async () => {
    const spawnedProcess = createSpawnedProcessMock();
    let now = 0;
    const fs = createFsMock();
    const sleepImpl = vi.fn(async (ms: number) => {
      now += ms;
      fs.writeFileSync('/tmp/project/.agentworkforce/relay/connection.json', connectionFile(4242));
    });
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if ((pid === 9001 || pid === 4242) && signal === 0) return;
      throw new Error('unexpected kill check');
    });
    sdkStatusClient.getStatus.mockResolvedValue({
      agent_count: 0,
      pending_delivery_count: 0,
      node_connected: true,
      node_delivery: { token_present: true, connected: true },
    });
    sdkStatusClient.getSession.mockResolvedValue({
      workspace_key: 'rk_enrolled',
      node_id: 'node_enrolled',
      node_name: 'sf-mini',
    });
    const { program, deps } = createHarness({
      fs,
      env: {
        RELAY_NODE_ID: 'node_enrolled',
        RELAY_NODE_TOKEN: 'nt_enrolled',
      },
      spawnedProcess,
      killImpl,
      nowImpl: vi.fn(() => now),
      sleepImpl,
      execPath: '/tmp/agent-relay-darwin-arm64',
      configureDependencies: (deps) => enableBackgroundIdentity(deps, 'sf-mini'),
      cliScript: '/$bunfs/root/agent-relay-darwin-arm64',
      argv: [
        'bun',
        '/$bunfs/root/agent-relay-darwin-arm64',
        'node',
        'up',
        '--background',
        '--config',
        'agent-relay.mjs',
      ],
    });

    const exitCode = await runCommand(program, ['up', '--background', '--broker-name', 'sf-mini']);

    expect(exitCode).toBe(0);
    expect(deps.spawnProcess).toHaveBeenCalledWith(
      '/tmp/agent-relay-darwin-arm64',
      ['node', 'up', '--config', 'agent-relay.mjs', '--broker-name', 'sf-mini', '--background-child'],
      {
        detached: true,
        stdio: 'ignore',
        env: expect.objectContaining({
          RELAY_NODE_ID: 'node_enrolled',
          RELAY_NODE_TOKEN: 'nt_enrolled',
        }),
      }
    );
  });

  it('up --background fails loudly when the broker reports the wrong enrolled identity', async () => {
    const spawnedProcess = createSpawnedProcessMock();
    let now = 0;
    const fs = createFsMock();
    const sleepImpl = vi.fn(async (ms: number) => {
      now += ms;
      fs.writeFileSync('/tmp/project/.agentworkforce/relay/connection.json', connectionFile(4242));
    });
    const stopped = new Set<number>();
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if ((pid === 9001 || pid === 4242) && signal === 0 && !stopped.has(pid)) return;
      if ((pid === 9001 || pid === 4242) && (signal === 'SIGTERM' || signal === 'SIGKILL')) {
        stopped.add(pid);
        return;
      }
      throw new Error('unexpected kill check');
    });
    sdkStatusClient.getStatus.mockResolvedValue({
      node_connected: true,
      node_delivery: { token_present: true, connected: true },
    });
    sdkStatusClient.getSession.mockResolvedValue({
      workspace_key: 'rk_enrolled',
      node_id: 'node_enrolled',
      node_name: 'project',
    });
    const { program, deps } = createHarness({
      fs,
      env: {
        RELAY_NODE_ID: 'node_enrolled',
        RELAY_NODE_TOKEN: 'nt_enrolled',
      },
      spawnedProcess,
      killImpl,
      nowImpl: vi.fn(() => now),
      sleepImpl,
    });

    const exitCode = await runCommand(program, ['up', '--background', '--broker-name', 'sf-mini']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith(
      'Cloud enrollment identity mismatch: expected node name "sf-mini", got "project".'
    );
    expect(killImpl).not.toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(fs.existsSync('/tmp/project/.agentworkforce/relay/connection.json')).toBe(true);
    expect(deps.log).not.toHaveBeenCalledWith('Broker started.');
  });

  it('up --background rejects an enrolled node token without a node id', async () => {
    const spawnedProcess = createSpawnedProcessMock();
    let now = 0;
    const fs = createFsMock();
    const sleepImpl = vi.fn(async (ms: number) => {
      now += ms;
      fs.writeFileSync('/tmp/project/.agentworkforce/relay/connection.json', connectionFile(4242));
    });
    const stopped = new Set<number>();
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if ((pid === 9001 || pid === 4242) && signal === 0 && !stopped.has(pid)) return;
      if ((pid === 9001 || pid === 4242) && (signal === 'SIGTERM' || signal === 'SIGKILL')) {
        stopped.add(pid);
        return;
      }
      throw new Error('unexpected kill check');
    });
    const { program, deps } = createHarness({
      fs,
      env: { RELAY_NODE_ID: '   ', RELAY_NODE_TOKEN: 'nt_incomplete' },
      spawnedProcess,
      killImpl,
      nowImpl: vi.fn(() => now),
      sleepImpl,
    });

    const exitCode = await runCommand(program, ['up', '--background', '--broker-name', 'sf-mini']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith(
      'Cloud enrollment credentials are incomplete: RELAY_NODE_ID is required when RELAY_NODE_TOKEN is set.'
    );
    expect(killImpl).not.toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(fs.existsSync('/tmp/project/.agentworkforce/relay/connection.json')).toBe(true);
    expect(deps.log).not.toHaveBeenCalledWith('Broker started.');
  });

  it('up --background retains broker state when failed enrollment cleanup cannot stop the broker', async () => {
    const spawnedProcess = createSpawnedProcessMock();
    let now = 0;
    const fs = createFsMock();
    const connectionPath = '/tmp/project/.agentworkforce/relay/connection.json';
    const sleepImpl = vi.fn(async (ms: number) => {
      now += ms;
      fs.writeFileSync(connectionPath, connectionFile(4242));
    });
    const runningPids = new Set([9001, 4242]);
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        if (runningPids.has(pid)) return;
        throw new Error('not running');
      }
      if (pid === 9001 && (signal === 'SIGTERM' || signal === 'SIGKILL')) {
        runningPids.delete(pid);
      }
    });
    sdkStatusClient.getStatus.mockResolvedValue({
      node_connected: true,
      node_delivery: { token_present: true, connected: true },
    });
    sdkStatusClient.getSession.mockResolvedValue({
      workspace_key: 'rk_enrolled',
      node_id: 'node_enrolled',
      node_name: 'project',
    });
    const { program, deps } = createHarness({
      fs,
      env: {
        RELAY_NODE_ID: 'node_enrolled',
        RELAY_NODE_TOKEN: 'nt_enrolled',
      },
      spawnedProcess,
      killImpl,
      nowImpl: vi.fn(() => now),
      sleepImpl,
    });

    const exitCode = await runCommand(program, ['up', '--background', '--broker-name', 'sf-mini']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith(
      'Failed to stop broker process after Cloud enrollment startup failed (pid: 4242). ' +
        'Verify process ownership before stopping it manually; inspect identities in /tmp/project/.agentworkforce/relay.'
    );
    expect(fs.existsSync(connectionPath)).toBe(true);
    expect(deps.log).not.toHaveBeenCalledWith('Broker started.');
  });

  it('up --background fails when enrolled node delivery never connects', async () => {
    const spawnedProcess = createSpawnedProcessMock();
    let now = 0;
    const fs = createFsMock();
    const sleepImpl = vi.fn(async (ms: number) => {
      now += ms;
      fs.writeFileSync('/tmp/project/.agentworkforce/relay/connection.json', connectionFile(4242));
    });
    const stopped = new Set<number>();
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if ((pid === 9001 || pid === 4242) && signal === 0 && !stopped.has(pid)) return;
      if ((pid === 9001 || pid === 4242) && (signal === 'SIGTERM' || signal === 'SIGKILL')) {
        stopped.add(pid);
        return;
      }
      throw new Error('unexpected kill check');
    });
    sdkStatusClient.getStatus.mockResolvedValue({
      node_connected: false,
      node_delivery: { token_present: true, connected: false },
    });
    sdkStatusClient.getSession.mockResolvedValue({
      workspace_key: 'rk_enrolled',
      node_id: 'node_enrolled',
      node_name: 'sf-mini',
    });
    const { program, deps } = createHarness({
      fs,
      env: {
        RELAY_NODE_ID: 'node_enrolled',
        RELAY_NODE_TOKEN: 'nt_expired',
      },
      spawnedProcess,
      killImpl,
      nowImpl: vi.fn(() => now),
      sleepImpl,
    });

    const exitCode = await runCommand(program, ['up', '--background', '--broker-name', 'sf-mini']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith(
      'Cloud enrollment for node "sf-mini" did not become ready. Node delivery: DOWN (node websocket disconnected)'
    );
    expect(deps.log).not.toHaveBeenCalledWith('Broker started.');
  });

  it('up --background exits non-zero when the detached broker never becomes ready', async () => {
    const spawnedProcess = createSpawnedProcessMock();
    let now = 0;
    let childRunning = true;
    const sleepImpl = vi.fn(async (ms: number) => {
      now += ms;
    });
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 9001 && signal === 0 && childRunning) return;
      if (pid === 9001 && signal === 'SIGTERM') {
        childRunning = false;
        return;
      }
      throw new Error('unexpected kill check');
    });
    const { program, deps } = createHarness({
      spawnedProcess,
      killImpl,
      nowImpl: vi.fn(() => now),
      sleepImpl,
    });

    const exitCode = await runCommand(program, ['up', '--background']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith(
      'Broker background start did not become ready within 10s (pid: 9001).'
    );
    expect(deps.error).toHaveBeenCalledWith(
      'Run `agent-relay status --wait-for=10` for details, or `agent-relay down --force` to clean up.'
    );
    expect(killImpl).toHaveBeenCalledWith(9001, 'SIGTERM');
    expect(deps.warn).toHaveBeenCalledWith('Cleaning up failed broker start (pid: 9001)');
    expect(deps.log).not.toHaveBeenCalledWith('Broker started.');
  });

  it('up --background reports an early detached-child failure without trying to kill a dead PID', async () => {
    const spawnedProcess = createSpawnedProcessMock();
    let now = 0;
    let childRunning = true;
    const fs = createFsMock();
    const sleepImpl = vi.fn(async (ms: number) => {
      now += ms;
      childRunning = false;
      fs.writeFileSync(
        '/tmp/project/.agentworkforce/relay/background-start-error.log',
        'explicit workspace key was rejected'
      );
    });
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 9001 && signal === 0 && childRunning) return;
      throw new Error('not running');
    });
    const { program, deps } = createHarness({
      fs,
      spawnedProcess,
      killImpl,
      nowImpl: vi.fn(() => now),
      sleepImpl,
    });

    const exitCode = await runCommand(program, ['up', '--background', '--workspace-key', 'rk_live_other']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith(
      'Broker background child exited before becoming ready (pid: 9001).'
    );
    expect(deps.error).toHaveBeenCalledWith('Detached broker error: explicit workspace key was rejected');
    expect(killImpl).not.toHaveBeenCalledWith(9001, 'SIGTERM');
    expect(deps.error).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to stop half-started broker process')
    );
  });

  it.each(['../../../etc/relay-background-error', '/tmp/relay-background-error-escape'])(
    'detached-child failure ignores an untrusted background error path %s',
    async (untrustedPath) => {
      const fs = createFsMock();
      const relay = createRelayMock({
        getStatus: vi.fn(async () => {
          throw new Error('detached child failed');
        }),
      });
      const { program, dataDir } = createHarness({
        fs,
        relay,
        env: {
          AGENT_RELAY_BACKGROUND_START_ERROR_FILE: untrustedPath,
        },
      });

      const exitCode = await runCommand(program, ['up', '--background-child']);

      expect(exitCode).toBe(1);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        `${dataDir}/background-start-error.log`,
        'detached child failed\n',
        'utf-8'
      );
      expect(fs.writeFileSync).not.toHaveBeenCalledWith(untrustedPath, expect.anything(), expect.anything());
    }
  );

  const fixedStart = 'Thu Sep 10 18:00:00 2026';
  function identityCommand(pid = 222, lockPath = '/tmp/project/.agentworkforce/relay/broker-project.lock') {
    return vi.fn(async (command: string) => {
      if (command === `LC_ALL=C TZ=UTC ps -p ${pid} -o lstart=`)
        return { stdout: `Thu Sep 10  18:00:00 2026   \n`, stderr: '' };
      if (command === `lsof -nP -a -p ${pid} -d txt -FfDi`)
        return { stdout: `p${pid}\nftxt\nD0x100\ni1234\n`, stderr: '' };
      if (command === `lsof -nP -a -p ${pid} -FfnDi`)
        return { stdout: `p${pid}\nf10\nD0x100\ni9876\nn${lockPath}\n`, stderr: '' };
      throw new Error(`Unexpected command: ${command}`);
    });
  }

  function enableBackgroundIdentity(
    deps: CoreDependencies,
    name = 'project',
    stateDir = deps.getProjectPaths().dataDir,
    pid = 4242
  ) {
    deps.pid = 9999;
    const originalExec = deps.execCommand;
    const command = identityCommand(pid, `${stateDir}/broker-${name}.lock`);
    deps.execCommand = (value) => (value.includes(`-p ${pid} `) ? command(value) : originalExec(value));
    const sleep = deps.sleep;
    deps.sleep = async (ms) => {
      await sleep(ms);
      await persistBrokerIdentity({ ...deps.getProjectPaths(), dataDir: stateDir }, pid, name, deps);
    };
  }

  it.each([
    '/tmp/project/relay  state',
    '/tmp/project/.agentworkforce/relay',
    nodePath.resolve('nested/candidate-state'),
  ])('force cleanup stops only the recorded custom broker in %s', async (stateDir) => {
    const running = new Set([222, 333, 444, 555]);
    const execCommand = identityCommand(222, `${stateDir}/broker-custom-node.lock`);
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        if (!running.has(pid)) throw new Error('not running');
        return;
      }
      running.delete(pid);
    });
    const { program, deps } = createHarness({ execCommand, killImpl });
    const paths = { ...deps.getProjectPaths(), dataDir: stateDir };
    await persistBrokerIdentity(paths, 222, 'custom-node', deps);
    const filename = brokerIdentityPath(paths, deps, 'custom-node');
    expect(filename).toMatch(/^\/tmp\/project\/\.agentworkforce\/relay\/broker-identity-/);
    expect(deps.fs.existsSync(filename)).toBe(true);
    const stateArg =
      stateDir === nodePath.resolve('nested/candidate-state') ? 'nested/candidate-state' : stateDir;
    await runCommand(program, ['down', '--force', '--state-dir', stateArg]);
    expect(killImpl).toHaveBeenCalledWith(222, 'SIGTERM');
    expect([...running]).toEqual([333, 444, 555]);
    expect(deps.fs.existsSync(filename)).toBe(false);
    expect(execCommand).not.toHaveBeenCalledWith('ps aux');
  });

  it('up persists the actual broker identity outside redirected state before force recovery', async () => {
    const running = new Set([222, 333]);
    const execCommand = identityCommand(222, '/tmp/project/redirected state/broker-custom-node.lock');
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        if (!running.has(pid)) throw new Error('not running');
        return;
      }
      running.delete(pid);
    });
    const { program, deps } = createHarness({
      execCommand,
      killImpl,
      relay: createRelayMock({ brokerPid: 222 }),
    });
    const stateDir = '/tmp/project/redirected state';
    await runCommand(program, ['up', '--state-dir', stateDir, '--broker-name', 'custom-node']);
    const filename = brokerIdentityPath(
      { ...deps.getProjectPaths(), dataDir: stateDir },
      deps,
      'custom-node'
    );
    expect(JSON.parse(deps.fs.readFileSync(filename, 'utf-8'))).toMatchObject({
      pid: 222,
      brokerName: 'custom-node',
      stateDirectory: stateDir,
      startedAt: fixedStart,
      executable: '0x100:1234',
    });
    // Discovery files can disappear while the native runtime lock stays open.
    deps.fs.unlinkSync(`${stateDir}/connection.json`);
    await runCommand(program, ['down', '--force', '--state-dir', stateDir]);
    expect([...running]).toEqual([333]);
    expect(deps.fs.existsSync(filename)).toBe(false);
  });

  it.each([
    'missing',
    'malformed',
    'legacy',
    'start-mismatch',
    'executable-mismatch',
    'dead',
    'unsupported',
    'wrong-state',
  ])('force cleanup preserves processes and identity when ownership is %s', async (kind) => {
    const running = new Set([222, 333]);
    const execCommand = identityCommand();
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        if (!running.has(pid)) throw new Error('not running');
        return;
      }
      running.delete(pid);
    });
    const { program, deps } = createHarness({ execCommand, killImpl });
    const paths = deps.getProjectPaths();
    await persistBrokerIdentity(paths, 222, 'project', deps);
    const filename = brokerIdentityPath(paths, deps);
    const value = JSON.parse(deps.fs.readFileSync(filename, 'utf-8'));
    if (kind === 'missing') deps.fs.unlinkSync(filename);
    if (kind === 'malformed') deps.fs.writeFileSync(filename, '{');
    if (kind === 'legacy') deps.fs.writeFileSync(filename, JSON.stringify({ pid: 222 }));
    if (kind === 'start-mismatch')
      deps.fs.writeFileSync(filename, JSON.stringify({ ...value, startedAt: 'Thu Sep 10 17:59:59 2026' }));
    if (kind === 'executable-mismatch')
      deps.fs.writeFileSync(filename, JSON.stringify({ ...value, executable: '0x100:999' }));
    if (kind === 'wrong-state')
      deps.fs.writeFileSync(filename, JSON.stringify({ ...value, stateDirectory: '/tmp/project/peer' }));
    if (kind === 'dead') running.delete(222);
    if (kind === 'unsupported') execCommand.mockRejectedValue(new Error('lsof unavailable'));
    const before = deps.fs.readFileSync(filename, 'utf-8');
    await runCommand(program, ['down', '--force']);
    expect(killImpl.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
    expect(deps.fs.readFileSync(filename, 'utf-8')).toBe(before);
    expect(running.has(333)).toBe(true);
    expect(execCommand).not.toHaveBeenCalledWith('ps aux');
  });

  it.each(['reopened', 'replaced', 'missing', 'descriptor-mismatch'])(
    'same-second PID and executable reuse cannot adopt a %s runtime lock',
    async (kind) => {
      const execCommand = identityCommand();
      const { program, deps } = createHarness({ execCommand });
      await persistBrokerIdentity(deps.getProjectPaths(), 222, 'project', deps);
      const filename = brokerIdentityPath(deps.getProjectPaths(), deps);
      expect(deps.fs.existsSync(filename)).toBe(true);
      const record = deps.fs.readFileSync(filename, 'utf-8');
      if (kind === 'reopened')
        vi.mocked(deps.fs.statSync!).mockReturnValue({
          dev: 256n,
          ino: 9876n,
          ctimeNs: 1000000002n,
          mtimeNs: 1000000002n,
        });
      if (kind === 'replaced')
        vi.mocked(deps.fs.statSync!).mockReturnValue({
          dev: 256n,
          ino: 9877n,
          ctimeNs: 1000000001n,
          mtimeNs: 1000000001n,
        });
      if (kind === 'missing')
        vi.mocked(deps.fs.statSync!).mockImplementation(() => {
          throw new Error('ENOENT');
        });
      if (kind === 'descriptor-mismatch') {
        const original = execCommand.getMockImplementation()!;
        execCommand.mockImplementation(async (command) =>
          command.endsWith('-FfnDi')
            ? {
                stdout: 'p222\nf10\nD0x100\ni9999\nn/tmp/project/.agentworkforce/relay/broker-project.lock\n',
                stderr: '',
              }
            : original(command)
        );
      }
      await runCommand(program, ['down', '--force']);
      expect(vi.mocked(deps.killProcess).mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
      expect(deps.fs.readFileSync(filename, 'utf-8')).toBe(record);
    }
  );

  it.each([false, true])(
    'unsupported-platform up refuses before spawning (background=%s)',
    async (background) => {
      const { program, deps } = createHarness();
      const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
      try {
        expect(await runCommand(program, background ? ['up', '--background'] : ['up'])).toBe(1);
        expect(deps.createRelay).not.toHaveBeenCalled();
        expect(deps.spawnProcess).not.toHaveBeenCalled();
        expect(deps.killProcess).not.toHaveBeenCalled();
        expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('refusing to start on win32'));
      } finally {
        Object.defineProperty(process, 'platform', descriptor);
      }
    }
  );

  it.each(
    [false, true].flatMap((backgroundChild) =>
      ['missing-tools', 'uninspectable-lock', 'write-denied', 'missing-pid'].map((failure) => ({
        backgroundChild,
        failure,
      }))
    )
  )(
    'supported startup rejects failed identity capture ($backgroundChild, $failure)',
    async ({ backgroundChild, failure }) => {
      const relay = createRelayMock(failure === 'missing-pid' ? { brokerPid: undefined } : {});
      const { program, deps } = createHarness({
        relay,
        configureDependencies: (configured) => {
          if (failure === 'missing-tools')
            configured.execCommand = vi.fn(async () => {
              throw new Error('lsof unavailable');
            });
          if (failure === 'uninspectable-lock')
            configured.fs.statSync = vi.fn(() => {
              throw new Error('permission denied');
            });
          if (failure === 'write-denied')
            configured.fs.renameSync = vi.fn(() => {
              throw new Error('read only directory');
            });
        },
      });
      const exitCode = await runCommand(program, backgroundChild ? ['up', '--background-child'] : ['up']);
      expect(exitCode).toBe(1);
      expect(relay.shutdown).toHaveBeenCalledExactlyOnceWith();
      expect(relay.spawn).not.toHaveBeenCalled();
      expect(deps.holdOpen).not.toHaveBeenCalled();
      expect(deps.log).not.toHaveBeenCalledWith('Broker started.');
      expect(deps.error).toHaveBeenCalledWith(
        expect.stringContaining('Could not persist a verified broker process identity')
      );
      expect(readBrokerIdentities(deps.getProjectPaths(), deps)).toEqual([]);
      if (backgroundChild)
        expect(
          deps.fs.readFileSync(`${deps.getProjectPaths().dataDir}/background-start-error.log`, 'utf-8')
        ).toContain('Could not persist a verified broker process identity');
      expect(vi.mocked(deps.killProcess).mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
    }
  );

  it.each([false, true].flatMap((connected) => [false, true].map((replace) => ({ connected, replace }))))(
    'verified ESRCH removes only its unchanged record (connected=$connected, replace=$replace)',
    async ({ connected, replace }) => {
      let running = true;
      const { program, deps } = createHarness({
        execCommand: identityCommand(),
        killImpl: vi.fn((pid, signal) => {
          if (pid === 222 && signal === 'SIGTERM') {
            running = false;
            if (replace) {
              const filename = brokerIdentityPath(deps.getProjectPaths(), deps);
              const original = JSON.parse(deps.fs.readFileSync(filename, 'utf-8'));
              deps.fs.writeFileSync(filename, JSON.stringify({ ...original, pid: 333 }));
              deps.fs.writeFileSync(
                '/tmp/project/.agentworkforce/relay/connection.json',
                connectionFile(333)
              );
            }
            throw Object.assign(new Error('exited before signal'), { code: 'ESRCH' });
          }
          if (pid === 222 && signal === 0 && !running)
            throw Object.assign(new Error('not running'), { code: 'ESRCH' });
        }),
      });
      await persistBrokerIdentity(deps.getProjectPaths(), 222, 'project', deps);
      if (connected)
        deps.fs.writeFileSync('/tmp/project/.agentworkforce/relay/connection.json', connectionFile(222));
      const runtime = '/tmp/project/.agentworkforce/relay/runtime.json';
      deps.fs.writeFileSync(runtime, 'retained');
      expect(await runCommand(program, ['down', '--force'])).toBeUndefined();
      const filename = brokerIdentityPath(deps.getProjectPaths(), deps);
      expect(deps.fs.existsSync(filename)).toBe(replace);
      expect(deps.fs.existsSync(runtime)).toBe(replace);
      if (replace) expect(JSON.parse(deps.fs.readFileSync(filename, 'utf-8')).pid).toBe(333);
      expect(vi.mocked(deps.killProcess).mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
        [222, 'SIGTERM'],
      ]);
    }
  );

  it('force escalation rechecks PID reuse and retains the identity of an unconfirmed exit', async () => {
    let now = 0;
    let terminated = false;
    const execCommand = identityCommand();
    const { program, deps } = createHarness({
      execCommand,
      killImpl: vi.fn((_pid, signal) => {
        if (signal === 'SIGTERM') terminated = true;
      }),
      nowImpl: () => now,
      sleepImpl: async (ms) => {
        now += ms;
        if (terminated) execCommand.mockResolvedValue({ stdout: '', stderr: '' });
      },
    });
    await persistBrokerIdentity(deps.getProjectPaths(), 222, 'project', deps);
    const filename = brokerIdentityPath(deps.getProjectPaths(), deps);
    expect(await runCommand(program, ['down', '--force'])).toBe(1);
    expect(deps.killProcess).toHaveBeenCalledWith(222, 'SIGTERM');
    expect(deps.killProcess).not.toHaveBeenCalledWith(222, 'SIGKILL');
    expect(deps.fs.existsSync(filename)).toBe(true);
  });

  it.each(
    [false, true].flatMap((connected) =>
      ['missing', 'malformed', 'replacement'].map((change) => ({ connected, change }))
    )
  )(
    'force escalation rejects $change authorization (connected=$connected)',
    async ({ connected, change }) => {
      let now = 0;
      let terminated = false;
      let changed = false;
      const { program, deps } = createHarness({
        execCommand: identityCommand(),
        killImpl: vi.fn((_pid, signal) => {
          if (signal === 'SIGTERM') terminated = true;
        }),
        nowImpl: () => now,
        sleepImpl: async (ms) => {
          now += ms;
          if (!terminated || changed) return;
          changed = true;
          const filename = brokerIdentityPath(deps.getProjectPaths(), deps);
          if (change === 'missing') deps.fs.unlinkSync(filename);
          else if (change === 'malformed') deps.fs.writeFileSync(filename, '{');
          else {
            const original = JSON.parse(deps.fs.readFileSync(filename, 'utf-8'));
            deps.fs.writeFileSync(filename, JSON.stringify({ ...original, pid: 333 }));
          }
        },
      });
      await persistBrokerIdentity(deps.getProjectPaths(), 222, 'project', deps);
      const connection = '/tmp/project/.agentworkforce/relay/connection.json';
      if (connected) deps.fs.writeFileSync(connection, connectionFile(222));
      const runtime = '/tmp/project/.agentworkforce/relay/runtime.json';
      deps.fs.writeFileSync(runtime, 'retained');
      expect(await runCommand(program, ['down', '--force', '--timeout', '500'])).toBe(1);
      expect(vi.mocked(deps.killProcess).mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
        [222, 'SIGTERM'],
      ]);
      expect(deps.fs.readFileSync(runtime, 'utf-8')).toBe('retained');
      if (connected) expect(deps.fs.readFileSync(connection, 'utf-8')).toBe(connectionFile(222));
      const filename = brokerIdentityPath(deps.getProjectPaths(), deps);
      if (change === 'missing') expect(deps.fs.existsSync(filename)).toBe(false);
      else if (change === 'malformed') expect(deps.fs.readFileSync(filename, 'utf-8')).toBe('{');
      else expect(JSON.parse(deps.fs.readFileSync(filename, 'utf-8')).pid).toBe(333);
    }
  );

  it('identity removal during OS verification prevents the initial signal', async () => {
    const command = identityCommand();
    let armed = false;
    const { program, deps } = createHarness({
      execCommand: async (value) => {
        const result = await command(value);
        if (armed && value.endsWith('-FfnDi'))
          deps.fs.unlinkSync(brokerIdentityPath(deps.getProjectPaths(), deps));
        return result;
      },
    });
    await persistBrokerIdentity(deps.getProjectPaths(), 222, 'project', deps);
    armed = true;
    expect(await runCommand(program, ['down', '--force'])).toBe(1);
    expect(vi.mocked(deps.killProcess).mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
  });

  it('force escalation kills a still-matching process and removes its record after exit', async () => {
    let now = 0;
    let running = true;
    const { program, deps } = createHarness({
      execCommand: identityCommand(),
      killImpl: vi.fn((_pid, signal) => {
        if (signal === 'SIGKILL') running = false;
        if (signal === 0 && !running) throw new Error('not running');
      }),
      nowImpl: () => now,
      sleepImpl: async (ms) => {
        now += ms;
      },
    });
    await persistBrokerIdentity(deps.getProjectPaths(), 222, 'project', deps);
    await runCommand(program, ['down', '--force']);
    expect(deps.killProcess).toHaveBeenCalledWith(222, 'SIGKILL');
    expect(deps.fs.existsSync(brokerIdentityPath(deps.getProjectPaths(), deps))).toBe(false);
  });

  it('cleanup keeps a newer record and discovery files written while the matched broker exits', async () => {
    let running = true;
    const { program, deps } = createHarness({
      execCommand: identityCommand(),
      killImpl: vi.fn((_pid, signal) => {
        if (signal === 'SIGTERM') {
          running = false;
          const filename = brokerIdentityPath(deps.getProjectPaths(), deps);
          const value = JSON.parse(deps.fs.readFileSync(filename, 'utf-8'));
          deps.fs.writeFileSync(filename, JSON.stringify({ ...value, pid: 333 }));
          deps.fs.writeFileSync('/tmp/project/.agentworkforce/relay/connection.json', connectionFile(333));
          deps.fs.writeFileSync('/tmp/project/.agentworkforce/relay/runtime.json', 'replacement');
        }
        if (signal === 0 && !running) throw new Error('not running');
      }),
    });
    await persistBrokerIdentity(deps.getProjectPaths(), 222, 'project', deps);
    await runCommand(program, ['down', '--force']);
    expect(
      JSON.parse(deps.fs.readFileSync(brokerIdentityPath(deps.getProjectPaths(), deps), 'utf-8')).pid
    ).toBe(333);
    expect(
      JSON.parse(deps.fs.readFileSync('/tmp/project/.agentworkforce/relay/connection.json', 'utf-8')).pid
    ).toBe(333);
    expect(deps.fs.readFileSync('/tmp/project/.agentworkforce/relay/runtime.json', 'utf-8')).toBe(
      'replacement'
    );
  });

  it('up --background reaps only its recorded broker before starting cleanly', async () => {
    const running = new Set([222, 9001, 4242]);
    let now = 0;
    const fs = createFsMock();
    const { program, deps } = createHarness({
      fs,
      execCommand: identityCommand(),
      killImpl: vi.fn((pid, signal) => {
        if (signal === 0) {
          if (!running.has(pid)) throw new Error('not running');
          return;
        }
        running.delete(pid);
      }),
      nowImpl: () => now,
      sleepImpl: async (ms) => {
        now += ms;
        fs.writeFileSync('/tmp/project/.agentworkforce/relay/connection.json', connectionFile(4242));
      },
      configureDependencies: enableBackgroundIdentity,
    });
    await persistBrokerIdentity(deps.getProjectPaths(), 222, 'project', deps);
    expect(await runCommand(program, ['up', '--background'])).toBe(0);
    expect(deps.killProcess).toHaveBeenCalledWith(222, 'SIGTERM');
    expect(deps.spawnProcess).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'cleanup preserves a replacement connection before its identity is captured (orphan=%s)',
    async (orphan) => {
      const running = new Set([222, 333]);
      const { program, deps } = createHarness({
        execCommand: identityCommand(),
        killImpl: vi.fn((pid, signal) => {
          if (signal === 0) {
            if (!running.has(pid)) throw new Error('not running');
            return;
          }
          running.delete(pid);
          deps.fs.writeFileSync('/tmp/project/.agentworkforce/relay/connection.json', connectionFile(333));
          deps.fs.writeFileSync('/tmp/project/.agentworkforce/relay/runtime.json', 'replacement');
        }),
      });
      await persistBrokerIdentity(deps.getProjectPaths(), 222, 'project', deps);
      if (!orphan)
        deps.fs.writeFileSync('/tmp/project/.agentworkforce/relay/connection.json', connectionFile(222));
      await runCommand(program, ['down', '--force']);
      expect(
        JSON.parse(deps.fs.readFileSync('/tmp/project/.agentworkforce/relay/connection.json', 'utf-8')).pid
      ).toBe(333);
      expect(deps.fs.readFileSync('/tmp/project/.agentworkforce/relay/runtime.json', 'utf-8')).toBe(
        'replacement'
      );
      expect(deps.fs.existsSync(brokerIdentityPath(deps.getProjectPaths(), deps))).toBe(false);
    }
  );

  it('startup does not adopt a recorded broker with another name', async () => {
    const { program, deps } = createHarness({
      execCommand: identityCommand(222, '/tmp/project/.agentworkforce/relay/broker-peer-node.lock'),
    });
    await persistBrokerIdentity(deps.getProjectPaths(), 222, 'peer-node', deps);
    await runCommand(program, ['up', '--broker-name', 'selected-node']);
    expect(vi.mocked(deps.killProcess).mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
  });

  it.each(['  custom-node  ', ''])(
    'startup normalizes broker name %j before identity capture',
    async (name) => {
      const normalized = name.trim() || 'project';
      const { program, deps } = createHarness({
        relay: createRelayMock({ brokerPid: 222 }),
        env: { AGENT_RELAY_BROKER_NAME: name },
        execCommand: identityCommand(222, `/tmp/project/.agentworkforce/relay/broker-${normalized}.lock`),
      });
      await runCommand(program, name ? ['up', '--broker-name', name] : ['up']);
      expect(
        JSON.parse(
          deps.fs.readFileSync(brokerIdentityPath(deps.getProjectPaths(), deps, normalized), 'utf-8')
        ).brokerName
      ).toBe(normalized);
    }
  );

  it('state-directory aliases find the same persisted broker', async () => {
    let running = true;
    const fs = createFsMock();
    fs.realpathSync = (p) => p.replace('/tmp/project/alias', '/tmp/project/canonical');
    const { program, deps } = createHarness({
      fs,
      execCommand: identityCommand(222, '/tmp/project/canonical/broker-project.lock'),
      killImpl: vi.fn((_pid, signal) => {
        if (signal === 'SIGTERM') running = false;
        if (signal === 0 && !running) throw new Error('not running');
      }),
    });
    await persistBrokerIdentity(
      { ...deps.getProjectPaths(), dataDir: '/tmp/project/alias' },
      222,
      'project',
      deps
    );
    await runCommand(program, ['down', '--force', '--state-dir', '/tmp/project/canonical']);
    expect(deps.killProcess).toHaveBeenCalledWith(222, 'SIGTERM');
  });

  it('different names retain independent records and forced cleanup verifies each', async () => {
    const running = new Set([222, 333]);
    const first = identityCommand(222, '/tmp/project/.agentworkforce/relay/broker-first.lock');
    const second = identityCommand(333, '/tmp/project/.agentworkforce/relay/broker-second.lock');
    const { program, deps } = createHarness({
      execCommand: async (command) => (command.includes('-p 222 ') ? first(command) : second(command)),
      killImpl: vi.fn((pid, signal) => {
        if (signal === 0) {
          if (!running.has(pid)) throw new Error('not running');
          return;
        }
        running.delete(pid);
      }),
    });
    const paths = deps.getProjectPaths();
    await persistBrokerIdentity(paths, 222, 'first', deps);
    await persistBrokerIdentity(paths, 333, 'second', deps);
    const firstPath = brokerIdentityPath(paths, deps, 'first');
    const secondPath = brokerIdentityPath(paths, deps, 'second');
    expect(deps.fs.existsSync(firstPath)).toBe(true);
    expect(deps.fs.existsSync(secondPath)).toBe(true);
    await runCommand(program, ['down', '--force']);
    expect([...running]).toEqual([]);
    expect(deps.fs.existsSync(firstPath)).toBe(false);
    expect(deps.fs.existsSync(secondPath)).toBe(false);
  });

  it('background startup retains all state and refuses an unverified live generation', async () => {
    const { program, deps } = createHarness({ execCommand: identityCommand() });
    await persistBrokerIdentity(deps.getProjectPaths(), 222, 'project', deps);
    deps.fs.writeFileSync('/tmp/project/.agentworkforce/relay/runtime.json', 'keep');
    vi.mocked(deps.fs.statSync!).mockReturnValue({
      dev: 256n,
      ino: 9876n,
      ctimeNs: 1000000002n,
      mtimeNs: 1000000002n,
    });
    expect(await runCommand(program, ['up', '--background'])).toBe(1);
    expect(deps.spawnProcess).not.toHaveBeenCalled();
    expect(deps.fs.readFileSync('/tmp/project/.agentworkforce/relay/runtime.json', 'utf-8')).toBe('keep');
    expect(vi.mocked(deps.killProcess).mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
  });

  it.each([false, true])(
    'graceful down removes its verified record and preserves a replacement=%s',
    async (replace) => {
      let running = true;
      const { program, deps } = createHarness({
        execCommand: identityCommand(),
        killImpl: vi.fn((_pid, signal) => {
          if (signal === 'SIGTERM') {
            running = false;
            if (replace) {
              const filename = brokerIdentityPath(deps.getProjectPaths(), deps);
              const value = JSON.parse(deps.fs.readFileSync(filename, 'utf-8'));
              deps.fs.writeFileSync(filename, JSON.stringify({ ...value, pid: 333 }));
              deps.fs.writeFileSync(
                '/tmp/project/.agentworkforce/relay/connection.json',
                connectionFile(333)
              );
              deps.fs.writeFileSync('/tmp/project/.agentworkforce/relay/runtime.json', 'replacement');
            }
          }
          if (signal === 0 && !running) throw new Error('not running');
        }),
      });
      await persistBrokerIdentity(deps.getProjectPaths(), 222, 'project', deps);
      deps.fs.writeFileSync('/tmp/project/.agentworkforce/relay/connection.json', connectionFile(222));
      await runCommand(program, ['down']);
      expect(deps.fs.existsSync(brokerIdentityPath(deps.getProjectPaths(), deps))).toBe(replace);
      if (replace) {
        expect(
          JSON.parse(deps.fs.readFileSync('/tmp/project/.agentworkforce/relay/connection.json', 'utf-8')).pid
        ).toBe(333);
        expect(deps.fs.readFileSync('/tmp/project/.agentworkforce/relay/runtime.json', 'utf-8')).toBe(
          'replacement'
        );
      }
    }
  );

  it.each(['down', 'up'])(
    'a stale connection does not bypass the recorded generation during %s',
    async (command) => {
      const { program, deps } = createHarness({ execCommand: identityCommand() });
      await persistBrokerIdentity(deps.getProjectPaths(), 222, 'project', deps);
      deps.fs.writeFileSync('/tmp/project/.agentworkforce/relay/connection.json', connectionFile(222));
      vi.mocked(deps.fs.statSync!).mockReturnValue({
        dev: 256n,
        ino: 9876n,
        ctimeNs: 1000000002n,
        mtimeNs: 1000000002n,
      });
      sdkStatusClient.getStatus.mockRejectedValue(new Error('API unavailable'));
      expect(await runCommand(program, command === 'up' ? ['up', '--background'] : ['down', '--force'])).toBe(
        1
      );
      expect(vi.mocked(deps.killProcess).mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
      expect(deps.fs.existsSync('/tmp/project/.agentworkforce/relay/connection.json')).toBe(true);
    }
  );

  it('stops the node supervisor and services when its broker child exits', async () => {
    let brokerExited: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const relay = createRelayMock({
      onBrokerExit: (listener) => {
        brokerExited = listener;
        return unsubscribe;
      },
    });
    const { program, deps } = createHarness({
      relay,
      holdOpen: () => {
        brokerExited!();
        return new Promise(() => undefined);
      },
    });
    expect(await runCommand(program, ['up'])).toBe(1);
    expect(relay.shutdown).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(deps.error).toHaveBeenCalledWith(
      expect.stringContaining('Broker exited; stopping the node supervisor.')
    );
  });

  it.each([false, true])(
    'an observed managed-child exit removes only its captured record (replacement=%s)',
    async (replace) => {
      let exited = false;
      let onExit: (() => void) | undefined;
      const relay = createRelayMock({
        brokerPid: 222,
        onBrokerExit: (listener) => {
          onExit = listener;
          return () => undefined;
        },
      });
      Object.defineProperty(relay, 'brokerPid', { get: () => (exited ? undefined : 222) });
      const { program, deps } = createHarness({
        relay,
        execCommand: identityCommand(),
        killImpl: vi.fn((pid, signal) => {
          if (pid === 222 && signal === 0 && exited) throw new Error('not running');
        }),
        holdOpen: () => {
          if (replace) {
            const filename = brokerIdentityPath(deps.getProjectPaths(), deps);
            const value = JSON.parse(deps.fs.readFileSync(filename, 'utf-8'));
            deps.fs.writeFileSync(filename, JSON.stringify({ ...value, pid: 333 }));
          }
          exited = true;
          onExit!();
          return new Promise(() => undefined);
        },
      });
      expect(await runCommand(program, ['up'])).toBe(1);
      expect(deps.fs.existsSync(brokerIdentityPath(deps.getProjectPaths(), deps))).toBe(replace);
    }
  );

  it('foreground orphan cleanup waits through native graceful drain before starting', async () => {
    let now = 0;
    let stopping = false;
    const { program, deps } = createHarness({
      relay: createRelayMock({ brokerPid: 333 }),
      execCommand: vi.fn(async (command: string) =>
        identityCommand(command.includes('-p 222') ? 222 : 333)(command)
      ),
      nowImpl: () => now,
      sleepImpl: async (ms) => {
        now += ms;
      },
      killImpl: vi.fn((pid, signal) => {
        if (pid === 222 && signal === 'SIGTERM') stopping = true;
        if (pid === 222 && signal === 0 && stopping && now >= 3500) throw new Error('not running');
      }),
    });
    await persistBrokerIdentity(deps.getProjectPaths(), 222, 'project', deps);
    const createRelay = vi.mocked(deps.createRelay);
    const createStartedRelay = createRelay.getMockImplementation()!;
    createRelay.mockImplementationOnce(async (...args) => {
      expect(readBrokerIdentities(deps.getProjectPaths(), deps)).toEqual([]);
      return createStartedRelay(...args);
    });
    expect(await runCommand(program, ['up'])).not.toBe(1);
    expect(now).toBeGreaterThanOrEqual(3500);
    expect(readBrokerIdentities(deps.getProjectPaths(), deps).map((identity) => identity.pid)).toEqual([333]);
    expect(deps.killProcess).not.toHaveBeenCalledWith(222, 'SIGKILL');
  });

  it.each([true, false])(
    'background success waits for persisted identity (eventually=%s)',
    async (eventually) => {
      let now = 0;
      const { program, deps } = createHarness({
        execCommand: identityCommand(4242),
        configureDependencies: (deps) => {
          deps.pid = 9999;
        },
        nowImpl: () => now,
        sleepImpl: async (ms) => {
          now += ms;
          deps.fs.writeFileSync('/tmp/project/.agentworkforce/relay/connection.json', connectionFile(4242));
          if (eventually && now >= 500)
            await persistBrokerIdentity(deps.getProjectPaths(), 4242, 'project', deps);
        },
      });
      expect(await runCommand(program, ['up', '--background'])).toBe(eventually ? 0 : 1);
      expect(now).toBeGreaterThanOrEqual(500);
      if (!eventually) {
        expect(deps.log).not.toHaveBeenCalledWith('Broker started.');
        expect(deps.fs.existsSync('/tmp/project/.agentworkforce/relay/connection.json')).toBe(true);
      }
      expect(vi.mocked(deps.killProcess).mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
    }
  );

  it('an exiting supervisor preserves the connection of a replacement broker', async () => {
    let brokerExited: (() => void) | undefined;
    let exited = false;
    const relay = createRelayMock({
      brokerPid: 222,
      onBrokerExit: (listener) => {
        brokerExited = listener;
        return () => undefined;
      },
    });
    Object.defineProperty(relay, 'brokerPid', { get: () => (exited ? undefined : 222) });
    const { program, deps } = createHarness({
      relay,
      execCommand: identityCommand(),
      holdOpen: () => {
        deps.fs.writeFileSync('/tmp/project/.agentworkforce/relay/connection.json', connectionFile(333));
        exited = true;
        brokerExited!();
        return new Promise(() => undefined);
      },
    });
    expect(await runCommand(program, ['up'])).toBe(1);
    expect(
      JSON.parse(deps.fs.readFileSync('/tmp/project/.agentworkforce/relay/connection.json', 'utf-8')).pid
    ).toBe(333);
  });

  it('an interrupted identity write preserves the prior record and removes its partial temporary file', async () => {
    const { deps } = createHarness({ execCommand: identityCommand() });
    const paths = deps.getProjectPaths();
    await persistBrokerIdentity(paths, 222, 'project', deps);
    const filename = brokerIdentityPath(paths, deps);
    const before = deps.fs.readFileSync(filename, 'utf-8');
    const write = vi.mocked(deps.fs.writeFileSync).getMockImplementation()!;
    vi.mocked(deps.fs.writeFileSync).mockImplementation((file, data, encoding) => {
      write(file, data.slice(0, 5), encoding);
      throw new Error('ENOSPC');
    });
    await persistBrokerIdentity(paths, 222, 'project', deps);
    expect(deps.fs.readFileSync(filename, 'utf-8')).toBe(before);
    expect(deps.fs.readdirSync(nodePath.dirname(filename))).toEqual([nodePath.basename(filename)]);
  });

  it('a listed identity disappearing fails closed instead of enabling legacy shutdown', async () => {
    const { program, deps } = createHarness({ execCommand: identityCommand() });
    const paths = deps.getProjectPaths();
    await persistBrokerIdentity(paths, 222, 'project', deps);
    const filename = brokerIdentityPath(paths, deps);
    deps.fs.writeFileSync('/tmp/project/.agentworkforce/relay/connection.json', connectionFile(222));
    const read = vi.mocked(deps.fs.readFileSync).getMockImplementation()!;
    vi.mocked(deps.fs.readFileSync).mockImplementation((file, encoding) => {
      if (file === filename) throw Object.assign(new Error('record disappeared'), { code: 'ENOENT' });
      return read(file, encoding);
    });
    expect(readBrokerIdentities(paths, deps)).toBeNull();
    expect(await runCommand(program, ['down', '--force'])).toBe(1);
    expect(vi.mocked(deps.killProcess).mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
  });

  it.each(['ENOENT', 'EACCES'])('identity directory listing distinguishes %s', async (code) => {
    const { deps } = createHarness();
    vi.mocked(deps.fs.readdirSync).mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });
    expect(readBrokerIdentities(deps.getProjectPaths(), deps)).toEqual(code === 'ENOENT' ? [] : null);
  });

  it('permission denial while observing exit retains the matched identity', async () => {
    let now = 0;
    let signalled = false;
    const { program, deps } = createHarness({
      execCommand: identityCommand(),
      nowImpl: () => now,
      sleepImpl: async (ms) => {
        now += ms;
      },
      killImpl: vi.fn((_pid, signal) => {
        if (signal === 'SIGTERM') signalled = true;
        if (signal === 0 && signalled) throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
      }),
    });
    await persistBrokerIdentity(deps.getProjectPaths(), 222, 'project', deps);
    expect(await runCommand(program, ['down', '--force'])).toBe(1);
    expect(deps.fs.existsSync(brokerIdentityPath(deps.getProjectPaths(), deps))).toBe(true);
  });

  it.each([false, true])(
    'startup preserves a dead identity without replacing it (background=%s)',
    async (background) => {
      const { program, deps } = createHarness({
        execCommand: identityCommand(),
        killImpl: vi.fn((pid, signal) => {
          if (pid === 222 && signal === 0) throw new Error('not running');
        }),
      });
      const paths = deps.getProjectPaths();
      await persistBrokerIdentity(paths, 222, 'project', deps);
      const filename = brokerIdentityPath(paths, deps);
      const before = deps.fs.readFileSync(filename, 'utf-8');
      expect(await runCommand(program, background ? ['up', '--background'] : ['up'])).toBe(1);
      expect(deps.fs.readFileSync(filename, 'utf-8')).toBe(before);
      expect(deps.spawnProcess).not.toHaveBeenCalled();
    }
  );

  it('malformed orphan records identify the recovery directory', async () => {
    const { program, deps } = createHarness({ execCommand: identityCommand() });
    deps.fs.writeFileSync(brokerIdentityPath(deps.getProjectPaths(), deps), '{broken');
    expect(await runCommand(program, ['down', '--force'])).toBe(1);
    expect(deps.warn).toHaveBeenCalledWith(
      expect.stringContaining('Broker identities could not be read in /tmp/project/.agentworkforce/relay')
    );
  });

  it.each(['changed', 'still-running'])(
    'normal forced down exits nonzero when escalation is %s',
    async (mode) => {
      let now = 0;
      let signalled = false;
      const execCommand = identityCommand();
      const { program, deps } = createHarness({
        execCommand,
        killImpl: vi.fn((_pid, signal) => {
          if (signal === 'SIGTERM') signalled = true;
        }),
        nowImpl: () => now,
        sleepImpl: async (ms) => {
          now += ms;
          if (signalled && mode === 'changed') execCommand.mockResolvedValue({ stdout: '', stderr: '' });
        },
      });
      const paths = deps.getProjectPaths();
      await persistBrokerIdentity(paths, 222, 'project', deps);
      deps.fs.writeFileSync('/tmp/project/.agentworkforce/relay/connection.json', connectionFile(222));
      expect(await runCommand(program, ['down', '--force', '--timeout', '1'])).toBe(1);
      expect(deps.fs.existsSync(brokerIdentityPath(paths, deps))).toBe(true);
      expect(deps.fs.existsSync('/tmp/project/.agentworkforce/relay/connection.json')).toBe(true);
      if (mode === 'changed') expect(deps.killProcess).not.toHaveBeenCalledWith(222, 'SIGKILL');
    }
  );

  it('fixed OS identity rejects unsupported systems and malformed process fields', async () => {
    const { deps } = createHarness({ execCommand: identityCommand() });
    expect(await readBrokerProcessIdentity(222, deps, 'win32')).toBeNull();
    expect(await readBrokerProcessIdentity(-1, deps)).toBeNull();
    expect(await readBrokerProcessIdentity(deps.pid, deps)).toBeNull();
    vi.mocked(deps.execCommand).mockResolvedValue({
      stdout: 'Thu Sep 10 18:00:00 2026\nThu Sep 10 18:00:00 2026',
      stderr: '',
    });
    expect(await readBrokerProcessIdentity(222, deps)).toBeNull();
  });

  it('up --background refuses a legacy connection-only PID whose API never becomes ready', async () => {
    const spawnedProcess = createSpawnedProcessMock({ pid: 9001 });
    const runningPids = new Set([3030, 9001, 4242]);
    const fs = createFsMock({ ['/tmp/project/.agentworkforce/relay/connection.json']: connectionFile(3030) });
    let now = 0;
    const sleepImpl = vi.fn(async (ms: number) => {
      now += ms;
      fs.writeFileSync('/tmp/project/.agentworkforce/relay/connection.json', connectionFile(4242));
    });
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        if (runningPids.has(pid)) return;
        throw new Error('not running');
      }
      runningPids.delete(pid);
    });
    sdkStatusClient.getStatus
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValue({ agent_count: 0, pending_delivery_count: 0 });
    const { program, deps } = createHarness({
      fs,
      spawnedProcess,
      killImpl,
      nowImpl: vi.fn(() => now),
      sleepImpl,
    });

    const exitCode = await runCommand(program, ['up', '--background']);

    expect(exitCode).toBe(1);
    expect(killImpl).not.toHaveBeenCalledWith(3030, 'SIGTERM');
    expect(fs.existsSync('/tmp/project/.agentworkforce/relay/connection.json')).toBe(true);
    expect(deps.error).toHaveBeenCalledWith(
      expect.stringContaining('Connection metadata alone cannot authorize a signal.')
    );
    expect(deps.spawnProcess).not.toHaveBeenCalled();
  });

  it('up --background reports the broker PID when the detached broker is live but API-unready', async () => {
    const spawnedProcess = createSpawnedProcessMock({ pid: 9001 });
    let now = 0;
    const runningPids = new Set([9001, 4242]);
    const fs = createFsMock();
    const sleepImpl = vi.fn(async (ms: number) => {
      now += ms;
      fs.writeFileSync('/tmp/project/.agentworkforce/relay/connection.json', connectionFile(4242));
    });
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        if (runningPids.has(pid)) return;
        throw new Error('not running');
      }
      if (pid === 9001 || pid === 4242) {
        runningPids.delete(pid);
        return;
      }
      throw new Error('unexpected kill check');
    });
    sdkStatusClient.getStatus.mockRejectedValue(new Error('503 Service Unavailable'));
    const { program, deps } = createHarness({
      fs,
      spawnedProcess,
      killImpl,
      nowImpl: vi.fn(() => now),
      sleepImpl,
    });

    const exitCode = await runCommand(program, ['up', '--background']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith(
      'Broker background start did not become ready within 10s (pid: 4242).'
    );
    expect(deps.error).toHaveBeenCalledWith('Broker process is running, but the API did not become ready.');
    expect(killImpl).toHaveBeenCalledWith(9001, 'SIGTERM');
    expect(killImpl).not.toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(fs.existsSync('/tmp/project/.agentworkforce/relay/connection.json')).toBe(true);
  });

  it('up --background reports spawn failures without claiming background success', async () => {
    const { program, deps } = createHarness({
      spawnImpl: vi.fn(() => {
        throw new Error('spawn EACCES');
      }) as unknown as CoreDependencies['spawnProcess'],
    });

    const exitCode = await runCommand(program, ['up', '--background']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith('Failed to start broker in background: spawn EACCES');
    expect(deps.log).not.toHaveBeenCalledWith('Broker started.');
  });

  it('up force exits on repeated SIGINT during a hung shutdown', async () => {
    const relay = createRelayMock({
      shutdown: vi.fn(() => new Promise(() => undefined)),
    });

    const { program, deps } = createHarness({
      relay,
      holdOpen: vi.fn(() => new Promise(() => undefined)),
    });
    void runCommand(program, ['up']);

    // SIGINT/SIGTERM are now registered before the broker starts (so a
    // signal arriving during startup is handled gracefully too), so
    // registration alone no longer implies `relay` is set. Wait for the
    // broker to actually be up before firing the signal.
    await vi.waitFor(() => expect(deps.log).toHaveBeenCalledWith('Broker started.'));

    const onSignalMock = deps.onSignal as unknown as { mock: { calls: unknown[][] } };
    const sigintHandler = onSignalMock.mock.calls.find((call) => call[0] === 'SIGINT')?.[1] as
      | (() => Promise<void>)
      | undefined;
    expect(sigintHandler).toBeDefined();
    const sigint = sigintHandler as () => Promise<void>;

    void sigint();
    await vi.waitFor(() => expect(relay.shutdown).toHaveBeenCalledTimes(1));
    await expect(sigint()).rejects.toMatchObject({ code: 130 });

    expect(relay.shutdown).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledTimes(1);
    expect(deps.warn).toHaveBeenCalledWith('Force exiting...');

    const logCalls = (deps.log as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(logCalls.filter((call) => call[0] === '\nStopping...')).toHaveLength(1);
  });

  it('up shuts down the in-flight broker candidate when SIGTERM arrives before the status check resolves', async () => {
    let resolveStatus: (() => void) | undefined;
    const relay = createRelayMock({
      getStatus: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveStatus = () => resolve({ agent_count: 0, pending_delivery_count: 0 });
          })
      ),
    });
    const { program, deps } = createHarness({ relay });
    void runCommand(program, ['up']);

    // Wait until the status check has actually started. By this point
    // `startBrokerWithPortFallback`'s `onCandidateReady` callback has
    // already assigned the outer `relay` -- well before the check itself
    // resolves. This is exactly the window where `relay` used to still be
    // null and a signal would leak the broker child instead of shutting it
    // down.
    for (
      let i = 0;
      i < 20 && (relay.getStatus as unknown as { mock: { calls: unknown[][] } }).mock.calls.length === 0;
      i += 1
    ) {
      await Promise.resolve();
    }
    expect(relay.getStatus).toHaveBeenCalled();
    expect(relay.shutdown).not.toHaveBeenCalled();

    const onSignalMock = deps.onSignal as unknown as { mock: { calls: unknown[][] } };
    const sigtermHandler = onSignalMock.mock.calls.find((call) => call[0] === 'SIGTERM')?.[1] as
      | (() => Promise<void>)
      | undefined;
    expect(sigtermHandler).toBeDefined();

    await expect((sigtermHandler as () => Promise<void>)()).rejects.toMatchObject({ code: 0 });

    expect(relay.shutdown).toHaveBeenCalledTimes(1);
    resolveStatus?.();
  });

  it('down stops broker and cleans stale files', async () => {
    const connectionPath = '/tmp/project/.agentworkforce/relay/connection.json';
    const relaySockPath = '/tmp/project/.agentworkforce/relay/relay.sock';
    const runtimePath = '/tmp/project/.agentworkforce/relay/runtime.json';

    const fs = createFsMock({
      [connectionPath]: connectionFile(3030),
      [relaySockPath]: '',
      [runtimePath]: '',
    });

    let running = true;
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 || signal === undefined) {
        if (!running) {
          const err = new Error('not running') as Error & { code?: string };
          err.code = 'ESRCH';
          throw err;
        }
        return;
      }
      if (signal === 'SIGTERM') {
        running = false;
      }
    });

    const { program, deps } = createHarness({ fs, killImpl, execCommand: identityCommand(3030) });
    await persistBrokerIdentity(deps.getProjectPaths(), 3030, 'project', deps);

    const exitCode = await runCommand(program, ['down']);

    expect(exitCode).toBeUndefined();
    expect(killImpl).toHaveBeenCalledWith(3030, 'SIGTERM');
    expect(fs.unlinkSync).toHaveBeenCalledWith(connectionPath);
    expect(fs.unlinkSync).toHaveBeenCalledWith(relaySockPath);
    expect(fs.unlinkSync).toHaveBeenCalledWith(runtimePath);
  });

  it.each([false, true])('down refuses legacy connection-only ownership (force=%s)', async (force) => {
    const connectionPath = '/tmp/project/.agentworkforce/relay/connection.json';
    const fs = createFsMock({ [connectionPath]: connectionFile(3030) });
    const { program, deps } = createHarness({ fs });
    expect(await runCommand(program, force ? ['down', '--force'] : ['down'])).toBe(1);
    expect(vi.mocked(deps.killProcess).mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
    expect(fs.readFileSync(connectionPath, 'utf-8')).toBe(connectionFile(3030));
    expect(deps.error).toHaveBeenCalledWith(
      expect.stringContaining('Connection metadata alone cannot authorize a signal.')
    );
  });

  it('forced down with no identity reports preservation and does not signal', async () => {
    const { program, deps } = createHarness();
    expect(await runCommand(program, ['down', '--force'])).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('No verified orphan broker found; retained existing state.');
    expect(vi.mocked(deps.killProcess).mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
  });

  it('down reports not running when connection metadata is missing', async () => {
    const { program, deps } = createHarness();

    const exitCode = await runCommand(program, ['down']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('Not running');
  });

  it('status checks broker status and prints metrics', async () => {
    const connectionPath = '/tmp/project/.agentworkforce/relay/connection.json';
    const fs = createFsMock({
      [connectionPath]: connectionFile(4242, 'http://127.0.0.1:3889', 'br_secret', 'project'),
    });
    sdkStatusClient.getStatus.mockResolvedValueOnce({ agent_count: 4, pending_delivery_count: 2 });
    sdkStatusClient.getSession.mockResolvedValueOnce({
      workspace_key: 'rk_live_teststatus123',
      node_id: 'node_enrolled',
      node_name: 'sf-mini',
    });

    const { program, deps } = createHarness({ fs });

    const exitCode = await runCommand(program, ['status']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('Status: RUNNING');
    expect(deps.log).toHaveBeenCalledWith('Agents: 4');
    expect(deps.log).toHaveBeenCalledWith('Pending deliveries: 2');
    expect(deps.log).toHaveBeenCalledWith('Node: sf-mini (node_enrolled)');
    expect(deps.log).toHaveBeenCalledWith('Workspace Key: rk_live_…s123');
    expect(deps.log).toHaveBeenCalledWith(
      'Workspace source: repository pin (.agentworkforce/relay/workspace-key.json)'
    );
    const logCalls = (deps.log as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(logCalls.some((call) => String(call[0]).startsWith('Observer:'))).toBe(false);
    expect(sdkStatusClient.disconnect).toHaveBeenCalled();
  });

  it.each([
    {
      source: 'flag',
      label: 'command-line flag (--workspace-key / --wk)',
    },
    {
      source: 'env',
      label: 'environment (RELAY_WORKSPACE_KEY > AGENT_RELAY_WORKSPACE_KEY > RELAY_API_KEY)',
    },
    {
      source: 'project',
      label: 'repository pin (.agentworkforce/relay/workspace-key.json)',
    },
    {
      source: 'store',
      label: 'machine-global active workspace (~/.agentworkforce/relay/workspaces.json)',
    },
    {
      source: 'created',
      label: 'created (no configured workspace resolved)',
    },
  ])('status reports the $source workspace source', async ({ source, label }) => {
    const connectionPath = '/tmp/project/.agentworkforce/relay/connection.json';
    const fs = createFsMock({
      [connectionPath]: connectionFile(4242, 'http://127.0.0.1:3889', 'br_secret', source),
    });
    const { program, deps } = createHarness({ fs });

    const exitCode = await runCommand(program, ['status']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith(`Workspace source: ${label}`);
  });

  it('status omits workspace key and observer when broker has no workspace_key', async () => {
    const connectionPath = '/tmp/project/.agentworkforce/relay/connection.json';
    const fs = createFsMock({ [connectionPath]: connectionFile(4242) });
    sdkStatusClient.getStatus.mockResolvedValueOnce({ agent_count: 0, pending_delivery_count: 0 });
    sdkStatusClient.getSession.mockResolvedValueOnce({});

    const { program, deps } = createHarness({ fs });

    const exitCode = await runCommand(program, ['status']);

    expect(exitCode).toBeUndefined();
    const logCalls = (deps.log as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(logCalls.some((call) => String(call[0]).startsWith('Workspace Key:'))).toBe(false);
    expect(logCalls.some((call) => String(call[0]).startsWith('Observer:'))).toBe(false);
    expect(sdkStatusClient.disconnect).toHaveBeenCalled();
  });

  it('status cleans stale connection metadata when broker is not running', async () => {
    const connectionPath = '/tmp/project/.agentworkforce/relay/connection.json';
    const fs = createFsMock({ [connectionPath]: connectionFile(9999) });
    const killImpl = vi.fn(() => {
      const err = new Error('gone') as Error & { code?: string };
      err.code = 'ESRCH';
      throw err;
    });

    const { program, deps } = createHarness({ fs, killImpl });

    const exitCode = await runCommand(program, ['status']);

    expect(exitCode).toBeUndefined();
    expect(fs.unlinkSync).toHaveBeenCalledWith(connectionPath);
    expect(deps.log).toHaveBeenCalledWith('Status: STOPPED');
  });

  it('status --wait-for polls until broker connection metadata appears', async () => {
    let now = 0;
    const fs = createFsMock();
    const sleepImpl = vi.fn(async (ms: number) => {
      now += ms;
      fs.writeFileSync('/tmp/project/.agentworkforce/relay/connection.json', connectionFile(4242));
    });
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 4242 && signal === 0) return;
      throw new Error('unexpected kill check');
    });
    const { program, deps } = createHarness({
      fs,
      killImpl,
      nowImpl: vi.fn(() => now),
      sleepImpl,
    });

    const exitCode = await runCommand(program, ['status', '--wait-for', '1']);

    expect(exitCode).toBeUndefined();
    expect(sleepImpl).toHaveBeenCalledWith(500);
    expect(deps.log).toHaveBeenCalledWith('Status: RUNNING');
    expect(deps.log).toHaveBeenCalledWith('PID: 4242');
  });

  it('status --wait-for waits for the broker API after the PID appears', async () => {
    let now = 0;
    const connectionPath = '/tmp/project/.agentworkforce/relay/connection.json';
    const fs = createFsMock({ [connectionPath]: connectionFile(4242) });
    const sleepImpl = vi.fn(async (ms: number) => {
      now += ms;
    });
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 4242 && signal === 0) return;
      throw new Error('unexpected kill check');
    });
    sdkStatusClient.getStatus
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce({ agent_count: 1, pending_delivery_count: 0 });
    sdkStatusClient.getSession.mockResolvedValueOnce({ workspace_key: 'rk_live_readywait9' });

    const { program, deps } = createHarness({
      fs,
      killImpl,
      nowImpl: vi.fn(() => now),
      sleepImpl,
    });

    const exitCode = await runCommand(program, ['status', '--wait-for', '1']);

    expect(exitCode).toBeUndefined();
    expect(sleepImpl).toHaveBeenCalledWith(500);
    expect(sdkStatusClient.getStatus).toHaveBeenCalledTimes(2);
    expect(fs.unlinkSync).not.toHaveBeenCalledWith(connectionPath);
    expect(deps.log).toHaveBeenCalledWith('Status: RUNNING');
    expect(deps.log).toHaveBeenCalledWith('Agents: 1');
    expect(deps.log).toHaveBeenCalledWith('Workspace Key: rk_live_…ait9');
  });

  it('status --wait-for treats getStatus success as ready even when session lookup fails', async () => {
    const now = 0;
    const connectionPath = '/tmp/project/.agentworkforce/relay/connection.json';
    const fs = createFsMock({ [connectionPath]: connectionFile(4242) });
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 4242 && signal === 0) return;
      throw new Error('unexpected kill check');
    });
    sdkStatusClient.getStatus.mockResolvedValueOnce({ agent_count: 2, pending_delivery_count: 0 });
    sdkStatusClient.getSession.mockRejectedValueOnce(new Error('503 Service Unavailable'));

    const { program, deps } = createHarness({
      fs,
      killImpl,
      nowImpl: vi.fn(() => now),
    });

    const exitCode = await runCommand(program, ['status', '--wait-for', '1']);

    expect(exitCode).toBeUndefined();
    expect(sdkStatusClient.getStatus).toHaveBeenCalledTimes(1);
    expect(sdkStatusClient.getSession).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith('Status: RUNNING');
    expect(deps.log).toHaveBeenCalledWith('Agents: 2');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('Workspace Key:'));
  });

  it.each(['10s', 'foo', '-1', ''])('status rejects invalid --wait-for value %j', async (waitFor) => {
    const { program, deps } = createHarness();

    const exitCode = await runCommand(program, ['status', '--wait-for', waitFor]);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith('--wait-for must be a non-negative number of seconds.');
    expect(deps.log).not.toHaveBeenCalledWith('Status: STOPPED');
  });

  it('status --wait-for reports STARTING and exits non-zero when the PID is live but the API is unready', async () => {
    let now = 0;
    const connectionPath = '/tmp/project/.agentworkforce/relay/connection.json';
    const fs = createFsMock({ [connectionPath]: connectionFile(4242) });
    const sleepImpl = vi.fn(async (ms: number) => {
      now += ms;
    });
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 4242 && signal === 0) return;
      throw new Error('unexpected kill check');
    });
    sdkStatusClient.getStatus.mockRejectedValue(new Error('503 Service Unavailable'));

    const { program, deps } = createHarness({
      fs,
      killImpl,
      nowImpl: vi.fn(() => now),
      sleepImpl,
    });

    const exitCode = await runCommand(program, ['status', '--wait-for', '1']);

    expect(exitCode).toBe(1);
    expect(fs.unlinkSync).not.toHaveBeenCalledWith(connectionPath);
    expect(deps.log).toHaveBeenCalledWith('Status: STARTING');
    expect(deps.log).toHaveBeenCalledWith('PID: 4242');
    expect(deps.warn).toHaveBeenCalledWith(
      'Broker process is running, but the API did not become ready before timeout.'
    );
  });

  it('status --wait-for exits non-zero when no broker becomes ready before timeout', async () => {
    let now = 0;
    const sleepImpl = vi.fn(async (ms: number) => {
      now += ms;
    });
    const { program, deps } = createHarness({
      nowImpl: vi.fn(() => now),
      sleepImpl,
    });

    const exitCode = await runCommand(program, ['status', '--wait-for', '1']);

    expect(exitCode).toBe(1);
    expect(deps.log).toHaveBeenCalledWith('Status: STOPPED');
  });

  it('version prints current version', async () => {
    const { deps } = createHarness();
    const program = new Command();
    registerCoreMaintenance(program, deps);

    const exitCode = await runCommand(program, ['version']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('agent-relay v1.2.3');
  });

  it('update in --check mode reports available version without installing', async () => {
    const { deps } = createHarness({
      checkForUpdatesResult: { updateAvailable: true, latestVersion: '2.0.0' },
    });
    const program = new Command();
    registerCoreMaintenance(program, deps);

    const exitCode = await runCommand(program, ['update', '--check']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('New version available: 2.0.0');
    expect(deps.execCommand).not.toHaveBeenCalled();
    expect(telemetryMocks.track).not.toHaveBeenCalledWith('cli_update', expect.any(Object));
  });

  it('update tracks successful install attempts', async () => {
    const { deps } = createHarness({
      checkForUpdatesResult: { updateAvailable: true, latestVersion: '2.0.0' },
      execCommand: vi.fn(async () => ({ stdout: 'updated\n', stderr: '' })),
    });
    const program = new Command();
    registerCoreMaintenance(program, deps);

    const exitCode = await runCommand(program, ['update']);

    expect(exitCode).toBeUndefined();
    expect(deps.execCommand).toHaveBeenCalledWith('npm install -g agent-relay@latest');
    expect(telemetryMocks.track).toHaveBeenCalledWith('cli_update', {
      from_version: '1.2.3',
      to_version: '2.0.0',
      success: true,
    });
  });

  it('update tracks failed install attempts without leaking messages', async () => {
    const { deps } = createHarness({
      checkForUpdatesResult: { updateAvailable: true, latestVersion: '2.0.0' },
      execCommand: vi.fn(async () => {
        throw new Error('registry token /tmp/private');
      }),
    });
    const program = new Command();
    registerCoreMaintenance(program, deps);

    const exitCode = await runCommand(program, ['update']);

    expect(exitCode).toBe(1);
    expect(telemetryMocks.track).toHaveBeenCalledWith('cli_update', {
      from_version: '1.2.3',
      to_version: '2.0.0',
      success: false,
      error_class: 'Error',
    });
  });

  it('uninstall dry-run covers renamed and legacy installer bin directories', async () => {
    const { deps } = createHarness();
    const program = new Command();
    registerCoreMaintenance(program, deps);
    const home = os.homedir();
    const paths = [`${home}/.agentworkforce/relay/bin`, `${home}/.agent-relay/bin`];
    for (const filePath of paths) {
      deps.fs.writeFileSync(filePath, '');
    }

    const exitCode = await runCommand(program, ['uninstall', '--dry-run']);

    expect(exitCode).toBeUndefined();
    for (const filePath of paths) {
      expect(deps.log).toHaveBeenCalledWith(`[dry-run] Would remove directory: ${filePath}`);
    }
    expect(deps.execCommand).not.toHaveBeenCalled();
  });

  it('up always logs the workspace key after broker starts', async () => {
    const relay = createRelayMock();
    const { program, deps } = createHarness({ relay });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('Workspace Key: rk_live_…ey01');
  });

  it('up logs the auto-created workspace key', async () => {
    const relay = createRelayMock({ workspaceKey: 'rk_live_autominted456' });
    const { program, deps } = createHarness({ relay });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('Workspace Key: rk_live_…d456');
  });

  it('up --workspace-key sets RELAY_WORKSPACE_KEY in env before broker starts', async () => {
    const env: NodeJS.ProcessEnv = {};
    const relay = createRelayMock({ workspaceKey: 'rk_live_customflag77' });
    const { program, deps } = createHarness({ relay, env });

    const exitCode = await runCommand(program, ['up', '--workspace-key', 'rk_live_customflag77']);

    expect(exitCode).toBeUndefined();
    expect(env.RELAY_WORKSPACE_KEY).toBe('rk_live_customflag77');
    expect(env.RELAY_API_KEY).toBe('rk_live_customflag77');
    expect(deps.createRelay).toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('Workspace Key: rk_live_…ag77');
  });

  it('up --wk is an alias for --workspace-key', async () => {
    const env: NodeJS.ProcessEnv = {};
    const relay = createRelayMock({ workspaceKey: 'rk_live_aliasflag88' });
    const { program, deps } = createHarness({ relay, env });

    const exitCode = await runCommand(program, ['up', '--wk', 'rk_live_aliasflag88']);

    expect(exitCode).toBeUndefined();
    // The alias is folded into workspaceKey, so the broker sees the same env the
    // explicit flag would have set.
    expect(env.RELAY_WORKSPACE_KEY).toBe('rk_live_aliasflag88');
    expect(env.RELAY_API_KEY).toBe('rk_live_aliasflag88');
    expect(deps.log).toHaveBeenCalledWith('Workspace Key: rk_live_…ag88');
  });

  it('up without --workspace-key or a pinned session does not set workspace key env vars', async () => {
    const env: NodeJS.ProcessEnv = {};
    const relay = createRelayMock();
    const { program } = createHarness({ relay, env });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBeUndefined();
    expect(env.RELAY_WORKSPACE_KEY).toBeUndefined();
    expect(env.RELAY_API_KEY).toBeUndefined();
  });

  it('up resumes the workspace session pinned to the project', async () => {
    const env: NodeJS.ProcessEnv = {};
    const fs = createFsMock({
      '/tmp/project/.agentworkforce/relay/workspace-key.json': JSON.stringify({
        workspaceKey: 'rk_live_pinned',
      }),
    });
    const relay = createRelayMock({ workspaceKey: 'rk_live_pinned' });
    const { program } = createHarness({ relay, env, fs });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBeUndefined();
    expect(env.RELAY_WORKSPACE_KEY).toBe('rk_live_pinned');
    expect(env.RELAY_API_KEY).toBe('rk_live_pinned');
  });

  it('up resumes the repository pin when an enrolled node token is present', async () => {
    const env: NodeJS.ProcessEnv = {
      RELAY_NODE_ID: 'node_enrolled',
      RELAY_NODE_TOKEN: 'nt_enrolled',
    };
    const projectSessionPath = '/tmp/project/.agentworkforce/relay/workspace-key.json';
    const fs = createFsMock({
      [projectSessionPath]: JSON.stringify({
        workspaceKey: 'rk_live_project_pin',
        workspaceId: 'rw_project',
        enrolledNodeId: 'node_enrolled',
      }),
    });
    const relay = createRelayMock({
      workspaceKey: 'rk_live_project_pin',
      workspaceId: 'rw_project',
    });
    const createRelay = vi.fn(async () => {
      // This is the non-mocked handoff to broker creation: the project pin is
      // already canonicalized even though the enrolled identity is present.
      expect(env.RELAY_WORKSPACE_KEY).toBe('rk_live_project_pin');
      expect(env.RELAY_API_KEY).toBe('rk_live_project_pin');
      expect(env.RELAY_NODE_TOKEN).toBe('nt_enrolled');
      return relay;
    });
    const { program, deps } = createHarness({ fs, env, relay, createRelay });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBeUndefined();
    expect(createRelay).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith(
      'Workspace source: repository pin (/tmp/project/.agentworkforce/relay/workspace-key.json)'
    );
    expect(deps.log).toHaveBeenCalledWith('Workspace: joined rw_project');
  });

  it('up treats a non-blank workspace env alias as explicit when the primary is blank', async () => {
    const env: NodeJS.ProcessEnv = {
      RELAY_WORKSPACE_KEY: '   ',
      AGENT_RELAY_WORKSPACE_KEY: ' rk_live_aliasflag88 ',
    };
    const fs = createFsMock({
      '/tmp/project/.agentworkforce/relay/workspace-key.json': JSON.stringify({
        workspaceKey: 'rk_live_pinned',
      }),
    });
    const relay = createRelayMock({ workspaceKey: 'rk_live_aliasflag88' });
    const { program } = createHarness({ relay, env, fs });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBeUndefined();
    expect(env.RELAY_WORKSPACE_KEY).toBe('rk_live_aliasflag88');
    expect(env.RELAY_API_KEY).toBeUndefined();
  });

  it('plain up preserves the enrolled node associated with a resumed project session', async () => {
    const projectDataDir = '/tmp/project/.agentworkforce/relay';
    const projectSessionPath = `${projectDataDir}/workspace-key.json`;
    const env: NodeJS.ProcessEnv = {};
    const fs = createFsMock({
      [projectSessionPath]: JSON.stringify({
        workspaceKey: 'rk_live_pinned',
        enrolledNodeId: 'node_enrolled',
      }),
    });
    const relay = createRelayMock({ workspaceKey: 'rk_live_pinned' });
    const { program } = createHarness({ relay, env, fs });

    nodeFs.rmSync(projectSessionPath, { force: true });
    try {
      const exitCode = await runCommand(program, ['up']);

      expect(exitCode).toBeUndefined();
      expect(readProjectWorkspaceSession(projectDataDir)).toEqual({
        workspaceKey: 'rk_live_pinned',
        enrolledNodeId: 'node_enrolled',
      });
    } finally {
      nodeFs.rmSync(projectSessionPath, { force: true });
    }
  });

  it('background up forwards the repository pin with an enrolled identity to the detached child', async () => {
    const spawnedProcess = createSpawnedProcessMock();
    let now = 0;
    const projectSessionPath = '/tmp/project/.agentworkforce/relay/workspace-key.json';
    const fs = createFsMock({
      [projectSessionPath]: JSON.stringify({
        workspaceKey: 'rk_live_pinned',
        enrolledNodeId: 'node_enrolled',
      }),
    });
    const sleepImpl = vi.fn(async (ms: number) => {
      now += ms;
      fs.writeFileSync('/tmp/project/.agentworkforce/relay/connection.json', connectionFile(5151));
    });
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if ((pid === 9001 || pid === 5151) && signal === 0) return;
      throw new Error('unexpected kill check');
    });
    sdkStatusClient.getStatus.mockResolvedValue({
      node_connected: true,
      node_delivery: { token_present: true, connected: true },
    });
    sdkStatusClient.getSession.mockResolvedValue({
      workspace_key: 'rk_live_pinned',
      node_id: 'node_enrolled',
      node_name: 'project',
    });
    const { program, deps } = createHarness({
      fs,
      env: {
        RELAY_NODE_ID: 'node_enrolled',
        RELAY_NODE_TOKEN: 'nt_enrolled',
      },
      spawnedProcess,
      killImpl,
      nowImpl: vi.fn(() => now),
      sleepImpl,
      configureDependencies: (deps) => enableBackgroundIdentity(deps, 'project', undefined, 5151),
    });

    const exitCode = await runCommand(program, ['up', '--background']);

    expect(exitCode).toBe(0);
    expect(deps.spawnProcess).toHaveBeenCalledWith(
      '/usr/bin/node',
      ['/tmp/agent-relay.js', 'up', '--background-child'],
      {
        detached: true,
        stdio: 'ignore',
        env: expect.objectContaining({
          AGENT_RELAY_ENROLLED_NODE_ID: 'node_enrolled',
          RELAY_API_KEY: 'rk_live_pinned',
          RELAY_NODE_ID: 'node_enrolled',
          RELAY_NODE_TOKEN: 'nt_enrolled',
          RELAY_WORKSPACE_KEY: 'rk_live_pinned',
        }),
      }
    );
  });

  it('up configures a bundled Agent Relay MCP command when the wrapper script exists', async () => {
    const env: NodeJS.ProcessEnv = {};
    const fs = createFsMock({ '/tmp/agent-relay-mcp.js': '' });
    const relay = createRelayMock();
    const { program } = createHarness({ relay, env, fs });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBeUndefined();
    expect(env.AGENT_RELAY_MCP_COMMAND).toBe('/usr/bin/node /tmp/agent-relay-mcp.js');
  });

  it('up re-enters the installed Bun executable for Agent Relay MCP', async () => {
    const env: NodeJS.ProcessEnv = {};
    const relay = createRelayMock();
    const { program } = createHarness({
      relay,
      env,
      argv: ['bun', '/$bunfs/root/agent-relay', 'up'],
      execPath: '/opt/agent-relay/bin/agent-relay',
      cliScript: '/$bunfs/root/agent-relay',
    });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBeUndefined();
    expect(env.AGENT_RELAY_MCP_COMMAND).toBe('/opt/agent-relay/bin/agent-relay mcp');
  });

  it('up quotes an installed Bun executable path containing spaces', async () => {
    const env: NodeJS.ProcessEnv = {};
    const relay = createRelayMock();
    const { program } = createHarness({
      relay,
      env,
      argv: ['bun', '/$bunfs/root/agent-relay', 'up'],
      execPath: '/Applications/Agent Relay/agent-relay',
      cliScript: '/$bunfs/root/agent-relay',
    });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBeUndefined();
    expect(env.AGENT_RELAY_MCP_COMMAND).toBe('"/Applications/Agent Relay/agent-relay" mcp');
  });

  it('up preserves an explicit AGENT_RELAY_MCP_COMMAND override', async () => {
    const env: NodeJS.ProcessEnv = { AGENT_RELAY_MCP_COMMAND: 'node /custom/agent-relay-mcp.js' };
    const fs = createFsMock({ '/tmp/agent-relay-mcp.js': '' });
    const relay = createRelayMock();
    const { program } = createHarness({ relay, env, fs });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBeUndefined();
    expect(env.AGENT_RELAY_MCP_COMMAND).toBe('node /custom/agent-relay-mcp.js');
  });

  it('up logs "unknown" when workspace key is unexpectedly missing', async () => {
    const relay = createRelayMock({ workspaceKey: undefined });
    const { program, deps } = createHarness({ relay });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('Workspace Key: unknown');
  });

  it('up --workspace-key overrides existing workspace key env vars', async () => {
    const env: NodeJS.ProcessEnv = { RELAY_API_KEY: 'rk_live_old' };
    const relay = createRelayMock({ workspaceKey: 'rk_live_newmint99' });
    const { program, deps } = createHarness({ relay, env });

    const exitCode = await runCommand(program, ['up', '--workspace-key', 'rk_live_newmint99']);

    expect(exitCode).toBeUndefined();
    expect(env.RELAY_WORKSPACE_KEY).toBe('rk_live_newmint99');
    expect(env.RELAY_API_KEY).toBe('rk_live_newmint99');
    expect(deps.log).toHaveBeenCalledWith('Workspace Key: rk_live_…nt99');
  });
});

describe('dead-letter commands', () => {
  function deadLetterEntry(overrides: Record<string, unknown> = {}) {
    return {
      delivery_id: 'del_1',
      worker_name: 'Worker',
      event_id: 'evt_1',
      from: 'Lead',
      to: 'Worker',
      attempts: 10,
      reason: 'max delivery retries exceeded',
      queued_at_ms: 1,
      failed_at_ms: 2,
      age_ms: 65_000,
      ...overrides,
    };
  }

  it('deadletters lists entries from the broker', async () => {
    const client = {
      getDeadLetters: vi.fn(async () => ({ count: 1, dead_letters: [deadLetterEntry()] })),
      disconnect: vi.fn(),
    };
    harnessConnectMock.mockReturnValueOnce(client);
    const { program, deps } = createHarness();

    const exitCode = await runCommand(program, ['deadletters']);

    expect(exitCode).toBeUndefined();
    expect(client.getDeadLetters).toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('del_1'));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('recipient=Worker'));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('reason=max delivery retries exceeded'));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('age=1m'));
    expect(client.disconnect).toHaveBeenCalled();
  });

  it('deadletters reports an empty queue', async () => {
    const client = {
      getDeadLetters: vi.fn(async () => ({ count: 0, dead_letters: [] })),
      disconnect: vi.fn(),
    };
    harnessConnectMock.mockReturnValueOnce(client);
    const { program, deps } = createHarness();

    await runCommand(program, ['deadletters']);

    expect(deps.log).toHaveBeenCalledWith('No dead-letter deliveries.');
  });

  it('deadletters --json prints the raw response', async () => {
    const response = { count: 1, dead_letters: [deadLetterEntry()] };
    const client = {
      getDeadLetters: vi.fn(async () => response),
      disconnect: vi.fn(),
    };
    harnessConnectMock.mockReturnValueOnce(client);
    const { program, deps } = createHarness();

    await runCommand(program, ['deadletters', '--json']);

    expect(deps.log).toHaveBeenCalledWith(JSON.stringify(response, null, 2));
  });

  it('redeliver requeues a single entry by id', async () => {
    const client = {
      redeliverDeadLetters: vi.fn(async () => ({
        redelivered: [{ delivery_id: 'del_1', worker_name: 'Worker', event_id: 'evt_1' }],
        skipped: [],
      })),
      disconnect: vi.fn(),
    };
    harnessConnectMock.mockReturnValueOnce(client);
    const { program, deps } = createHarness();

    const exitCode = await runCommand(program, ['redeliver', 'del_1']);

    expect(exitCode).toBeUndefined();
    expect(client.redeliverDeadLetters).toHaveBeenCalledWith({ id: 'del_1' });
    expect(deps.log).toHaveBeenCalledWith('Redelivered del_1 to Worker');
    expect(client.disconnect).toHaveBeenCalled();
  });

  it('redeliver --all requeues everything and reports skips', async () => {
    const client = {
      redeliverDeadLetters: vi.fn(async () => ({
        redelivered: [{ delivery_id: 'del_1', worker_name: 'Worker', event_id: 'evt_1' }],
        skipped: [{ delivery_id: 'del_2', worker_name: 'Ghost', reason: 'recipient not running' }],
      })),
      disconnect: vi.fn(),
    };
    harnessConnectMock.mockReturnValueOnce(client);
    const { program, deps } = createHarness();

    await runCommand(program, ['redeliver', '--all']);

    expect(client.redeliverDeadLetters).toHaveBeenCalledWith({ all: true });
    expect(deps.log).toHaveBeenCalledWith('Redelivered del_1 to Worker');
    expect(deps.warn).toHaveBeenCalledWith('Skipped del_2 (Ghost): recipient not running');
  });

  it('redeliver requires exactly one of id or --all', async () => {
    const { program, deps } = createHarness();

    expect(await runCommand(program, ['redeliver'])).toBe(1);
    expect(await runCommand(program, ['redeliver', 'del_1', '--all'])).toBe(1);
    expect(deps.error).toHaveBeenCalledWith('Provide exactly one of <id> or --all.');
    expect(harnessConnectMock).not.toHaveBeenCalled();
  });
});
