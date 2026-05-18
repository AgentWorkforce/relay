import { Buffer } from 'node:buffer';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  KeybindParser,
  classifyWsEvent,
  registerDriveCommands,
  renderStatusLine,
  runDriveSession,
  type DriveDependencies,
  type DriveStdin,
  type DriveTerminal,
  type DriveWebSocket,
} from './drive.js';

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

/** Routed fetch — keyed on `${method} ${pathSuffix}`. */
type FetchRoute = (init?: RequestInit) => Promise<Response>;

interface FetchScript {
  /** Map of route key → handler. Default behaviour returns 200 + sensible body. */
  routes?: Record<string, FetchRoute>;
  /** Default mode reported by `GET …/mode`. */
  initialMode?: 'human' | 'relay';
  /** Default pending count reported by `GET …/pending`. */
  initialPending?: number;
  /** Make `PUT …/mode` to `human` fail with this status / body. */
  modeFlipFailure?: { status: number; error?: string };
  /** Make `captureAndRenderSnapshot` return this status. */
  snapshotResult?: Awaited<ReturnType<DriveDependencies['captureAndRenderSnapshot']>>;
  /** Initial local terminal size. Defaults to `{ rows: 30, cols: 100 }`;
   *  pass `null` to simulate "not a TTY" so the resize-forwarding path
   *  short-circuits. */
  terminalSize?: { rows: number; cols: number } | null;
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

  const initialMode = opts.initialMode ?? 'relay';
  const initialPending = opts.initialPending ?? 0;

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
    fetchLog.push({ url, method, body: bodyJson });

