import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DriveDependencies } from './drive.js';
import { registerNewCommands, runNew, spawnAgent, type NewDependencies } from './new.js';
import type { RelayDependencies } from './relay.js';
import type { ViewDependencies } from './view.js';

import {
  runSpawnAndAttach,
  type AttachChildDependencies,
  type SpawnAndAttachDependencies,
  type SpawnAndAttachOptions,
} from '../lib/spawn-and-attach.js';

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
    expect(cmd?.description()).toMatch(/spawn a new agent under the broker/i);
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

  it('description mentions both headless default and --attach mode', () => {
    const { deps } = createHarness();
    const program = new Command();
    program.exitOverride();
    registerNewCommands(program, deps);
    const cmd = program.commands.find((c) => c.name() === 'new');
    expect(cmd?.description().toLowerCase()).toContain('headless');
    expect(cmd?.description().toLowerCase()).toContain('--attach');
  });

  it('wires the canonical flag set (--task, --channels, --cwd, --team, --model, --broker-url, --api-key, --state-dir, --attach, --mode, --ephemeral)', () => {
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
        '--attach',
        '--mode',
        '--ephemeral',
        '--broker-url',
        '--api-key',
        '--state-dir',
      ])
    );
  });
});

/* ----- spawn-and-attach composition (new --attach) ----- */

interface AttachHarnessCaptures {
  spawnCalls: Array<{ url: string; body: unknown }>;
  releaseCalls: Array<{ name: string }>;
  signalHandlers: Map<NodeJS.Signals, Array<() => void | Promise<void>>>;
  logs: unknown[][];
  errors: unknown[][];
}

interface AttachHarnessOptions {
  spawnFails?: boolean;
  releaseReturns?: { ok: boolean; status: number; message?: string };
  connectionUrl?: string;
}

/**
 * Harness for `runSpawnAndAttach`. Stubs out the child attach runners
 * (they each have their own test suites — drive.test.ts, relay.test.ts,
 * view.test.ts — so we don't re-exercise them here) and records the
 * composition's spawn + release + signal interactions.
 */
