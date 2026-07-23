import { Buffer } from 'node:buffer';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  KeybindParser,
  classifyWsEvent,
  renderStatusLine,
  runDriveSession,
  type CliPtyInputStream,
  type DriveDependencies,
  type DriveStdin,
  type DriveTerminal,
  type DriveWebSocket,
} from './attach-drive.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

type WsListener = (...args: unknown[]) => void;

class FakeWebSocket implements DriveWebSocket {
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

class FakeStdin implements DriveStdin {
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

  /** Tests use this to simulate the user typing. */
  type(chunk: Buffer): void {
    this.listener?.(chunk);
  }
}

/**
 * Fake terminal size source. Tests control the current `(rows, cols)`
 * via `setSize` and synthesize a resize event via `triggerResize`.
 * `null` size simulates "not a TTY" so the resize-forwarding path can
 * be exercised in both modes.
 */
class FakeTerminal implements DriveTerminal {
  private currentSize: { rows: number; cols: number } | null;
  private handlers: Array<() => void> = [];
  /** Records every `(rows, cols)` reported via `getSize` *after* it
   *  was called by the system under test. Useful for assertions. */
  readonly sizeReadCount = { value: 0 };

  constructor(initial: { rows: number; cols: number } | null = { rows: 30, cols: 100 }) {
    this.currentSize = initial;
  }

  getSize(): { rows: number; cols: number } | null {
    this.sizeReadCount.value += 1;
    return this.currentSize;
  }

  onResize(handler: () => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /** Update the reported size *and* fire a resize event. */
  setSize(size: { rows: number; cols: number } | null): void {
    this.currentSize = size;
    for (const h of this.handlers) h();
  }

  /** Returns the number of currently-subscribed resize listeners. */
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
    if (this.sendError) throw this.sendError;
    this.writes.push(data);
    return { name: this.name, bytes_written: Buffer.byteLength(data, 'utf8') };
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }
}

class FakePredictiveEcho {
  readonly seeded: string[] = [];
  readonly inputs: string[] = [];

  async seed(data: string): Promise<void> {
    this.seeded.push(data);
  }

