import { Buffer } from 'node:buffer';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PassthroughKeybindParser,
  classifyWsEvent,
  registerPassthroughCommands,
  renderStatusLine,
  runPassthroughSession,
  type PassthroughDependencies,
  type PassthroughStdin,
  type PassthroughTerminal,
  type PassthroughWebSocket,
} from './passthrough.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

type WsListener = (...args: unknown[]) => void;

class FakeWebSocket implements PassthroughWebSocket {
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

class FakeStdin implements PassthroughStdin {
  isTTY = true;
  setRawMode = vi.fn<(mode: boolean) => unknown>(() => undefined);
  resume = vi.fn(() => undefined);
  pause = vi.fn(() => undefined);
  private listener: ((chunk: Buffer) => void) | null = null;
  rawModeCalls: boolean[] = [];

  constructor() {
    this.setRawMode = vi.fn((mode: boolean) => {
      this.rawModeCalls.push(mode);
      return undefined;
    });
  }

  on(event: 'data', listener: (chunk: Buffer) => void): unknown {
    if (event === 'data') this.listener = listener;
    return this;
  }

  off(event: 'data', listener: (chunk: Buffer) => void): unknown {
    if (event === 'data' && this.listener === listener) this.listener = null;
    return this;
  }

  removeListener(event: 'data', listener: (chunk: Buffer) => void): unknown {
    return this.off(event, listener);
  }

  type(chunk: Buffer): void {
    this.listener?.(chunk);
  }
}

class FakeTerminal implements PassthroughTerminal {
  private currentSize: { rows: number; cols: number } | null;
  private handlers: Array<() => void> = [];

  constructor(initial: { rows: number; cols: number } | null = { rows: 30, cols: 100 }) {
    this.currentSize = initial;
  }

  getSize(): { rows: number; cols: number } | null {
    return this.currentSize;
  }

