import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  extractMatchingChunk,
  registerViewCommands,
  resolveViewBrokerConnection,
  runViewSession,
  toWsUrl,
  type ViewDependencies,
  type ViewWebSocket,
} from './view.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

type WsListener = (...args: unknown[]) => void;

class FakeWebSocket implements ViewWebSocket {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly listeners = new Map<string, WsListener[]>();
  closed = false;
  closeCode?: number;
  closeReason?: string;

  constructor(url: string, headers: Record<string, string>) {
    this.url = url;
    this.headers = headers;
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const bucket = this.listeners.get(event) ?? [];
    bucket.push(listener);
    this.listeners.set(event, bucket);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }
}

interface HarnessOverrides {
  env?: NodeJS.ProcessEnv;
  connectionFile?: unknown;
  defaultStateDir?: string;
  /** Override the snapshot helper outcome. Defaults to `{ status: 'ok' }`
   *  with no writes — most tests don't care about the snapshot path. */
  snapshotResult?: Awaited<ReturnType<ViewDependencies['captureAndRenderSnapshot']>>;
  /** If set, snapshot helper writes this string to `writeChunk` when called. */
  snapshotChunk?: string;
}

function createHarness(overrides: HarnessOverrides = {}): {
  deps: ViewDependencies;
  writes: string[];
  errors: unknown[][];
  logs: unknown[][];
  signals: Map<NodeJS.Signals, () => void | Promise<void>>;
  sockets: FakeWebSocket[];
} {
  const writes: string[] = [];
  const errors: unknown[][] = [];
  const logs: unknown[][] = [];
  const signals = new Map<NodeJS.Signals, () => void | Promise<void>>();
  const sockets: FakeWebSocket[] = [];

  const deps: ViewDependencies = {
    readConnectionFile: vi.fn(() => overrides.connectionFile ?? null),
    getDefaultStateDir: vi.fn(() => overrides.defaultStateDir ?? '/tmp/fake/.agent-relay'),
    env: overrides.env ?? {},
    createWebSocket: vi.fn((url: string, headers: Record<string, string>) => {
      const socket = new FakeWebSocket(url, headers);
      sockets.push(socket);
      return socket;
    }),
    writeChunk: (chunk: string) => {
      writes.push(chunk);
    },
    onSignal: (signal, handler) => {
      signals.set(signal, handler);
    },
    log: (...args: unknown[]) => {
      logs.push(args);
    },
    error: (...args: unknown[]) => {
      errors.push(args);
    },
    exit: vi.fn((code: number) => {
      throw new ExitSignal(code);
    }) as unknown as ViewDependencies['exit'],
    // Snapshot path: tests opt in by overriding either the result or the
    // emitted chunk via `HarnessOverrides`. Default is `ok` with no write
    // so existing tests continue to assert on live-stream writes only.
    fetch: vi.fn(async () => new Response('', { status: 200 })) as ViewDependencies['fetch'],
    captureAndRenderSnapshot: vi.fn(async (_conn, _name, snapshotDeps) => {
      if (overrides.snapshotChunk !== undefined) {
        snapshotDeps.writeChunk(overrides.snapshotChunk);
      }
      return overrides.snapshotResult ?? { status: 'ok' };
    }) as ViewDependencies['captureAndRenderSnapshot'],
  };

  return { deps, writes, errors, logs, signals, sockets };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('extractMatchingChunk', () => {
  it('returns the chunk for matching worker_stream events', () => {
    const raw = JSON.stringify({
      kind: 'worker_stream',
      name: 'Alice',
      stream: 'stdout',
      chunk: '[31mhello[0m',
    });
    expect(extractMatchingChunk(raw, 'Alice')).toBe('[31mhello[0m');
  });

  it('filters out events for other agents', () => {
    const raw = JSON.stringify({
      kind: 'worker_stream',
      name: 'Bob',
      stream: 'stdout',
      chunk: 'hello',
    });
    expect(extractMatchingChunk(raw, 'Alice')).toBeNull();
  });

  it('filters out events with non-worker_stream kinds', () => {
    const raw = JSON.stringify({
      kind: 'agent_spawned',
      name: 'Alice',
    });
    expect(extractMatchingChunk(raw, 'Alice')).toBeNull();
  });

  it('returns null for non-JSON input', () => {
    expect(extractMatchingChunk('not-json', 'Alice')).toBeNull();
  });

  it('returns null for JSON payloads missing chunk', () => {
    const raw = JSON.stringify({ kind: 'worker_stream', name: 'Alice', stream: 'stdout' });
    expect(extractMatchingChunk(raw, 'Alice')).toBeNull();
  });

  it('returns null for arrays/non-object JSON payloads', () => {
    expect(extractMatchingChunk('[1,2,3]', 'Alice')).toBeNull();
  });

  it('keeps empty chunks (server sends them to signal flushes)', () => {
    const raw = JSON.stringify({ kind: 'worker_stream', name: 'Alice', stream: 'stdout', chunk: '' });
    expect(extractMatchingChunk(raw, 'Alice')).toBe('');
  });
});

describe('toWsUrl', () => {
  it('rewrites http://host:port to ws://host:port/ws', () => {
    expect(toWsUrl('http://localhost:3889')).toBe('ws://localhost:3889/ws');
  });

  it('rewrites https://… to wss://…/ws', () => {
    expect(toWsUrl('https://broker.example.com')).toBe('wss://broker.example.com/ws');
  });

  it('handles trailing-slash-stripped input', () => {
    expect(toWsUrl('http://localhost:3889')).toBe('ws://localhost:3889/ws');
  });
});

describe('resolveViewBrokerConnection', () => {
  it('prefers --broker-url over env and connection.json', () => {
    const { deps } = createHarness({
      env: { RELAY_BROKER_URL: 'http://env-host:1234' },
      connectionFile: { url: 'http://file-host:5678', api_key: 'file-key' },
    });

    const conn = resolveViewBrokerConnection({ brokerUrl: 'http://flag-host:9999' }, deps);
    expect(conn).toEqual({ url: 'http://flag-host:9999', apiKey: 'file-key' });
  });

  it('uses RELAY_BROKER_URL when no flag is provided', () => {
    const { deps } = createHarness({
      env: { RELAY_BROKER_URL: 'http://env-host:1234', RELAY_BROKER_API_KEY: 'env-key' },
      connectionFile: { url: 'http://file-host:5678', api_key: 'file-key' },
    });

    const conn = resolveViewBrokerConnection({}, deps);
    expect(conn).toEqual({ url: 'http://env-host:1234', apiKey: 'env-key' });
  });

  it('falls back to connection.json for both url and api_key', () => {
    const { deps } = createHarness({
      env: {},
      connectionFile: { url: 'http://file-host:5678/', api_key: 'file-key' },
    });

    const conn = resolveViewBrokerConnection({}, deps);
    expect(conn).toEqual({ url: 'http://file-host:5678', apiKey: 'file-key' });
  });

  it('returns null when no source provides a URL', () => {
    const { deps } = createHarness({ env: {}, connectionFile: null });
    expect(resolveViewBrokerConnection({}, deps)).toBeNull();
  });

  it('allows --api-key to override the connection-file key', () => {
    const { deps } = createHarness({
      env: {},
      connectionFile: { url: 'http://file-host:5678', api_key: 'file-key' },
    });

    const conn = resolveViewBrokerConnection({ apiKey: 'flag-key' }, deps);
    expect(conn).toEqual({ url: 'http://file-host:5678', apiKey: 'flag-key' });
  });

  it('returns undefined apiKey when none of the sources have one', () => {
    const { deps } = createHarness({
      env: {},
      connectionFile: { url: 'http://file-host:5678' },
    });

    const conn = resolveViewBrokerConnection({}, deps);
    expect(conn).toEqual({ url: 'http://file-host:5678', apiKey: undefined });
  });
});

describe('runViewSession', () => {
  it('writes chunks for matching events and ignores others', async () => {
    const { deps, writes, sockets } = createHarness({
      connectionFile: { url: 'http://localhost:3889', api_key: 'k' },
    });

    const sessionPromise = runViewSession('Alice', {}, deps);
    // Wait a tick so the WebSocket factory has been called
    await new Promise((resolve) => setImmediate(resolve));
    expect(sockets).toHaveLength(1);
    const socket = sockets[0];
    expect(socket.url).toBe('ws://localhost:3889/ws');
    expect(socket.headers['X-API-Key']).toBe('k');

    socket.emit('open');
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ kind: 'worker_stream', name: 'Alice', stream: 'stdout', chunk: 'hi' }))
    );
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ kind: 'worker_stream', name: 'Bob', stream: 'stdout', chunk: 'nope' }))
    );
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ kind: 'agent_spawned', name: 'Alice', runtime: 'pty' }))
    );
    socket.emit('close', 1000, Buffer.from(''));

    const code = await sessionPromise;
    expect(code).toBe(0);
    expect(writes).toEqual(['hi']);
  });

  it('preserves raw ANSI escape sequences byte-for-byte', async () => {
    const { deps, writes, sockets } = createHarness({
      connectionFile: { url: 'http://localhost:3889' },
    });
    const ansi = '[2J[H[31;1mRED[0m\r\n';

    const sessionPromise = runViewSession('Alice', {}, deps);
    await new Promise((resolve) => setImmediate(resolve));
    const socket = sockets[0];
    socket.emit('open');
    socket.emit(
      'message',
      JSON.stringify({ kind: 'worker_stream', name: 'Alice', stream: 'stdout', chunk: ansi })
    );
    socket.emit('close', 1000, Buffer.from(''));

    await sessionPromise;
    expect(writes).toEqual([ansi]);
  });

  it('exits cleanly on SIGINT without surfacing an error', async () => {
    const { deps, sockets, signals } = createHarness({
      connectionFile: { url: 'http://localhost:3889' },
    });

    const sessionPromise = runViewSession('Alice', {}, deps);
    await new Promise((resolve) => setImmediate(resolve));
    const socket = sockets[0];
    socket.emit('open');

    const sigintHandler = signals.get('SIGINT');
    expect(sigintHandler).toBeDefined();
    await sigintHandler?.();

    const code = await sessionPromise;
    expect(code).toBe(0);
    expect(socket.closed).toBe(true);
  });

  it('reports an error and resolves with 1 on abnormal close', async () => {
    const { deps, errors, sockets } = createHarness({
      connectionFile: { url: 'http://localhost:3889' },
    });

    const sessionPromise = runViewSession('Alice', {}, deps);
    await new Promise((resolve) => setImmediate(resolve));
    const socket = sockets[0];
    socket.emit('close', 1006, Buffer.from('abnormal'));

    const code = await sessionPromise;
    expect(code).toBe(1);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('returns 1 when no broker connection can be resolved', async () => {
    const { deps, errors } = createHarness({ env: {}, connectionFile: null });
    const code = await runViewSession('Alice', {}, deps);
    expect(code).toBe(1);
    expect(errors[0]?.[0]).toMatch(/could not locate broker connection/);
  });

  it('omits the X-API-Key header when no api key is available', async () => {
    const { deps, sockets } = createHarness({
      connectionFile: { url: 'http://localhost:3889' },
    });

    const sessionPromise = runViewSession('Alice', {}, deps);
    await new Promise((resolve) => setImmediate(resolve));
    const socket = sockets[0];
    expect(socket.headers['X-API-Key']).toBeUndefined();
    socket.emit('close', 1000, Buffer.from(''));
    await sessionPromise;
  });

  it('renders the snapshot to stdout BEFORE the WebSocket opens', async () => {
    // The snapshot helper writes a clear-screen + welcome banner first;
    // the live WS then appends a delta. The user's terminal should see
    // the snapshot bytes first, then the live chunk.
    const snapshotBytes = '\x1b[2J\x1b[H\x1b[32mWelcome back Will\x1b[0m\n❯\n';
    const { deps, writes, sockets } = createHarness({
      connectionFile: { url: 'http://localhost:3889', api_key: 'k' },
      snapshotChunk: snapshotBytes,
    });

    const sessionPromise = runViewSession('Alice', {}, deps);
    await new Promise((resolve) => setImmediate(resolve));

    // Snapshot must have been written before any WS chunk arrives.
    expect(writes).toEqual([snapshotBytes]);

    const socket = sockets[0];
    socket.emit('open');
    socket.emit(
      'message',
      JSON.stringify({ kind: 'worker_stream', name: 'Alice', stream: 'stdout', chunk: 'live delta' })
    );
    socket.emit('close', 1000, Buffer.from(''));

    await sessionPromise;
    expect(writes).toEqual([snapshotBytes, 'live delta']);
  });

  it('aborts with exit code 1 when the snapshot reports not_found', async () => {
    const { deps, errors, sockets } = createHarness({
      connectionFile: { url: 'http://localhost:3889' },
      snapshotResult: { status: 'not_found', message: "no agent named 'Ghost'" },
    });

    const code = await runViewSession('Ghost', {}, deps);
    expect(code).toBe(1);
    expect(sockets).toHaveLength(0); // never opened the WS
    expect(errors[0]?.[0]).toMatch(/no agent named/);
  });

  it('aborts with exit code 1 when the worker has no PTY', async () => {
    const { deps, errors, sockets } = createHarness({
      connectionFile: { url: 'http://localhost:3889' },
      snapshotResult: {
        status: 'no_pty',
        message: "agent 'Headless' has no PTY (headless worker — nothing to view)",
      },
    });

    const code = await runViewSession('Headless', {}, deps);
    expect(code).toBe(1);
    expect(sockets).toHaveLength(0);
    expect(errors[0]?.[0]).toMatch(/no PTY/);
  });

  it('logs and continues when the snapshot is transiently unavailable', async () => {
    // Snapshot fails (broker hiccup, worker crashed mid-snapshot, etc.)
    // but the live stream should still attach — the agent may produce
    // useful output even if the current screen couldn't be captured.
    const { deps, logs, sockets, writes } = createHarness({
      connectionFile: { url: 'http://localhost:3889' },
      snapshotResult: { status: 'unavailable', message: 'snapshot returned HTTP 504' },
    });

    const sessionPromise = runViewSession('Alice', {}, deps);
    await new Promise((resolve) => setImmediate(resolve));

    expect(sockets).toHaveLength(1); // WS still opened
    expect(logs.some((args) => String(args[0]).includes('could not capture initial screen'))).toBe(true);

    const socket = sockets[0];
    socket.emit('open');
    socket.emit(
      'message',
      JSON.stringify({ kind: 'worker_stream', name: 'Alice', stream: 'stdout', chunk: 'live' })
    );
    socket.emit('close', 1000, Buffer.from(''));

    const code = await sessionPromise;
    expect(code).toBe(0);
    expect(writes).toEqual(['live']);
  });
});

describe('registerViewCommands', () => {
  it('registers a `view` command on the program', () => {
    const { deps } = createHarness();
    const program = new Command();
    program.exitOverride();
    registerViewCommands(program, deps);

    const cmd = program.commands.find((c) => c.name() === 'view');
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toMatch(/read-only/i);
  });

  it('wires --broker-url, --api-key, and --state-dir options', () => {
    const { deps } = createHarness();
    const program = new Command();
    program.exitOverride();
    registerViewCommands(program, deps);

    const cmd = program.commands.find((c) => c.name() === 'view');
    const flags = cmd?.options.map((opt) => opt.long).filter(Boolean);
    expect(flags).toEqual(expect.arrayContaining(['--broker-url', '--api-key', '--state-dir']));
  });
});
