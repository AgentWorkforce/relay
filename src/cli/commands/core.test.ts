import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

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
  killImpl?: CoreDependencies['killProcess'];
  checkForUpdatesResult?: Awaited<ReturnType<CoreDependencies['checkForUpdates']>>;
}) {
  const projectRoot = '/tmp/project';
  const dataDir = '/tmp/project/.agent-relay';
  const relaySockPath = '/tmp/project/.agent-relay/relay.sock';
  const brokerPidPath = '/tmp/project/.agent-relay/broker.pid';
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
    execCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
    killProcess: options?.killImpl ?? vi.fn(() => undefined),
    fs,
    generateAgentName: vi.fn(() => 'AutoAgent'),
    checkForUpdates: vi.fn(
      async () => options?.checkForUpdatesResult ?? { updateAvailable: false, latestVersion: '1.2.3' }
    ) as unknown as CoreDependencies['checkForUpdates'],
    getVersion: vi.fn(() => '1.2.3'),
    env: options?.env ?? {},
    argv: ['node', '/tmp/agent-relay.js', 'up'],
    execPath: '/usr/bin/node',
    cliScript: '/tmp/agent-relay.js',
    pid: 4242,
    now: vi.fn(() => Date.now()),
    sleep: vi.fn(async () => undefined),
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
    brokerPidPath,
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
    const { program, deps } = createHarness({ relay });

    const exitCode = await runCommand(program, ['up', '--port', '4999']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelay).toHaveBeenCalledWith('/tmp/project', 5000);
    expect(deps.spawnProcess).toHaveBeenCalledWith(
      '/usr/local/bin/relay-dashboard-server',
      expect.arrayContaining(['--port', '4999', '--relay-url', 'http://localhost:5000']),
      expect.any(Object)
    );
    const dashboardArgs = (deps.spawnProcess as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][1] as string[];
    expect(dashboardArgs).not.toContain('--no-spawn');
    expect(relay.getStatus).toHaveBeenCalledTimes(1);
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
      expect.arrayContaining(['--port', '4999', '--relay-url', 'http://localhost:5000']),
      expect.any(Object)
    );
    const logCalls = (deps.log as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(logCalls).toEqual(expect.arrayContaining([['Dashboard: http://localhost:4999/dev/cli-tools?tool=claude']]));
  });

  it('up exits early when broker pid file points to a running process', async () => {
    const brokerPidPath = '/tmp/project/.agent-relay/broker.pid';
    const fs = createFsMock({ [brokerPidPath]: '3030' });
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
    expect(dashboardArgs).toEqual(expect.arrayContaining(['--relay-url', 'http://localhost:5000']));
    expect(dashboardArgs).toEqual(expect.arrayContaining(['--static-dir', staticDir]));
    expect(dashboardOptions.env?.RELAY_URL).toBeUndefined();
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

    const exitCode = await runCommand(program, ['up', '--no-dashboard']);

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

  it('up retries with next API port when first API port is taken', async () => {
    const firstRelay = createRelayMock({
      getStatus: vi.fn(async () => {
        const error = new Error('Error: failed to bind API on port 3889\nCaused by:\nAddress already in use (os error 48)') as Error & {
          code?: string;
        };
        throw error;
      }),
    });

    const secondRelay = createRelayMock();
    const createRelay = vi
      .fn()
      .mockReturnValueOnce(firstRelay)
      .mockReturnValueOnce(secondRelay) as unknown as CoreDependencies['createRelay'];

    const { program, deps } = createHarness({ createRelay });

    const exitCode = await runCommand(program, ['up', '--port', '3888']);

    expect(exitCode).toBeUndefined();
    expect(createRelay).toHaveBeenCalledWith('/tmp/project', 3889);
    expect(createRelay).toHaveBeenCalledWith('/tmp/project', 3890);
    expect(secondRelay.getStatus).toHaveBeenCalledTimes(1);
    expect(secondRelay.shutdown).toHaveBeenCalledTimes(0);
    expect(deps.spawnProcess).toHaveBeenCalledWith(
      '/usr/local/bin/relay-dashboard-server',
      expect.arrayContaining(['--port', '3888', '--relay-url', 'http://localhost:3890']),
      expect.any(Object)
    );
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
    const brokerPidPath = '/tmp/project/.agent-relay/broker.pid';
    const relaySockPath = '/tmp/project/.agent-relay/relay.sock';
    const runtimePath = '/tmp/project/.agent-relay/runtime.json';

    const fs = createFsMock({
      [brokerPidPath]: '3030',
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
    expect(fs.unlinkSync).toHaveBeenCalledWith(brokerPidPath);
    expect(fs.unlinkSync).toHaveBeenCalledWith(relaySockPath);
    expect(fs.unlinkSync).toHaveBeenCalledWith(runtimePath);
  });

  it('down reports not running when broker pid file is missing', async () => {
    const { program, deps } = createHarness();

    const exitCode = await runCommand(program, ['down']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('Not running');
  });

  it('status checks broker status and prints metrics', async () => {
    const brokerPidPath = '/tmp/project/.agent-relay/broker.pid';
    const fs = createFsMock({ [brokerPidPath]: '4242' });
    const relay = createRelayMock({
      getStatus: vi.fn(async () => ({ agent_count: 4, pending_delivery_count: 2 })),
    });

    const { program, deps } = createHarness({ fs, relay });

    const exitCode = await runCommand(program, ['status']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('Status: RUNNING');
    expect(deps.log).toHaveBeenCalledWith('Agents: 4');
    expect(deps.log).toHaveBeenCalledWith('Pending deliveries: 2');
  });

  it('status cleans stale pid file when broker is not running', async () => {
    const brokerPidPath = '/tmp/project/.agent-relay/broker.pid';
    const fs = createFsMock({ [brokerPidPath]: '9999' });
    const killImpl = vi.fn(() => {
      const err = new Error('gone') as Error & { code?: string };
      err.code = 'ESRCH';
      throw err;
    });

    const { program, deps } = createHarness({ fs, killImpl });

    const exitCode = await runCommand(program, ['status']);

    expect(exitCode).toBeUndefined();
    expect(fs.unlinkSync).toHaveBeenCalledWith(brokerPidPath);
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
