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
    validateBridgeDaemons: vi.fn(() => ({ valid: validBridgeProjects, missing: missingBridgeProjects })),
    getAgentOutboxTemplate: vi.fn(() => '/tmp/project/.agent-relay/outbox'),
    createRelay: options?.createRelay ?? vi.fn(() => relay),
    findDashboardBinary: vi.fn(() => '/usr/local/bin/relay-dashboard-server'),
    spawnProcess:
      options?.spawnImpl ??
      (vi.fn(() => spawnedProcess) as unknown as CoreDependencies['spawnProcess']),
    execCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
    killProcess: options?.killImpl ?? vi.fn(() => undefined),
    fs,
    generateAgentName: vi.fn(() => 'AutoAgent'),
    checkForUpdates:
      vi.fn(async () => options?.checkForUpdatesResult ?? ({ updateAvailable: false, latestVersion: '1.2.3' })) as unknown as CoreDependencies['checkForUpdates'],
    getVersion: vi.fn(() => '1.2.3'),
    env: {},
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
      expect.arrayContaining(['up', 'down', 'status', 'uninstall', 'version', 'update', 'bridge'])
    );
  });

  it('up starts broker and dashboard process', async () => {
    const relay = createRelayMock({
      getStatus: vi.fn(async () => ({ agent_count: 1, pending_delivery_count: 0 })),
    });
    const { program, deps, fs, brokerPidPath } = createHarness({ relay });

    const exitCode = await runCommand(program, ['up', '--port', '4999']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelay).toHaveBeenCalledWith('/tmp/project');
    expect(fs.writeFileSync).toHaveBeenCalledWith(brokerPidPath, '4242', 'utf-8');
    expect(deps.spawnProcess).toHaveBeenCalledWith(
      '/usr/local/bin/relay-dashboard-server',
      expect.arrayContaining(['--integrated', '--port', '4999']),
      expect.any(Object)
    );
    expect(relay.getStatus).toHaveBeenCalledTimes(1);
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

    const exitCode = await runCommand(program, ['bridge', '--architect=claude:sonnet', '/tmp/alpha', '/tmp/beta']);

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
