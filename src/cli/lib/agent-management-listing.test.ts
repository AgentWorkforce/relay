import { describe, expect, it, vi } from 'vitest';

import {
  runAgentsCommand,
  runAgentsLogsCommand,
  runWhoCommand,
  toPlainLogLines,
  type AgentManagementListingDependencies,
  type ListingWorkerInfo,
} from './agent-management-listing.js';

function createDeps(options?: {
  workers?: ListingWorkerInfo[];
  listAgentsError?: Error;
  nowIso?: string;
  metrics?: Array<{ name: string; pid: number; memory_bytes: number; uptime_secs: number }>;
  getMetricsError?: Error;
}) {
  const workers = options?.workers ?? [];
  const listAgents = options?.listAgentsError
    ? vi.fn(async () => {
        throw options.listAgentsError;
      })
    : vi.fn(async () => workers);
  const getMetrics =
    options?.getMetricsError !== undefined
      ? vi.fn(async () => {
          throw options.getMetricsError;
        })
      : options?.metrics !== undefined
        ? vi.fn(async () => ({ agents: options.metrics }))
        : undefined;
  const shutdown = vi.fn(async () => undefined);
  const log = vi.fn(() => undefined);
  const error = vi.fn(() => undefined);
  const exit = vi.fn((code: number) => {
    throw new Error(`exit:${code}`);
  }) as unknown as AgentManagementListingDependencies['exit'];

  const deps: AgentManagementListingDependencies = {
    getProjectRoot: vi.fn(() => '/tmp/project'),
    getDataDir: vi.fn(() => '/tmp/data'),
    createClient: vi.fn(() => ({
      listAgents,
      ...(getMetrics ? { getMetrics } : {}),
      shutdown,
    })),
    fileExists: vi.fn(() => false),
    readFile: vi.fn(() => ''),
    fetch: vi.fn(async () => {
      throw new Error('not implemented');
    }),
    nowIso: vi.fn(() => options?.nowIso ?? '2026-03-04T00:00:00.000Z'),
    log,
    error,
    exit,
  };

  return { deps, listAgents, shutdown, log, error };
}

describe('agent-management-listing JSON output', () => {
  it('runAgentsCommand emits deterministic JSON for visible local agents', async () => {
    const { deps, log, shutdown } = createDeps({
      workers: [
        { name: 'WorkerA', runtime: 'codex', model: 'o3', team: 'core', pid: 4242 },
        { name: 'Dashboard', runtime: 'pty' },
      ],
    });

    await runAgentsCommand({ json: true }, deps);

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual([
      {
        name: 'WorkerA',
        status: 'ONLINE',
        cli: 'codex',
        model: 'o3',
        team: 'core',
        pid: 4242,
        location: 'local',
      },
    ]);
  });

  it('runWhoCommand emits structured JSON with real broker metrics', async () => {
    const { deps, log, shutdown } = createDeps({
      workers: [
        { name: 'WorkerWho', cli: 'claude' },
        { name: 'Dashboard', runtime: 'pty' },
      ],
      metrics: [{ name: 'WorkerWho', pid: 4321, memory_bytes: 1048576, uptime_secs: 421 }],
    });

    await runWhoCommand({ json: true }, deps);

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual([
      {
        name: 'WorkerWho',
        cli: 'claude',
        status: 'online',
        pid: 4321,
        uptimeSecs: 421,
        memoryBytes: 1048576,
      },
    ]);
  });

  it('runWhoCommand falls back to list-only fields when metrics are unavailable', async () => {
    const { deps, log } = createDeps({
      workers: [{ name: 'WorkerWho', cli: 'claude', pid: 99 }],
    });

    await runWhoCommand({ json: true }, deps);

    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual([
      {
        name: 'WorkerWho',
        cli: 'claude',
        status: 'online',
        pid: 99,
        uptimeSecs: null,
        memoryBytes: null,
      },
    ]);
  });

  it('runWhoCommand falls back to list-only fields when getMetrics throws', async () => {
    const { deps, log } = createDeps({
      workers: [{ name: 'WorkerWho', cli: 'claude', pid: 99 }],
      getMetricsError: new Error('metrics unavailable'),
    });

    await runWhoCommand({ json: true }, deps);

    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual([
      {
        name: 'WorkerWho',
        cli: 'claude',
        status: 'online',
        pid: 99,
        uptimeSecs: null,
        memoryBytes: null,
      },
    ]);
  });

  it('runWhoCommand matches metrics by agent name without leaking mismatched metrics', async () => {
    const { deps, log } = createDeps({
      workers: [{ name: 'WorkerWho', cli: 'claude', pid: 99 }],
      metrics: [{ name: 'OtherWorker', pid: 4321, memory_bytes: 1048576, uptime_secs: 421 }],
    });

    await runWhoCommand({ json: true }, deps);

    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual([
      {
        name: 'WorkerWho',
        cli: 'claude',
        status: 'online',
        pid: 99,
        uptimeSecs: null,
        memoryBytes: null,
      },
    ]);
  });

  it('runWhoCommand renders the human table with real PID and UPTIME columns', async () => {
    const { deps, log } = createDeps({
      workers: [{ name: 'WorkerWho', cli: 'claude' }],
      metrics: [{ name: 'WorkerWho', pid: 4321, memory_bytes: 1048576, uptime_secs: 421 }],
    });

    await runWhoCommand({}, deps);

    const lines = log.mock.calls.map((c) => c[0] as string);
    expect(lines.some((l) => l.includes('PID') && l.includes('UPTIME'))).toBe(true);
    // Real pid and formatted uptime (421s -> "7m 01s"), not "ONLINE / now".
    const row = lines.find((l) => l.startsWith('WorkerWho'));
    expect(row).toContain('online');
    expect(row).toContain('4321');
    expect(row).toContain('7m 01s');
    expect(lines[0]).not.toContain('MEMORY');
    expect(row).not.toContain('1048576');
    expect(lines.some((l) => l.includes('LAST SEEN'))).toBe(false);
  });

  it('runAgentsCommand returns [] JSON when listAgents fails', async () => {
    const { deps, log, shutdown } = createDeps({
      listAgentsError: new Error('broker unavailable'),
    });

    await runAgentsCommand({ json: true }, deps);

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual([]);
  });
});

