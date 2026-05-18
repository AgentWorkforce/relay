import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerNewCommands, runNew, spawnAgent, type NewDependencies } from './new.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

interface HarnessOptions {
  spawnStatus?: number;
  spawnBody?: unknown;
  spawnThrows?: Error;
}

function createHarness(opts: HarnessOptions = {}): {
  deps: NewDependencies;
  logs: unknown[][];
  errors: unknown[][];
  fetchLog: Array<{ url: string; method: string; body?: unknown; headers?: Record<string, string> }>;
} {
  const logs: unknown[][] = [];
  const errors: unknown[][] = [];
  const fetchLog: Array<{ url: string; method: string; body?: unknown; headers?: Record<string, string> }> =
    [];

  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    let bodyJson: unknown;
    if (init?.body) {
      try {
        bodyJson = JSON.parse(String(init.body));
      } catch {
        bodyJson = String(init.body);
      }
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    fetchLog.push({ url, method, body: bodyJson, headers });
    if (opts.spawnThrows) throw opts.spawnThrows;
    const status = opts.spawnStatus ?? 200;
    const body = opts.spawnBody ?? { success: true, name: 'Alice' };
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;

  const deps: NewDependencies = {
    readConnectionFile: () => ({ url: 'http://localhost:3889', api_key: 'k' }),
    getDefaultStateDir: () => '/tmp/fake/.agent-relay',
    env: {},
    fetch: fetchFn,
    log: (...args) => logs.push(args),
    error: (...args) => errors.push(args),
    exit: vi.fn((code: number) => {
      throw new ExitSignal(code);
    }) as unknown as NewDependencies['exit'],
  };

  return { deps, logs, errors, fetchLog };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('spawnAgent', () => {
  it('POSTs to /api/spawn with the request body and API-key header', async () => {
    const { deps, fetchLog } = createHarness();
    const result = await spawnAgent(
      { url: 'http://localhost:3889', apiKey: 'k' },
      { name: 'Alice', cli: 'claude', task: 'review the PR', channels: ['general'] },
      deps.fetch
    );
    expect(result.ok).toBe(true);
    expect(fetchLog).toHaveLength(1);
    expect(fetchLog[0]).toMatchObject({
      url: 'http://localhost:3889/api/spawn',
      method: 'POST',
      body: { name: 'Alice', cli: 'claude', task: 'review the PR', channels: ['general'] },
    });
    expect(fetchLog[0].headers).toMatchObject({ 'X-API-Key': 'k', 'Content-Type': 'application/json' });
  });

  it('surfaces a broker-supplied error message on non-2xx', async () => {
    const { deps } = createHarness({
      spawnStatus: 400,
      spawnBody: { error: 'Missing required field: name' },
    });
    const result = await spawnAgent(
      { url: 'http://localhost:3889' },
      { name: '', cli: 'claude' },
      deps.fetch
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.message).toBe('Missing required field: name');
  });

  it('returns ok:false with the transport message on network failure', async () => {
    const { deps } = createHarness({ spawnThrows: new Error('econnrefused') });
    const result = await spawnAgent(
      { url: 'http://localhost:3889' },
      { name: 'Alice', cli: 'claude' },
      deps.fetch
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.message).toBe('econnrefused');
  });

  it('omits the API-key header when the connection has none', async () => {
    const { deps, fetchLog } = createHarness();
    await spawnAgent({ url: 'http://localhost:3889' }, { name: 'A', cli: 'claude' }, deps.fetch);
    expect(fetchLog[0].headers).not.toHaveProperty('X-API-Key');
  });
});

describe('runNew', () => {
  it('spawns and prints the attach hint on success', async () => {
    const { deps, logs, fetchLog } = createHarness();
    const code = await runNew('claude', ['--say', 'hi'], { name: 'Alice' }, deps);
    expect(code).toBe(0);
    expect(fetchLog[0].body).toEqual({ name: 'Alice', cli: 'claude', args: ['--say', 'hi'] });
    expect(logs.some((args) => String(args[0]).includes('Spawned agent: Alice'))).toBe(true);
    expect(logs.some((args) => String(args[0]).includes('attach with: agent-relay drive Alice'))).toBe(true);
  });

  it('rejects when -n is missing', async () => {
    const { deps, errors } = createHarness();
    const code = await runNew('claude', [], {}, deps);
    expect(code).toBe(1);
    expect(errors[0]?.[0]).toMatch(/agent name is required/);
  });

  it('rejects when CLI positional is missing', async () => {
    const { deps, errors } = createHarness();
    const code = await runNew(undefined, [], { name: 'Alice' }, deps);
    expect(code).toBe(1);
    expect(errors[0]?.[0]).toMatch(/CLI is required/);
  });

  it('returns 1 when no broker connection can be resolved', async () => {
    const { deps, errors } = createHarness();
    deps.readConnectionFile = () => null;
    const code = await runNew('claude', [], { name: 'Alice' }, deps);
    expect(code).toBe(1);
    expect(errors[0]?.[0]).toMatch(/could not locate broker connection/);
  });

  it('passes --task, --team, --model, --cwd through to the spawn body', async () => {
    const { deps, fetchLog } = createHarness();
    await runNew(
      'claude',
      [],
      {
        name: 'Alice',
        task: 'fix the bug',
        team: 'core',
        model: 'opus',
        cwd: '/repo',
        channels: 'general,reviews',
      },
      deps
    );
    expect(fetchLog[0].body).toEqual({
      name: 'Alice',
      cli: 'claude',
      task: 'fix the bug',
      team: 'core',
      model: 'opus',
      cwd: '/repo',
      channels: ['general', 'reviews'],
    });
  });

  it('returns 1 when the broker rejects the spawn', async () => {
    const { deps, errors } = createHarness({
      spawnStatus: 500,
      spawnBody: { error: 'agent already exists' },
    });
    const code = await runNew('claude', [], { name: 'Alice' }, deps);
    expect(code).toBe(1);
    expect(errors[0]?.[0]).toMatch(/agent already exists/);
  });
});

describe('registerNewCommands', () => {
  it('registers a `new` command on the program', () => {
    const { deps } = createHarness();
    const program = new Command();
    program.exitOverride();
    registerNewCommands(program, deps);
    const cmd = program.commands.find((c) => c.name() === 'new');
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toMatch(/spawn a new agent/i);
  });

  it('marks -n / --name as required', () => {
    const { deps } = createHarness();
    const program = new Command();
    program.exitOverride();
    registerNewCommands(program, deps);
    const cmd = program.commands.find((c) => c.name() === 'new');
    const nameOpt = cmd?.options.find((o) => o.long === '--name');
    expect(nameOpt?.required).toBe(true);
  });

  it('wires the canonical flag set (--task, --channels, --cwd, --team, --model, --broker-url, --api-key, --state-dir)', () => {
    const { deps } = createHarness();
    const program = new Command();
    program.exitOverride();
    registerNewCommands(program, deps);
    const cmd = program.commands.find((c) => c.name() === 'new');
    const flags = cmd?.options.map((opt) => opt.long).filter(Boolean) ?? [];
    expect(flags).toEqual(
      expect.arrayContaining([
        '--name',
        '--task',
        '--channels',
        '--cwd',
        '--team',
        '--model',
        '--broker-url',
        '--api-key',
        '--state-dir',
      ])
    );
  });
});
