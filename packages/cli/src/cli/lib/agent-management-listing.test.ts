import { describe, expect, it, vi } from 'vitest';

import {
  PtyLogCooker,
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
  createClientError?: Error;
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
  const writeChunk = vi.fn(() => undefined);
  const error = vi.fn(() => undefined);
  const exit = vi.fn((code: number) => {
    throw new Error(`exit:${code}`);
  }) as unknown as AgentManagementListingDependencies['exit'];

  const deps: AgentManagementListingDependencies = {
    getProjectRoot: vi.fn(() => '/tmp/project'),
    getDataDir: vi.fn(() => '/tmp/data'),
    createClient: options?.createClientError
      ? vi.fn(() => {
          throw options.createClientError;
        })
      : vi.fn(() => ({
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
    writeChunk,
    log,
    error,
    exit,
  };

  return { deps, listAgents, shutdown, log, error, exit };
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
        lastActivity: null,
        contextBudgetPct: null,
        currentState: 'working',
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
        lastActivity: null,
        contextBudgetPct: null,
        currentState: 'working',
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
        lastActivity: null,
        contextBudgetPct: null,
        currentState: 'working',
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
        lastActivity: null,
        contextBudgetPct: null,
        currentState: 'working',
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

  it('runAgentsCommand sanitizes agent-controlled table cells', async () => {
    const ESC = '\u001b';
    const { deps, log } = createDeps({
      workers: [
        {
          name: `Worker${ESC}[2J${ESC}]52;c;AAAA${String.fromCharCode(7)}\rA`,
          cli: `codex${ESC}[31m\r`,
          model: `gpt${ESC}[0m`,
          team: `core${String.fromCharCode(0x7f)}`,
        },
      ],
    });

    await runAgentsCommand({}, deps);

    const output = log.mock.calls.map((call) => call[0] as string).join('');
    // eslint-disable-next-line no-control-regex -- asserting output contains no raw control bytes
    expect(output).not.toMatch(/[\x00-\x1F\x7F-\x9F]/);
    expect(output).not.toContain(ESC);
    expect(output).toContain('Worker A');
    expect(output).toContain('codex');
  });

  it('runWhoCommand sanitizes agent-controlled table cells', async () => {
    const ESC = '\u001b';
    const { deps, log } = createDeps({
      workers: [
        {
          name: `Who${ESC}[2J${ESC}]52;c;AAAA${String.fromCharCode(7)}\rA`,
          cli: `claude${ESC}[31m\r`,
          pid: 99,
        },
      ],
    });

    await runWhoCommand({}, deps);

    const output = log.mock.calls.map((call) => call[0] as string).join('');
    // eslint-disable-next-line no-control-regex -- asserting output contains no raw control bytes
    expect(output).not.toMatch(/[\x00-\x1F\x7F-\x9F]/);
    expect(output).not.toContain(ESC);
    expect(output).toContain('Who A');
    expect(output).toContain('claude');
  });

  it('runAgentsCommand exits non-zero when listAgents fails instead of emitting [] JSON', async () => {
    const { deps, log, shutdown, error } = createDeps({
      listAgentsError: new Error('broker unavailable'),
    });

    await expect(runAgentsCommand({ json: true }, deps)).rejects.toThrow('exit:1');

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('Failed to query broker agents: broker unavailable');
    expect(error).toHaveBeenCalledWith('Start the broker with `agent-relay up` and try again.');
  });

  it('runWhoCommand exits non-zero when broker client creation fails instead of emitting [] JSON', async () => {
    const { deps, log, error } = createDeps({
      createClientError: new Error('stale connection refused'),
    });

    await expect(runWhoCommand({ json: true }, deps)).rejects.toThrow('exit:1');

    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('Failed to query broker agents: stale connection refused');
    expect(error).toHaveBeenCalledWith('Start the broker with `agent-relay up` and try again.');
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

  it('replays cursor-position redraws instead of concatenating repaint fragments', () => {
    const ESC = '\u001b';
    const raw = [
      `${ESC}[10;3HSt${ESC}[10;4Hta${ESC}[10;5Har${ESC}[10;6Hrt${ESC}[10;7Hti${ESC}[10;8Hin${ESC}[10;9Hng MCP servers`,
      `${ESC}[11;1H•${ESC}[11;3HW${ESC}[11;3HWo${ESC}[11;4Hor${ESC}[11;5Hrk${ESC}[11;6Hki${ESC}[11;7Hin${ESC}[11;8Hng`,
      `${ESC}[14;1H•${ESC}[14;3HCalling${ESC}[15;3H└ relaycast.remove_agent(...)`,
    ].join('');

    const cooked = toPlainLogLines(raw).join('\n');

    expect(cooked).toContain('Starting MCP servers');
    expect(cooked).toContain('• Working');
    expect(cooked).toContain('Calling');
    expect(cooked).toContain('└ relaycast.remove_agent(...)');
    expect(cooked).not.toContain('Sttaarrtti');
    expect(cooked).not.toContain('WWoor');
  });

  it('drops a leading partial CSI suffix from byte-tailed snapshots', () => {
    const ESC = '\u001b';

    expect(toPlainLogLines(`2H${ESC}[1;1Hready`)).toEqual(['ready']);
  });

  it('carries split CSI and UTF-8 sequences across streamed pushes', () => {
    const ESC = '\u001b';
    const euro = Buffer.from('€', 'utf-8');
    const chunks = [
      Buffer.from(`busy\r${ESC}[`, 'utf-8'),
      Buffer.concat([Buffer.from('Kdone ', 'utf-8'), euro.subarray(0, 1)]),
      Buffer.concat([euro.subarray(1), Buffer.from('\n', 'utf-8')]),
    ];
    const full = Buffer.concat(chunks);

    const streamed = new PtyLogCooker();
    const streamedLines = chunks.flatMap((chunk) => streamed.push(chunk)).concat(streamed.finish());

    const oneShot = new PtyLogCooker();
    const oneShotLines = oneShot.push(full).concat(oneShot.finish());

    expect(streamedLines).toEqual(['done €']);
    expect(streamedLines).toEqual(oneShotLines);
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
    const writeChunk = vi.fn(() => undefined);
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
      writeChunk,
      log,
      error,
      exit,
    };
    return { deps, log, writeChunk, error };
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

  it('default (no flags) emits cooked lines without a decorative header', async () => {
    const { deps, log } = logsDeps();

    await runAgentsLogsCommand('WorkerA', {}, deps);

    const joined = log.mock.calls.map((c) => c[0] as string).join('\n');
    expect(joined).not.toContain('Logs for WorkerA');
    expect(joined).toContain('line one');
    expect(joined).not.toContain(ESC);
  });

  it('--raw emits the unmodified PTY stream through stdout', async () => {
    const { deps, log, writeChunk } = logsDeps();

    await runAgentsLogsCommand('WorkerA', { raw: true }, deps);

    expect(writeChunk).toHaveBeenCalledTimes(1);
    expect(writeChunk).toHaveBeenCalledWith(Buffer.from(rawLog, 'utf-8'));
    expect(log).not.toHaveBeenCalled();
  });

  it('--raw emits non-UTF-8 and control bytes byte-identically', async () => {
    const { deps, writeChunk } = logsDeps();
    const rawBytes = Buffer.from([0x6f, 0x6b, 0x0a, 0x1b, 0x5b, 0x4b, 0xff, 0x80, 0x00, 0x41]);
    deps.readFile = vi.fn(() => {
      throw new Error('raw path must not decode the log as UTF-8');
    });
    deps.readFileTailBuffer = vi.fn(() => ({ buffer: rawBytes, size: rawBytes.length }));

    await runAgentsLogsCommand('WorkerA', { raw: true }, deps);

    expect(writeChunk).toHaveBeenCalledTimes(1);
    const emitted = writeChunk.mock.calls[0][0];
    expect(Buffer.isBuffer(emitted)).toBe(true);
    expect(Buffer.compare(emitted as Buffer, rawBytes)).toBe(0);
  });

  it('rejects path traversal agent names before probing or reading files', async () => {
    const { deps, error } = logsDeps();

    await expect(runAgentsLogsCommand('../../secret', {}, deps)).rejects.toThrow('exit:1');

    expect(error).toHaveBeenCalledWith('Invalid agent name for log lookup: "../../secret"');
    expect(deps.fileExists).not.toHaveBeenCalled();
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  it('looks up valid agent names under worker-log directories', async () => {
    const { deps, log } = logsDeps();

    await runAgentsLogsCommand('WorkerA', { lines: '1' }, deps);

    expect(deps.fileExists).toHaveBeenCalledWith('/tmp/project/.agent-relay/team/worker-logs/WorkerA.log');
    expect(log.mock.calls.map((call) => call[0] as string).join('\n')).toContain('line two');
  });

  it('uses bounded tail reads for small snapshots', async () => {
    const { deps, log } = logsDeps();
    deps.readFile = vi.fn(() => {
      throw new Error('full read should not be used');
    });
    deps.readFileTail = vi.fn(() => ({ text: 'tail one\ntail two\n', size: 10_000_000 }));

    await runAgentsLogsCommand('WorkerA', { lines: '1', plain: true }, deps);

    expect(deps.readFileTail).toHaveBeenCalledWith(
      '/tmp/project/.agent-relay/team/worker-logs/WorkerA.log',
      expect.any(Number),
      'utf-8'
    );
    expect(deps.readFile).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('tail two');
  });

  it('rejects excessive --lines values', async () => {
    const { deps, error } = logsDeps();

    await expect(runAgentsLogsCommand('WorkerA', { lines: '999999' }, deps)).rejects.toThrow('exit:1');

    expect(error).toHaveBeenCalledWith('Failed to read logs: Invalid --lines value: 999999 (must be 1-5000)');
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  it('--plain --follow carries dedupe state across the snapshot boundary', async () => {
    vi.useFakeTimers();
    const log = vi.fn(() => undefined);
    const error = vi.fn(() => undefined);
    const exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }) as unknown as AgentManagementListingDependencies['exit'];
    const initial = 'line one\n';
    const followed = 'line one\nline one\nline two\n';
    let readCount = 0;
    const deps: AgentManagementListingDependencies = {
      getProjectRoot: vi.fn(() => '/tmp/project'),
      getDataDir: vi.fn(() => '/tmp/data'),
      createClient: vi.fn(() => ({
        listAgents: vi.fn(async () => []),
        shutdown: vi.fn(async () => undefined),
      })),
      fileExists: vi.fn(() => true),
      readFile: vi.fn(() => (readCount++ === 0 ? initial : followed)),
      fetch: vi.fn(async () => {
        throw new Error('not implemented');
      }),
      nowIso: vi.fn(() => '2026-03-04T00:00:00.000Z'),
      writeChunk: vi.fn(() => undefined),
      log,
      error,
      exit,
    };

    void runAgentsLogsCommand('WorkerA', { plain: true, follow: true, lines: '1' }, deps);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);

    expect(log.mock.calls.map((call) => call[0])).toEqual(['line one', 'line two']);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('--plain --follow resets dedupe state after log rotation', async () => {
    vi.useFakeTimers();
    const log = vi.fn(() => undefined);
    const error = vi.fn(() => undefined);
    const exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }) as unknown as AgentManagementListingDependencies['exit'];
    const snapshots = ['same\n', '', 'same\n'];
    const deps: AgentManagementListingDependencies = {
      getProjectRoot: vi.fn(() => '/tmp/project'),
      getDataDir: vi.fn(() => '/tmp/data'),
      createClient: vi.fn(() => ({
        listAgents: vi.fn(async () => []),
        shutdown: vi.fn(async () => undefined),
      })),
      fileExists: vi.fn(() => true),
      readFile: vi.fn(() => snapshots.shift() ?? 'same\n'),
      fetch: vi.fn(async () => {
        throw new Error('not implemented');
      }),
      nowIso: vi.fn(() => '2026-03-04T00:00:00.000Z'),
      writeChunk: vi.fn(() => undefined),
      log,
      error,
      exit,
    };

    void runAgentsLogsCommand('WorkerA', { plain: true, follow: true, lines: '1' }, deps);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);

    expect(log.mock.calls.map((call) => call[0])).toEqual(['same', 'same']);
    vi.clearAllTimers();
    vi.useRealTimers();
  });
});