describe('toPlainLogLines', () => {
  it('strips ANSI/cursor escapes, drops escape-only lines, collapses redraw frames', () => {
    const ESC = '\u001b';
    const raw = [
      `${ESC}[2J${ESC}[H`, // pure cursor/clear noise -> dropped
      `${ESC}[31mERROR${ESC}[0m: boom`, // color codes stripped
      `${ESC}[?25l⠙ Working(18m 06s)`,
      `${ESC}[?25l⠙ Working(18m 06s)`, // identical redraw frame -> collapsed
      `${ESC}[?25l⠙ Working(18m 07s)`,
      'done   ', // trailing whitespace trimmed
    ].join('\n');

    expect(toPlainLogLines(raw)).toEqual(['ERROR: boom', '⠙ Working(18m 06s)', '⠙ Working(18m 07s)', 'done']);
  });

  it('preserves a single genuine blank line but collapses runs', () => {
    expect(toPlainLogLines('a\n\n\n b ')).toEqual(['a', '', ' b']);
  });
});

describe('runAgentsLogsCommand --plain / --json', () => {
  const ESC = '\u001b';
  const rawLog = [
    `${ESC}[2J${ESC}[H`,
    `${ESC}[32mline one${ESC}[0m`,
    `${ESC}[?25l⠙ spin`,
    `${ESC}[?25l⠙ spin`,
    'line two',
    '',
  ].join('\n');

  function logsDeps() {
    const log = vi.fn(() => undefined);
    const error = vi.fn(() => undefined);
    const exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }) as unknown as AgentManagementListingDependencies['exit'];
    const deps: AgentManagementListingDependencies = {
      getProjectRoot: vi.fn(() => '/tmp/project'),
      getDataDir: vi.fn(() => '/tmp/data'),
      createClient: vi.fn(() => ({
        listAgents: vi.fn(async () => []),
        shutdown: vi.fn(async () => undefined),
      })),
      fileExists: vi.fn(() => true),
      readFile: vi.fn(() => rawLog),
      fetch: vi.fn(async () => {
        throw new Error('not implemented');
      }),
      nowIso: vi.fn(() => '2026-03-04T00:00:00.000Z'),
      log,
      error,
      exit,
    };
    return { deps, log, error };
  }

  it('--plain emits sanitized, deduped lines with no decorative header', async () => {
    const { deps, log } = logsDeps();

    await runAgentsLogsCommand('WorkerA', { plain: true }, deps);

    expect(log).toHaveBeenCalledTimes(1);
    const out = log.mock.calls[0][0] as string;
    expect(out).toBe(['line one', '⠙ spin', 'line two'].join('\n'));
    expect(out).not.toContain(ESC);
    expect(out).not.toContain('Logs for WorkerA');
  });

  it('--json emits structured sanitized snapshot', async () => {
    const { deps, log } = logsDeps();

    await runAgentsLogsCommand('WorkerA', { json: true }, deps);

    expect(log).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(log.mock.calls[0][0] as string);
    expect(parsed.agent).toBe('WorkerA');
    expect(parsed.lines).toEqual(['line one', '⠙ spin', 'line two']);
    expect(log.mock.calls[0][0] as string).not.toContain(ESC);
  });

  it('default (no flags) preserves the raw header + content', async () => {
    const { deps, log } = logsDeps();

    await runAgentsLogsCommand('WorkerA', {}, deps);

    const joined = log.mock.calls.map((c) => c[0] as string).join('\n');
    expect(joined).toContain('Logs for WorkerA');
    expect(joined).toContain(ESC); // raw view keeps escapes
  });
});
