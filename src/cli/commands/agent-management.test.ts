import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import {
  registerAgentManagementCommands,
  type AgentManagementClient,
  type AgentManagementDependencies,
} from './agent-management.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

function createClientMock(overrides: Partial<AgentManagementClient> = {}): AgentManagementClient {
  const client: AgentManagementClient = {
    spawnPty: vi.fn(async () => undefined),
    listAgents: vi.fn(async () => []),
    release: vi.fn(async () => undefined),
    setModel: vi.fn(async () => ({ success: true })),
    getMetrics: vi.fn(async () => ({ agents: [] })),
    shutdown: vi.fn(async () => undefined),
  };

  Object.assign(client, overrides);
  return client;
}

function createHarness(options?: {
  client?: AgentManagementClient;
  projectRoot?: string;
  stdinTask?: string | undefined;
  dataDir?: string;
  files?: Record<string, string>;
  fetchResponse?: unknown;
  nowIso?: string;
}) {
  const client = options?.client ?? createClientMock();
  const projectRoot = options?.projectRoot ?? '/tmp/project';
  const dataDir = options?.dataDir ?? '/tmp/data';
  const stdinTask = options?.stdinTask;
  const files = new Map(Object.entries(options?.files ?? {}));

  const exit = vi.fn((code: number) => {
    throw new ExitSignal(code);
  }) as unknown as AgentManagementDependencies['exit'];

  const deps: AgentManagementDependencies = {
    getProjectRoot: vi.fn(() => projectRoot),
    getDataDir: vi.fn(() => dataDir),
    createClient: vi.fn(() => client),
    readTaskFromStdin: vi.fn(async () => stdinTask),
    fileExists: vi.fn((filePath: string) => files.has(filePath)),
    readFile: vi.fn((filePath: string) => files.get(filePath) ?? ''),
    fetch: vi.fn(async () => new Response(JSON.stringify(options?.fetchResponse ?? { allAgents: [] }))),
    nowIso: vi.fn(() => options?.nowIso ?? '2026-02-20T12:00:00.000Z'),
    killProcess: vi.fn(() => undefined),
    sleep: vi.fn(async () => undefined),
    log: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    exit,
  };

  const program = new Command();
  registerAgentManagementCommands(program, deps);

  return { program, deps, client };
}

async function runCommand(program: Command, args: string[]): Promise<number | undefined> {
  try {
    await program.parseAsync(args, { from: 'user' });
    return undefined;
  } catch (err) {
    if (err instanceof ExitSignal) {
      return err.code;
    }
    throw err;
  }
}