  onResize(handler: () => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  setSize(size: { rows: number; cols: number } | null): void {
    this.currentSize = size;
    for (const h of this.handlers) h();
  }

  listenerCount(): number {
    return this.handlers.length;
  }
}

type FetchRoute = (init?: RequestInit) => Promise<Response>;

interface FetchScript {
  routes?: Record<string, FetchRoute>;
  initialMode?: 'human' | 'passthrough';
  modeFlipFailure?: { status: number; error?: string };
  snapshotResult?: Awaited<ReturnType<PassthroughDependencies['captureAndRenderSnapshot']>>;
  terminalSize?: { rows: number; cols: number } | null;
}

function createHarness(opts: FetchScript = {}): {
  deps: PassthroughDependencies;
  stdin: FakeStdin;
  terminal: FakeTerminal;
  sockets: FakeWebSocket[];
  writes: string[];
  errors: unknown[][];
  logs: unknown[][];
  signals: Map<NodeJS.Signals, () => void | Promise<void>>;
  fetchLog: Array<{ url: string; method: string; body?: unknown }>;
} {
  const writes: string[] = [];
  const errors: unknown[][] = [];
  const logs: unknown[][] = [];
  const signals = new Map<NodeJS.Signals, () => void | Promise<void>>();
  const sockets: FakeWebSocket[] = [];
  const fetchLog: Array<{ url: string; method: string; body?: unknown }> = [];
  const stdin = new FakeStdin();
  const terminal = new FakeTerminal(
    opts.terminalSize === undefined ? { rows: 30, cols: 100 } : opts.terminalSize
  );

  const initialMode = opts.initialMode ?? 'passthrough';

  const defaultRoutes: Record<string, FetchRoute> = {
    'POST /resize': async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    'GET /mode': async () =>
      new Response(JSON.stringify({ mode: initialMode }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    'PUT /mode': async (init) => {
      if (opts.modeFlipFailure) {
        return new Response(JSON.stringify({ error: opts.modeFlipFailure.error ?? 'fail' }), {
          status: opts.modeFlipFailure.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const body = init?.body ? (JSON.parse(String(init.body)) as { mode: string }) : { mode: '' };
      return new Response(JSON.stringify({ mode: body.mode, flushed: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    'POST /input': async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  };
  const routes = { ...defaultRoutes, ...(opts.routes ?? {}) };

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
    fetchLog.push({ url, method, body: bodyJson });

    let key: string | null = null;
    if (/\/api\/spawned\/[^/]+\/mode$/.test(url)) {
      key = `${method} /mode`;
    } else if (/\/api\/input\/[^/]+$/.test(url)) {
      key = `${method} /input`;
    } else if (/\/api\/resize\/[^/]+$/.test(url)) {
      key = `${method} /resize`;
    }
    if (key && routes[key]) {
      return routes[key](init);
    }
    return new Response('not mocked', { status: 500 });
  }) as unknown as typeof globalThis.fetch;

  const deps: PassthroughDependencies = {
    readConnectionFile: vi.fn(() => ({ url: 'http://localhost:3889', api_key: 'k' })),
    getDefaultStateDir: vi.fn(() => '/tmp/fake/.agent-relay'),
    env: {},
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
    }) as unknown as PassthroughDependencies['exit'],
    fetch: fetchFn,
    captureAndRenderSnapshot: vi.fn(async (_conn, _name, snapshotDeps) => {
      void snapshotDeps;
      return opts.snapshotResult ?? { status: 'ok' };
    }) as PassthroughDependencies['captureAndRenderSnapshot'],
    stdin,
    terminal,
  };

  return { deps, stdin, terminal, sockets, writes, errors, logs, signals, fetchLog };
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function openSocket(sockets: FakeWebSocket[]): Promise<FakeWebSocket> {
  for (let i = 0; i < 10 && sockets.length === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(sockets).toHaveLength(1);
  const socket = sockets[0];
  socket.emit('open');
  await new Promise((resolve) => setImmediate(resolve));
  return socket;
}

function jsonMessage(payload: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(payload));
}

describe('classifyWsEvent', () => {
  it('matches worker_stream for the targeted agent', () => {
    expect(
      classifyWsEvent(JSON.stringify({ kind: 'worker_stream', name: 'Alice', chunk: 'hi' }), 'Alice')
    ).toEqual({ kind: 'worker_stream', chunk: 'hi' });
  });

  it('filters worker_stream for other agents', () => {
    expect(
      classifyWsEvent(JSON.stringify({ kind: 'worker_stream', name: 'Bob', chunk: 'hi' }), 'Alice')
    ).toEqual({ kind: 'other' });
  });

  it('returns other for delivery_queued (no queue in passthrough mode)', () => {
    expect(classifyWsEvent(JSON.stringify({ kind: 'delivery_queued', name: 'Alice' }), 'Alice')).toEqual({
      kind: 'other',
    });
  });

  it('returns other for non-JSON payloads', () => {
    expect(classifyWsEvent('not-json', 'Alice')).toEqual({ kind: 'other' });
  });
});

describe('PassthroughKeybindParser', () => {
  it('forwards ordinary keystrokes unchanged', () => {
    const p = new PassthroughKeybindParser();
    const out = p.feed(Buffer.from('hello'));
    expect(out.forward.toString()).toBe('hello');
    expect(out.actions).toEqual([]);
  });

  it('intercepts Ctrl+C as detach', () => {
    const p = new PassthroughKeybindParser();
    const out = p.feed(Buffer.from([0x03]));
    expect(out.forward.length).toBe(0);
    expect(out.actions).toEqual(['detach']);
  });

  it('recognises Ctrl+B D as detach across chunks', () => {
    const p = new PassthroughKeybindParser();
    expect(p.feed(Buffer.from([0x02])).actions).toEqual([]);
    expect(p.feed(Buffer.from([0x44])).actions).toEqual(['detach']);
  });

  it('recognises Ctrl+B ? as toggle_help', () => {
    const p = new PassthroughKeybindParser();
    expect(p.feed(Buffer.from([0x02, 0x3f])).actions).toEqual(['toggle_help']);
  });

  it('forwards Ctrl+B + unknown byte verbatim', () => {
    const p = new PassthroughKeybindParser();
    const out = p.feed(Buffer.from([0x02, 0x78]));
    expect(Array.from(out.forward)).toEqual([0x02, 0x78]);
    expect(out.actions).toEqual([]);
  });

  it('does NOT recognise Ctrl+G (no flush keybind in passthrough mode)', () => {
    const p = new PassthroughKeybindParser();
    const out = p.feed(Buffer.from([0x07]));
    // Ctrl+G is forwarded verbatim instead of being intercepted as flush.
    expect(Array.from(out.forward)).toEqual([0x07]);
    expect(out.actions).toEqual([]);
  });
});

describe('renderStatusLine', () => {
  it('shows [passthrough name | mode=passthrough] without a pending counter', () => {
    const out = renderStatusLine({ agentName: 'Alice', mode: 'passthrough', showHelp: false });
    expect(out).toContain('passthrough Alice');
    expect(out).toContain('mode=passthrough');
    expect(out).toContain('Ctrl+B D detach');
    expect(out).not.toContain('pending=');
  });

  it('uses save/restore cursor + reverse video', () => {
    const out = renderStatusLine({ agentName: 'A', mode: 'passthrough', showHelp: false });
    expect(out.startsWith('\x1b7')).toBe(true);
    expect(out.endsWith('\x1b8')).toBe(true);
    expect(out).toContain('\x1b[7m');
    expect(out).toContain('\x1b[0m');
  });
});

describe('runPassthroughSession', () => {
  it('ensures passthrough mode on attach, opens WS, then restores prior mode on detach', async () => {
    const { deps, sockets, fetchLog, stdin } = createHarness({ initialMode: 'passthrough' });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    const socket = await openSocket(sockets);
    expect(socket.url).toBe('ws://localhost:3889/ws');
    expect(socket.headers['X-API-Key']).toBe('k');

    // After attach (before detach), exactly one PUT /mode should have fired:
    // the "ensure passthrough" call. The restore PUT only fires after detach.
    const afterAttach = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/mode'));
    expect(afterAttach.map((c) => c.body)).toEqual([{ mode: 'passthrough' }]);
    expect(stdin.rawModeCalls).toEqual([true]);

    stdin.type(Buffer.from([0x02, 0x44])); // Ctrl+B D
    const code = await sessionPromise;
    expect(code).toBe(0);

    // After detach, the restore PUT to the prior mode ('passthrough') should
    // have fired, and raw mode should be off.
    const afterDetach = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/mode'));
    expect(afterDetach.map((c) => c.body)).toEqual([{ mode: 'passthrough' }, { mode: 'passthrough' }]);
    expect(stdin.rawModeCalls).toEqual([true, false]);
  });

  it('flips back to passthrough even when the worker was in human mode on attach, then restores to human on detach', async () => {
    const { deps, sockets, fetchLog, stdin } = createHarness({ initialMode: 'human' });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    await openSocket(sockets);

    stdin.type(Buffer.from([0x03])); // Ctrl+C
    await sessionPromise;

    const flipBodies = fetchLog
      .filter((c) => c.method === 'PUT' && c.url.endsWith('/mode'))
      .map((c) => c.body);
    expect(flipBodies).toEqual([{ mode: 'passthrough' }, { mode: 'human' }]);
  });

  it('aborts before opening the WS when the broker rejects the mode flip', async () => {
    const { deps, sockets, errors } = createHarness({
      modeFlipFailure: { status: 404, error: "no agent named 'Ghost'" },
    });
    const code = await runPassthroughSession('Ghost', {}, deps);
    expect(code).toBe(1);
    expect(sockets).toHaveLength(0);
    expect(errors.some((args) => String(args[0]).includes("no agent named 'Ghost'"))).toBe(true);
  });

  it('aborts on snapshot not_found', async () => {
    const { deps, sockets, errors, fetchLog } = createHarness({
      snapshotResult: { status: 'not_found', message: "no agent named 'Ghost'" },
    });
    const code = await runPassthroughSession('Ghost', {}, deps);
    expect(code).toBe(1);
    expect(sockets).toHaveLength(0);
    expect(errors[0]?.[0]).toMatch(/no agent named/);
    // Best-effort restore PUT.
    const flips = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/mode'));
    expect(flips.map((c) => c.body)).toEqual([{ mode: 'passthrough' }, { mode: 'passthrough' }]);
  });

  it('continues with a warning when the snapshot is transiently unavailable', async () => {
    const { deps, sockets, logs } = createHarness({
      snapshotResult: { status: 'unavailable', message: 'HTTP 504' },
    });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    const socket = await openSocket(sockets);
    expect(logs.some((args) => String(args[0]).includes('could not capture initial screen'))).toBe(true);
    socket.emit('close', 1000, Buffer.from(''));
    await sessionPromise;
  });

  it('writes worker_stream chunks to stdout and repaints the status line', async () => {
    const { deps, sockets, writes, stdin } = createHarness();
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    const socket = await openSocket(sockets);
    socket.emit('message', jsonMessage({ kind: 'worker_stream', name: 'Alice', chunk: 'live output' }));
    expect(writes.includes('live output')).toBe(true);
    const liveIdx = writes.indexOf('live output');
    const repaintAfter = writes.slice(liveIdx + 1).some((w) => w.includes('passthrough Alice'));
    expect(repaintAfter).toBe(true);

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
  });

  it('forwards stdin keystrokes via POST /api/input/{name}', async () => {
    const { deps, sockets, stdin, fetchLog } = createHarness();
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    await openSocket(sockets);

    stdin.type(Buffer.from('hello'));
    await new Promise((resolve) => setImmediate(resolve));
    const input = fetchLog.find((c) => c.method === 'POST' && c.url.includes('/api/input/'));
    expect(input?.body).toEqual({ data: 'hello' });

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
  });

  it('restores the prior mode even on abnormal WebSocket close', async () => {
    const { deps, sockets, fetchLog, errors } = createHarness({ initialMode: 'human' });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    const socket = await openSocket(sockets);

    socket.emit('close', 1006, Buffer.from('abnormal'));
    const code = await sessionPromise;
    expect(code).toBe(1);
    expect(errors.some((args) => String(args[0]).includes('connection closed'))).toBe(true);

    const flips = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/mode')).map((c) => c.body);
    expect(flips).toEqual([{ mode: 'passthrough' }, { mode: 'human' }]);
  });

  it('exits cleanly on SIGINT', async () => {
    const { deps, sockets, signals, stdin } = createHarness();
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    await openSocket(sockets);

    const sigint = signals.get('SIGINT');
    expect(sigint).toBeDefined();
    await sigint?.();

    const code = await sessionPromise;
    expect(code).toBe(0);
    expect(stdin.rawModeCalls).toEqual([true, false]);
  });

  it('returns 1 when no broker connection can be resolved', async () => {
    const { deps, errors } = createHarness();
    deps.readConnectionFile = vi.fn(() => null);
    const code = await runPassthroughSession('Alice', {}, deps);
    expect(code).toBe(1);
    expect(errors[0]?.[0]).toMatch(/could not locate broker connection/);
  });

  it('forwards the local terminal size to the broker on attach', async () => {
    const { deps, sockets, signals, fetchLog } = createHarness({
      terminalSize: { rows: 60, cols: 200 },
    });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    await openSocket(sockets);

    const resizeCalls = fetchLog.filter((c) => c.method === 'POST' && c.url.includes('/resize/'));
    expect(resizeCalls).toHaveLength(1);
    expect(resizeCalls[0].body).toEqual({ rows: 60, cols: 200 });

    await signals.get('SIGINT')?.();
    await sessionPromise;
  });

  it('skips resize forwarding when stdout is not a TTY', async () => {
    const { deps, sockets, signals, fetchLog } = createHarness({ terminalSize: null });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    await openSocket(sockets);

    const resizeCalls = fetchLog.filter((c) => c.method === 'POST' && c.url.includes('/resize/'));
    expect(resizeCalls).toHaveLength(0);

    await signals.get('SIGINT')?.();
    await sessionPromise;
  });
});

describe('registerPassthroughCommands', () => {
  it('registers a `passthrough` command on the program', () => {
    const { deps } = createHarness();
    const program = new Command();
    program.exitOverride();
    registerPassthroughCommands(program, deps);
    const cmd = program.commands.find((c) => c.name() === 'passthrough');
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toMatch(/passthrough mode/i);
  });

  it('wires --broker-url, --api-key, and --state-dir', () => {
    const { deps } = createHarness();
    const program = new Command();
    program.exitOverride();
    registerPassthroughCommands(program, deps);
    const cmd = program.commands.find((c) => c.name() === 'passthrough');
    const flags = cmd?.options.map((opt) => opt.long).filter(Boolean) ?? [];
    expect(flags).toEqual(expect.arrayContaining(['--broker-url', '--api-key', '--state-dir']));
  });
});
