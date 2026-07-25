import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  extractMatchingChunk,
  InputReportModeFilter,
  resolveViewBrokerConnection,
  runViewSession,
  toWsUrl,
  type ViewDependencies,
  type ViewWebSocket,
} from './attach-view.js';

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
  terminated = false;
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

  terminate(): void {
    this.terminated = true;
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
  /** Simulate an interactive (TTY) stdout so the on-detach reset fires. */
  stdoutIsTty?: boolean;
}

class FakeStdin {
  isTTY = true;
  isRaw = false;
  readonly listeners = new Map<string, Array<(chunk: Buffer) => void>>();
  readonly setRawMode = vi.fn((mode: boolean) => {
    this.isRaw = mode;
  });
  readonly resume = vi.fn();
  readonly pause = vi.fn();

  on(event: 'data', listener: (chunk: Buffer) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: 'data', listener: (chunk: Buffer) => void): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener)
    );
    return this;
  }

  emitData(chunk: Buffer): void {
    for (const listener of this.listeners.get('data') ?? []) listener(chunk);
  }
}

function createHarness(overrides: HarnessOverrides = {}): {
  deps: ViewDependencies;
  writes: string[];
  errors: unknown[][];
  logs: unknown[][];
  signals: Map<NodeJS.Signals, () => void | Promise<void>>;
  sockets: FakeWebSocket[];
  stdin: FakeStdin;
} {
  const writes: string[] = [];
  const errors: unknown[][] = [];
  const logs: unknown[][] = [];
  const signals = new Map<NodeJS.Signals, () => void | Promise<void>>();
  const sockets: FakeWebSocket[] = [];
  const stdin = new FakeStdin();

  const deps: ViewDependencies = {
    readConnectionFile: vi.fn(() => overrides.connectionFile ?? null),
    getDefaultStateDir: vi.fn(() => overrides.defaultStateDir ?? '/tmp/fake/.agentworkforce/relay'),
    env: overrides.env ?? {},
    stdin,
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
    stdoutIsTty: overrides.stdoutIsTty ?? false,
  };

  return { deps, writes, errors, logs, signals, sockets, stdin };
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
      offset: 7,
    });
    expect(extractMatchingChunk(raw, 'Alice')).toEqual({ chunk: '[31mhello[0m', offset: 7 });
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
    expect(extractMatchingChunk(raw, 'Alice')).toEqual({ chunk: '', offset: undefined });
  });
});