  async onServerOutput(): Promise<void> {}
  onUserInput(forward: Buffer): void {
    this.inputs.push(forward.toString('utf-8'));
  }
  rollback(): void {}
  onResize(): void {}
  reset(): void {}
}

/** Routed fetch — keyed on `${method} ${pathSuffix}`. */
type FetchRoute = (init?: RequestInit) => Promise<Response>;

interface FetchScript {
  /** Map of route key → handler. Default behaviour returns 200 + sensible body. */
  routes?: Record<string, FetchRoute>;
  /** Default mode reported by `GET …/delivery-mode`. */
  initialMode?: 'manual_flush' | 'auto_inject';
  /** Default pending count reported by `GET …/pending`. */
  initialPending?: number;
  /** Durable-event cutoff reported by `GET /api/events/replay`. */
  initialCurrentSeq?: number;
  /** Make `PUT …/delivery-mode` to `manual_flush` fail with this status / body. */
  modeFlipFailure?: { status: number; error?: string };
  /** Make `captureAndRenderSnapshot` return this status. */
  snapshotResult?: Awaited<ReturnType<DriveDependencies['captureAndRenderSnapshot']>>;
  /** Initial local terminal size. Defaults to `{ rows: 30, cols: 100 }`;
   *  pass `null` to simulate "not a TTY" so the resize-forwarding path
   *  short-circuits. */
  terminalSize?: { rows: number; cols: number } | null;
  inputStreamOpenError?: Error;
  inputStreamSendError?: Error;
  /** Ownership re-assert interval (ms). Defaults to disabled (0) in tests so
   *  the keep-alive timer doesn't interfere; the re-assert test sets it small. */
  ownershipReassertMs?: number;
  predictiveEcho?: FakePredictiveEcho;
}

function createHarness(opts: FetchScript = {}): {
  deps: DriveDependencies;
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
  const stdin = new FakeStdin();
  const terminal = new FakeTerminal(
    opts.terminalSize === undefined ? { rows: 30, cols: 100 } : opts.terminalSize
  );

  const initialMode = opts.initialMode ?? 'auto_inject';
  const initialPending = opts.initialPending ?? 0;
  const initialCurrentSeq = opts.initialCurrentSeq ?? 0;

  // Stateful delivery mode: GET reflects the last successful PUT so the
  // detach-time re-read (which only restores when the mode is still what this
  // session set) behaves like a real broker.
  let currentMode: 'manual_flush' | 'auto_inject' = initialMode;
  let currentRevision = 0;

  const defaultRoutes: Record<string, FetchRoute> = {
    'GET /events-replay': async () =>
      new Response(JSON.stringify({ events: [], gap: false, currentSeq: initialCurrentSeq }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
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
    'GET /pending': async () => {
      const pending = Array.from({ length: initialPending }, (_, i) => ({ event_id: `e${i}` }));
      return new Response(JSON.stringify({ pending }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    'POST /flush': async () =>
      new Response(JSON.stringify({ flushed: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
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

    // Match by the trailing path segment (`/delivery-mode`, `/pending`, `/flush`)
    // or the `/api/input/...` prefix.
    let key: string | null = null;
    if (/\/api\/spawned\/[^/]+\/delivery-mode$/.test(url)) {
      key = `${method} /delivery-mode`;
    } else if (/\/api\/spawned\/[^/]+\/pending$/.test(url)) {
      key = `${method} /pending`;
    } else if (/\/api\/spawned\/[^/]+\/flush$/.test(url)) {
      key = `${method} /flush`;
    } else if (/\/api\/input\/[^/]+$/.test(url)) {
      key = `${method} /input`;
    } else if (/\/api\/resize\/[^/]+$/.test(url)) {
      key = `${method} /resize`;
    } else if (/\/api\/events\/replay(\?|$)/.test(url)) {
      key = `${method} /events-replay`;
    }
    if (key && routes[key]) {
      return routes[key](init);
    }
    return new Response('not mocked', { status: 500 });
  }) as unknown as typeof globalThis.fetch;

  const deps: DriveDependencies = {
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
    }) as unknown as DriveDependencies['exit'],
    fetch: fetchFn,
    captureAndRenderSnapshot: vi.fn(async (_conn, _name, snapshotDeps) => {
      // The default behaviour writes nothing — most tests assert on the
      // status line + WS chunks, not on the snapshot.
      void snapshotDeps;
      return opts.snapshotResult ?? { status: 'ok' };
    }) as DriveDependencies['captureAndRenderSnapshot'],
    stdin,
    terminal,
    openInputStream: vi.fn((_connection, streamName) => {
      const stream = new FakeInputStream(streamName, opts.inputStreamOpenError, opts.inputStreamSendError);
      inputStreams.push(stream);
      return stream;
    }),
    createPredictiveEcho: opts.predictiveEcho ? () => opts.predictiveEcho ?? null : undefined,
    // Immediate, deterministic status repaints in tests (no coalescing timer).
    statusRepaintCoalesceMs: 0,
    // Disable the ownership re-assert timer by default so it can't perturb
    // resize-count assertions; individual tests opt in with a small value.
    ownershipReassertMs: opts.ownershipReassertMs ?? 0,
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

/** Helpers ----- */

async function openSocket(sockets: FakeWebSocket[]): Promise<FakeWebSocket> {
  // Allow the awaited mode-flip + pending + cutoff HTTP calls to settle
  // before the WS factory is invoked.
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

/** Tests ----- */

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

  it('classifies delivery_queued for the targeted agent, carrying its event id', () => {
    expect(
      classifyWsEvent(JSON.stringify({ kind: 'delivery_queued', name: 'Alice', event_id: 'e1' }), 'Alice')
    ).toEqual({ kind: 'delivery_queued', eventId: 'e1' });
  });

  it('classifies delivery_queued without an event id (legacy frame)', () => {
    expect(classifyWsEvent(JSON.stringify({ kind: 'delivery_queued', name: 'Alice' }), 'Alice')).toEqual({
      kind: 'delivery_queued',
      eventId: undefined,
    });
  });

  it('classifies agent_pending_drained with optional count', () => {
    expect(
      classifyWsEvent(JSON.stringify({ kind: 'agent_pending_drained', name: 'Alice', count: 3 }), 'Alice')
    ).toEqual({ kind: 'agent_pending_drained', count: 3 });
  });

  it('returns other for unrelated kinds', () => {
    expect(classifyWsEvent(JSON.stringify({ kind: 'agent_spawned', name: 'Alice' }), 'Alice')).toEqual({
      kind: 'other',
    });
  });

  it('returns other for non-JSON payloads', () => {
    expect(classifyWsEvent('not-json', 'Alice')).toEqual({ kind: 'other' });
  });
});

describe('KeybindParser', () => {
  it('forwards ordinary keystrokes unchanged', () => {
    const p = new KeybindParser();
    const out = p.feed(Buffer.from('hello'));
    expect(out.forward.toString()).toBe('hello');
    expect(out.actions).toEqual([]);
  });

  it('forwards Ctrl+G to the agent instead of flushing', () => {
    const p = new KeybindParser();
    const out = p.feed(Buffer.from([0x68, 0x07, 0x69])); // h, Ctrl+G, i
    expect(Array.from(out.forward)).toEqual([0x68, 0x07, 0x69]);
    expect(out.actions).toEqual([]);
  });

  it('intercepts Ctrl+C as detach', () => {
    const p = new KeybindParser();
    const out = p.feed(Buffer.from([0x03]));
    expect(out.forward.length).toBe(0);
    expect(out.actions).toEqual(['detach']);
  });

  it('forwards Ctrl+B sequences to the agent', () => {
    const p = new KeybindParser();
    const first = p.feed(Buffer.from([0x02]));
    expect(Array.from(first.forward)).toEqual([0x02]);
    expect(first.actions).toEqual([]);
    const second = p.feed(Buffer.from([0x44])); // 'D'
    expect(Array.from(second.forward)).toEqual([0x44]);
    expect(second.actions).toEqual([]);
  });

  it('stops forwarding the chunk after Ctrl+C detach', () => {
    const p = new KeybindParser();
    const out = p.feed(Buffer.from([0x61, 0x07, 0x62, 0x03, 0x02, 0x64]));
    expect(Array.from(out.forward)).toEqual([0x61, 0x07, 0x62]);
    expect(out.actions).toEqual(['detach']);
  });

  it('intercepts Ctrl+] as toggle-delivery without forwarding it', () => {
    const p = new KeybindParser();
    const out = p.feed(Buffer.from([0x61, 0x1d, 0x62])); // a, Ctrl+], b
    expect(Array.from(out.forward)).toEqual([0x61, 0x62]);
    expect(out.actions).toEqual(['toggle-delivery']);
  });

  it('keeps scanning for detach after a toggle-delivery byte', () => {
    const p = new KeybindParser();
    const out = p.feed(Buffer.from([0x1d, 0x61, 0x03, 0x62]));
    expect(Array.from(out.forward)).toEqual([0x61]);
    expect(out.actions).toEqual(['toggle-delivery', 'detach']);
  });
});

describe('renderStatusLine', () => {
  it('includes agent name, mode, pending count, and detach hint', () => {
    const out = renderStatusLine({ name: 'Alice', mode: 'manual_flush', pending: 3 });
    expect(out).toContain('drive Alice');
    expect(out).toContain('delivery=manual_flush');
    expect(out).toContain('pending=3');
    expect(out).toContain('Ctrl+C detach');
  });

  it('hints Ctrl+] deliver while holding and Ctrl+] hold while live', () => {
    const held = renderStatusLine({ name: 'Alice', mode: 'manual_flush', pending: 1 });
    expect(held).toContain('Ctrl+] deliver');
    const live = renderStatusLine({ name: 'Alice', mode: 'auto_inject', pending: 0 });
    expect(live).toContain('delivery=auto_inject');
    expect(live).toContain('Ctrl+] hold');
  });

  it('uses save/restore cursor + reverse video so the agent screen is preserved', () => {
    const out = renderStatusLine({ name: 'Alice', mode: 'manual_flush', pending: 0 });
    expect(out.startsWith('\x1b7')).toBe(true); // save cursor
    expect(out.endsWith('\x1b8')).toBe(true); // restore cursor
    expect(out).toContain('\x1b[7m'); // reverse video
    expect(out).toContain('\x1b[0m'); // reset
  });

  it('positions at the given row', () => {
    const out = renderStatusLine({
      name: 'A',
      mode: 'manual_flush',
      pending: 0,
      rows: 50,
    });
    expect(out).toContain('\x1b[50;1H');
  });
});

describe('runDriveSession', () => {
  it('flips to manual_flush delivery mode, renders snapshot, opens WS, then restores prior mode on detach', async () => {
    const { deps, sockets, fetchLog, stdin, logs } = createHarness({ initialMode: 'auto_inject' });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    const socket = await openSocket(sockets);
    expect(socket.url).toBe('ws://localhost:3889/ws');
    expect(socket.headers['X-API-Key']).toBe('k');
    expect(logs.some((args) => String(args[0]).includes('driving Alice via'))).toBe(false);

    // PUT /delivery-mode body should be { mode: 'manual_flush' }.
    const flipCall = fetchLog.find((c) => c.method === 'PUT' && c.url.endsWith('/delivery-mode'));
    expect(flipCall?.body).toEqual({ mode: 'manual_flush' });

    // Raw mode should be on after open.
    expect(stdin.rawModeCalls.includes(true)).toBe(true);

    // Detach via Ctrl+C.
    stdin.type(Buffer.from([0x03]));
    const code = await sessionPromise;
    expect(code).toBe(0);

    // Raw mode restored.
    expect(stdin.rawModeCalls).toEqual([true, false]);

    // Last PUT /delivery-mode call should restore to 'auto_inject' (the prior
    // mode) via a compare-and-set guarded by `expected_mode: manual_flush`.
    const modeCalls = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/delivery-mode'));
    expect(modeCalls).toHaveLength(2);
    expect(modeCalls[1].body).toEqual({
      mode: 'auto_inject',
      expected_mode: 'manual_flush',
      expected_revision: '1',
    });
  });

  it('takes stdin raw before replaying a TUI snapshot', async () => {
    const { deps, sockets, stdin } = createHarness();
    deps.captureAndRenderSnapshot = vi.fn(async () => {
      expect(stdin.isRaw).toBe(true);
      return { status: 'ok' };
    }) as DriveDependencies['captureAndRenderSnapshot'];

    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);
    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
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
    }) as DriveDependencies['captureAndRenderSnapshot'];

    const sessionPromise = runDriveSession('Alice', {}, deps);
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

    const sessionPromise = runDriveSession('Alice', {}, deps);
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

  it('preserves an already-raw stdin on detach', async () => {
    const { deps, sockets, stdin } = createHarness();
    stdin.isRaw = true;

    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);
    expect(stdin.rawModeCalls).toEqual([]);

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
    expect(stdin.rawModeCalls).toEqual([]);
  });

  it('aborts before opening the WS when the broker rejects the mode flip', async () => {
    const { deps, sockets, errors } = createHarness({
      modeFlipFailure: { status: 404, error: "no agent named 'Ghost'" },
    });
    const code = await runDriveSession('Ghost', {}, deps);
    expect(code).toBe(1);
    expect(sockets).toHaveLength(0);
    expect(errors.some((args) => String(args[0]).includes("no agent named 'Ghost'"))).toBe(true);
  });

  it('aborts and closes the WS when the snapshot is not_found', async () => {
    const { deps, sockets, errors, fetchLog } = createHarness({
      snapshotResult: { status: 'not_found', message: "no agent named 'Ghost'" },
    });
    const sessionPromise = runDriveSession('Ghost', {}, deps);
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
    // Best-effort restore PUT should still have fired.
    const modeCalls = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/delivery-mode'));
    expect(modeCalls.map((c) => c.body)).toEqual([
      { mode: 'manual_flush' },
      { mode: 'auto_inject', expected_mode: 'manual_flush', expected_revision: '1' },
    ]);
  });

  it('aborts and closes the WS when the worker has no PTY', async () => {
    const { deps, sockets, errors } = createHarness({
      snapshotResult: { status: 'no_pty', message: "agent 'Headless' has no PTY" },
    });
    const sessionPromise = runDriveSession('Headless', {}, deps);
    for (let i = 0; i < 10 && sockets.length === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(sockets).toHaveLength(1);
    sockets[0].emit('open');
    const code = await sessionPromise;
    expect(code).toBe(1);
    expect(sockets[0].closed).toBe(true);
    expect(errors[0]?.[0]).toMatch(/no PTY/);
  });

  it('continues with a warning when the snapshot is transiently unavailable', async () => {
    const { deps, sockets, logs } = createHarness({
      snapshotResult: { status: 'unavailable', message: 'HTTP 504' },
    });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    const socket = await openSocket(sockets);
    expect(logs.some((args) => String(args[0]).includes('could not capture initial screen'))).toBe(true);
    // Detach to let the test finish.
    socket.emit('close', 1000, Buffer.from(''));
    await sessionPromise;
  });

  it('increments pending on delivery_queued and resets on agent_pending_drained', async () => {
    const { deps, sockets, writes, stdin } = createHarness();
    const sessionPromise = runDriveSession('Alice', {}, deps);
    const socket = await openSocket(sockets);
    // Initial paint should have happened.
    const initialPaints = writes.filter((w) => w.includes('drive Alice')).length;
    expect(initialPaints).toBeGreaterThan(0);

    socket.emit('message', jsonMessage({ kind: 'delivery_queued', name: 'Alice', event_id: 'e1' }));
    socket.emit('message', jsonMessage({ kind: 'delivery_queued', name: 'Alice', event_id: 'e2' }));
    expect(writes.some((w) => w.includes('pending=1'))).toBe(true);
    expect(writes.some((w) => w.includes('pending=2'))).toBe(true);

    socket.emit('message', jsonMessage({ kind: 'agent_pending_drained', name: 'Alice', count: 2 }));
    // After the drained event we should see a pending=0 paint.
    expect(writes.filter((w) => w.includes('pending=0')).length).toBeGreaterThan(0);

    stdin.type(Buffer.from([0x03])); // Ctrl+C → detach
    await sessionPromise;
  });

  it('keeps the remainder counted when a drain event reports a partial count', async () => {
    const { deps, sockets, writes, stdin } = createHarness();
    const sessionPromise = runDriveSession('Alice', {}, deps);
    const socket = await openSocket(sockets);

    socket.emit('message', jsonMessage({ kind: 'delivery_queued', name: 'Alice', event_id: 'e1' }));
    socket.emit('message', jsonMessage({ kind: 'delivery_queued', name: 'Alice', event_id: 'e2' }));
    socket.emit('message', jsonMessage({ kind: 'delivery_queued', name: 'Alice', event_id: 'e3' }));
    expect(writes.some((w) => w.includes('pending=3'))).toBe(true);

    // A failed injection stops a flush mid-queue: only 2 of 3 drained.
    writes.length = 0;
    socket.emit('message', jsonMessage({ kind: 'agent_pending_drained', name: 'Alice', count: 2 }));
    expect(writes.some((w) => w.includes('pending=1'))).toBe(true);

    stdin.type(Buffer.from([0x03])); // Ctrl+C → detach
    await sessionPromise;
  });

  it('toggles delivery to auto_inject on Ctrl+], re-holds on a second press, and restores from the latest revision on detach', async () => {
    const { deps, sockets, writes, stdin, fetchLog, inputStreams } = createHarness({
      initialMode: 'auto_inject',
    });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    // First Ctrl+] — go live: CAS from this session's attach flip (rev 1).
    stdin.type(Buffer.from([0x1d]));
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    let modeCalls = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/delivery-mode'));
    expect(modeCalls).toHaveLength(2);
    expect(modeCalls[1].body).toEqual({
      mode: 'auto_inject',
      expected_mode: 'manual_flush',
      expected_revision: '1',
    });
    expect(writes.some((w) => w.includes('delivery=auto_inject') && w.includes('Ctrl+] hold'))).toBe(true);

    // Second Ctrl+] — back to hold: CAS from the toggled state (rev 2).
    stdin.type(Buffer.from([0x1d]));
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    modeCalls = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/delivery-mode'));
    expect(modeCalls).toHaveLength(3);
    expect(modeCalls[2].body).toEqual({
      mode: 'manual_flush',
      expected_mode: 'auto_inject',
      expected_revision: '2',
    });

    // The control byte itself must never reach the PTY.
    expect(inputStreams[0].writes.join('')).not.toContain('\x1d');

    // Detach: restore CASes against the session's LAST write (rev 3), not the
    // attach-time revision.
    stdin.type(Buffer.from([0x03]));
    const code = await sessionPromise;
    expect(code).toBe(0);
    modeCalls = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/delivery-mode'));
    expect(modeCalls).toHaveLength(4);
    expect(modeCalls[3].body).toEqual({
      mode: 'auto_inject',
      expected_mode: 'manual_flush',
      expected_revision: '3',
    });
  });

  it('adopts the broker-reported mode when the toggle compare-and-set mismatches', async () => {
    let putCalls = 0;
    const { deps, sockets, writes, stdin, fetchLog, logs } = createHarness({
      routes: {
        'PUT /delivery-mode': async () => {
          putCalls += 1;
          // Attach flip succeeds; the toggle loses the CAS race to an
          // out-of-band change and reports the current (unchanged) state.
          const body =
            putCalls === 1
              ? { mode: 'manual_flush', flushed: 0, matched: true, revision: '1' }
              : { mode: 'manual_flush', flushed: 0, matched: false, revision: '7' };
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      },
    });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    stdin.type(Buffer.from([0x1d]));
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(logs.some((args) => String(args[0]).includes('changed by another session'))).toBe(true);
    // Still holding — and the next toggle CASes from the adopted revision.
    expect(writes.some((w) => w.includes('delivery=manual_flush'))).toBe(true);
    stdin.type(Buffer.from([0x1d]));
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    const modeCalls = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/delivery-mode'));
    expect(modeCalls[2]?.body).toEqual({
      mode: 'auto_inject',
      expected_mode: 'manual_flush',
      expected_revision: '7',
    });

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
  });

  it('awaits an in-flight toggle before the detach restore so a quick Ctrl+] then Ctrl+C restores from the toggled state', async () => {
    const { deps, sockets, stdin, fetchLog } = createHarness({ initialMode: 'auto_inject' });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    // Toggle and detach back-to-back, with no event-loop turns in between —
    // the toggle PUT is still in flight when finish() runs.
    stdin.type(Buffer.from([0x1d]));
    stdin.type(Buffer.from([0x03]));
    const code = await sessionPromise;
    expect(code).toBe(0);

    const modeCalls = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/delivery-mode'));
    expect(modeCalls).toHaveLength(3);
    // The toggle landed (rev 1 → 2)…
    expect(modeCalls[1].body).toEqual({
      mode: 'auto_inject',
      expected_mode: 'manual_flush',
      expected_revision: '1',
    });
    // …and the restore CASed against the POST-toggle state, not the stale
    // attach-time revision.
    expect(modeCalls[2].body).toEqual({
      mode: 'auto_inject',
      expected_mode: 'auto_inject',
      expected_revision: '2',
    });
  });

  it('keeps the expectedMode guard when a legacy broker reports no revision', async () => {
    const { deps, sockets, stdin, fetchLog } = createHarness({
      routes: {
        // Legacy broker: applies the mode but never reports a revision.
        'PUT /delivery-mode': async (init) => {
          const body = init?.body ? (JSON.parse(String(init.body)) as { mode: string }) : { mode: '' };
          return new Response(JSON.stringify({ mode: body.mode, flushed: 0, matched: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      },
    });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    stdin.type(Buffer.from([0x1d]));
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    const modeCalls = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/delivery-mode'));
    // The toggle is still mode-guarded — never an unconditional write.
    expect(modeCalls[1]?.body).toEqual({
      mode: 'auto_inject',
      expected_mode: 'manual_flush',
    });

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
  });

  it('connects the event WS with the durable-event sinceSeq cutoff', async () => {
    // The cutoff stops the broker replaying historical durable events (old
    // delivery_queued frames) that would otherwise inflate the pending
    // counter seeded from GET /pending.
    const { deps, sockets, writes, stdin } = createHarness({
      initialCurrentSeq: 20,
      initialPending: 2,
    });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    const socket = await openSocket(sockets);
    expect(socket.url).toBe('ws://localhost:3889/ws?sinceSeq=20');
    // Pending is seeded from the live queue (2), not inflated by lifetime
    // delivery_queued events — those are suppressed by the broker via sinceSeq.
    expect(writes.some((w) => w.includes('pending=2'))).toBe(true);
    expect(writes.some((w) => w.includes('pending=22'))).toBe(false);

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
  });

  it('dedupes replayed delivery_queued frames against the pending seed', async () => {
    // The seed (GET /pending) reports 2 messages with ids e0/e1. A frame
    // replayed for one of them (it raced the cutoff/seed capture and has
    // seq > cutoff) must not re-increment the counter; a frame for a new
    // delivery must.
    const { deps, sockets, writes, stdin } = createHarness({
      initialCurrentSeq: 20,
      initialPending: 2,
    });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    const socket = await openSocket(sockets);
    expect(writes.some((w) => w.includes('pending=2'))).toBe(true);

    // Replayed frame for a seeded delivery — deduped, stays at 2.
    socket.emit('message', jsonMessage({ kind: 'delivery_queued', name: 'Alice', event_id: 'e0' }));
    expect(writes.some((w) => w.includes('pending=3'))).toBe(false);

    // A genuinely new delivery — counted, goes to 3.
    socket.emit('message', jsonMessage({ kind: 'delivery_queued', name: 'Alice', event_id: 'brand-new' }));
    expect(writes.some((w) => w.includes('pending=3'))).toBe(true);

    // The same seeded id re-queued *later* (after being consumed once from the
    // seed) counts normally — the id was forgotten after its first dedupe.
    socket.emit('message', jsonMessage({ kind: 'delivery_queued', name: 'Alice', event_id: 'e0' }));
    expect(writes.some((w) => w.includes('pending=4'))).toBe(true);

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
  });

  it('reconciles buffered worker_stream against the snapshot offset', async () => {
    // Snapshot reports offset=10 (default mock writes nothing but reports the
    // offset). Chunks buffered before the snapshot with end offset <= 10 are
    // already on screen and dropped; later ones are applied.
    const { deps, sockets, writes, stdin } = createHarness({
      snapshotResult: { status: 'ok', offset: 10 },
    });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    // Grab the socket, emit buffered chunks *before* the open handler's async
    // snapshot resolves, then let it settle.
    for (let i = 0; i < 10 && sockets.length === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const socket = sockets[0];
    socket.emit('open');
    socket.emit(
      'message',
      jsonMessage({ kind: 'worker_stream', name: 'Alice', chunk: 'inSnap', offset: 10 })
    );
    socket.emit(
      'message',
      jsonMessage({ kind: 'worker_stream', name: 'Alice', chunk: 'afterSnap', offset: 18 })
    );
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));

    expect(writes.includes('afterSnap')).toBe(true);
    expect(writes.includes('inSnap')).toBe(false);

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
  });

  it('writes worker_stream chunks to stdout and repaints the status line', async () => {
    const { deps, sockets, writes, stdin } = createHarness();
    const sessionPromise = runDriveSession('Alice', {}, deps);
    const socket = await openSocket(sockets);
    socket.emit('message', jsonMessage({ kind: 'worker_stream', name: 'Alice', chunk: 'live output' }));
    expect(writes.includes('live output')).toBe(true);
    // Some paint should follow the worker chunk.
    const liveIdx = writes.indexOf('live output');
    const repaintAfter = writes.slice(liveIdx + 1).some((w) => w.includes('drive Alice'));
    expect(repaintAfter).toBe(true);

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
  });

  it('forwards stdin keystrokes through the SDK PTY input stream', async () => {
    const { deps, sockets, stdin, fetchLog, inputStreams } = createHarness();
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    stdin.type(Buffer.from('hello'));
    // Let the fire-and-forget stream write settle.
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
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    const code = await sessionPromise;
    expect(code).toBe(1);
    expect(stdin.rawModeCalls).toEqual([]);
    expect(errors.some((args) => String(args[0]).includes('could not open PTY input stream'))).toBe(true);
  });

  it('forwards Ctrl+G through the PTY input stream instead of flushing', async () => {
    const { deps, sockets, stdin, fetchLog, inputStreams } = createHarness();
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    stdin.type(Buffer.from([0x07])); // Ctrl+G
    await new Promise((resolve) => setImmediate(resolve));
    expect(inputStreams[0].writes).toEqual(['\x07']);
    const flush = fetchLog.find((c) => c.method === 'POST' && c.url.endsWith('/flush'));
    expect(flush).toBeUndefined();

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
  });

  it('restores the prior mode even on abnormal WebSocket close', async () => {
    const { deps, sockets, fetchLog, errors } = createHarness({ initialMode: 'auto_inject' });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    const socket = await openSocket(sockets);

    socket.emit('close', 1006, Buffer.from('abnormal'));
    const code = await sessionPromise;
    expect(code).toBe(1);
    expect(errors.some((args) => String(args[0]).includes('connection closed'))).toBe(true);

    const modeCalls = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/delivery-mode'));
    expect(modeCalls.map((c) => c.body)).toEqual([
      { mode: 'manual_flush' },
      { mode: 'auto_inject', expected_mode: 'manual_flush', expected_revision: '1' },
    ]);
  });

  it('treats WebSocket errors as fatal and restores delivery mode', async () => {
    const { deps, sockets, fetchLog, errors } = createHarness({ initialMode: 'auto_inject' });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    const socket = await openSocket(sockets);

    socket.emit('error', new Error('boom'));
    const code = await sessionPromise;
    expect(code).toBe(1);
    expect(errors.some((args) => String(args[0]).includes('WebSocket error: boom'))).toBe(true);

    const modeCalls = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/delivery-mode'));
    expect(modeCalls.map((c) => c.body)).toEqual([
      { mode: 'manual_flush' },
      { mode: 'auto_inject', expected_mode: 'manual_flush', expected_revision: '1' },
    ]);
  });

  it('proceeds when the worker is already in manual_flush mode (re-attach scenario)', async () => {
    const { deps, sockets, stdin, fetchLog } = createHarness({ initialMode: 'manual_flush' });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;

    const modeCalls = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/delivery-mode'));
    // Restore to 'manual_flush' since that was the prior mode, via a
    // compare-and-set guarded by `expected_mode: manual_flush`.
    expect(modeCalls.map((c) => c.body)).toEqual([
      { mode: 'manual_flush' },
      { mode: 'manual_flush', expected_mode: 'manual_flush', expected_revision: '1' },
    ]);
  });

  it('exits cleanly on SIGINT', async () => {
    const { deps, sockets, signals, stdin } = createHarness();
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    const sigint = signals.get('SIGINT');
    expect(sigint).toBeDefined();
    await sigint?.();

    const code = await sessionPromise;
    expect(code).toBe(0);
    // Raw mode must be restored.
    expect(stdin.rawModeCalls).toEqual([true, false]);
  });

  it('returns 1 when no broker connection can be resolved', async () => {
    const { deps, errors } = createHarness();
    deps.readConnectionFile = vi.fn(() => null);
    const code = await runDriveSession('Alice', {}, deps);
    expect(code).toBe(1);
    expect(errors[0]?.[0]).toMatch(/could not locate broker connection/);
  });

  // ---- API-key header propagation ----

  it('sends X-API-Key on every broker request when configured', async () => {
    const { deps, sockets, signals, fetchLog } = createHarness();
    const sessionPromise = runDriveSession('Alice', {}, deps);
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
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);
    await signals.get('SIGINT')?.();
    await sessionPromise;

    expect(fetchLog.length).toBeGreaterThan(0);
    for (const call of fetchLog) {
      expect(call.headers).not.toHaveProperty('X-API-Key');
    }
  });

  // ---- resize forwarding (table-stakes for a take-over UX) ----

  it('forwards the local terminal size to the broker on attach', async () => {
    const { deps, sockets, signals, fetchLog } = createHarness({
      terminalSize: { rows: 60, cols: 200 },
    });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    const resizeCalls = fetchLog.filter((call) => call.method === 'POST' && call.url.includes('/resize/'));
    expect(resizeCalls).toHaveLength(1);
    const body = resizeCalls[0].body as { rows: number; cols: number; session_id?: string };
    expect({ rows: body.rows, cols: body.cols }).toEqual({ rows: 60, cols: 200 });
    // The on-attach sync carries a session id for the single-resizer policy.
    expect(body.session_id).toEqual(expect.any(String));

    await signals.get('SIGINT')?.();
    await sessionPromise;
  });

  it('forwards subsequent SIGWINCH resize events to the broker', async () => {
    const { deps, sockets, signals, terminal, fetchLog } = createHarness({
      terminalSize: { rows: 30, cols: 100 },
    });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    // Simulate the user dragging their terminal larger, then smaller.
    terminal.setSize({ rows: 50, cols: 150 });
    await new Promise((resolve) => setImmediate(resolve));
    terminal.setSize({ rows: 24, cols: 80 });
    await new Promise((resolve) => setImmediate(resolve));

    const resizeBodies = fetchLog
      .filter((call) => call.method === 'POST' && call.url.includes('/resize/'))
      .map((call) => call.body as { rows: number; cols: number; session_id?: string });
    // First the on-attach sync, then each user-driven resize. Every resize
    // carries the same per-attach session id (single-resizer policy, #1247).
    expect(resizeBodies.map(({ rows, cols }) => ({ rows, cols }))).toEqual([
      { rows: 30, cols: 100 },
      { rows: 50, cols: 150 },
      { rows: 24, cols: 80 },
    ]);
    const sessionIds = new Set(resizeBodies.map((b) => b.session_id));
    expect(sessionIds.size).toBe(1);
    expect([...sessionIds][0]).toEqual(expect.any(String));

    await signals.get('SIGINT')?.();
    await sessionPromise;
  });

  it('unsubscribes the resize listener on detach', async () => {
    const { deps, sockets, signals, terminal } = createHarness();
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    expect(terminal.listenerCount()).toBe(1);
    await signals.get('SIGINT')?.();
    await sessionPromise;
    expect(terminal.listenerCount()).toBe(0);
  });

  it('releases resize ownership on detach with the attach session id', async () => {
    const { deps, sockets, signals, fetchLog } = createHarness({
      terminalSize: { rows: 30, cols: 100 },
    });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    // Capture the session id claimed by the on-attach resize sync.
    const attachResize = fetchLog.find((call) => call.method === 'POST' && call.url.includes('/resize/'));
    const sessionId = (attachResize?.body as { session_id?: string } | undefined)?.session_id;
    expect(sessionId).toEqual(expect.any(String));

    await signals.get('SIGINT')?.();
    await sessionPromise;

    // Detach must send a release for the same session id.
    const releaseCall = fetchLog.find(
      (call) =>
        call.method === 'POST' &&
        call.url.includes('/resize/') &&
        (call.body as { release?: boolean }).release === true
    );
    expect(releaseCall).toBeDefined();
    expect((releaseCall?.body as { session_id?: string }).session_id).toBe(sessionId);
    // A pure release carries no placeholder dimensions (#1247).
    const releaseBody = releaseCall?.body as { rows?: number; cols?: number };
    expect(releaseBody.rows).toBeUndefined();
    expect(releaseBody.cols).toBeUndefined();
  });

  it('periodically re-asserts resize ownership on the same session id', async () => {
    const { deps, sockets, signals, fetchLog } = createHarness({
      terminalSize: { rows: 30, cols: 100 },
      ownershipReassertMs: 5,
    });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    // Let a couple of re-assert ticks fire without any local resize.
    await new Promise((resolve) => setTimeout(resolve, 40));

    const activeResizes = fetchLog.filter(
      (call) =>
        call.method === 'POST' &&
        call.url.includes('/resize/') &&
        (call.body as { release?: boolean }).release !== true
    );
    // The on-attach sync plus at least one keep-alive re-assert.
    expect(activeResizes.length).toBeGreaterThanOrEqual(2);
    // Every resize (initial + re-asserts) carries the same owning session id.
    const sessionIds = new Set(
      activeResizes.map((call) => (call.body as { session_id?: string }).session_id)
    );
    expect(sessionIds.size).toBe(1);
    // Re-asserts re-send the unchanged current size.
    for (const call of activeResizes) {
      expect(call.body as { rows: number; cols: number }).toMatchObject({ rows: 30, cols: 100 });
    }

    await signals.get('SIGINT')?.();
    await sessionPromise;
  });

  it('logs a rejected periodic resize ownership re-assert', async () => {
    let resizeCount = 0;
    const { deps, sockets, signals, logs } = createHarness({
      terminalSize: { rows: 30, cols: 100 },
      ownershipReassertMs: 5,
      routes: {
        'POST /resize': async () => {
          resizeCount += 1;
          if (resizeCount === 1) {
            return new Response(JSON.stringify({ applied: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response('lease rejected', { status: 409 });
        },
      },
    });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(logs.some((args) => String(args[0]).includes('resize ownership re-assert failed'))).toBe(true);

    await signals.get('SIGINT')?.();
    await sessionPromise;
  });

  it('skips resize forwarding when stdout is not a TTY', async () => {
    const { deps, sockets, signals, fetchLog } = createHarness({ terminalSize: null });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    const resizeCalls = fetchLog.filter((call) => call.method === 'POST' && call.url.includes('/resize/'));
    expect(resizeCalls).toHaveLength(0);

    await signals.get('SIGINT')?.();
    await sessionPromise;
  });

  it('logs but continues when the initial resize sync fails', async () => {
    const { deps, sockets, signals, logs } = createHarness({
      terminalSize: { rows: 30, cols: 100 },
      routes: {
        'POST /resize': async () =>
          new Response('boom', { status: 500, headers: { 'Content-Type': 'text/plain' } }),
      },
    });

    const sessionPromise = runDriveSession('Alice', {}, deps);
    // Should still open the WS even though resize failed — UX-annoying
    // not fatal; the human can still type into an unsync'd-size agent.
    const socket = await openSocket(sockets);

    expect(logs.some((args) => String(args[0]).includes('could not sync agent PTY size'))).toBe(true);
    expect(socket).toBeDefined();

    await signals.get('SIGINT')?.();
    await sessionPromise;
  });

  // ---- signal safety during setup (item 1) ----

  it('restores the delivery mode and exits if interrupted before the session loop starts', async () => {
    // /pending never resolves, so the run is parked in the setup window (mode
    // already flipped to manual_flush, terminal still cooked, session loop not
    // yet reached). A SIGINT here must restore the prior mode and exit rather
    // than strand the worker in manual_flush.
    const { deps, sockets, signals, fetchLog } = createHarness({
      initialMode: 'auto_inject',
      routes: {
        'GET /pending': () => new Promise<Response>(() => undefined),
      },
    });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    void sessionPromise; // parked on the hung /pending; never resolves
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));

    // The session loop has not opened the WS yet.
    expect(sockets).toHaveLength(0);
    const sigint = signals.get('SIGINT');
    expect(sigint).toBeDefined();
    await expect(sigint?.()).rejects.toBeInstanceOf(ExitSignal);

    const modeCalls = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/delivery-mode'));
    expect(modeCalls.map((c) => c.body)).toEqual([
      { mode: 'manual_flush' },
      { mode: 'auto_inject', expected_mode: 'manual_flush', expected_revision: '1' },
    ]);
  });

  // ---- multi-byte UTF-8 stdin (item 2) ----

  it('forwards a multi-byte character split across stdin chunks intact', async () => {
    const { deps, sockets, stdin, inputStreams } = createHarness();
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    // 'é' = 0xC3 0xA9, arriving as two separate stdin data events (routine in
    // large pastes / IME). Naive per-chunk decoding would send U+FFFD twice.
    stdin.type(Buffer.from([0xc3]));
    await new Promise((resolve) => setImmediate(resolve));
    stdin.type(Buffer.from([0xa9]));
    await new Promise((resolve) => setImmediate(resolve));

    expect(inputStreams[0].writes).toEqual(['é']);

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
  });

  // ---- no output after teardown begins (item 3) ----

  it('stops writing output once teardown has begun', async () => {
    const { deps, sockets, writes, stdin } = createHarness();
    const sessionPromise = runDriveSession('Alice', {}, deps);
    const socket = await openSocket(sockets);

    stdin.type(Buffer.from([0x03])); // detach → settled
    await sessionPromise;

    const before = writes.length;
    socket.emit('message', jsonMessage({ kind: 'worker_stream', name: 'Alice', chunk: 'POST-DETACH' }));
    expect(writes.includes('POST-DETACH')).toBe(false);
    expect(writes.length).toBe(before);
  });

  // ---- terminal reset on detach (item #1247) ----

  it('emits a conservative terminal reset on detach when stdout is a TTY', async () => {
    const { deps, sockets, writes, stdin } = createHarness();
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    stdin.type(Buffer.from([0x03])); // Ctrl+C → detach
    await sessionPromise;

    // The replayed snapshot + live stream may have left the local terminal in
    // alt-screen / mouse / bracketed-paste mode; detach must heal it.
    const reset = writes.find((w) => w.includes('\x1b[?1049l'));
    expect(reset).toBeDefined();
    expect(reset).toContain('\x1b[?25h'); // show cursor
    expect(reset).toContain('\x1b[?1000l'); // mouse reporting off
    expect(reset).toContain('\x1b[?2004l'); // bracketed paste off
  });

  it('does not emit a terminal reset on detach when stdout is not a TTY', async () => {
    const { deps, sockets, writes, signals } = createHarness({ terminalSize: null });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    await signals.get('SIGINT')?.();
    await sessionPromise;

    expect(writes.some((w) => w.includes('\x1b[?1049l'))).toBe(false);
  });

  // ---- status line boundary-hold (item 4) ----

  it('holds the status repaint while a worker chunk ends mid escape sequence', async () => {
    const { deps, sockets, writes, stdin } = createHarness();
    const sessionPromise = runDriveSession('Alice', {}, deps);
    const socket = await openSocket(sockets);

    const paintsBefore = writes.filter((w) => w.includes('drive Alice')).length;
    // Chunk ends mid-CSI (ESC [) — repainting the status here would splice
    // reverse-video controls into the agent's half-sent sequence.
    socket.emit('message', jsonMessage({ kind: 'worker_stream', name: 'Alice', chunk: 'data\x1b[' }));
    expect(writes.filter((w) => w.includes('drive Alice')).length).toBe(paintsBefore);
    // Completing the CSI lands at a boundary → the deferred repaint fires.
    socket.emit('message', jsonMessage({ kind: 'worker_stream', name: 'Alice', chunk: '2J' }));
    expect(writes.filter((w) => w.includes('drive Alice')).length).toBeGreaterThan(paintsBefore);

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
  });

  // ---- non-TTY skips the status line (item 5) ----

  it('skips status-line painting when stdout is not a TTY', async () => {
    const { deps, sockets, writes, signals } = createHarness({ terminalSize: null });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    const socket = await openSocket(sockets);

    socket.emit('message', jsonMessage({ kind: 'worker_stream', name: 'Alice', chunk: 'plain' }));
    expect(writes.includes('plain')).toBe(true);
    expect(writes.some((w) => w.includes('drive Alice'))).toBe(false);

    await signals.get('SIGINT')?.();
    await sessionPromise;
  });

  // ---- detach does not clobber another session's mode change (item 6) ----

  it('restores via compare-and-set so a concurrent mode change is not clobbered on detach', async () => {
    // Session flips to manual_flush (prev auto_inject). Another session changes
    // the mode before detach, so the broker's compare-and-set (guarded by
    // `expected_mode: manual_flush`) misses and the restore is a broker-side
    // no-op — the concurrent change is preserved. The client no longer does a
    // read-then-set (which had a TOCTOU); it always sends the guarded PUT.
    const { deps, sockets, stdin, fetchLog } = createHarness({
      initialMode: 'auto_inject',
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
              JSON.stringify({ mode: 'auto_inject', flushed: 0, matched: false, revision: '2' }),
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
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    stdin.type(Buffer.from([0x03])); // detach → compare-and-set restore
    await sessionPromise;

    const putCalls = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/delivery-mode'));
    // Attach flip (unconditional), then a compare-and-set restore guarded by
    // `expected_mode`. The restore no-ops broker-side rather than clobbering.
    expect(putCalls.map((c) => c.body)).toEqual([
      { mode: 'manual_flush' },
      { mode: 'auto_inject', expected_mode: 'manual_flush', expected_revision: '1' },
    ]);
  });
});