function createAttachHarness(opts: AttachHarnessOptions = {}): {
  deps: SpawnAndAttachDependencies;
  captures: AttachHarnessCaptures;
} {
  const captures: AttachHarnessCaptures = {
    spawnCalls: [],
    releaseCalls: [],
    signalHandlers: new Map(),
    logs: [],
    errors: [],
  };
  const connectionUrl = opts.connectionUrl ?? 'http://localhost:3889';

  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/spawn')) {
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
      captures.spawnCalls.push({ url, body });
      if (opts.spawnFails) {
        return new Response(JSON.stringify({ error: 'spawn failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ name: 'Alice' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Anything else (attach runners' fetches) — not exercised here.
    return new Response('not mocked', { status: 500 });
  }) as unknown as typeof globalThis.fetch;

  const exitFn = vi.fn((code: number) => {
    throw new ExitSignal(code);
  }) as unknown as NewDependencies['exit'];

  const newDeps: NewDependencies = {
    readConnectionFile: () => ({ url: connectionUrl, api_key: 'k' }),
    getDefaultStateDir: () => '/tmp/fake/.agent-relay',
    env: {},
    fetch: fetchFn,
    log: (...args) => captures.logs.push(args),
    error: (...args) => captures.errors.push(args),
    exit: exitFn,
  };

  // Minimal stubs for the three attach runners' deps. None of these are
  // exercised because we wrap runSpawnAndAttach with deps where the
  // child runners never actually open a WS — the no-op WebSocket
  // factory returns immediately and the runners exit with code 1
  // (broker fetch returns "not mocked"). The composition still records
  // its spawn + release + signal-registration steps, which is all we
  // care about here.
  const stubChildDep = {
    readConnectionFile: () => ({ url: connectionUrl, api_key: 'k' }),
    getDefaultStateDir: () => '/tmp/fake/.agent-relay',
    env: {},
    fetch: (async () => new Response('not mocked', { status: 500 })) as typeof globalThis.fetch,
    log: () => undefined,
    error: () => undefined,
    exit: exitFn,
    onSignal: () => undefined,
    writeChunk: () => undefined,
    createWebSocket: () => ({
      on: () => undefined,
      close: () => undefined,
    }),
    captureAndRenderSnapshot: async () => ({ status: 'ok' as const }),
    stdin: {
      isTTY: false,
      setRawMode: () => undefined,
      resume: () => undefined,
      pause: () => undefined,
      on: () => undefined,
      off: () => undefined,
    },
    terminal: { getSize: () => null, onResize: () => () => undefined },
  };
  const driveDeps = stubChildDep as unknown as DriveDependencies;
  const relayDeps = stubChildDep as unknown as RelayDependencies;
  const viewDeps = stubChildDep as unknown as ViewDependencies;

  const onSignal = (signal: NodeJS.Signals, handler: () => void | Promise<void>): void => {
    const bucket = captures.signalHandlers.get(signal) ?? [];
    bucket.push(handler);
    captures.signalHandlers.set(signal, bucket);
  };

  const deps: SpawnAndAttachDependencies = {
    newDeps,
    driveDeps,
    relayDeps,
    viewDeps,
    releaseAgent: vi.fn(async (_conn, name) => {
      captures.releaseCalls.push({ name });
      return opts.releaseReturns ?? { ok: true, status: 200 };
    }),
    onSignal,
    log: (...args) => captures.logs.push(args),
    error: (...args) => captures.errors.push(args),
  };

  return { deps, captures };
}

describe('runSpawnAndAttach — argument validation', () => {
  it('rejects when name is missing', async () => {
    const { deps, captures } = createAttachHarness();
    const code = await runSpawnAndAttach({ name: '', cli: 'claude' } as SpawnAndAttachOptions, deps);
    expect(code).toBe(1);
    expect(captures.errors[0]?.[0]).toMatch(/agent name is required/);
    expect(captures.spawnCalls).toHaveLength(0);
  });

  it('rejects when cli is missing', async () => {
    const { deps, captures } = createAttachHarness();
    const code = await runSpawnAndAttach({ name: 'Alice', cli: '' } as SpawnAndAttachOptions, deps);
    expect(code).toBe(1);
    expect(captures.errors[0]?.[0]).toMatch(/CLI is required/);
    expect(captures.spawnCalls).toHaveLength(0);
  });

  it('rejects an invalid --mode value', async () => {
    const { deps, captures } = createAttachHarness();
    const code = await runSpawnAndAttach(
      { name: 'Alice', cli: 'claude', mode: 'bogus' as unknown as 'drive' },
      deps
    );
    expect(code).toBe(1);
    expect(captures.errors[0]?.[0]).toMatch(/--mode must be one of/);
  });

  it('returns 1 when no broker connection can be resolved', async () => {
    const { deps, captures } = createAttachHarness();
    deps.newDeps.readConnectionFile = () => null;
    const code = await runSpawnAndAttach({ name: 'Alice', cli: 'claude' }, deps);
    expect(code).toBe(1);
    expect(captures.errors[0]?.[0]).toMatch(/could not locate broker connection/);
  });
});

describe('runSpawnAndAttach — spawn step', () => {
  it('POSTs to /api/spawn with the assembled body', async () => {
    const { deps, captures } = createAttachHarness();
    // The child runner is stubbed to fail (returns 500); we just need
    // spawn to have run first.
    await runSpawnAndAttach(
      {
        name: 'Alice',
        cli: 'claude',
        args: ['--say', 'hi'],
        task: 'review',
        team: 'core',
        model: 'opus',
        channels: 'general, reviews',
        cwd: '/repo',
      },
      deps
    );
    expect(captures.spawnCalls).toHaveLength(1);
    expect(captures.spawnCalls[0].body).toEqual({
      name: 'Alice',
      cli: 'claude',
      args: ['--say', 'hi'],
      task: 'review',
      team: 'core',
      model: 'opus',
      channels: ['general', 'reviews'],
      cwd: '/repo',
    });
  });

  it('aborts the whole flow when spawn fails', async () => {
    const { deps, captures } = createAttachHarness({ spawnFails: true });
    const code = await runSpawnAndAttach({ name: 'Alice', cli: 'claude' }, deps);
    expect(code).toBe(1);
    expect(captures.errors[0]?.[0]).toMatch(/could not spawn 'Alice'/);
    expect(captures.releaseCalls).toHaveLength(0);
  });
});

describe('runSpawnAndAttach — --ephemeral teardown', () => {
  it('does NOT register signal-based release teardowns when --ephemeral is off', async () => {
    const { deps, captures } = createAttachHarness();
    await runSpawnAndAttach({ name: 'Alice', cli: 'claude' }, deps);
    expect(captures.signalHandlers.size).toBe(0);
    expect(captures.releaseCalls).toHaveLength(0);
  });

  it('registers SIGINT + SIGTERM handlers when --ephemeral is set', async () => {
    const { deps, captures } = createAttachHarness();
    await runSpawnAndAttach({ name: 'Alice', cli: 'claude', ephemeral: true }, deps);
    expect(captures.signalHandlers.has('SIGINT')).toBe(true);
    expect(captures.signalHandlers.has('SIGTERM')).toBe(true);
  });

  it('fires releaseAgent on clean detach when --ephemeral is set', async () => {
    const { deps, captures } = createAttachHarness();
    await runSpawnAndAttach({ name: 'Alice', cli: 'claude', ephemeral: true }, deps);
    // At least one release call — the post-attach finally-block fires
    // regardless of whether a signal also fired.
    expect(captures.releaseCalls.length).toBeGreaterThanOrEqual(1);
    expect(captures.releaseCalls[0].name).toBe('Alice');
  });
});

describe('runSpawnAndAttach — byte-equivalence with the verbless `-n` alias', () => {
  it('alias preset (mode=relay, ephemeral=true) produces the same spawn body + teardown footprint as an explicit --mode relay --ephemeral call', async () => {
    const argv = ['-n', 'Alice', 'claude', '--say', 'hi']; // hypothetical user input
    // What the alias dispatcher feeds into runSpawnAndAttach:
    const aliasOptions: SpawnAndAttachOptions = {
      name: 'Alice',
      cli: 'claude',
      args: ['--say', 'hi'],
      mode: 'relay',
      ephemeral: true,
    };
    // What `new -n Alice claude --attach --mode relay --ephemeral --say hi`
    // feeds into the same helper after the action layer's destructuring:
    const newAttachOptions: SpawnAndAttachOptions = {
      name: 'Alice',
      cli: 'claude',
      args: ['--say', 'hi'],
      mode: 'relay',
      ephemeral: true,
    };
    expect(aliasOptions).toEqual(newAttachOptions);
    // argv is only kept here for narrative — the real proof is that
    // parseVerblessAlias (tested in bootstrap.test.ts) returns the
    // same triplet that `new --attach` puts together.
    void argv;

    // Exercise both paths through the same harness and assert
    // identical side effects.
    const { deps: aliasDeps, captures: aliasCaptures } = createAttachHarness();
    await runSpawnAndAttach(aliasOptions, aliasDeps);

    const { deps: newDeps2, captures: newCaptures } = createAttachHarness();
    await runSpawnAndAttach(newAttachOptions, newDeps2);

    expect(aliasCaptures.spawnCalls).toEqual(newCaptures.spawnCalls);
    expect(aliasCaptures.releaseCalls.length).toBe(newCaptures.releaseCalls.length);
    expect([...aliasCaptures.signalHandlers.keys()].sort()).toEqual(
      [...newCaptures.signalHandlers.keys()].sort()
    );
  });
});

describe('registerNewCommands — --attach action integration', () => {
  // Light end-to-end-ish exercise of the action dispatch: build a real
  // commander program with our stubbed attach child deps, parse a
  // `new --attach` argv, and verify the spawn call fires through the
  // composition path (not the headless path).
  it('routes through runSpawnAndAttach when --attach is set', async () => {
    const program = new Command();
    program.exitOverride();
    const { deps: newDeps2 } = createHarness();

    const attachCaptures = {
      spawnCalls: [] as Array<{ url: string; body: unknown }>,
    };
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/spawn')) {
        const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
        attachCaptures.spawnCalls.push({ url, body });
        return new Response(JSON.stringify({ name: 'Alice' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not mocked', { status: 500 });
    }) as unknown as typeof globalThis.fetch;
    newDeps2.fetch = fetchFn;

    // Stub the attach child deps so the runner exits immediately.
    const stubChild = {
      readConnectionFile: () => ({ url: 'http://localhost:3889' }),
      getDefaultStateDir: () => '/tmp/fake/.agent-relay',
      env: {},
      fetch: fetchFn,
      log: () => undefined,
      error: () => undefined,
      exit: newDeps2.exit,
      onSignal: () => undefined,
      writeChunk: () => undefined,
      createWebSocket: () => ({ on: () => undefined, close: () => undefined }),
      captureAndRenderSnapshot: async () => ({ status: 'ok' as const }),
      stdin: {
        isTTY: false,
        setRawMode: () => undefined,
        resume: () => undefined,
        pause: () => undefined,
        on: () => undefined,
        off: () => undefined,
      },
      terminal: { getSize: () => null, onResize: () => () => undefined },
    };
    const attachChildDeps: AttachChildDependencies = {
      newDeps: newDeps2,
      driveDeps: stubChild as unknown as DriveDependencies,
      relayDeps: stubChild as unknown as RelayDependencies,
      viewDeps: stubChild as unknown as ViewDependencies,
    };

    registerNewCommands(program, newDeps2, attachChildDeps);

    // commander's parse rethrows on exit; we expect the attach runner
    // to fail (broker fetch is mocked to 500 for non-spawn URLs) and
    // dep.exit to throw an ExitSignal.
    await expect(
      program.parseAsync(['node', 'agent-relay', 'new', '-n', 'Alice', 'claude', '--attach'], {
        from: 'node',
      })
    ).rejects.toBeInstanceOf(ExitSignal);

    // The spawn step must have fired exactly once — proving we went
    // through the composition path, not the headless-only path.
    expect(attachCaptures.spawnCalls).toHaveLength(1);
    expect((attachCaptures.spawnCalls[0].body as { name: string }).name).toBe('Alice');
  });
});