describe('registerAgentManagementCommands', () => {
  it('registers agent-management commands on the program', () => {
    const { program } = createHarness();
    const commandNames = program.commands.map((cmd) => cmd.name());

    expect(commandNames).toEqual(
      expect.arrayContaining([
        'spawn',
        'agents',
        'who',
        'agents:logs',
        'release',
        'set-model',
        'agents:kill',
        'broker-spawn',
      ])
    );
  });

  it('spawns an agent using AgentRelayClient and exits 0', async () => {
    const client = createClientMock({
      listAgents: vi.fn(async () => [{ name: 'WorkerA', pid: 4321 }]),
    });
    const { program, deps } = createHarness({ client });

    const exitCode = await runCommand(program, ['spawn', 'WorkerA', 'codex', 'Ship tests']);

    expect(exitCode).toBe(0);
    expect(deps.createClient).toHaveBeenCalledWith('/tmp/project');
    expect(client.spawnPty).toHaveBeenCalledWith({
      name: 'WorkerA',
      cli: 'codex',
      channels: ['general'],
      task: 'Ship tests',
      team: undefined,
      model: undefined,
      cwd: undefined,
      shadowOf: undefined,
      shadowMode: undefined,
    });
    expect(client.listAgents).toHaveBeenCalledTimes(1);
    expect(client.shutdown).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith('Spawned agent: WorkerA (pid: 4321)');
  });

  it('uses stdin task for spawn when task argument is omitted', async () => {
    const client = createClientMock();
    const { program } = createHarness({ client, stdinTask: 'Task from stdin' });

    const exitCode = await runCommand(program, ['spawn', 'WorkerB', 'claude']);

    expect(exitCode).toBe(0);
    expect(client.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'WorkerB',
        cli: 'claude',
        task: 'Task from stdin',
      })
    );
  });

  it('fails spawn when no task is provided via args or stdin', async () => {
    const { program, deps } = createHarness({ stdinTask: undefined });

    const exitCode = await runCommand(program, ['spawn', 'WorkerC', 'gemini']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith('Error: Task description required (as argument or via stdin)');
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it('releases an agent via AgentRelayClient', async () => {
    const client = createClientMock();
    const { program } = createHarness({ client });

    const exitCode = await runCommand(program, ['release', 'WorkerD']);

    expect(exitCode).toBe(0);
    expect(client.release).toHaveBeenCalledWith('WorkerD', 'released via cli');
    expect(client.shutdown).toHaveBeenCalledTimes(1);
  });

  it('sets model with parsed timeout', async () => {
    const client = createClientMock({
      setModel: vi.fn(async () => ({ success: true, model: 'sonnet' })),
    });
    const { program } = createHarness({ client });

    const exitCode = await runCommand(program, ['set-model', 'WorkerE', 'sonnet', '--timeout', '4500']);

    expect(exitCode).toBe(0);
    expect(client.setModel).toHaveBeenCalledWith('WorkerE', 'sonnet', { timeoutMs: 4500 });
    expect(client.shutdown).toHaveBeenCalledTimes(1);
  });

  it('kills an agent by pid with --force', async () => {
    const client = createClientMock({
      listAgents: vi.fn(async () => [{ name: 'WorkerF', pid: 1234 }]),
    });
    const { program, deps } = createHarness({ client });

    const exitCode = await runCommand(program, ['agents:kill', 'WorkerF', '--force']);

    expect(exitCode).toBeUndefined();
    expect(deps.killProcess).toHaveBeenCalledWith(1234, 'SIGKILL');
    expect(deps.log).toHaveBeenCalledWith('Killed agent: WorkerF');
  });

  it('fails agents:kill when agent is missing', async () => {
    const client = createClientMock({
      listAgents: vi.fn(async () => []),
    });
    const { program } = createHarness({ client });

    const exitCode = await runCommand(program, ['agents:kill', 'MissingWorker']);

    expect(exitCode).toBe(1);
  });

  it('lists agents including remote agents with --remote', async () => {
    const client = createClientMock({
      listAgents: vi.fn(async () => [{ name: 'WorkerLocal', runtime: 'pty', pid: 2222 }]),
    });
    const { program, deps } = createHarness({
      client,
      files: {
        '/tmp/data/cloud-config.json': JSON.stringify({
          cloudUrl: 'https://cloud.example.com',
          apiKey: 'ar_live_key',
        }),
      },
      fetchResponse: {
        allAgents: [
          {
            name: 'WorkerRemote',
            status: 'online',
            daemonId: 'daemon-1',
            daemonName: 'RemoteHost',
          },
        ],
      },
    });

    const exitCode = await runCommand(program, ['agents', '--remote']);

    expect(exitCode).toBeUndefined();
    expect(deps.fetch).toHaveBeenCalledWith(
      'https://cloud.example.com/api/daemons/agents',
      expect.objectContaining({ method: 'POST' })
    );
    const output = (deps.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => call.join(' '))
      .join('\n');
    expect(output).toContain('WorkerLocal');
    expect(output).toContain('WorkerRemote');
  });

  it('shows currently active agents for who command', async () => {
    const client = createClientMock({
      listAgents: vi.fn(async () => [{ name: 'WorkerWho', runtime: 'pty' }]),
    });
    const { program, deps } = createHarness({ client, nowIso: '2026-02-20T12:00:00.000Z' });

    const exitCode = await runCommand(program, ['who']);

    expect(exitCode).toBeUndefined();
    const output = (deps.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => call.join(' '))
      .join('\n');
    expect(output).toContain('NAME');
    expect(output).toContain('WorkerWho');
  });

  it('prints recent lines for agents:logs', async () => {
    const { program, deps } = createHarness({
      files: {
        '/tmp/project/.agent-relay/worker-logs/WorkerLogs.log': ['line-1', 'line-2', 'line-3'].join('\n'),
      },
    });

    const exitCode = await runCommand(program, ['agents:logs', 'WorkerLogs', '--lines', '2']);

    expect(exitCode).toBeUndefined();
    const output = (deps.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => call.join(' '))
      .join('\n');
    expect(output).toContain('Logs for WorkerLogs');
    expect(output).toContain('line-2');
    expect(output).toContain('line-3');
  });
});
