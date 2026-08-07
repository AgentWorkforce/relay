import { Buffer } from 'node:buffer';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_TERMINAL_RESET_SEQUENCE } from './attach.js';
import type { CliPtyInputStream } from './attach-drive.js';
import {
  PassthroughKeybindParser,
  classifyWsEvent,
  renderStatusLine,
  runPassthroughSession,
  type PassthroughDependencies,
  type PassthroughStdin,
  type PassthroughTerminal,
  type PassthroughWebSocket,
} from './attach-passthrough.js';

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
  isRaw = false;
  setRawMode = vi.fn<(mode: boolean) => unknown>(() => undefined);
  resume = vi.fn(() => undefined);
  pause = vi.fn(() => undefined);
  private listener: ((chunk: Buffer) => void) | null = null;
  rawModeCalls: boolean[] = [];

  constructor() {
    this.setRawMode = vi.fn((mode: boolean) => {
      this.rawModeCalls.push(mode);
      this.isRaw = mode;
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

class FakeInputStream implements CliPtyInputStream {
  readonly writes: string[] = [];
  closed = false;
  closeCode?: number;
  closeReason?: string;

  constructor(
    private readonly name: string,
    private readonly openError?: Error,
    private readonly sendError?: Error
  ) {}

  async waitUntilOpen(): Promise<void> {
    if (this.openError) throw this.openError;
  }

  async send(data: string): Promise<{ name: string; bytes_written: number }> {
    // Mirror the real PtyInputStream: once the socket is gone the guard rejects
    // immediately and permanently (transport.ts:199).
    if (this.closed) throw new Error('PTY input stream is closed');
    if (this.sendError) throw this.sendError;
    this.writes.push(data);
    return { name: this.name, bytes_written: Buffer.byteLength(data, 'utf8') };
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }

  /** Test helper: the broker/proxy drops the socket without telling the CLI. */
  killFromServer(): void {
    this.closed = true;
  }
}

type FetchRoute = (init?: RequestInit) => Promise<Response>;

interface FetchScript {
  routes?: Record<string, FetchRoute>;
  initialMode?: 'manual_flush' | 'auto_inject';
  modeFlipFailure?: { status: number; error?: string };
  snapshotResult?: Awaited<ReturnType<PassthroughDependencies['captureAndRenderSnapshot']>>;
  terminalSize?: { rows: number; cols: number } | null;
  inputStreamOpenError?: Error;
  inputStreamSendError?: Error;
  /** Open-errors applied to reopen attempts only, in order. */
  reopenOpenErrors?: Array<Error | undefined>;
  inputReopenMaxAttempts?: number;
  inputReopenBaseDelayMs?: number;
  /**
   * Worker identities returned by successive `getWorkerIdentity` calls. Index 0
   * is the attach-time baseline; later entries answer post-reopen checks.
   * Defaults to a stable pid, i.e. "same worker throughout".
   */
  workerIdentities?: Array<string | null>;
  /** When set, inject this fake engine via the createPredictiveEcho factory. */
  predictiveEcho?: FakePredictiveEcho;
}

/** Records the calls the session routes into the predictive-echo engine. */
class FakePredictiveEcho {
  readonly seeded: string[] = [];
  readonly inputs: string[] = [];
  readonly outputs: string[] = [];
  resetCount = 0;

  async seed(data: string): Promise<void> {
    this.seeded.push(data);
  }

  onUserInput(forward: Buffer): void {
    this.inputs.push(forward.toString('utf-8'));
  }

  async onServerOutput(chunk: string): Promise<void> {
    this.outputs.push(chunk);
  }

  rollbackCount = 0;
  rollback(): void {
    this.rollbackCount += 1;
  }

  onResize(): void {}

  reset(): void {
    this.resetCount += 1;
  }
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
  fetchLog: Array<{ url: string; method: string; body?: unknown; headers: Record<string, string> }>;
  inputStreams: FakeInputStream[];
  predictiveEcho?: FakePredictiveEcho;
} {
  const writes: string[] = [];
  const errors: unknown[][] = [];
  const logs: unknown[][] = [];
  const signals = new Map<NodeJS.Signals, () => void | Promise<void>>();
  const sockets: FakeWebSocket[] = [];
  const inputStreams: FakeInputStream[] = [];
  const fetchLog: Array<{
    url: string;
    method: string;
    body?: unknown;
    headers: Record<string, string>;
  }> = [];
  const identityCalls: Array<string | null> = [];
  const stdin = new FakeStdin();
  const terminal = new FakeTerminal(
    opts.terminalSize === undefined ? { rows: 30, cols: 100 } : opts.terminalSize
  );

  const initialMode = opts.initialMode ?? 'auto_inject';

  // Stateful delivery mode: GET reflects the last successful PUT so the
  // detach-time re-read behaves like a real broker.
  let currentMode: 'manual_flush' | 'auto_inject' = initialMode;
  let currentRevision = 0;

  const defaultRoutes: Record<string, FetchRoute> = {
    'POST /resize': async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    'GET /delivery-mode': async () =>
      new Response(JSON.stringify({ mode: currentMode }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    'PUT /delivery-mode': async (init) => {
      if (opts.modeFlipFailure) {
        return new Response(JSON.stringify({ error: opts.modeFlipFailure.error ?? 'fail' }), {
          status: opts.modeFlipFailure.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const body = init?.body
        ? (JSON.parse(String(init.body)) as {
            mode: string;
            expected_mode?: string;
            expected_revision?: string;
          })
        : { mode: '' };
      // Compare-and-set: when `expected_mode` is present and no longer matches
      // the current mode, no-op and report `matched:false` with the unchanged
      // current mode (mirrors the real broker).
      if (
        (body.expected_mode !== undefined && body.expected_mode !== currentMode) ||
        (body.expected_revision !== undefined && body.expected_revision !== String(currentRevision))
      ) {
        return new Response(
          JSON.stringify({
            mode: currentMode,
            flushed: 0,
            matched: false,
            revision: String(currentRevision),
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      if (body.mode === 'manual_flush' || body.mode === 'auto_inject') currentMode = body.mode;
      currentRevision += 1;
      return new Response(
        JSON.stringify({ mode: body.mode, flushed: 0, matched: true, revision: String(currentRevision) }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
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
    // Normalize whatever shape the CLI passed for `init.headers`
    // (plain record / Headers instance / [k,v][] tuples) into a flat
    // record so tests can assert on auth headers ergonomically.
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
    fetchLog.push({ url, method, body: bodyJson, headers });

    let key: string | null = null;
    if (/\/api\/spawned\/[^/]+\/delivery-mode$/.test(url)) {
      key = `${method} /delivery-mode`;
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
    getDefaultStateDir: vi.fn(() => '/tmp/fake/.agentworkforce/relay'),
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
    openInputStream: vi.fn((_connection, streamName) => {
      const reopenIndex = inputStreams.length - 1;
      const openError =
        reopenIndex >= 0 && opts.reopenOpenErrors
          ? opts.reopenOpenErrors[reopenIndex]
          : opts.inputStreamOpenError;
      const stream = new FakeInputStream(streamName, openError, opts.inputStreamSendError);
      inputStreams.push(stream);
      return stream;
    }),
    createPredictiveEcho: opts.predictiveEcho ? () => opts.predictiveEcho ?? null : undefined,
    // Immediate, deterministic status repaints in tests (no coalescing timer).
    statusRepaintCoalesceMs: 0,
    // Small, deterministic reopen policy so tests don't wait on real backoff.
    inputReopenMaxAttempts: opts.inputReopenMaxAttempts ?? 2,
    inputReopenBaseDelayMs: opts.inputReopenBaseDelayMs ?? 1,
    getWorkerIdentity: vi.fn(async () => {
      const scripted = opts.workerIdentities;
      if (!scripted) return 'pid-1';
      // Index explicitly: a scripted `null` is a meaningful value ("identity
      // unavailable"), so `??` must not collapse it into the fallback.
      const index = identityCalls.length;
      const value =
        index < scripted.length ? scripted[index] : (scripted[scripted.length - 1] ?? null);
      identityCalls.push(value);
      return value;
    }),
  };

  return {
    deps,
    stdin,
    terminal,
    sockets,
    writes,
    errors,
    logs,
    signals,
    fetchLog,
    inputStreams,
    predictiveEcho: opts.predictiveEcho,
  };
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
  // Subscribe-first: the `open` handler paints the snapshot, reconciles the
  // buffer, forwards the initial resize, and takes over stdin — several
  // awaits deep. Flush enough turns for that chain to settle.
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
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

  it('returns other for delivery_queued (no queue in passthrough session)', () => {
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

  it('stops forwarding the chunk after Ctrl+C detach', () => {
    const p = new PassthroughKeybindParser();
    const out = p.feed(Buffer.from([0x61, 0x03, 0x62]));
    expect(Array.from(out.forward)).toEqual([0x61]);
    expect(out.actions).toEqual(['detach']);
  });

  it('forwards Ctrl+B sequences to the agent', () => {
    const p = new PassthroughKeybindParser();
    const out = p.feed(Buffer.from([0x02, 0x44]));
    expect(Array.from(out.forward)).toEqual([0x02, 0x44]);
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
  it('shows [passthrough name | delivery=auto_inject] without a pending counter', () => {
    const out = renderStatusLine({ name: 'Alice', mode: 'auto_inject' });
    expect(out).toContain('passthrough Alice');
    expect(out).toContain('delivery=auto_inject');
    expect(out).toContain('Ctrl+C detach');
    expect(out).not.toContain('pending=');
  });

  it('uses save/restore cursor + reverse video', () => {
    const out = renderStatusLine({ name: 'A', mode: 'auto_inject' });
    expect(out.startsWith('\x1b7')).toBe(true);
    expect(out.endsWith('\x1b8')).toBe(true);
    expect(out).toContain('\x1b[7m');
    expect(out).toContain('\x1b[0m');
  });

  // Same wrap-then-scroll cascade `drive` hits: a label wider than the pane
  // scrolls the screen on every repaint and shreds the agent's TUI behind it.
  it('truncates the label to the terminal width so it can never wrap', () => {
    const cols = 40;
    // eslint-disable-next-line no-control-regex -- matching the raw ESC bytes this module emits
    const strip = (s: string) => s.replace(/\x1b(?:[78]|\[[?0-9;]*[A-Za-z])/g, '');
    const text = strip(renderStatusLine({ name: 'Gamemaster', mode: 'auto_inject', rows: 24, cols }));
    expect(text.length).toBeLessThan(cols);
    expect(text).toContain('[passthrough');
    expect(text).toContain('detach]');
  });
});

describe('runPassthroughSession', () => {
  it('ensures passthrough mode on attach, opens WS, then restores prior mode on detach', async () => {
    const { deps, sockets, fetchLog, stdin, logs } = createHarness({ initialMode: 'auto_inject' });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    const socket = await openSocket(sockets);
    expect(socket.url).toBe('ws://localhost:3889/ws');
    expect(socket.headers['X-API-Key']).toBe('k');
    expect(logs.some((args) => String(args[0]).includes('attached to'))).toBe(false);

    // After attach (before detach), exactly one PUT /delivery-mode should have fired:
    // the "ensure passthrough" call. The restore PUT only fires after detach.
    const afterAttach = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/delivery-mode'));
    expect(afterAttach.map((c) => c.body)).toEqual([{ mode: 'auto_inject' }]);
    expect(stdin.rawModeCalls).toEqual([true]);

    stdin.type(Buffer.from([0x03])); // Ctrl+C
    const code = await sessionPromise;
    expect(code).toBe(0);

    // After detach, the restore PUT to the prior mode should
    // have fired, and raw mode should be off.
    const afterDetach = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/delivery-mode'));
    // Attach flip (unconditional), then a compare-and-set restore guarded by
    // `expected_mode` so a concurrent change is never clobbered.
    expect(afterDetach.map((c) => c.body)).toEqual([
      { mode: 'auto_inject' },
      { mode: 'auto_inject', expected_mode: 'auto_inject', expected_revision: '1' },
    ]);
    expect(stdin.rawModeCalls).toEqual([true, false]);
  });

  it('keeps Ctrl+C available while a raw-mode snapshot is pending', async () => {
    let releaseSnapshot!: () => void;
    const snapshotPending = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const { deps, sockets, stdin, inputStreams } = createHarness();
    deps.captureAndRenderSnapshot = vi.fn(async () => {
      await snapshotPending;
      return { status: 'ok' };
    }) as PassthroughDependencies['captureAndRenderSnapshot'];

    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    await openSocket(sockets);
    expect(stdin.isRaw).toBe(true);

    stdin.type(Buffer.from('\x1b[0A'));
    stdin.type(Buffer.from([0x03]));
    await expect(sessionPromise).resolves.toBe(0);
    expect(inputStreams[0].writes).toEqual([]);
    releaseSnapshot();
  });

  it('waits for predictive echo seeding before forwarding initial input', async () => {
    let releaseSeed!: () => void;
    const seedPending = new Promise<void>((resolve) => {
      releaseSeed = resolve;
    });
    const predictiveEcho = new FakePredictiveEcho();
    predictiveEcho.seed = vi.fn(() => seedPending);
    const { deps, sockets, stdin, inputStreams } = createHarness({ predictiveEcho });

    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    await openSocket(sockets);
    stdin.type(Buffer.from('before'));
    expect(inputStreams[0].writes).toEqual([]);
    expect(predictiveEcho.inputs).toEqual([]);

    releaseSeed();
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
    stdin.type(Buffer.from('after'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(inputStreams[0].writes).toEqual(['after']);
    expect(predictiveEcho.inputs).toEqual(['after']);

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
  });

  it('takes stdin raw before replaying a TUI snapshot', async () => {
    const { deps, sockets, stdin } = createHarness();
    deps.captureAndRenderSnapshot = vi.fn(async () => {
      expect(stdin.isRaw).toBe(true);
      return { status: 'ok' };
    }) as PassthroughDependencies['captureAndRenderSnapshot'];

    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    await openSocket(sockets);
    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
  });

  it('preserves an already-raw stdin on detach', async () => {
    const { deps, sockets, stdin } = createHarness();
    stdin.isRaw = true;

    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    await openSocket(sockets);
    expect(stdin.rawModeCalls).toEqual([]);

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
    expect(stdin.rawModeCalls).toEqual([]);
  });

  it('flips to auto_inject even when the worker was in manual_flush mode on attach, then restores on detach', async () => {
    const { deps, sockets, fetchLog, stdin } = createHarness({ initialMode: 'manual_flush' });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    await openSocket(sockets);

    stdin.type(Buffer.from([0x03])); // Ctrl+C
    await sessionPromise;

    const flipBodies = fetchLog
      .filter((c) => c.method === 'PUT' && c.url.endsWith('/delivery-mode'))
      .map((c) => c.body);
    expect(flipBodies).toEqual([
      { mode: 'auto_inject' },
      { mode: 'manual_flush', expected_mode: 'auto_inject', expected_revision: '1' },
    ]);
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
    const sessionPromise = runPassthroughSession('Ghost', {}, deps);
    // Subscribe-first: the broker-wide WS opens, then the snapshot 404s.
    for (let i = 0; i < 10 && sockets.length === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(sockets).toHaveLength(1);
    sockets[0].emit('open');
    const code = await sessionPromise;
    expect(code).toBe(1);
    expect(sockets[0].closed).toBe(true);
    expect(errors[0]?.[0]).toMatch(/no agent named/);
    // Best-effort compare-and-set restore PUT (guarded by `expected_mode`).
    const flips = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/delivery-mode'));
    expect(flips.map((c) => c.body)).toEqual([
      { mode: 'auto_inject' },
      { mode: 'auto_inject', expected_mode: 'auto_inject', expected_revision: '1' },
    ]);
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

  it('writes worker_stream chunks and safely restores the reserved status row', async () => {
    const { deps, sockets, writes, stdin } = createHarness();
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    const socket = await openSocket(sockets);
    socket.emit('message', jsonMessage({ kind: 'worker_stream', name: 'Alice', chunk: 'live output' }));
    expect(writes.includes('live output')).toBe(true);
    const paintsAfter = writes.filter((w) => w.includes('passthrough Alice')).length;
    socket.emit('message', jsonMessage({ kind: 'worker_stream', name: 'Alice', chunk: 'more output' }));
    expect(writes.filter((w) => w.includes('passthrough Alice')).length).toBeGreaterThan(paintsAfter);

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
  });

  it('repaints after worker output erases the full display', async () => {
    const { deps, sockets, writes, stdin } = createHarness();
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    const socket = await openSocket(sockets);
    const paintsBefore = writes.filter((w) => w.includes('passthrough Alice')).length;

    socket.emit('message', jsonMessage({ kind: 'worker_stream', name: 'Alice', chunk: '\x1b[2J' }));

    expect(writes.filter((w) => w.includes('passthrough Alice')).length).toBeGreaterThan(paintsBefore);
    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
  });

  it('forwards stdin keystrokes through the SDK PTY input stream', async () => {
    const { deps, sockets, stdin, fetchLog, inputStreams } = createHarness();
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    await openSocket(sockets);

    stdin.type(Buffer.from('hello'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(inputStreams).toHaveLength(1);
    expect(inputStreams[0].writes).toEqual(['hello']);
    const input = fetchLog.find((c) => c.method === 'POST' && c.url.includes('/api/input/'));
    expect(input).toBeUndefined();

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
    expect(inputStreams[0].closed).toBe(true);
  });

  it('aborts without raw mode when the SDK PTY input stream does not open', async () => {
    const { deps, sockets, stdin, errors } = createHarness({
      inputStreamOpenError: new Error('stream refused'),
    });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    await openSocket(sockets);

    const code = await sessionPromise;
    expect(code).toBe(1);
    expect(stdin.rawModeCalls).toEqual([]);
    expect(errors.some((args) => String(args[0]).includes('could not open PTY input stream'))).toBe(true);
  });

  it('restores the prior mode even on abnormal WebSocket close', async () => {
    const { deps, sockets, fetchLog, errors } = createHarness({ initialMode: 'manual_flush' });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    const socket = await openSocket(sockets);

    socket.emit('close', 1006, Buffer.from('abnormal'));
    const code = await sessionPromise;
    expect(code).toBe(1);
    expect(errors.some((args) => String(args[0]).includes('connection closed'))).toBe(true);

    const flips = fetchLog
      .filter((c) => c.method === 'PUT' && c.url.endsWith('/delivery-mode'))
      .map((c) => c.body);
    expect(flips).toEqual([
      { mode: 'auto_inject' },
      { mode: 'manual_flush', expected_mode: 'auto_inject', expected_revision: '1' },
    ]);
  });

  it('treats WebSocket errors as fatal and restores delivery mode', async () => {
    const { deps, sockets, fetchLog, errors } = createHarness({ initialMode: 'manual_flush' });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    const socket = await openSocket(sockets);

    socket.emit('error', new Error('boom'));
    const code = await sessionPromise;
    expect(code).toBe(1);
    expect(errors.some((args) => String(args[0]).includes('WebSocket error: boom'))).toBe(true);

    const flips = fetchLog
      .filter((c) => c.method === 'PUT' && c.url.endsWith('/delivery-mode'))
      .map((c) => c.body);
    expect(flips).toEqual([
      { mode: 'auto_inject' },
      { mode: 'manual_flush', expected_mode: 'auto_inject', expected_revision: '1' },
    ]);
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

  // ---- API-key header propagation ----

  it('sends X-API-Key on every broker request when configured', async () => {
    const { deps, sockets, signals, fetchLog } = createHarness();
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    await openSocket(sockets);
    await signals.get('SIGINT')?.();
    await sessionPromise;

    // Every fetch the runner made must carry the configured API key.
    // Without this the broker (when running with RELAY_BROKER_API_KEY)
    // would 401 every call and the session would be silently broken.
    expect(fetchLog.length).toBeGreaterThan(0);
    for (const call of fetchLog) {
      expect(call.headers).toMatchObject({ 'X-API-Key': 'k' });
    }
  });

  it('omits X-API-Key on every broker request when no key is configured', async () => {
    const { deps, sockets, signals, fetchLog } = createHarness();
    deps.readConnectionFile = vi.fn(() => ({ url: 'http://localhost:3889' })); // no api_key
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    await openSocket(sockets);
    await signals.get('SIGINT')?.();
    await sessionPromise;

    expect(fetchLog.length).toBeGreaterThan(0);
    for (const call of fetchLog) {
      expect(call.headers).not.toHaveProperty('X-API-Key');
    }
  });

  it('reserves the final local row when sizing the agent PTY on attach', async () => {
    const { deps, sockets, signals, fetchLog } = createHarness({
      terminalSize: { rows: 60, cols: 200 },
    });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    await openSocket(sockets);

    const resizeCalls = fetchLog.filter((c) => c.method === 'POST' && c.url.includes('/resize/'));
    expect(resizeCalls).toHaveLength(1);
    const body = resizeCalls[0].body as { rows: number; cols: number; session_id?: string };
    expect({ rows: body.rows, cols: body.cols }).toEqual({ rows: 59, cols: 199 });
    // The on-attach sync carries a session id for the single-resizer policy.
    expect(body.session_id).toEqual(expect.any(String));

    await signals.get('SIGINT')?.();
    await sessionPromise;
  });

  it('refreshes terminal size when it changes before the event socket opens', async () => {
    const { deps, sockets, terminal, signals, fetchLog, writes } = createHarness({
      terminalSize: { rows: 30, cols: 100 },
    });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    for (let i = 0; i < 10 && sockets.length === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    terminal.setSize({ rows: 42, cols: 120 });
    await openSocket(sockets);

    const firstResize = fetchLog.find((call) => call.url.includes('/api/resize/'));
    expect(firstResize?.body).toMatchObject({ rows: 41, cols: 119 });
    expect([...writes].reverse().find((write) => write.includes('[passthrough Alice'))).toContain(
      '\x1b[42;1H'
    );

    await signals.get('SIGINT')?.();
    await sessionPromise;
  });

  it('reapplies the latest size after a stale initial resize completes', async () => {
    let resolveInitialResize: ((response: Response) => void) | undefined;
    let resizeCalls = 0;
    const { deps, sockets, terminal, signals, fetchLog, writes } = createHarness({
      terminalSize: { rows: 30, cols: 100 },
      routes: {
        'POST /resize': async () => {
          resizeCalls += 1;
          if (resizeCalls === 1) {
            return new Promise<Response>((resolve) => {
              resolveInitialResize = resolve;
            });
          }
          return new Response(JSON.stringify({ applied: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      },
    });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    for (let i = 0; i < 10 && sockets.length === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    sockets[0]?.emit('open');
    await new Promise((resolve) => setImmediate(resolve));
    terminal.setSize({ rows: 42, cols: 120 });
    await new Promise((resolve) => setImmediate(resolve));
    // Without this the test can pass on the SIGWINCH resize alone: if setup
    // never reached the first `POST /resize`, the optional resolve below is a
    // no-op and the stale path is never exercised (silent false green).
    expect(resolveInitialResize).toBeTypeOf('function');
    resolveInitialResize?.(
      new Response(JSON.stringify({ applied: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));

    const activeResizes = fetchLog.filter(
      (call) => call.url.includes('/api/resize/') && !(call.body as { release?: boolean }).release
    );
    expect(activeResizes.at(-1)?.body).toMatchObject({ rows: 41, cols: 119 });
    expect([...writes].reverse().find((write) => write.includes('[passthrough Alice'))).toContain(
      '\x1b[42;1H'
    );

    await signals.get('SIGINT')?.();
    await sessionPromise;
  });

  it('waits for the initial resize before releasing ownership on detach', async () => {
    let finishInitialResize: ((response: Response) => void) | undefined;
    const { deps, sockets, signals, fetchLog } = createHarness({
      routes: {
        'POST /resize': async (init) => {
          const body = JSON.parse(String(init?.body ?? '{}')) as { release?: boolean };
          if (body.release === true) {
            return new Response(JSON.stringify({ released: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Promise<Response>((resolve) => {
            finishInitialResize = resolve;
          });
        },
      },
    });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    await openSocket(sockets);
    expect(finishInitialResize).toBeDefined();

    await signals.get('SIGINT')?.();
    expect(
      fetchLog.some(
        (call) => call.url.includes('/resize/') && (call.body as { release?: boolean }).release === true
      )
    ).toBe(false);

    finishInitialResize?.(
      new Response(JSON.stringify({ applied: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await sessionPromise;
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const resizeBodies = fetchLog
      .filter((call) => call.url.includes('/resize/'))
      .map((call) => call.body as { release?: boolean });
    expect(resizeBodies.map((body) => body.release === true)).toEqual([false, true]);
  });

  it('restores the reserved row and column on the release itself', async () => {
    const { deps, sockets, signals, fetchLog } = createHarness({
      terminalSize: { rows: 30, cols: 100 },
    });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    await openSocket(sockets);

    // The attach sizes the worker one row and column short to reserve the
    // status line.
    const attachResize = fetchLog.find((call) => call.method === 'POST' && call.url.includes('/resize/'));
    expect(attachResize?.body).toMatchObject({ rows: 29, cols: 99 });

    await signals.get('SIGINT')?.();
    await sessionPromise;

    // Detach hands the reserved row and column back on the release request, so
    // a later read-only `view` session doesn't inherit a short PTY. Doing it on
    // the release keeps it atomic: a separate resize could land afterwards and
    // re-claim ownership (#1247).
    const releaseCalls = fetchLog.filter(
      (call) => call.url.includes('/resize/') && (call.body as { release?: boolean }).release === true
    );
    expect(releaseCalls).toHaveLength(1);
    expect(releaseCalls[0]?.body).toMatchObject({ rows: 30, cols: 100 });
  });

  // ---- predictive-echo wiring ----

  it('seeds the engine with the snapshot and routes input + output through it', async () => {
    const fake = new FakePredictiveEcho();
    const { deps, sockets, stdin } = createHarness({ predictiveEcho: fake });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    const socket = await openSocket(sockets);

    // Snapshot bytes seeded the confirmed model.
    expect(fake.seeded.length).toBe(1);

    // Live output is routed through the engine (it owns pass-through), not
    // written directly.
    socket.emit('message', jsonMessage({ kind: 'worker_stream', name: 'Alice', chunk: 'live' }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.outputs).toContain('live');

    // Keystrokes are mirrored to the engine for optimistic echo.
    stdin.type(Buffer.from('hi'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.inputs).toContain('hi');

    stdin.type(Buffer.from([0x03])); // Ctrl+C detach
    await sessionPromise;
    expect(fake.resetCount).toBe(1);
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

  // ---- multi-byte UTF-8 stdin (item 2) ----

  it('forwards a multi-byte character split across stdin chunks intact', async () => {
    const { deps, sockets, stdin, inputStreams } = createHarness();
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    await openSocket(sockets);

    // '你' = 0xE4 0xBD 0xA0, arriving as three separate stdin data events.
    stdin.type(Buffer.from([0xe4]));
    await new Promise((resolve) => setImmediate(resolve));
    stdin.type(Buffer.from([0xbd]));
    await new Promise((resolve) => setImmediate(resolve));
    stdin.type(Buffer.from([0xa0]));
    await new Promise((resolve) => setImmediate(resolve));

    expect(inputStreams[0].writes).toEqual(['你']);

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
  });

  // ---- no output after teardown begins (item 3) ----

  it('stops writing output once teardown has begun', async () => {
    const { deps, sockets, writes, stdin } = createHarness();
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    const socket = await openSocket(sockets);

    stdin.type(Buffer.from([0x03])); // detach → settled
    await sessionPromise;

    const before = writes.length;
    socket.emit('message', jsonMessage({ kind: 'worker_stream', name: 'Alice', chunk: 'POST-DETACH' }));
    expect(writes.includes('POST-DETACH')).toBe(false);
    expect(writes.length).toBe(before);
  });

  // ---- status line boundary-hold (item 4) ----

  it('holds the status repaint while a worker chunk ends mid escape sequence', async () => {
    const { deps, sockets, writes, stdin, terminal } = createHarness();
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    const socket = await openSocket(sockets);

    const paintsBefore = writes.filter((w) => w.includes('passthrough Alice')).length;
    socket.emit('message', jsonMessage({ kind: 'worker_stream', name: 'Alice', chunk: 'data\x1b[' }));
    const writesBeforeResize = writes.length;
    // A local resize requests a status repaint, but it must wait until the
    // worker completes its split CSI sequence.
    terminal.setSize({ rows: 31, cols: 100 });
    expect(writes.filter((w) => w.includes('passthrough Alice')).length).toBe(paintsBefore);
    expect(writes).toHaveLength(writesBeforeResize);
    socket.emit('message', jsonMessage({ kind: 'worker_stream', name: 'Alice', chunk: '2J' }));
    expect(writes.filter((w) => w.includes('passthrough Alice')).length).toBeGreaterThan(paintsBefore);

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
  });

  it.each([1, 2])('disables status painting when a large terminal shrinks to %i rows', async (rows) => {
    const { deps, sockets, writes, stdin, terminal, fetchLog } = createHarness({
      terminalSize: { rows: 10, cols: 80 },
    });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    const socket = await openSocket(sockets);
    terminal.setSize({ rows, cols: 80 });
    const paintsAfterShrink = writes.filter((write) => write.includes('[passthrough Alice')).length;

    socket.emit('message', jsonMessage({ kind: 'worker_stream', name: 'Alice', chunk: 'only row' }));

    expect(writes.filter((write) => write.includes('[passthrough Alice'))).toHaveLength(paintsAfterShrink);
    expect(
      fetchLog.some(
        (call) =>
          call.url.includes('/api/resize/') &&
          (call.body as { rows?: number; cols?: number }).rows === rows &&
          (call.body as { rows?: number; cols?: number }).cols === 80
      )
    ).toBe(true);
    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
    expect(writes).toContain(LOCAL_TERMINAL_RESET_SEQUENCE);
  });

  it.each([1, 2])('activates row reservation when a %i-row terminal grows', async (rows) => {
    const { deps, sockets, writes, stdin, terminal, fetchLog } = createHarness({
      terminalSize: { rows, cols: 80 },
    });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    await openSocket(sockets);
    expect(writes.some((write) => write.includes('[passthrough Alice'))).toBe(false);

    terminal.setSize({ rows: 10, cols: 80 });

    expect(writes.some((write) => write.includes('[passthrough Alice'))).toBe(true);
    expect(
      fetchLog.some(
        (call) =>
          call.url.includes('/api/resize/') &&
          (call.body as { rows?: number; cols?: number }).rows === 9 &&
          (call.body as { rows?: number; cols?: number }).cols === 79
      )
    ).toBe(true);
    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
  });

  // ---- non-TTY skips the status line (item 5) ----

  it('skips status-line painting when stdout is not a TTY', async () => {
    const { deps, sockets, writes, signals } = createHarness({ terminalSize: null });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    const socket = await openSocket(sockets);

    socket.emit('message', jsonMessage({ kind: 'worker_stream', name: 'Alice', chunk: 'plain' }));
    expect(writes.includes('plain')).toBe(true);
    expect(writes.some((w) => w.includes('passthrough Alice'))).toBe(false);

    await signals.get('SIGINT')?.();
    await sessionPromise;
  });

  // ---- detach does not clobber another session's mode change (item 6) ----

  it('restores via compare-and-set so a concurrent mode change is not clobbered on detach', async () => {
    // Session flips to auto_inject (prev manual_flush). Another session changes
    // the mode before detach, so the broker's compare-and-set (guarded by
    // `expected_mode: auto_inject`) misses and the restore is a broker-side
    // no-op — the concurrent change is preserved. The client no longer does a
    // read-then-set (which had a TOCTOU); it always sends the guarded PUT.
    const { deps, sockets, stdin, fetchLog } = createHarness({
      initialMode: 'manual_flush',
      routes: {
        'PUT /delivery-mode': async (init) => {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            mode: string;
            expected_mode?: string;
            expected_revision?: string;
          };
          // The restore carries `expected_mode`; model a broker whose current
          // mode was changed by another session, so the compare-and-set misses.
          if (body.expected_mode !== undefined) {
            return new Response(
              JSON.stringify({ mode: 'manual_flush', flushed: 0, matched: false, revision: '2' }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }
            );
          }
          return new Response(JSON.stringify({ mode: body.mode, flushed: 0, matched: true, revision: '1' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      },
    });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    await openSocket(sockets);

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;

    const putCalls = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/delivery-mode'));
    // Attach flip (unconditional), then a compare-and-set restore guarded by
    // `expected_mode`. The restore no-ops broker-side rather than clobbering.
    expect(putCalls.map((c) => c.body)).toEqual([
      { mode: 'auto_inject' },
      { mode: 'manual_flush', expected_mode: 'auto_inject', expected_revision: '1' },
    ]);
  });
});

/**
 * Passthrough carries the same lost-input-stream defect drive did (#1419) and
 * now shares its recovery (`attach-input-recovery.ts`). These pin the two
 * halves of the contract that matter most; the drive suite covers the rest of
 * the shared behaviour.
 */
describe('runPassthroughSession — lost PTY input stream', () => {
  async function settleRecovery(turns = 60): Promise<void> {
    for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 1));
  }

  it('reports the loss exactly once however much input arrives', async () => {
    const { deps, sockets, stdin, logs, errors, inputStreams } = createHarness({
      reopenOpenErrors: [new Error('still down'), new Error('still down')],
    });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    await openSocket(sockets);

    inputStreams[0].killFromServer();
    // Mouse reports, not keystrokes — the amplifier that made this a flood.
    for (let i = 0; i < 200; i++) stdin.type(Buffer.from(`\x1b[<35;${i};10M`));
    await settleRecovery();

    const lost = [...logs, ...errors]
      .map((args) => String(args[0]))
      .filter((line) => line.includes('input stream lost'));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain('[passthrough]');
    await sessionPromise;
  });

  it('exits non-zero with a readable message when every reopen fails', async () => {
    const { deps, sockets, stdin, errors, inputStreams } = createHarness({
      inputReopenMaxAttempts: 2,
      reopenOpenErrors: [new Error('broker down'), new Error('broker down')],
    });
    const sessionPromise = runPassthroughSession('Alice', {}, deps);
    await openSocket(sockets);

    inputStreams[0].killFromServer();
    stdin.type(Buffer.from('a'));

    expect(await sessionPromise).toBe(1);
    const exhausted = errors
      .map((args) => String(args[0]))
      .find((line) => line.includes('could not be reopened'));
    expect(exhausted).toContain('Alice is still running');
  });
});