    // Match by the trailing path segment (`/mode`, `/pending`, `/flush`)
    // or the `/api/input/...` prefix.
    let key: string | null = null;
    if (/\/api\/spawned\/[^/]+\/mode$/.test(url)) {
      key = `${method} /mode`;
    } else if (/\/api\/spawned\/[^/]+\/pending$/.test(url)) {
      key = `${method} /pending`;
    } else if (/\/api\/spawned\/[^/]+\/flush$/.test(url)) {
      key = `${method} /flush`;
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

  const deps: DriveDependencies = {
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
  };

  return { deps, stdin, terminal, sockets, writes, errors, logs, signals, fetchLog };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Helpers ----- */

async function openSocket(sockets: FakeWebSocket[]): Promise<FakeWebSocket> {
  // Allow the awaited mode-flip + snapshot HTTP calls to settle before
  // the WS factory is invoked.
  for (let i = 0; i < 10 && sockets.length === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(sockets).toHaveLength(1);
  const socket = sockets[0];
  socket.emit('open');
  // Let the stdin-takeover microtasks run.
  await new Promise((resolve) => setImmediate(resolve));
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

  it('classifies delivery_queued for the targeted agent', () => {
    expect(
      classifyWsEvent(JSON.stringify({ kind: 'delivery_queued', name: 'Alice', event_id: 'e1' }), 'Alice')
    ).toEqual({ kind: 'delivery_queued' });
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

  it('intercepts Ctrl+G as flush', () => {
    const p = new KeybindParser();
    const out = p.feed(Buffer.from([0x68, 0x07, 0x69])); // h, Ctrl+G, i
    expect(out.forward.toString()).toBe('hi');
    expect(out.actions).toEqual(['flush']);
  });

  it('intercepts Ctrl+C as detach', () => {
    const p = new KeybindParser();
    const out = p.feed(Buffer.from([0x03]));
    expect(out.forward.length).toBe(0);
    expect(out.actions).toEqual(['detach']);
  });

  it('recognises Ctrl+B D (capital) as detach across chunks', () => {
    const p = new KeybindParser();
    const first = p.feed(Buffer.from([0x02]));
    expect(first.forward.length).toBe(0);
    expect(first.actions).toEqual([]);
    const second = p.feed(Buffer.from([0x44])); // 'D'
    expect(second.forward.length).toBe(0);
    expect(second.actions).toEqual(['detach']);
  });

  it('recognises Ctrl+B d (lowercase) and Ctrl+B Ctrl+D as detach', () => {
    const p1 = new KeybindParser();
    expect(p1.feed(Buffer.from([0x02, 0x64])).actions).toEqual(['detach']);
    const p2 = new KeybindParser();
    expect(p2.feed(Buffer.from([0x02, 0x04])).actions).toEqual(['detach']);
  });

  it('recognises Ctrl+B ? as toggle_help', () => {
    const p = new KeybindParser();
    expect(p.feed(Buffer.from([0x02, 0x3f])).actions).toEqual(['toggle_help']);
  });

  it('forwards Ctrl+B + unknown byte verbatim so the agent is not deprived', () => {
    const p = new KeybindParser();
    const out = p.feed(Buffer.from([0x02, 0x78])); // Ctrl+B, 'x'
    expect(Array.from(out.forward)).toEqual([0x02, 0x78]);
    expect(out.actions).toEqual([]);
  });

  it('handles multiple keybinds in one chunk in order', () => {
    const p = new KeybindParser();
    const out = p.feed(Buffer.from([0x61, 0x07, 0x62, 0x02, 0x64])); // 'a', Ctrl+G, 'b', Ctrl+B, 'd'
    expect(out.forward.toString()).toBe('ab');
    expect(out.actions).toEqual(['flush', 'detach']);
  });
});

describe('renderStatusLine', () => {
  it('includes agent name, mode, pending count, and detach hint', () => {
    const out = renderStatusLine({ agentName: 'Alice', mode: 'human', pending: 3, showHelp: false });
    expect(out).toContain('drive Alice');
    expect(out).toContain('mode=human');
    expect(out).toContain('pending=3');
    expect(out).toContain('Ctrl+B D detach');
  });

  it('uses save/restore cursor + reverse video so the agent screen is preserved', () => {
    const out = renderStatusLine({ agentName: 'Alice', mode: 'human', pending: 0, showHelp: false });
    expect(out.startsWith('\x1b7')).toBe(true); // save cursor
    expect(out.endsWith('\x1b8')).toBe(true); // restore cursor
    expect(out).toContain('\x1b[7m'); // reverse video
    expect(out).toContain('\x1b[0m'); // reset
  });

  it('positions at the given row', () => {
    const out = renderStatusLine({
      agentName: 'A',
      mode: 'human',
      pending: 0,
      showHelp: false,
      rows: 50,
    });
    expect(out).toContain('\x1b[50;1H');
  });

  it('shows extra hint when help is toggled on', () => {
    const out = renderStatusLine({ agentName: 'A', mode: 'human', pending: 0, showHelp: true });
    expect(out).toContain('hide help');
  });
});

describe('runDriveSession', () => {
  it('flips to human mode, renders snapshot, opens WS, then restores prior mode on detach', async () => {
    const { deps, sockets, fetchLog, stdin } = createHarness({ initialMode: 'relay' });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    const socket = await openSocket(sockets);
    expect(socket.url).toBe('ws://localhost:3889/ws');
    expect(socket.headers['X-API-Key']).toBe('k');

    // PUT /mode body should be { mode: 'human' }.
    const flipCall = fetchLog.find((c) => c.method === 'PUT' && c.url.endsWith('/mode'));
    expect(flipCall?.body).toEqual({ mode: 'human' });

    // Raw mode should be on after open.
    expect(stdin.rawModeCalls.includes(true)).toBe(true);

    // Detach via Ctrl+B D.
    stdin.type(Buffer.from([0x02, 0x44]));
    const code = await sessionPromise;
    expect(code).toBe(0);

    // Raw mode restored.
    expect(stdin.rawModeCalls).toEqual([true, false]);

    // Last PUT /mode call should restore to 'relay' (the prior mode).
    const modeCalls = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/mode'));
    expect(modeCalls).toHaveLength(2);
    expect(modeCalls[1].body).toEqual({ mode: 'relay' });
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

  it('aborts before opening the WS when the snapshot is not_found', async () => {
    const { deps, sockets, errors, fetchLog } = createHarness({
      snapshotResult: { status: 'not_found', message: "no agent named 'Ghost'" },
    });
    const code = await runDriveSession('Ghost', {}, deps);
    expect(code).toBe(1);
    expect(sockets).toHaveLength(0);
    expect(errors[0]?.[0]).toMatch(/no agent named/);
    // Best-effort restore PUT should still have fired.
    const modeCalls = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/mode'));
    expect(modeCalls.map((c) => c.body)).toEqual([{ mode: 'human' }, { mode: 'relay' }]);
  });

  it('aborts before opening the WS when the worker has no PTY', async () => {
    const { deps, sockets, errors } = createHarness({
      snapshotResult: { status: 'no_pty', message: "agent 'Headless' has no PTY" },
    });
    const code = await runDriveSession('Headless', {}, deps);
    expect(code).toBe(1);
    expect(sockets).toHaveLength(0);
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

  it('forwards stdin keystrokes via POST /api/input/{name}', async () => {
    const { deps, sockets, stdin, fetchLog } = createHarness();
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    stdin.type(Buffer.from('hello'));
    // Let the fire-and-forget POST settle.
    await new Promise((resolve) => setImmediate(resolve));
    const input = fetchLog.find((c) => c.method === 'POST' && c.url.includes('/api/input/'));
    expect(input?.body).toEqual({ data: 'hello' });

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
  });

  it('Ctrl+G triggers POST /api/spawned/{name}/flush', async () => {
    const { deps, sockets, stdin, fetchLog } = createHarness();
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    stdin.type(Buffer.from([0x07])); // Ctrl+G
    await new Promise((resolve) => setImmediate(resolve));
    const flush = fetchLog.find((c) => c.method === 'POST' && c.url.endsWith('/flush'));
    expect(flush).toBeDefined();

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;
  });

  it('restores the prior mode even on abnormal WebSocket close', async () => {
    const { deps, sockets, fetchLog, errors } = createHarness({ initialMode: 'relay' });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    const socket = await openSocket(sockets);

    socket.emit('close', 1006, Buffer.from('abnormal'));
    const code = await sessionPromise;
    expect(code).toBe(1);
    expect(errors.some((args) => String(args[0]).includes('connection closed'))).toBe(true);

    const modeCalls = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/mode'));
    expect(modeCalls.map((c) => c.body)).toEqual([{ mode: 'human' }, { mode: 'relay' }]);
  });

  it('proceeds when the worker is already in human mode (re-attach scenario)', async () => {
    const { deps, sockets, stdin, fetchLog } = createHarness({ initialMode: 'human' });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    stdin.type(Buffer.from([0x03]));
    await sessionPromise;

    const modeCalls = fetchLog.filter((c) => c.method === 'PUT' && c.url.endsWith('/mode'));
    // Restore to 'human' since that was the prior mode.
    expect(modeCalls.map((c) => c.body)).toEqual([{ mode: 'human' }, { mode: 'human' }]);
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

  // ---- resize forwarding (table-stakes for a take-over UX) ----

  it('forwards the local terminal size to the broker on attach', async () => {
    const { deps, sockets, signals, fetchLog } = createHarness({
      terminalSize: { rows: 60, cols: 200 },
    });
    const sessionPromise = runDriveSession('Alice', {}, deps);
    await openSocket(sockets);

    const resizeCalls = fetchLog.filter((call) => call.method === 'POST' && call.url.includes('/resize/'));
    expect(resizeCalls).toHaveLength(1);
    expect(resizeCalls[0].body).toEqual({ rows: 60, cols: 200 });

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
      .map((call) => call.body);
    // First the on-attach sync, then each user-driven resize.
    expect(resizeBodies).toEqual([
      { rows: 30, cols: 100 },
      { rows: 50, cols: 150 },
      { rows: 24, cols: 80 },
    ]);

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
});

describe('registerDriveCommands', () => {
  it('registers a `drive` command on the program', () => {
    const { deps } = createHarness();
    const program = new Command();
    program.exitOverride();
    registerDriveCommands(program, deps);
    const cmd = program.commands.find((c) => c.name() === 'drive');
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toMatch(/interactive control/i);
  });

  it('wires --broker-url, --api-key, and --state-dir options', () => {
    const { deps } = createHarness();
    const program = new Command();
    program.exitOverride();
    registerDriveCommands(program, deps);
    const cmd = program.commands.find((c) => c.name() === 'drive');
    const flags = cmd?.options.map((opt) => opt.long).filter(Boolean);
    expect(flags).toEqual(expect.arrayContaining(['--broker-url', '--api-key', '--state-dir']));
  });
});