describe('InputReportModeFilter', () => {
  it('passes escape-free text through untouched (fast path)', () => {
    const filter = new InputReportModeFilter();
    expect(filter.push('plain text\r\n')).toBe('plain text\r\n');
  });

  it('strips mouse-tracking and SGR-encoding enables', () => {
    const filter = new InputReportModeFilter();
    expect(filter.push('before\x1b[?1000hafter')).toBe('beforeafter');
    expect(filter.push('\x1b[?1002h\x1b[?1003h\x1b[?1006h')).toBe('');
  });

  it('strips focus, alternate-scroll, and bracketed-paste enables', () => {
    const filter = new InputReportModeFilter();
    expect(filter.push('\x1b[?1004h\x1b[?1007h\x1b[?2004h')).toBe('');
  });

  it('keeps the matching disables so mode resets pass through', () => {
    const filter = new InputReportModeFilter();
    expect(filter.push('\x1b[?1000l\x1b[?2004l')).toBe('\x1b[?1000l\x1b[?2004l');
  });

  it('keeps other DECSET enables (alt screen, cursor show) verbatim', () => {
    const filter = new InputReportModeFilter();
    expect(filter.push('\x1b[?1049h\x1b[?25h\x1b[?1h')).toBe('\x1b[?1049h\x1b[?25h\x1b[?1h');
  });

  it('rewrites multi-mode sets, keeping only the non-report modes', () => {
    const filter = new InputReportModeFilter();
    expect(filter.push('\x1b[?1002;25h')).toBe('\x1b[?25h');
    expect(filter.push('\x1b[?1002;1006h')).toBe('');
    expect(filter.push('\x1b[?25;1049h')).toBe('\x1b[?25;1049h');
  });

  it('passes non-DECSET CSIs, SGR colors, and 2-byte escapes through', () => {
    const filter = new InputReportModeFilter();
    const bytes = '\x1b[2J\x1b[H\x1b[31;1mRED\x1b[0m\x1b7\x1b8\x1b]0;title\x07';
    expect(filter.push(bytes)).toBe(bytes);
  });

  it('filters a DECSET split across chunk boundaries', () => {
    const filter = new InputReportModeFilter();
    expect(filter.push('hi\x1b[?10')).toBe('hi');
    expect(filter.push('06h there')).toBe(' there');
  });

  it('holds a bare trailing ESC and reassembles it with the next chunk', () => {
    const filter = new InputReportModeFilter();
    expect(filter.push('ok\x1b')).toBe('ok');
    expect(filter.push('[?1000hrest')).toBe('rest');
    expect(filter.push('ok\x1b')).toBe('ok');
    expect(filter.push('[31mred')).toBe('\x1b[31mred');
  });

  it('gives up on pathologically long unterminated non-private CSIs instead of holding forever', () => {
    const filter = new InputReportModeFilter();
    const longCsi = '\x1b[' + '1;'.repeat(200);
    expect(filter.push(longCsi)).toBe(longCsi);
  });

  it('holds and filters a large batched private-mode set split across frames', () => {
    // A full private-mode init batches visual + input-report modes and can
    // still split before the final `h`; the whole set must be held so the
    // input-report modes are stripped while the visual ones survive.
    const filter = new InputReportModeFilter();
    expect(filter.push('\x1b[?1049;1000;1002;1003;1004;1006;1007;1015;1016;2004;25')).toBe('');
    expect(filter.push(';47h')).toBe('\x1b[?1049;25;47h');
  });

  it('drops an over-long partial private-mode set instead of flushing it', () => {
    // If a private-mode set overruns the hold cap, flushing the partial
    // `CSI ? …` prefix would let a later chunk's `h` complete it locally and
    // re-enable the input-report modes this filter exists to strip. Drop it.
    const filter = new InputReportModeFilter();
    const longPrivate = '\x1b[?' + '1000;'.repeat(80);
    expect(longPrivate.length).toBeGreaterThan(256);
    expect(filter.push(longPrivate)).toBe('');
    // The completing `h` arriving next must not resurrect the sequence.
    expect(filter.push('h')).toBe('h');
  });

  it('drops a held partial sequence on reset', () => {
    const filter = new InputReportModeFilter();
    expect(filter.push('\x1b[?10')).toBe('');
    filter.reset();
    expect(filter.push('normal')).toBe('normal');
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

  it('falls through blank URL and API-key candidates', () => {
    const { deps } = createHarness({
      env: { RELAY_BROKER_URL: '   ', RELAY_BROKER_API_KEY: '   ' },
      connectionFile: { url: 'http://file-host:5678', api_key: 'file-key' },
    });

    const conn = resolveViewBrokerConnection({ brokerUrl: ' ', apiKey: ' ' }, deps);
    expect(conn).toEqual({ url: 'http://file-host:5678', apiKey: 'file-key' });
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

/** Flush enough microtasks/macrotasks that the async
 *  paint-snapshot-then-reconcile chain in the `open` handler settles. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('runViewSession', () => {
  it('writes chunks for matching events and ignores others', async () => {
    const { deps, writes, sockets, logs } = createHarness({
      connectionFile: { url: 'http://localhost:3889', api_key: 'k' },
    });

    const sessionPromise = runViewSession('Alice', {}, deps);
    // Wait a tick so the WebSocket factory has been called
    await new Promise((resolve) => setImmediate(resolve));
    expect(sockets).toHaveLength(1);
    const socket = sockets[0];
    expect(socket.url).toBe('ws://localhost:3889/ws');
    expect(socket.headers['X-API-Key']).toBe('k');

    // Subscribe-first: the snapshot is painted+reconciled after `open`.
    socket.emit('open');
    await settle();
    expect(logs.some((args) => String(args[0]).includes('streaming Alice from'))).toBe(false);
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
    await settle();
    socket.emit(
      'message',
      JSON.stringify({ kind: 'worker_stream', name: 'Alice', stream: 'stdout', chunk: ansi })
    );
    socket.emit('close', 1000, Buffer.from(''));

    await sessionPromise;
    expect(writes).toEqual([ansi]);
  });

  it('drops buffered chunks the snapshot already reflects, applies the rest (offset reconcile)', async () => {
    // Snapshot reports offset=10. Chunks with end offset <= 10 are already on
    // screen (drop); later ones are applied. Chunks buffered before the
    // snapshot is painted must be reconciled, not lost or double-applied.
    const snapshotBytes = 'SNAPSHOT';
    const { deps, writes, sockets } = createHarness({
      connectionFile: { url: 'http://localhost:3889' },
      snapshotChunk: snapshotBytes,
      snapshotResult: { status: 'ok', offset: 10 },
    });

    const sessionPromise = runViewSession('Alice', {}, deps);
    await new Promise((resolve) => setImmediate(resolve));
    const socket = sockets[0];
    socket.emit('open');
    // These arrive while the snapshot is still being fetched → buffered.
    socket.emit(
      'message',
      JSON.stringify({ kind: 'worker_stream', name: 'Alice', stream: 'stdout', chunk: 'inSnap', offset: 10 })
    );
    socket.emit(
      'message',
      JSON.stringify({
        kind: 'worker_stream',
        name: 'Alice',
        stream: 'stdout',
        chunk: 'afterSnap',
        offset: 18,
      })
    );
    await settle();
    socket.emit('close', 1000, Buffer.from(''));

    await sessionPromise;
    // Snapshot painted first, then only the post-offset chunk applied.
    expect(writes).toEqual([snapshotBytes, 'afterSnap']);
  });

  it('strips input-report mode enables from snapshot and live output', async () => {
    // A viewed TUI (or the snapshot's mode replay) enabling mouse tracking
    // must not reach the local terminal: view never consumes the reports the
    // terminal would start sending, so they'd echo as `^[[<35;22;25M` garbage
    // over cooked stdin. Visual modes and the disables still pass through.
    const { deps, writes, sockets } = createHarness({
      connectionFile: { url: 'http://localhost:3889' },
      snapshotChunk: '\x1b[?1049h\x1b[?1000h\x1b[?1006hSCREEN',
    });

    const sessionPromise = runViewSession('Alice', {}, deps);
    await new Promise((resolve) => setImmediate(resolve));
    const socket = sockets[0];
    socket.emit('open');
    await settle();
    expect(writes).toEqual(['\x1b[?1049hSCREEN']);

    // Live enable split across two worker_stream frames is still stripped.
    socket.emit(
      'message',
      JSON.stringify({ kind: 'worker_stream', name: 'Alice', stream: 'stdout', chunk: 'out\x1b[?10' })
    );
    socket.emit(
      'message',
      JSON.stringify({ kind: 'worker_stream', name: 'Alice', stream: 'stdout', chunk: '02hmore' })
    );
    socket.emit('close', 1000, Buffer.from(''));

    await sessionPromise;
    expect(writes).toEqual(['\x1b[?1049hSCREEN', 'out', 'more']);
  });

  it('consumes local input in raw mode so alternate-scroll reports are not echoed', async () => {
    const { deps, sockets, stdin } = createHarness({
      connectionFile: { url: 'http://localhost:3889' },
    });

    const sessionPromise = runViewSession('Alice', {}, deps);
    await new Promise((resolve) => setImmediate(resolve));
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(stdin.resume).toHaveBeenCalledOnce();

    // These are the bytes a terminal produces for mouse-wheel movement when
    // alternate-scroll is enabled. View must consume them rather than let
    // cooked stdin echo them as `^[[0A` and `^[[0B`.
    stdin.emitData(Buffer.from('\x1b[0A\x1b[0B'));
    expect(sockets[0].closed).toBe(false);

    stdin.emitData(Buffer.from([0x03]));
    await expect(sessionPromise).resolves.toBe(0);
    expect(sockets[0].terminated).toBe(true);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.pause).toHaveBeenCalledOnce();
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
    expect(socket.terminated).toBe(true);
  });

  it('emits a terminal reset on detach when stdout is a TTY', async () => {
    const { deps, writes, sockets, signals } = createHarness({
      connectionFile: { url: 'http://localhost:3889' },
      stdoutIsTty: true,
    });

    const sessionPromise = runViewSession('Alice', {}, deps);
    await new Promise((resolve) => setImmediate(resolve));
    sockets[0].emit('open');
    await signals.get('SIGINT')?.();
    await sessionPromise;

    // Leave alt-screen + show cursor + disable mouse/bracketed-paste must be
    // written so the viewer's terminal isn't left mis-configured by a snapshot
    // that re-emitted those modes.
    expect(writes.some((w) => w.includes('\x1b[?1049l') && w.includes('\x1b[?25h'))).toBe(true);
  });

  it('does not emit a terminal reset on detach when stdout is not a TTY', async () => {
    const { deps, writes, sockets, signals } = createHarness({
      connectionFile: { url: 'http://localhost:3889' },
      stdoutIsTty: false,
    });

    const sessionPromise = runViewSession('Alice', {}, deps);
    await new Promise((resolve) => setImmediate(resolve));
    sockets[0].emit('open');
    await signals.get('SIGINT')?.();
    await sessionPromise;

    expect(writes.some((w) => w.includes('\x1b[?1049l'))).toBe(false);
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

  it('treats WebSocket errors as fatal', async () => {
    const { deps, errors, sockets } = createHarness({
      connectionFile: { url: 'http://localhost:3889' },
    });

    const sessionPromise = runViewSession('Alice', {}, deps);
    await new Promise((resolve) => setImmediate(resolve));
    const socket = sockets[0];
    socket.emit('open');
    socket.emit('error', new Error('boom'));

    const code = await sessionPromise;
    expect(code).toBe(1);
    expect(errors.some((args) => String(args[0]).includes('WebSocket error: boom'))).toBe(true);
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

  it('renders the snapshot to stdout after subscribing, before live deltas', async () => {
    // Subscribe-first: the WS opens (and subscribes) first, then the
    // snapshot is painted, then buffered/live deltas are applied — so the
    // user still sees the snapshot before the live delta, with no gap.
    const snapshotBytes = '\x1b[2J\x1b[H\x1b[32mWelcome back Will\x1b[0m\n❯\n';
    const { deps, writes, sockets } = createHarness({
      connectionFile: { url: 'http://localhost:3889', api_key: 'k' },
      snapshotChunk: snapshotBytes,
    });

    const sessionPromise = runViewSession('Alice', {}, deps);
    await new Promise((resolve) => setImmediate(resolve));

    // Nothing painted until the WS subscribes and the snapshot is fetched.
    expect(writes).toEqual([]);

    const socket = sockets[0];
    socket.emit('open');
    await settle();
    // Snapshot painted on open.
    expect(writes).toEqual([snapshotBytes]);
    socket.emit(
      'message',
      JSON.stringify({ kind: 'worker_stream', name: 'Alice', stream: 'stdout', chunk: 'live delta' })
    );
    socket.emit('close', 1000, Buffer.from(''));

    await sessionPromise;
    expect(writes).toEqual([snapshotBytes, 'live delta']);
  });

  it('stops writing output once teardown has begun (item 3)', async () => {
    const { deps, writes, sockets, signals } = createHarness({
      connectionFile: { url: 'http://localhost:3889', api_key: 'k' },
      snapshotChunk: '',
    });

    const sessionPromise = runViewSession('Alice', {}, deps);
    await new Promise((resolve) => setImmediate(resolve));
    const socket = sockets[0];
    socket.emit('open');
    await settle();

    // Detach via SIGINT.
    await signals.get('SIGINT')?.();
    await sessionPromise;

    const before = writes.length;
    socket.emit(
      'message',
      JSON.stringify({ kind: 'worker_stream', name: 'Alice', stream: 'stdout', chunk: 'POST-DETACH' })
    );
    expect(writes.includes('POST-DETACH')).toBe(false);
    expect(writes.length).toBe(before);
  });

  it('aborts with exit code 1 when the snapshot reports not_found', async () => {
    const { deps, errors, sockets } = createHarness({
      connectionFile: { url: 'http://localhost:3889' },
      snapshotResult: { status: 'not_found', message: "no agent named 'Ghost'" },
    });

    const sessionPromise = runViewSession('Ghost', {}, deps);
    await new Promise((resolve) => setImmediate(resolve));
    // Subscribe-first: the broker-wide WS opens, then the snapshot 404s and
    // we close it and abort.
    expect(sockets).toHaveLength(1);
    sockets[0].emit('open');
    const code = await sessionPromise;
    expect(code).toBe(1);
    expect(sockets[0].closed).toBe(true);
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

    const sessionPromise = runViewSession('Headless', {}, deps);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sockets).toHaveLength(1);
    sockets[0].emit('open');
    const code = await sessionPromise;
    expect(code).toBe(1);
    expect(sockets[0].closed).toBe(true);
    expect(errors[0]?.[0]).toMatch(/no PTY/);
  });

  it('logs and continues when the snapshot is transiently unavailable', async () => {
    // Snapshot fails (broker hiccup, worker crashed mid-snapshot, etc.)
    // but the live stream should still attach — the agent may produce
    // useful output even if the current screen couldn't be captured. With no
    // snapshot to reconcile against, buffered chunks are applied as-is.
    const { deps, logs, sockets, writes } = createHarness({
      connectionFile: { url: 'http://localhost:3889' },
      snapshotResult: { status: 'unavailable', message: 'snapshot returned HTTP 504' },
    });

    const sessionPromise = runViewSession('Alice', {}, deps);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sockets).toHaveLength(1); // WS opened first

    const socket = sockets[0];
    socket.emit('open');
    await settle();
    expect(logs.some((args) => String(args[0]).includes('could not capture initial screen'))).toBe(true);
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
