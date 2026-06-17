import { Command } from 'commander';
import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdkStatusClient = {
  getStatus: vi.fn(async () => ({ agent_count: 0, pending_delivery_count: 0 })),
  getSession: vi.fn(async () => ({ workspace_key: '' }) as { workspace_key?: string }),
  disconnect: vi.fn(() => undefined),
};

vi.mock('@agent-relay/harness-driver', () => ({
  HarnessDriverClient: vi.fn(function () {
    return sdkStatusClient;
  }),
}));

const telemetryMocks = vi.hoisted(() => ({
  track: vi.fn(),
}));

vi.mock('../telemetry/index.js', () => ({
  track: telemetryMocks.track,
}));

beforeEach(() => {
  sdkStatusClient.getStatus.mockReset();
  sdkStatusClient.getStatus.mockResolvedValue({ agent_count: 0, pending_delivery_count: 0 });
  sdkStatusClient.getSession.mockReset();
  sdkStatusClient.getSession.mockResolvedValue({ workspace_key: '' });
  sdkStatusClient.disconnect.mockClear();
  telemetryMocks.track.mockClear();
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
  env?: NodeJS.ProcessEnv;
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
  const dataDir = '/tmp/project/.agentworkforce/relay';
  const relaySockPath = '/tmp/project/.agentworkforce/relay/relay.sock';
  const connectionPath = '/tmp/project/.agentworkforce/relay/connection.json';
  const runtimePath = '/tmp/project/.agentworkforce/relay/runtime.json';

  const fs = options?.fs ?? createFsMock();
  const relay = options?.relay ?? createRelayMock();
  const spawnedProcess = options?.spawnedProcess ?? createSpawnedProcessMock();

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

    expect(commandNames).toEqual(expect.arrayContaining(['up', 'down', 'status', 'metrics']));
    expect(commandNames).not.toEqual(expect.arrayContaining(['bridge', 'uninstall', 'version', 'update']));
  });

  it('up forwards --broker-name to createRelay', async () => {
    const relay = createRelayMock({
      getStatus: vi.fn(async () => ({ agent_count: 1, pending_delivery_count: 0 })),
    });
    const { program, deps } = createHarness({ relay });

    const exitCode = await runCommand(program, ['up', '--broker-name', 'relayfile-dev']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelay).toHaveBeenCalledWith('/tmp/project', 3889, 'relayfile-dev');
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

  it('up probes for a free API port before spawning the broker', async () => {
    const relay = createRelayMock();
    const { program, deps } = createHarness({ relay });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBeUndefined();
    // Port probing happens before createRelay — only one broker is spawned
    expect(deps.createRelay).toHaveBeenCalledTimes(1);
    // API port = base port (3888) + 1 = 3889
    expect(deps.createRelay).toHaveBeenCalledWith('/tmp/project', 3889, undefined);
    expect(relay.getStatus).toHaveBeenCalledTimes(1);
  });

  it('up enables the local broker API', async () => {
    const relay = createRelayMock();
    const { program, deps } = createHarness({ relay });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelay).toHaveBeenCalledTimes(1);
    expect(deps.createRelay).toHaveBeenCalledWith('/tmp/project', 3889, undefined);
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
    });

    const exitCode = await runCommand(program, ['up', '--background']);

    expect(exitCode).toBe(0);
    expect(deps.spawnProcess).toHaveBeenCalledWith(
      '/usr/bin/node',
      ['/tmp/agent-relay.js', 'up'],
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
    });
    deps.argv = [
      'node',
      '/tmp/agent-relay.js',
      'up',
      '--background',
      '--state-dir',
      stateDir,
      '--workspace-key',
      'rk_live_custom',
      '--broker-name',
      'relayfile-dev',
    ];

    const exitCode = await runCommand(program, [
      'up',
      '--background',
      '--state-dir',
      stateDir,
      '--workspace-key',
      'rk_live_custom',
      '--broker-name',
      'relayfile-dev',
    ]);

    expect(exitCode).toBe(0);
    expect(deps.spawnProcess).toHaveBeenCalledWith(
      '/usr/bin/node',
      [
        '/tmp/agent-relay.js',
        'up',
        '--state-dir',
        stateDir,
        '--workspace-key',
        'rk_live_custom',
        '--broker-name',
        'relayfile-dev',
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

  it('up --background re-execs a Bun standalone binary without adding its virtual entrypoint', async () => {
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
    const { program, deps } = createHarness({
      fs,
      spawnedProcess,
      killImpl,
      nowImpl: vi.fn(() => now),
      sleepImpl,
      execPath: '/tmp/agent-relay-darwin-arm64',
      cliScript: '/$bunfs/root/agent-relay-darwin-arm64',
      argv: ['bun', '/$bunfs/root/agent-relay-darwin-arm64', 'up', '--background'],
    });

    const exitCode = await runCommand(program, ['up', '--background']);

    expect(exitCode).toBe(0);
    expect(deps.spawnProcess).toHaveBeenCalledWith(
      '/tmp/agent-relay-darwin-arm64',
      ['up'],
      {
        detached: true,
        stdio: 'ignore',
        env: deps.env,
      }
    );
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

  it('down --force only kills actual orphaned broker executables for the project', async () => {
    const runningPids = new Set([222, 444, 666]);
    const execCommand = vi.fn(async (command: string) => {
      if (command === 'ps aux') {
        return {
          stdout: [
            'USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND',
            'khaliqgant 111 0.0 0.0 1 1 ?? S 1:00PM 0:00.01 /bin/zsh -lc BROKER=/tmp/project/target/release/agent-relay-broker node /tmp/agent-relay.js down --force',
            'khaliqgant 222 0.0 0.0 1 1 ?? S 1:00PM 0:00.01 /opt/bin/agent-relay-broker init --name project --channels general --persist',
            'khaliqgant 333 0.0 0.0 1 1 ?? S 1:00PM 0:00.01 /opt/bin/agent-relay-broker init --name project --channels general --persist',
            'khaliqgant 444 0.0 0.0 1 1 ?? S 1:00PM 0:00.01 /opt/bin/agent-relay-broker init --state-dir /tmp/project/.agentworkforce/relay --persist',
            'khaliqgant 555 0.0 0.0 1 1 ?? S 1:00PM 0:00.01 /opt/bin/agent-relay-broker init --state-dir /tmp/project-other/.agentworkforce/relay --persist',
            'khaliqgant 666 0.0 0.0 1 1 ?? S 1:00PM 0:00.01 /Users/test/.agentworkforce/relay/bin/agent-relay up',
            'khaliqgant 777 0.0 0.0 1 1 ?? S 1:00PM 0:00.01 /Users/test/.agentworkforce/relay/bin/agent-relay status --wait-for=30',
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
      if (command.includes('-p 666 ')) {
        return { stdout: 'p666\nfcwd\nn/tmp/project\n', stderr: '' };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        if (runningPids.has(pid)) return;
        throw new Error('not running');
      }
      runningPids.delete(pid);
    });
    let now = 0;
    const { program, deps } = createHarness({
      execCommand,
      killImpl,
      nowImpl: vi.fn(() => now),
      sleepImpl: vi.fn(async (ms: number) => {
        now += ms;
      }),
    });

    const exitCode = await runCommand(program, ['down', '--force']);

    expect(exitCode).toBeUndefined();
    expect(killImpl).toHaveBeenCalledWith(222, 'SIGTERM');
    expect(killImpl).toHaveBeenCalledWith(444, 'SIGTERM');
    expect(killImpl).toHaveBeenCalledWith(666, 'SIGTERM');
    expect(killImpl).not.toHaveBeenCalledWith(111, 'SIGTERM');
    expect(killImpl).not.toHaveBeenCalledWith(333, 'SIGTERM');
    expect(killImpl).not.toHaveBeenCalledWith(555, 'SIGTERM');
    expect(killImpl).not.toHaveBeenCalledWith(777, 'SIGTERM');
    expect(deps.warn).toHaveBeenCalledWith('Killing orphaned broker process (pid: 222)');
    expect(deps.warn).toHaveBeenCalledWith('Killing orphaned broker process (pid: 444)');
    expect(deps.warn).toHaveBeenCalledWith('Killing orphaned broker process (pid: 666)');
    expect(deps.log).toHaveBeenCalledWith('Cleaned up (was not running)');
  });

  it('up --background reaps a broker orphan before starting cleanly', async () => {
    const spawnedProcess = createSpawnedProcessMock({ pid: 9001 });
    const runningPids = new Set([777, 9001, 4242]);
    const fs = createFsMock();
    let now = 0;
    const execCommand = vi.fn(async (command: string) => {
      if (command === 'ps aux') {
        return {
          stdout: [
            'USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND',
            'khaliqgant 777 0.0 0.0 1 1 ?? S 1:00PM 0:00.01 /Users/test/.agentworkforce/relay/bin/agent-relay up',
          ].join('\n'),
          stderr: '',
        };
      }
      if (command.includes('-p 777 ')) {
        return { stdout: 'p777\nfcwd\nn/tmp/project\n', stderr: '' };
      }
      throw new Error(`unexpected command: ${command}`);
    });
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
    const { program, deps } = createHarness({
      fs,
      spawnedProcess,
      execCommand,
      killImpl,
      nowImpl: vi.fn(() => now),
      sleepImpl,
    });

    const exitCode = await runCommand(program, ['up', '--background']);

    expect(exitCode).toBe(0);
    expect(killImpl).toHaveBeenCalledWith(777, 'SIGTERM');
    expect(deps.warn).toHaveBeenCalledWith('Killing orphaned broker process (pid: 777)');
    expect(deps.spawnProcess).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith('Broker started.');
    expect(deps.log).toHaveBeenCalledWith('Broker PID: 4242');
  });

  it('up --background replaces a live broker PID whose API never becomes ready', async () => {
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

    expect(exitCode).toBe(0);
    expect(killImpl).toHaveBeenCalledWith(3030, 'SIGTERM');
    expect(fs.unlinkSync).toHaveBeenCalledWith('/tmp/project/.agentworkforce/relay/connection.json');
    expect(deps.warn).toHaveBeenCalledWith(
      'Broker process is running but the API is not ready; killing half-started broker (pid: 3030).'
    );
    expect(deps.spawnProcess).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith('Broker PID: 4242');
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
    expect(killImpl).toHaveBeenCalledWith(4242, 'SIGTERM');
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

    const { program, deps } = createHarness({ relay });
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
    const connectionPath = '/tmp/project/.agentworkforce/relay/connection.json';
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
    expect(deps.log).toHaveBeenCalledWith('Workspace Key: rk_live_default');
  });

  it('up logs the auto-created workspace key', async () => {
    const relay = createRelayMock({ workspaceKey: 'rk_live_auto456' });
    const { program, deps } = createHarness({ relay });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('Workspace Key: rk_live_auto456');
  });

  it('up --workspace-key sets RELAY_WORKSPACE_KEY in env before broker starts', async () => {
    const env: NodeJS.ProcessEnv = {};
    const relay = createRelayMock({ workspaceKey: 'rk_live_custom' });
    const { program, deps } = createHarness({ relay, env });

    const exitCode = await runCommand(program, ['up', '--workspace-key', 'rk_live_custom']);

    expect(exitCode).toBeUndefined();
    expect(env.RELAY_WORKSPACE_KEY).toBe('rk_live_custom');
    expect(env.RELAY_API_KEY).toBe('rk_live_custom');
    expect(deps.createRelay).toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('Workspace Key: rk_live_custom');
  });

  it('up without --workspace-key does not set workspace key env vars', async () => {
    const env: NodeJS.ProcessEnv = {};
    const relay = createRelayMock();
    const { program } = createHarness({ relay, env });

    const exitCode = await runCommand(program, ['up']);

    expect(exitCode).toBeUndefined();
    expect(env.RELAY_WORKSPACE_KEY).toBeUndefined();
    expect(env.RELAY_API_KEY).toBeUndefined();
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
    const relay = createRelayMock({ workspaceKey: 'rk_live_new' });
    const { program, deps } = createHarness({ relay, env });

    const exitCode = await runCommand(program, ['up', '--workspace-key', 'rk_live_new']);

    expect(exitCode).toBeUndefined();
    expect(env.RELAY_WORKSPACE_KEY).toBe('rk_live_new');
    expect(env.RELAY_API_KEY).toBe('rk_live_new');
    expect(deps.log).toHaveBeenCalledWith('Workspace Key: rk_live_new');
  });
});
