import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdkStatusClient = {
  getStatus: vi.fn(async () => ({ agent_count: 0, pending_delivery_count: 0 })),
  getSession: vi.fn(async () => ({ workspace_key: '' }) as { workspace_key?: string }),
  disconnect: vi.fn(() => undefined),
};

vi.mock('@agent-relay/sdk', () => ({
  AgentRelayClient: vi.fn().mockImplementation(() => sdkStatusClient),
}));

beforeEach(() => {
  sdkStatusClient.getStatus.mockReset();
  sdkStatusClient.getStatus.mockResolvedValue({ agent_count: 0, pending_delivery_count: 0 });
  sdkStatusClient.getSession.mockReset();
  sdkStatusClient.getSession.mockResolvedValue({ workspace_key: '' });
  sdkStatusClient.disconnect.mockClear();
});

import {
  registerCoreCommands,
  type BridgeProject,
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

function connectionFile(pid: number, url = 'http://127.0.0.1:3889', apiKey = 'br_secret'): string {
  return JSON.stringify({
    url,
    port: Number(new URL(url).port || '0'),
    api_key: apiKey,
    pid,
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
    workspaceKey: 'rk_live_default',
    ...overrides,
  };
}

function createFsMock(initialFiles: Record<string, string> = {}): CoreFileSystem {
  const files = new Map(Object.entries(initialFiles));

  return {
    existsSync: vi.fn((filePath: string) => files.has(filePath)),
    readFileSync: vi.fn((filePath: string) => files.get(filePath) ?? ''),
    writeFileSync: vi.fn((filePath: string, data: string) => {
      files.set(filePath, String(data));
    }),
    unlinkSync: vi.fn((filePath: string) => {
      files.delete(filePath);
    }),
    readdirSync: vi.fn(() => []),
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
  dashboardBinary?: string | null;
  env?: NodeJS.ProcessEnv;
  bridgeProjects?: BridgeProject[];
  validBridgeProjects?: BridgeProject[];
  missingBridgeProjects?: BridgeProject[];
  spawnedProcess?: SpawnedProcess;
  spawnImpl?: CoreDependencies['spawnProcess'];
  execCommand?: CoreDependencies['execCommand'];
  killImpl?: CoreDependencies['killProcess'];
  nowImpl?: CoreDependencies['now'];
  sleepImpl?: CoreDependencies['sleep'];
  execPath?: string;
  cliScript?: string;
  argv?: string[];
  checkForUpdatesResult?: Awaited<ReturnType<CoreDependencies['checkForUpdates']>>;
}) {
  const projectRoot = '/tmp/project';
  const dataDir = '/tmp/project/.agent-relay';
  const relaySockPath = '/tmp/project/.agent-relay/relay.sock';
  const connectionPath = '/tmp/project/.agent-relay/connection.json';
  const runtimePath = '/tmp/project/.agent-relay/runtime.json';

  const fs = options?.fs ?? createFsMock();
  const relay = options?.relay ?? createRelayMock();
  const spawnedProcess = options?.spawnedProcess ?? createSpawnedProcessMock();
  const bridgeProjects = options?.bridgeProjects ?? [];
  const validBridgeProjects = options?.validBridgeProjects ?? bridgeProjects;
  const missingBridgeProjects = options?.missingBridgeProjects ?? [];

  const exit = vi.fn((code: number) => {
    throw new ExitSignal(code);
  }) as unknown as CoreDependencies['exit'];

  const deps: CoreDependencies = {
    getProjectPaths: vi.fn(() => ({
      projectRoot,
      dataDir,
      teamDir: '/tmp/project/.agent-relay/teams',
      dbPath: '/tmp/project/.agent-relay/messages.db',
      projectId: 'project',
    })),
    loadTeamsConfig: vi.fn(() => options?.teamsConfig ?? null),
    resolveBridgeProjects: vi.fn(() => bridgeProjects),
    validateBridgeBrokers: vi.fn(() => ({ valid: validBridgeProjects, missing: missingBridgeProjects })),
    getAgentOutboxTemplate: vi.fn(() => '/tmp/project/.agent-relay/outbox'),
    createRelay: options?.createRelay ?? vi.fn(() => relay),
    findDashboardBinary: vi.fn(() => options?.dashboardBinary ?? '/usr/local/bin/relay-dashboard-server'),
    spawnProcess:
      options?.spawnImpl ?? (vi.fn(() => spawnedProcess) as unknown as CoreDependencies['spawnProcess']),
    execCommand: options?.execCommand ?? vi.fn(async () => ({ stdout: '', stderr: '' })),
    killProcess: options?.killImpl ?? vi.fn(() => undefined),
    fs,
    generateAgentName: vi.fn(() => 'AutoAgent'),
    checkForUpdates: vi.fn(
      async () => options?.checkForUpdatesResult ?? { updateAvailable: false, latestVersion: '1.2.3' }
    ) as unknown as CoreDependencies['checkForUpdates'],
    getVersion: vi.fn(() => '1.2.3'),
    env: options?.env ?? {},
    argv: options?.argv ?? ['node', '/tmp/agent-relay.js', 'up'],
    execPath: options?.execPath ?? '/usr/bin/node',
    cliScript: options?.cliScript ?? '/tmp/agent-relay.js',
    pid: 4242,
    now: options?.nowImpl ?? vi.fn(() => Date.now()),
    isPortInUse: vi.fn(async () => false),
    findBrokerApiPort: vi.fn(async () => 3889),
    sleep: options?.sleepImpl ?? vi.fn(async () => undefined),
    onSignal: vi.fn(() => undefined),
    holdOpen: vi.fn(async () => undefined),
    log: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    warn: vi.fn(() => undefined),
    exit,
  };

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
      expect.arrayContaining(['up', 'start', 'down', 'status', 'uninstall', 'version', 'update', 'bridge'])
    );
  });

  it('up starts broker and dashboard process', async () => {
    const relay = createRelayMock({
      getStatus: vi.fn(async () => ({ agent_count: 1, pending_delivery_count: 0 })),
    });
    const { program, deps, fs } = createHarness({ relay });

    const exitCode = await runCommand(program, ['up', '--port', '4999']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelay).toHaveBeenCalledWith('/tmp/project', 5000);
    expect(deps.spawnProcess).toHaveBeenCalledWith(
      '/usr/local/bin/relay-dashboard-server',
      expect.arrayContaining(['--port', '4999', '--relay-url', 'http://127.0.0.1:5000']),
      expect.any(Object)
    );
    const dashboardArgs = (deps.spawnProcess as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][1] as string[];
    expect(dashboardArgs).not.toContain('--no-spawn');
    expect(relay.getStatus).toHaveBeenCalledTimes(1);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('start dashboard.js logs a focused cli-tools dashboard URL', async () => {
    const relay = createRelayMock({
      getStatus: vi.fn(async () => ({ agent_count: 1, pending_delivery_count: 0 })),
    });
    const { program, deps } = createHarness({ relay });

    const exitCode = await runCommand(program, ['start', 'dashboard.js', 'claude', '--port', '4999']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelay).toHaveBeenCalledWith('/tmp/project', 5000);
    expect(deps.spawnProcess).toHaveBeenCalledWith(
      '/usr/local/bin/relay-dashboard-server',
      expect.arrayContaining(['--port', '4999', '--relay-url', 'http://127.0.0.1:5000']),
      expect.any(Object)
    );
    const logCalls = (deps.log as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(logCalls).toEqual(
      expect.arrayContaining([['Dashboard: http://localhost:4999/dev/cli-tools?tool=claude']])
    );
  });

  it('up exits early when connection metadata points to a running process', async () => {
    const connectionPath = '/tmp/project/.agent-relay/connection.json';
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
          'broker exited (code=1, signal=null): Error: another broker instance is already running in this directory (/tmp/project/.agent-relay)'
        );
      }),
    });
    const { program, deps } = createHarness({ relay });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith(
      'Broker already running for this project (lock: /tmp/project/.agent-relay).'
    );
    expect(deps.error).toHaveBeenCalledWith(
      'Run `agent-relay status` to inspect it, then `agent-relay down` to stop it.'
    );
    expect(deps.error).toHaveBeenCalledWith(
      'If it still fails, run `agent-relay down --force` to clear stale runtime files.'
    );
  });

  it('up infers static-dir for local dashboard JS entrypoint', async () => {
    const staticDir = '/tmp/relay-dashboard/packages/dashboard-server/out';
    const fs = createFsMock({ [staticDir]: '' });
    const { program, deps } = createHarness({
      fs,
      dashboardBinary: '/tmp/relay-dashboard/packages/dashboard-server/dist/start.js',
    });

    const exitCode = await runCommand(program, ['up', '--port', '4999']);

    expect(exitCode).toBeUndefined();
    const dashboardArgs = (deps.spawnProcess as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][1] as string[];
    const dashboardOptions = (deps.spawnProcess as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][2] as { env?: NodeJS.ProcessEnv };
    expect(dashboardArgs).toEqual(expect.arrayContaining(['--relay-url', 'http://127.0.0.1:5000']));
    expect(dashboardArgs).toEqual(expect.arrayContaining(['--static-dir', staticDir]));
    expect(dashboardOptions.env?.RELAY_URL).toBe('http://127.0.0.1:5000');
  });

  it('up infers static-dir for standalone dashboard binary install layout', async () => {
    const home = '/Users/tester';
    const staticDir = `${home}/.relay/dashboard/out`;
    const fs = createFsMock({
      [staticDir]: '',
      [`${staticDir}/index.html`]: '<html></html>',
    });
    const { program, deps } = createHarness({
      fs,
      env: { HOME: home },
      dashboardBinary: `${home}/.local/bin/relay-dashboard-server`,
    });

    const exitCode = await runCommand(program, ['up', '--port', '4999']);

    expect(exitCode).toBeUndefined();
    const dashboardArgs = (deps.spawnProcess as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][1] as string[];
    expect(dashboardArgs).toEqual(expect.arrayContaining(['--static-dir', staticDir]));
  });

  it('up prefers static-dir candidate that includes metrics page', async () => {
    const dashboardServerOut = '/tmp/relay-dashboard/packages/dashboard-server/out';
    const dashboardOut = '/tmp/relay-dashboard/packages/dashboard/out';
    const fs = createFsMock({
      [dashboardServerOut]: '',
      [dashboardOut]: '',
      [`${dashboardOut}/metrics.html`]: '<html></html>',
    });
    const { program, deps } = createHarness({
      fs,
      dashboardBinary: '/tmp/relay-dashboard/packages/dashboard-server/dist/start.js',
    });

    const exitCode = await runCommand(program, ['up', '--port', '4999']);

    expect(exitCode).toBeUndefined();
    const dashboardArgs = (deps.spawnProcess as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][1] as string[];
    expect(dashboardArgs).toEqual(expect.arrayContaining(['--static-dir', dashboardOut]));
  });

  it('up prefers static-dir candidate that includes nested metrics page', async () => {
    const dashboardServerOut = '/tmp/relay-dashboard/packages/dashboard-server/out';
    const dashboardOut = '/tmp/relay-dashboard/packages/dashboard/out';
    const fs = createFsMock({
      [dashboardServerOut]: '',
      [dashboardOut]: '',
      [`${dashboardOut}/metrics/index.html`]: '<html></html>',
    });
    const { program, deps } = createHarness({
      fs,
      dashboardBinary: '/tmp/relay-dashboard/packages/dashboard-server/dist/start.js',
    });

    const exitCode = await runCommand(program, ['up', '--port', '4999']);

    expect(exitCode).toBeUndefined();
    const dashboardArgs = (deps.spawnProcess as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][1] as string[];
    expect(dashboardArgs).toEqual(expect.arrayContaining(['--static-dir', dashboardOut]));
  });

  it('up auto-spawns agents from teams config', async () => {
    const relay = createRelayMock();
    const { program } = createHarness({
      relay,
      teamsConfig: {
        team: 'platform',
        autoSpawn: true,
        agents: [{ name: 'WorkerA', cli: 'codex', task: 'Ship tests' }],
      },
    });

    const exitCode = await runCommand(program, ['up', '--no-dashboard', '--foreground']);

    expect(exitCode).toBeUndefined();
    expect(relay.spawn).toHaveBeenCalledWith({
      name: 'WorkerA',
      cli: 'codex',
      channels: ['general'],
      task: 'Ship tests',
      team: 'platform',
    });
  });

  it('up skips teams auto-spawn when dashboard mode manages broker', async () => {
    const relay = createRelayMock();
    const { program, deps } = createHarness({
      relay,
      teamsConfig: {
        team: 'platform',
        autoSpawn: true,
        agents: [{ name: 'WorkerA', cli: 'codex', task: 'Ship tests' }],
      },
    });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBeUndefined();
    expect(relay.spawn).toHaveBeenCalledTimes(0);
    expect(deps.warn).toHaveBeenCalledWith(
      'Warning: auto-spawn from teams.json is skipped when dashboard mode manages the broker'
    );
  });

  it('up exits when dashboard port is already in use', async () => {
    const spawnImpl = vi.fn(() => {
      const error = new Error('listen EADDRINUSE') as Error & { code?: string };
      error.code = 'EADDRINUSE';
      throw error;
    }) as unknown as CoreDependencies['spawnProcess'];

    const { program, deps } = createHarness({ spawnImpl });

    const exitCode = await runCommand(program, ['up', '--port', '3888']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith('Dashboard port 3888 is already in use.');
  });

  it('up probes for a free API port before spawning the broker', async () => {
    const relay = createRelayMock();
    const { program, deps } = createHarness({ relay });

    const exitCode = await runCommand(program, ['up', '--port', '3888']);

    expect(exitCode).toBeUndefined();
    // Port probing happens before createRelay — only one broker is spawned
    expect(deps.createRelay).toHaveBeenCalledTimes(1);
    // API port = dashboard port (3888) + 1 = 3889
    expect(deps.createRelay).toHaveBeenCalledWith('/tmp/project', 3889);
    expect(relay.getStatus).toHaveBeenCalledTimes(1);
  });

  it('up without dashboard still enables the local broker API', async () => {
    const relay = createRelayMock();
    const { program, deps } = createHarness({ relay });

    const exitCode = await runCommand(program, ['up', '--no-dashboard', '--foreground', '--port', '3888']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelay).toHaveBeenCalledTimes(1);
    expect(deps.createRelay).toHaveBeenCalledWith('/tmp/project', 3889);
    expect(relay.getStatus).toHaveBeenCalledTimes(1);
  });

  it('up --no-dashboard detaches by default for headless sessions', async () => {
    const spawnedProcess = createSpawnedProcessMock();
    let now = 0;
    const fs = createFsMock();
    const sleepImpl = vi.fn(async (ms: number) => {
      now += ms;
      fs.writeFileSync('/tmp/project/.agent-relay/connection.json', connectionFile(4242));
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
    });

    const exitCode = await runCommand(program, ['up', '--no-dashboard']);

    expect(exitCode).toBe(0);
    expect(deps.spawnProcess).toHaveBeenCalledWith(
      '/usr/bin/node',
      ['/tmp/agent-relay.js', 'up', '--no-dashboard', '--foreground'],
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

  it('up --background --no-dashboard preserves state and workspace args in the foreground child', async () => {
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
    });
    deps.argv = [
      'node',
      '/tmp/agent-relay.js',
      'up',
      '--background',
      '--no-dashboard',
      '--state-dir',
      stateDir,
      '--workspace-key',
      'rk_live_custom',
    ];

    const exitCode = await runCommand(program, [
      'up',
      '--background',
      '--no-dashboard',
      '--state-dir',
      stateDir,
      '--workspace-key',
      'rk_live_custom',
    ]);

    expect(exitCode).toBe(0);
    expect(deps.spawnProcess).toHaveBeenCalledWith(
      '/usr/bin/node',
      [
        '/tmp/agent-relay.js',
        'up',
        '--no-dashboard',
        '--state-dir',
        stateDir,
        '--workspace-key',
        'rk_live_custom',
        '--foreground',
      ],
      {
        detached: true,
        stdio: 'ignore',
        env: deps.env,
      }
    );
    expect(deps.env.AGENT_RELAY_STATE_DIR).toBe(stateDir);
    expect(deps.log).toHaveBeenCalledWith('Broker started.');
    expect(deps.log).toHaveBeenCalledWith('Broker PID: 5151');
  });

  it('up rejects mutually exclusive background and foreground flags', async () => {
    const { program, deps } = createHarness();

    const exitCode = await runCommand(program, ['up', '--no-dashboard', '--background', '--foreground']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith('Cannot use --background and --foreground together.');
    expect(deps.spawnProcess).not.toHaveBeenCalled();
  });

  it('up --no-dashboard re-execs a Bun standalone binary without adding its virtual entrypoint', async () => {
    const spawnedProcess = createSpawnedProcessMock();
    let now = 0;
    const fs = createFsMock();
    const sleepImpl = vi.fn(async (ms: number) => {
      now += ms;
      fs.writeFileSync('/tmp/project/.agent-relay/connection.json', connectionFile(4242));
    });
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if ((pid === 9001 || pid === 4242) && signal === 0) return;
      throw new Error('unexpected kill check');
    });
    const { program, deps } = createHarness({
      fs,
      spawnedProcess,
      killImpl,
      nowImpl: vi.fn(() => now),
      sleepImpl,
      execPath: '/tmp/agent-relay-darwin-arm64',
      cliScript: '/$bunfs/root/agent-relay-darwin-arm64',
      argv: ['bun', '/$bunfs/root/agent-relay-darwin-arm64', 'up', '--no-dashboard'],
    });

    const exitCode = await runCommand(program, ['up', '--no-dashboard']);

    expect(exitCode).toBe(0);
    expect(deps.spawnProcess).toHaveBeenCalledWith(
      '/tmp/agent-relay-darwin-arm64',
      ['up', '--no-dashboard', '--foreground'],
      {
        detached: true,
        stdio: 'ignore',
        env: deps.env,
      }
    );
  });

  it('up --no-dashboard exits non-zero when the detached broker never becomes ready', async () => {
    const spawnedProcess = createSpawnedProcessMock();
    let now = 0;
    const sleepImpl = vi.fn(async (ms: number) => {
      now += ms;
    });
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 9001 && signal === 0) return;
      throw new Error('unexpected kill check');
    });
    const { program, deps } = createHarness({
      spawnedProcess,
      killImpl,
      nowImpl: vi.fn(() => now),
      sleepImpl,
    });

    const exitCode = await runCommand(program, ['up', '--no-dashboard']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith(
      'Broker background start did not become ready within 10s (pid: 9001).'
    );
    expect(deps.error).toHaveBeenCalledWith(
      'Run `agent-relay status --wait-for=10` for details, or `agent-relay down --force` to clean up.'
    );
    expect(deps.log).not.toHaveBeenCalledWith('Broker started.');
  });

  it('down --force only kills actual orphaned broker executables for the project', async () => {
    const execCommand = vi.fn(async (command: string) => {
      if (command === 'ps aux') {
        return {
          stdout: [
            'USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND',
            'khaliqgant 111 0.0 0.0 1 1 ?? S 1:00PM 0:00.01 /bin/zsh -lc BROKER=/tmp/project/target/release/agent-relay-broker node /tmp/agent-relay.js down --force',
            'khaliqgant 222 0.0 0.0 1 1 ?? S 1:00PM 0:00.01 /opt/bin/agent-relay-broker init --name project --channels general --persist',
            'khaliqgant 333 0.0 0.0 1 1 ?? S 1:00PM 0:00.01 /opt/bin/agent-relay-broker init --name project --channels general --persist',
            'khaliqgant 444 0.0 0.0 1 1 ?? S 1:00PM 0:00.01 /opt/bin/agent-relay-broker init --state-dir /tmp/project/.agent-relay --persist',
            'khaliqgant 555 0.0 0.0 1 1 ?? S 1:00PM 0:00.01 /opt/bin/agent-relay-broker init --state-dir /tmp/project-other/.agent-relay --persist',
          ].join('\n'),
          stderr: '',
        };
      }
      if (command.includes('-p 222 ')) {
        return { stdout: 'p222\nfcwd\nn/tmp/project\n', stderr: '' };
      }
      if (command.includes('-p 333 ')) {
        return { stdout: 'p333\nfcwd\nn/tmp/project-other\n', stderr: '' };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const killImpl = vi.fn(() => undefined);
    const { program, deps } = createHarness({ execCommand, killImpl });

    const exitCode = await runCommand(program, ['down', '--force']);

    expect(exitCode).toBeUndefined();
    expect(killImpl).toHaveBeenCalledWith(222, 'SIGTERM');
    expect(killImpl).toHaveBeenCalledWith(444, 'SIGTERM');
    expect(killImpl).not.toHaveBeenCalledWith(111, 'SIGTERM');
    expect(killImpl).not.toHaveBeenCalledWith(333, 'SIGTERM');
    expect(killImpl).not.toHaveBeenCalledWith(555, 'SIGTERM');
    expect(deps.warn).toHaveBeenCalledWith('Killing orphaned broker process (pid: 222)');
    expect(deps.warn).toHaveBeenCalledWith('Killing orphaned broker process (pid: 444)');
    expect(deps.log).toHaveBeenCalledWith('Cleaned up (was not running)');
  });

  it('up --no-dashboard reports the broker PID when the detached broker is live but API-unready', async () => {
    const spawnedProcess = createSpawnedProcessMock({ pid: 9001 });
    let now = 0;
    const fs = createFsMock({ ['/tmp/project/.agent-relay/connection.json']: connectionFile(4242) });
    const sleepImpl = vi.fn(async (ms: number) => {
      now += ms;
    });
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if ((pid === 9001 || pid === 4242) && signal === 0) return;
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

    const exitCode = await runCommand(program, ['up', '--no-dashboard']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith(
      'Broker background start did not become ready within 10s (pid: 4242).'
    );
    expect(deps.error).toHaveBeenCalledWith('Broker process is running, but the API did not become ready.');
  });

  it('up --no-dashboard reports spawn failures without claiming background success', async () => {
    const { program, deps } = createHarness({
      spawnImpl: vi.fn(() => {
        throw new Error('spawn EACCES');
      }) as unknown as CoreDependencies['spawnProcess'],
    });

    const exitCode = await runCommand(program, ['up', '--no-dashboard']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith('Failed to start broker in background: spawn EACCES');
    expect(deps.log).not.toHaveBeenCalledWith('Broker started.');
  });

  it('up force exits on repeated SIGINT during hung shutdown and suppresses expected dashboard signal noise', async () => {
    const relay = createRelayMock({
      shutdown: vi.fn(() => new Promise(() => undefined)),
    });
    let dashboardExitHandler: ((...args: unknown[]) => void) | undefined;

    const spawnedProcess = {
      pid: 9001,
      killed: false,
      kill: vi.fn((signal?: NodeJS.Signals | number) => {
        spawnedProcess.killed = true;
        dashboardExitHandler?.(null, typeof signal === 'string' ? signal : null);
      }),
      unref: vi.fn(() => undefined),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'exit') {
          dashboardExitHandler = cb;
        }
      }),
      stderr: { on: vi.fn(() => undefined) },
    } as unknown as SpawnedProcess;

    const { program, deps } = createHarness({ relay, spawnedProcess });
    const exitCode = await runCommand(program, ['up']);
    expect(exitCode).toBeUndefined();

    const onSignalMock = deps.onSignal as unknown as { mock: { calls: unknown[][] } };
    const sigintHandler = onSignalMock.mock.calls.find((call) => call[0] === 'SIGINT')?.[1] as
      | (() => Promise<void>)
      | undefined;
    expect(sigintHandler).toBeDefined();
    const sigint = sigintHandler as () => Promise<void>;

    void sigint();
    await Promise.resolve();
    await expect(sigint()).rejects.toMatchObject({ code: 130 });

    expect(relay.shutdown).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledTimes(1);
    expect(deps.warn).toHaveBeenCalledWith('Force exiting...');

    const logCalls = (deps.log as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(logCalls.filter((call) => call[0] === '\nStopping...')).toHaveLength(1);

    const errorCalls = (deps.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(
      errorCalls.filter((call) => String(call[0]).includes('Dashboard process killed by signal'))
    ).toHaveLength(0);
  });

  it('down stops broker and cleans stale files', async () => {
    const connectionPath = '/tmp/project/.agent-relay/connection.json';
    const relaySockPath = '/tmp/project/.agent-relay/relay.sock';
    const runtimePath = '/tmp/project/.agent-relay/runtime.json';

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

    const { program } = createHarness({ fs, killImpl });

    const exitCode = await runCommand(program, ['down']);

    expect(exitCode).toBeUndefined();
    expect(killImpl).toHaveBeenCalledWith(3030, 'SIGTERM');
    expect(fs.unlinkSync).toHaveBeenCalledWith(connectionPath);
    expect(fs.unlinkSync).toHaveBeenCalledWith(relaySockPath);
    expect(fs.unlinkSync).toHaveBeenCalledWith(runtimePath);
  });

  it('down reports not running when connection metadata is missing', async () => {
    const { program, deps } = createHarness();

    const exitCode = await runCommand(program, ['down']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('Not running');
  });

  it('status checks broker status and prints metrics', async () => {
    const connectionPath = '/tmp/project/.agent-relay/connection.json';
    const fs = createFsMock({ [connectionPath]: connectionFile(4242) });
    sdkStatusClient.getStatus.mockResolvedValueOnce({ agent_count: 4, pending_delivery_count: 2 });
    sdkStatusClient.getSession.mockResolvedValueOnce({ workspace_key: 'rk_live_test123' });

    const { program, deps } = createHarness({ fs });

    const exitCode = await runCommand(program, ['status']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('Status: RUNNING');
    expect(deps.log).toHaveBeenCalledWith('Agents: 4');
    expect(deps.log).toHaveBeenCalledWith('Pending deliveries: 2');
    expect(deps.log).toHaveBeenCalledWith('Workspace Key: rk_live_test123');
    expect(deps.log).toHaveBeenCalledWith('Observer: https://agentrelay.com/observer?key=rk_live_test123');
    expect(sdkStatusClient.disconnect).toHaveBeenCalled();
  });

  it('status omits workspace key and observer when broker has no workspace_key', async () => {
    const connectionPath = '/tmp/project/.agent-relay/connection.json';
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
    const connectionPath = '/tmp/project/.agent-relay/connection.json';
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
      fs.writeFileSync('/tmp/project/.agent-relay/connection.json', connectionFile(4242));
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
    const connectionPath = '/tmp/project/.agent-relay/connection.json';
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
    sdkStatusClient.getSession.mockResolvedValueOnce({ workspace_key: 'rk_live_ready' });

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
    expect(deps.log).toHaveBeenCalledWith('Workspace Key: rk_live_ready');
  });

  it('status --wait-for treats getStatus success as ready even when session lookup fails', async () => {
    const now = 0;
    const connectionPath = '/tmp/project/.agent-relay/connection.json';
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
    const connectionPath = '/tmp/project/.agent-relay/connection.json';
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
    const { program, deps } = createHarness();

    const exitCode = await runCommand(program, ['version']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('agent-relay v1.2.3');
  });

  it('update in --check mode reports available version without installing', async () => {
    const { program, deps } = createHarness({
      checkForUpdatesResult: { updateAvailable: true, latestVersion: '2.0.0' },
    });

    const exitCode = await runCommand(program, ['update', '--check']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('New version available: 2.0.0');
    expect(deps.execCommand).not.toHaveBeenCalled();
  });

  it('bridge connects projects and spawns architect with model override', async () => {
    const projectA: BridgeProject = { id: 'alpha', path: '/tmp/alpha', leadName: 'LeadA' };
    const projectB: BridgeProject = { id: 'beta', path: '/tmp/beta', leadName: 'LeadB' };

    const relayA = createRelayMock();
    const relayB = createRelayMock();

    const createRelay = vi.fn((cwd: string) => (cwd === '/tmp/alpha' ? relayA : relayB));

    const { program } = createHarness({
      bridgeProjects: [projectA, projectB],
      validBridgeProjects: [projectA, projectB],
      createRelay: createRelay as unknown as CoreDependencies['createRelay'],
    });

    const exitCode = await runCommand(program, [
      'bridge',
      '--architect=claude:sonnet',
      '/tmp/alpha',
      '/tmp/beta',
    ]);

    expect(exitCode).toBeUndefined();
    expect(relayA.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Architect',
        cli: 'claude',
        args: ['--model', 'sonnet'],
      })
    );
  });

  it('up always logs the workspace key after broker starts', async () => {
    const relay = createRelayMock();
    const { program, deps } = createHarness({ relay });

    const exitCode = await runCommand(program, ['up', '--no-dashboard', '--foreground']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('Workspace Key: rk_live_default');
  });

  it('up logs the auto-created workspace key with dashboard enabled', async () => {
    const relay = createRelayMock({ workspaceKey: 'rk_live_auto456' });
    const { program, deps } = createHarness({ relay });

    const exitCode = await runCommand(program, ['up', '--port', '4999']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('Workspace Key: rk_live_auto456');
  });

  it('up --workspace-key sets RELAY_API_KEY in env before broker starts', async () => {
    const env: NodeJS.ProcessEnv = {};
    const relay = createRelayMock({ workspaceKey: 'rk_live_custom' });
    const { program, deps } = createHarness({ relay, env });

    const exitCode = await runCommand(program, [
      'up',
      '--no-dashboard',
      '--foreground',
      '--workspace-key',
      'rk_live_custom',
    ]);

    expect(exitCode).toBeUndefined();
    expect(env.RELAY_API_KEY).toBe('rk_live_custom');
    expect(deps.createRelay).toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('Workspace Key: rk_live_custom');
  });

  it('up without --workspace-key does not set RELAY_API_KEY in env', async () => {
    const env: NodeJS.ProcessEnv = {};
    const relay = createRelayMock();
    const { program } = createHarness({ relay, env });

    const exitCode = await runCommand(program, ['up', '--no-dashboard', '--foreground']);

    expect(exitCode).toBeUndefined();
    expect(env.RELAY_API_KEY).toBeUndefined();
  });

  it('up configures a bundled Relaycast MCP command when the wrapper script exists', async () => {
    const env: NodeJS.ProcessEnv = {};
    const fs = createFsMock({ '/tmp/relaycast-mcp.js': '' });
    const relay = createRelayMock();
    const { program } = createHarness({ relay, env, fs });

    const exitCode = await runCommand(program, ['up', '--no-dashboard', '--foreground']);

    expect(exitCode).toBeUndefined();
    expect(env.RELAYCAST_MCP_COMMAND).toBe('/usr/bin/node /tmp/relaycast-mcp.js');
  });

  it('up preserves an explicit RELAYCAST_MCP_COMMAND override', async () => {
    const env: NodeJS.ProcessEnv = { RELAYCAST_MCP_COMMAND: 'node /custom/relaycast-mcp.js' };
    const fs = createFsMock({ '/tmp/relaycast-mcp.js': '' });
    const relay = createRelayMock();
    const { program } = createHarness({ relay, env, fs });

    const exitCode = await runCommand(program, ['up', '--no-dashboard', '--foreground']);

    expect(exitCode).toBeUndefined();
    expect(env.RELAYCAST_MCP_COMMAND).toBe('node /custom/relaycast-mcp.js');
  });

  it('up logs "unknown" when workspace key is unexpectedly missing', async () => {
    const relay = createRelayMock({ workspaceKey: undefined });
    const { program, deps } = createHarness({ relay });

    const exitCode = await runCommand(program, ['up', '--no-dashboard', '--foreground']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('Workspace Key: unknown');
  });

  it('start dashboard.js logs workspace key when reusing existing broker', async () => {
    const connectionPath = '/tmp/project/.agent-relay/connection.json';
    const fs = createFsMock({ [connectionPath]: connectionFile(3030) });
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 3030 && (signal === 0 || signal === undefined)) {
        return; // process is running
      }
      if (signal === 'SIGTERM') {
        return;
      }
    });
    const relay = createRelayMock({ workspaceKey: 'rk_live_reused' });
    const { program, deps } = createHarness({ fs, killImpl, relay });

    const exitCode = await runCommand(program, ['start', 'dashboard.js', 'claude', '--port', '4999']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('Workspace Key: rk_live_reused');
    expect(deps.log).toHaveBeenCalledWith(
      'Broker already running for this project; reusing existing broker.'
    );
  });

  it('up --workspace-key overrides existing RELAY_API_KEY in env', async () => {
    const env: NodeJS.ProcessEnv = { RELAY_API_KEY: 'rk_live_old' };
    const relay = createRelayMock({ workspaceKey: 'rk_live_new' });
    const { program, deps } = createHarness({ relay, env });

    const exitCode = await runCommand(program, [
      'up',
      '--no-dashboard',
      '--foreground',
      '--workspace-key',
      'rk_live_new',
    ]);

    expect(exitCode).toBeUndefined();
    expect(env.RELAY_API_KEY).toBe('rk_live_new');
    expect(deps.log).toHaveBeenCalledWith('Workspace Key: rk_live_new');
  });

  it('bridge exits when no projects have running brokers', async () => {
    const projectA: BridgeProject = { id: 'alpha', path: '/tmp/alpha', leadName: 'LeadA' };

    const { program, deps } = createHarness({
      bridgeProjects: [projectA],
      validBridgeProjects: [],
      missingBridgeProjects: [projectA],
    });

    const exitCode = await runCommand(program, ['bridge', '/tmp/alpha']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith('No projects have running brokers. Start them first.');
  });
});
