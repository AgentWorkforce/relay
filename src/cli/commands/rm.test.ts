import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerRmCommands, releaseAgent, runRm, type RmDependencies } from './rm.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

interface HarnessOptions {
  releaseStatus?: number;
  releaseBody?: unknown;
  releaseThrows?: Error;
}

/** Captured request snapshot. `headers` is a flat record so tests can
 *  assert on auth headers without unwrapping a `Headers` instance — the
 *  CLI always passes header objects as plain records anyway. */
interface FetchLogEntry {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function createHarness(opts: HarnessOptions = {}): {
  deps: RmDependencies;
  logs: unknown[][];
  errors: unknown[][];
  fetchLog: FetchLogEntry[];
} {
  const logs: unknown[][] = [];
  const errors: unknown[][] = [];
  const fetchLog: FetchLogEntry[] = [];

  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    // Normalize the headers shape. The CLI passes plain records; tests
    // assert on those keys directly. If someone ever swaps to a real
    // `Headers` instance, this materializes it the same way.
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (Array.isArray(rawHeaders)) {
      for (const [k, v] of rawHeaders) headers[k] = v;
    } else if (rawHeaders && typeof rawHeaders === 'object') {
      for (const [k, v] of Object.entries(rawHeaders)) {
        headers[k] = String(v);
      }
    }
    fetchLog.push({ url, method, headers });
    if (opts.releaseThrows) throw opts.releaseThrows;
    const status = opts.releaseStatus ?? 200;
    const body = opts.releaseBody ?? { success: true };
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;

  const deps: RmDependencies = {
    readConnectionFile: () => ({ url: 'http://localhost:3889', api_key: 'k' }),
    getDefaultStateDir: () => '/tmp/fake/.agent-relay',
    env: {},
    fetch: fetchFn,
    log: (...args) => logs.push(args),
    error: (...args) => errors.push(args),
    exit: vi.fn((code: number) => {
      throw new ExitSignal(code);
    }) as unknown as RmDependencies['exit'],
  };

  return { deps, logs, errors, fetchLog };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('releaseAgent', () => {
  it('issues DELETE /api/spawned/{name} with the API-key header', async () => {
    const { deps, fetchLog } = createHarness();
    const result = await releaseAgent({ url: 'http://localhost:3889', apiKey: 'k' }, 'Alice', deps.fetch);
    expect(result.ok).toBe(true);
    expect(fetchLog).toHaveLength(1);
    expect(fetchLog[0]).toMatchObject({
      url: 'http://localhost:3889/api/spawned/Alice',
      method: 'DELETE',
      headers: { 'X-API-Key': 'k' },
    });
  });

  it('omits the API-key header when no key is configured', async () => {
    const { deps, fetchLog } = createHarness();
    await releaseAgent({ url: 'http://localhost:3889' }, 'Alice', deps.fetch);
    expect(fetchLog[0].headers).not.toHaveProperty('X-API-Key');
  });

  it('returns ok:false with the broker-supplied error on 404', async () => {
    const { deps } = createHarness({ releaseStatus: 404, releaseBody: { error: "no agent named 'Ghost'" } });
    const result = await releaseAgent({ url: 'http://localhost:3889' }, 'Ghost', deps.fetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.message).toBe("no agent named 'Ghost'");
  });

  it('returns ok:false with the transport message on network failure', async () => {
    const boom = new Error('connection refused');
    const { deps } = createHarness({ releaseThrows: boom });
    const result = await releaseAgent({ url: 'http://localhost:3889' }, 'Alice', deps.fetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.message).toBe('connection refused');
  });

  it('url-encodes the agent name', async () => {
    const { deps, fetchLog } = createHarness();
    await releaseAgent({ url: 'http://localhost:3889' }, 'name/with slash', deps.fetch);
    expect(fetchLog[0].url).toBe('http://localhost:3889/api/spawned/name%2Fwith%20slash');
  });
});

describe('runRm', () => {
  it('logs a confirmation on success', async () => {
    const { deps, logs } = createHarness();
    const code = await runRm('Alice', {}, deps);
    expect(code).toBe(0);
    expect(logs.some((args) => String(args[0]) === 'Released agent: Alice')).toBe(true);
  });

  it('returns 1 with a friendly error on 404', async () => {
    const { deps, errors } = createHarness({
      releaseStatus: 404,
      releaseBody: { error: 'gone' },
    });
    const code = await runRm('Ghost', {}, deps);
    expect(code).toBe(1);
    expect(errors[0]?.[0]).toMatch(/no agent named 'Ghost'/);
  });

  it('returns 1 when no broker connection can be resolved', async () => {
    const { deps, errors } = createHarness();
    deps.readConnectionFile = () => null;
    const code = await runRm('Alice', {}, deps);
    expect(code).toBe(1);
    expect(errors[0]?.[0]).toMatch(/could not locate broker connection/);
  });

  it('rejects an empty agent name', async () => {
    const { deps, errors } = createHarness();
    const code = await runRm('', {}, deps);
    expect(code).toBe(1);
    expect(errors[0]?.[0]).toMatch(/agent name is required/);
  });

  it('rejects a whitespace-only agent name', async () => {
    const { deps, errors } = createHarness();
    const code = await runRm('   ', {}, deps);
    expect(code).toBe(1);
    expect(errors[0]?.[0]).toMatch(/agent name is required/);
  });

  it('trims whitespace from the agent name before talking to the broker', async () => {
    const { deps, fetchLog, logs } = createHarness();
    const code = await runRm('  Alice  ', {}, deps);
    expect(code).toBe(0);
    // The URL must use the trimmed name — otherwise the broker
    // (which stores names verbatim) would 404 on a stray space.
    expect(fetchLog[0].url).toBe('http://localhost:3889/api/spawned/Alice');
    // The success log echoes the trimmed name too.
    expect(logs.some((args) => String(args[0]) === 'Released agent: Alice')).toBe(true);
  });

  it('honours --broker-url over connection.json', async () => {
    const { deps, fetchLog } = createHarness();
    await runRm('Alice', { brokerUrl: 'http://other:9999' }, deps);
    expect(fetchLog[0].url).toBe('http://other:9999/api/spawned/Alice');
  });
});

describe('registerRmCommands', () => {
  it('registers an `rm` command on the program', () => {
    const { deps } = createHarness();
    const program = new Command();
    program.exitOverride();
    registerRmCommands(program, deps);
    const cmd = program.commands.find((c) => c.name() === 'rm');
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toMatch(/release a running agent/i);
  });

  it('wires --broker-url, --api-key, and --state-dir options', () => {
    const { deps } = createHarness();
    const program = new Command();
    program.exitOverride();
    registerRmCommands(program, deps);
    const cmd = program.commands.find((c) => c.name() === 'rm');
    const flags = cmd?.options.map((opt) => opt.long).filter(Boolean);
    expect(flags).toEqual(expect.arrayContaining(['--broker-url', '--api-key', '--state-dir']));
  });
});
