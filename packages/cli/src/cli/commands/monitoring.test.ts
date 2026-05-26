import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import {
  registerMonitoringCommands,
  type MonitoringDependencies,
  type MonitoringMetricsClient,
  type MonitoringProfilerRelay,
} from './monitoring.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

function createMetricsClientMock(overrides: Partial<MonitoringMetricsClient> = {}): MonitoringMetricsClient {
  return {
    getMetrics: vi.fn(async () => ({ agents: [] })),
    shutdown: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createProfilerRelayMock(overrides: Partial<MonitoringProfilerRelay> = {}): MonitoringProfilerRelay {
  return {
    spawn: vi.fn(async () => undefined),
    listAgents: vi.fn(async () => []),
    release: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createHarness(options?: {
  metricsClient?: MonitoringMetricsClient;
  profilerRelay?: MonitoringProfilerRelay;
  fetchImpl?: MonitoringDependencies['fetch'];
}) {
  const metricsClient = options?.metricsClient ?? createMetricsClientMock();
  const profilerRelay = options?.profilerRelay ?? createProfilerRelayMock();

  const exit = vi.fn((code: number) => {
    throw new ExitSignal(code);
  }) as unknown as MonitoringDependencies['exit'];

  const deps: MonitoringDependencies = {
    getProjectRoot: vi.fn(() => '/tmp/project'),
    createMetricsClient: vi.fn(() => metricsClient),
    createProfilerRelay: vi.fn(() => profilerRelay),
    generateAgentName: vi.fn(() => 'GeneratedAgent'),
    fetch:
      options?.fetchImpl ??
      (vi.fn(
        async () =>
          ({
            ok: true,
            json: async () => ({
              healthScore: 90,
              summary: 'ok',
              issues: [],
              recommendations: [],
              crashes: [],
              alerts: [],
              stats: { totalCrashes24h: 0, totalAlerts24h: 0, agentCount: 1 },
            }),
          }) as unknown as Response
      ) as MonitoringDependencies['fetch']),
    pathExists: vi.fn(() => true),
    mkdir: vi.fn(() => undefined),
    appendFile: vi.fn(() => undefined),
    memoryUsage: vi.fn(() => ({
      rss: 1,
      heapTotal: 2,
      heapUsed: 3,
      external: 4,
      arrayBuffers: 0,
    })),
    nowIso: vi.fn(() => '2026-01-01T00:00:00.000Z'),
    onSignal: vi.fn(() => undefined),
    setRepeatingTimer: vi.fn(() => 123 as unknown as NodeJS.Timeout),
    clearRepeatingTimer: vi.fn(() => undefined),
    log: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    clear: vi.fn(() => undefined),
    exit,
  };

  const program = new Command();
  registerMonitoringCommands(program, deps);

  return { program, deps, metricsClient, profilerRelay };
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

describe('registerMonitoringCommands', () => {
  it('registers monitoring commands on the program', () => {
    const { program } = createHarness();
    const commandNames = program.commands.map((cmd) => cmd.name());

    expect(commandNames).toEqual(expect.arrayContaining(['metrics', 'health', 'profile']));
  });

  it('runs metrics command and prints JSON output', async () => {
    const metricsClient = createMetricsClientMock({
      getMetrics: vi.fn(async () => ({
        agents: [{ name: 'A1', pid: 101, memory_bytes: 2048, uptime_secs: 60 }],
      })),
    });
    const { program, deps } = createHarness({ metricsClient });

    const exitCode = await runCommand(program, ['metrics', '--json']);

    expect(exitCode).toBeUndefined();
    expect(deps.createMetricsClient).toHaveBeenCalledWith('/tmp/project');
    expect(metricsClient.getMetrics).toHaveBeenCalledWith(undefined);
    expect(metricsClient.shutdown).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith(
      JSON.stringify({ agents: [{ name: 'A1', pid: 101, memory_bytes: 2048, uptime_secs: 60 }] }, null, 2)
    );
  });

  it('fetches and prints health JSON payload', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({
            healthScore: 80,
            summary: 'stable',
            issues: [],
            recommendations: [],
            crashes: [],
            alerts: [],
            stats: { totalCrashes24h: 1, totalAlerts24h: 0, agentCount: 3 },
          }),
        }) as unknown as Response
    ) as MonitoringDependencies['fetch'];

    const { program, deps } = createHarness({ fetchImpl });

    const exitCode = await runCommand(program, ['health', '--port', '4555', '--json']);

    expect(exitCode).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:4555/api/metrics/health');
    expect(deps.log).toHaveBeenCalledWith(
      JSON.stringify(
        {
          healthScore: 80,
          summary: 'stable',
          issues: [],
          recommendations: [],
          crashes: [],
          alerts: [],
          stats: { totalCrashes24h: 1, totalAlerts24h: 0, agentCount: 3 },
        },
        null,
        2
      )
    );
  });

  it('spawns profile relay with generated agent name', async () => {
    const profilerRelay = createProfilerRelayMock();
    const { program, deps } = createHarness({ profilerRelay });

    const exitCode = await runCommand(program, [
      'profile',
      'codex',
      'Ship',
      'tests',
      '--output-dir',
      './tmp-profiles',
    ]);

    expect(exitCode).toBeUndefined();
    expect(deps.pathExists).toHaveBeenCalledWith('./tmp-profiles');
    expect(profilerRelay.spawn).toHaveBeenCalledWith({
      name: 'GeneratedAgent',
      cli: 'codex',
      args: ['Ship', 'tests'],
      channels: ['general'],
    });
    expect(deps.onSignal).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });
});
