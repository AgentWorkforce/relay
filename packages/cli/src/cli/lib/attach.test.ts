import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AnsiBoundaryScanner,
  captureAndRenderSnapshot,
  createBackpressureAwareWriter,
  restoreInboundDeliveryModeOnDetach,
  StatusLineController,
  StreamSyncBuffer,
  type AttachSnapshotConnection,
  type AttachSnapshotDeps,
  type BackpressureWritable,
} from './attach.js';
import type { BrokerConnection } from './broker-connection.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeDeps(overrides: Partial<AttachSnapshotDeps> = {}): {
  deps: AttachSnapshotDeps;
  writes: string[];
} {
  const writes: string[] = [];
  const deps: AttachSnapshotDeps = {
    fetch: vi.fn(async () => new Response('', { status: 200 })),
    writeChunk: (chunk: string) => {
      writes.push(chunk);
    },
    ...overrides,
  };
  return { deps, writes };
}

const conn: AttachSnapshotConnection = { url: 'http://localhost:3889', apiKey: 'k' };

describe('captureAndRenderSnapshot', () => {
  it('writes the decoded ANSI bytes to writeChunk on success', async () => {
    const ansi = '\x1b[2J\x1b[H\x1b[32mhello\x1b[0m';
    const screen = Buffer.from(ansi, 'utf-8').toString('base64');
    const { deps, writes } = makeDeps({
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              format: 'ansi',
              rows: 24,
              cols: 80,
              cursor: [1, 6],
              screen,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      ),
    });

    const result = await captureAndRenderSnapshot(conn, 'Alice', deps);

    expect(result.status).toBe('ok');
    expect(result.rows).toBe(24);
    expect(result.cols).toBe(80);
    expect(result.cursor).toEqual([1, 6]);
    expect(writes).toEqual([ansi]);
  });

  it('hits the snapshot route with format=ansi and the X-API-Key header', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            format: 'ansi',
            screen: Buffer.from('x', 'utf-8').toString('base64'),
          }),
          { status: 200 }
        )
    );
    const { deps } = makeDeps({ fetch: fetchMock });

    await captureAndRenderSnapshot(conn, 'Alice', deps);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3889/api/spawned/Alice/snapshot?format=ansi');
    expect((init as RequestInit).headers).toEqual({ 'X-API-Key': 'k' });
  });

  it('URL-encodes the agent name', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            format: 'ansi',
            screen: Buffer.from('', 'utf-8').toString('base64'),
          }),
          { status: 200 }
        )
    );
    const { deps } = makeDeps({ fetch: fetchMock });

    await captureAndRenderSnapshot(conn, 'agent name/with slash', deps);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3889/api/spawned/agent%20name%2Fwith%20slash/snapshot?format=ansi');
  });

  it('omits the X-API-Key header when no api key is set', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ screen: Buffer.from('', 'utf-8').toString('base64') }), { status: 200 })
    );
    const { deps } = makeDeps({ fetch: fetchMock });

    await captureAndRenderSnapshot({ url: 'http://localhost:3889' }, 'Alice', deps);

    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).toEqual({});
  });

  it('returns not_found on HTTP 404 and does not write', async () => {
    const { deps, writes } = makeDeps({
      fetch: vi.fn(async () => new Response('', { status: 404 })),
    });

    const result = await captureAndRenderSnapshot(conn, 'Ghost', deps);

    expect(result.status).toBe('not_found');
    expect(result.message).toContain('Ghost');
    expect(writes).toEqual([]);
  });

  it('returns no_pty on HTTP 409', async () => {
    const { deps, writes } = makeDeps({
      fetch: vi.fn(async () => new Response('', { status: 409 })),
    });

    const result = await captureAndRenderSnapshot(conn, 'Headless', deps);

    expect(result.status).toBe('no_pty');
    expect(result.message).toMatch(/headless/i);
    expect(writes).toEqual([]);
  });

  it('returns unavailable on 5xx', async () => {
    const { deps } = makeDeps({
      fetch: vi.fn(async () => new Response('', { status: 503 })),
    });

    const result = await captureAndRenderSnapshot(conn, 'Alice', deps);

    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('503');
  });

  it('returns transport_error when fetch itself throws', async () => {
    const { deps } = makeDeps({
      fetch: vi.fn(async () => {
        throw new Error('network down');
      }),
    });

    const result = await captureAndRenderSnapshot(conn, 'Alice', deps);

    expect(result.status).toBe('transport_error');
    expect(result.message).toBe('network down');
  });

  it('returns transport_error when the body is not JSON', async () => {
    const { deps } = makeDeps({
      fetch: vi.fn(async () => new Response('not json', { status: 200 })),
    });

    const result = await captureAndRenderSnapshot(conn, 'Alice', deps);

    expect(result.status).toBe('transport_error');
    expect(result.message).toMatch(/not JSON/i);
  });

  it('returns transport_error when the screen field is missing', async () => {
    const { deps } = makeDeps({
      fetch: vi.fn(
        async () => new Response(JSON.stringify({ format: 'ansi', rows: 24, cols: 80 }), { status: 200 })
      ),
    });

    const result = await captureAndRenderSnapshot(conn, 'Alice', deps);

    expect(result.status).toBe('transport_error');
    expect(result.message).toMatch(/missing 'screen' field/);
  });

  it('strips a trailing slash from the connection URL', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ screen: Buffer.from('', 'utf-8').toString('base64') }), { status: 200 })
    );
    const { deps } = makeDeps({ fetch: fetchMock });

    await captureAndRenderSnapshot({ url: 'http://localhost:3889/', apiKey: 'k' }, 'Alice', deps);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3889/api/spawned/Alice/snapshot?format=ansi');
  });
});

describe('StreamSyncBuffer', () => {
  it('buffers chunks until reconcile, then applies live', () => {
    const sync = new StreamSyncBuffer();
    // While buffering, push returns false (hold the chunk).
    expect(sync.isBuffering).toBe(true);
    expect(sync.push('a', 5)).toBe(false);
    expect(sync.push('b', 10)).toBe(false);
    // Snapshot at offset 5: 'a' (end offset 5) is already on screen → drop;
    // 'b' (end offset 10 > 5) is applied.
    expect(sync.reconcile(5)).toEqual(['b']);
    expect(sync.isBuffering).toBe(false);
    // After reconcile, push returns true (apply live).
    expect(sync.push('c', 15)).toBe(true);
  });

  it('drops every buffered chunk fully covered by the snapshot (no duplication)', () => {
    const sync = new StreamSyncBuffer();
    sync.push('x', 4);
    sync.push('y', 8);
    sync.push('z', 8); // an empty-progress flush at the same boundary
    // Snapshot offset 8 covers all of them.
    expect(sync.reconcile(8)).toEqual([]);
  });

  it('applies only chunks past the snapshot boundary (no loss)', () => {
    const sync = new StreamSyncBuffer();
    sync.push('in', 10);
    sync.push('edge', 10); // exactly at the boundary → covered
    sync.push('after', 12);
    sync.push('later', 20);
    expect(sync.reconcile(10)).toEqual(['after', 'later']);
  });

  it('drops the pre-snapshot buffer when the broker reports no offset (snapshot-authoritative)', () => {
    const sync = new StreamSyncBuffer();
    sync.push('a', undefined);
    sync.push('b', undefined);
    // A painted snapshot with no reported offset: the buffered chunks arrived
    // before the snapshot response, so drop them (matching the legacy
    // snapshot-then-subscribe behaviour, which never saw them). Use flushAll
    // instead when NO snapshot was painted.
    expect(sync.reconcile(undefined)).toEqual([]);
  });

  it('applies a buffered chunk with no offset even when the snapshot has one', () => {
    const sync = new StreamSyncBuffer();
    sync.push('known', 4);
    sync.push('legacy', undefined);
    // With snapshot offset 8, the offset-tagged chunk (4 <= 8) drops; the
    // untagged one is applied rather than risk losing live output.
    expect(sync.reconcile(8)).toEqual(['legacy']);
  });

  it('flushAll returns every buffered chunk and switches to live', () => {
    const sync = new StreamSyncBuffer();
    sync.push('a', 4);
    sync.push('b', 8);
    expect(sync.flushAll()).toEqual(['a', 'b']);
    expect(sync.isBuffering).toBe(false);
    expect(sync.push('c', 12)).toBe(true);
  });
});

describe('AnsiBoundaryScanner', () => {
  it('reports a boundary for plain text', () => {
    const s = new AnsiBoundaryScanner();
    s.push('hello world');
    expect(s.atBoundary).toBe(true);
  });

  it('detects a chunk ending mid-CSI and recovers on the final byte', () => {
    const s = new AnsiBoundaryScanner();
    s.push('foo\x1b['); // ESC [
    expect(s.atBoundary).toBe(false);
    s.push('2'); // parameter byte
    expect(s.atBoundary).toBe(false);
    s.push('J'); // CSI final byte
    expect(s.atBoundary).toBe(true);
  });

  it('treats a bare trailing ESC as incomplete', () => {
    const s = new AnsiBoundaryScanner();
    s.push('x\x1b');
    expect(s.atBoundary).toBe(false);
    s.push('7'); // ESC 7 — complete 2-byte escape
    expect(s.atBoundary).toBe(true);
  });

  it('handles an OSC string terminated by BEL', () => {
    const s = new AnsiBoundaryScanner();
    s.push('\x1b]0;title');
    expect(s.atBoundary).toBe(false);
    s.push('\x07');
    expect(s.atBoundary).toBe(true);
  });

  it('handles a DCS string terminated by ST (ESC backslash)', () => {
    const s = new AnsiBoundaryScanner();
    s.push('\x1bP1;2body');
    expect(s.atBoundary).toBe(false);
    s.push('\x1b\\');
    expect(s.atBoundary).toBe(true);
  });

  it('is unaffected by multi-byte UTF-8 payload in the ground state', () => {
    const s = new AnsiBoundaryScanner();
    s.push('café 你好 🎉');
    expect(s.atBoundary).toBe(true);
  });
});

/** Deterministic in-memory timer queue for StatusLineController tests. */
function fakeTimers() {
  let seq = 0;
  let clock = 1000;
  const timers = new Map<number, { fn: () => void; at: number }>();
  return {
    now: () => clock,
    advance(ms: number) {
      clock += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= clock) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    setTimer: (fn: () => void, ms: number) => {
      const id = (seq += 1);
      timers.set(id, { fn, at: clock + ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (id: ReturnType<typeof setTimeout>) => {
      timers.delete(id as unknown as number);
    },
    pending: () => timers.size,
  };
}

describe('StatusLineController', () => {
  it('paints immediately at a boundary when enabled', () => {
    const writes: string[] = [];
    const t = fakeTimers();
    const c = new StatusLineController({
      render: () => 'STATUS',
      write: (s) => writes.push(s),
      enabled: true,
      coalesceMs: 0,
      now: t.now,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    c.request();
    expect(writes).toEqual(['STATUS']);
  });

  it('never paints when disabled (non-TTY stdout)', () => {
    const writes: string[] = [];
    const c = new StatusLineController({
      render: () => 'STATUS',
      write: (s) => writes.push(s),
      enabled: false,
      coalesceMs: 0,
    });
    c.request();
    c.observeOutput('x');
    c.request();
    expect(writes).toEqual([]);
  });

  it('holds a repaint while output ends mid escape sequence, then paints at the boundary', () => {
    const writes: string[] = [];
    const t = fakeTimers();
    const c = new StatusLineController({
      render: () => 'S',
      write: (s) => writes.push(s),
      enabled: true,
      coalesceMs: 0,
      now: t.now,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    c.observeOutput('foo\x1b['); // ends mid-CSI
    c.request();
    expect(writes).toEqual([]); // deferred — would splice into the CSI
    c.observeOutput('0m'); // completes the CSI at a boundary
    expect(writes).toEqual(['S']);
  });

  it('force-paints after boundaryHoldMs if output stays mid-sequence', () => {
    const writes: string[] = [];
    const t = fakeTimers();
    const c = new StatusLineController({
      render: () => 'S',
      write: (s) => writes.push(s),
      enabled: true,
      coalesceMs: 0,
      boundaryHoldMs: 100,
      now: t.now,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    c.observeOutput('\x1b[');
    c.request();
    expect(writes).toEqual([]);
    t.advance(100);
    expect(writes).toEqual(['S']); // bounded fallback
  });

  it('coalesces rapid repaints into one per window (latest state wins)', () => {
    const writes: string[] = [];
    const t = fakeTimers();
    let n = 0;
    const c = new StatusLineController({
      render: () => `S${n}`,
      write: (s) => writes.push(s),
      enabled: true,
      coalesceMs: 50,
      now: t.now,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    n = 1;
    c.request(); // leading edge paints immediately
    expect(writes).toEqual(['S1']);
    n = 2;
    c.request(); // within window → deferred
    n = 3;
    c.request(); // still within window → coalesced
    expect(writes).toEqual(['S1']);
    t.advance(50); // window elapses → single trailing paint of the latest state
    expect(writes).toEqual(['S1', 'S3']);
  });

  it('stops painting after dispose', () => {
    const writes: string[] = [];
    const t = fakeTimers();
    const c = new StatusLineController({
      render: () => 'S',
      write: (s) => writes.push(s),
      enabled: true,
      coalesceMs: 0,
      now: t.now,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    c.dispose();
    c.request();
    expect(writes).toEqual([]);
    expect(t.pending()).toBe(0);
  });
});

/** Fetch stub answering only the delivery-mode endpoint, with mutable state. */
function deliveryModeFetch(initial: 'manual_flush' | 'auto_inject') {
  let mode: 'manual_flush' | 'auto_inject' = initial;
  const puts: Array<'manual_flush' | 'auto_inject'> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (/\/delivery-mode$/.test(url)) {
      if (method === 'GET') {
        return new Response(JSON.stringify({ mode }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const body = JSON.parse(String(init?.body)) as { mode: 'manual_flush' | 'auto_inject' };
      mode = body.mode;
      puts.push(body.mode);
      return new Response(JSON.stringify({ mode }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('nope', { status: 500 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, puts, getMode: () => mode };
}

describe('restoreInboundDeliveryModeOnDetach', () => {
  const connection: BrokerConnection = { url: 'http://localhost:3889' };

  it('restores the previous mode when the mode is still what this session set', async () => {
    const f = deliveryModeFetch('manual_flush'); // session set manual_flush; prev was auto_inject
    const logs: unknown[][] = [];
    await restoreInboundDeliveryModeOnDetach(connection, 'A', 'auto_inject', 'manual_flush', 'drive', {
      fetch: f.fetch,
      log: (...a: unknown[]) => logs.push(a),
    });
    expect(f.puts).toEqual(['auto_inject']);
    expect(f.getMode()).toBe('auto_inject');
  });

  it('does NOT clobber a mode another session changed after this one set it', async () => {
    // Session set manual_flush, but the current mode is now auto_inject (someone
    // else flipped it). Restoring auto_inject → manual_flush would clobber them.
    const f = deliveryModeFetch('auto_inject');
    const logs: unknown[][] = [];
    await restoreInboundDeliveryModeOnDetach(connection, 'A', 'auto_inject', 'manual_flush', 'drive', {
      fetch: f.fetch,
      log: (...a: unknown[]) => logs.push(a),
    });
    expect(f.puts).toEqual([]); // left alone
    expect(f.getMode()).toBe('auto_inject');
  });

  it('leaves the mode untouched and warns when the pre-attach mode was unknown', async () => {
    const f = deliveryModeFetch('manual_flush');
    const logs: unknown[][] = [];
    await restoreInboundDeliveryModeOnDetach(connection, 'A', null, 'manual_flush', 'drive', {
      fetch: f.fetch,
      log: (...a: unknown[]) => logs.push(a),
    });
    expect(f.puts).toEqual([]);
    expect(logs.some((a) => String(a[0]).includes('could not restore'))).toBe(true);
  });
});

describe('createBackpressureAwareWriter', () => {
  it('writes straight through while the stream accepts data', () => {
    const written: string[] = [];
    const stdout: BackpressureWritable = {
      write: (c) => {
        written.push(c);
        return true;
      },
      once: () => undefined,
    };
    const w = createBackpressureAwareWriter(stdout);
    w('a');
    w('b');
    expect(written).toEqual(['a', 'b']);
  });

  it('queues while saturated and flushes in order on drain', () => {
    const written: string[] = [];
    let accept = true;
    let drain: (() => void) | null = null;
    const stdout: BackpressureWritable = {
      write: (c) => {
        written.push(c);
        return accept;
      },
      once: (_event, fn) => {
        drain = fn;
        return undefined;
      },
    };
    const w = createBackpressureAwareWriter(stdout);
    accept = false;
    w('a'); // write returns false → paused, drain registered
    w('b');
    w('c'); // held in the bounded queue
    expect(written).toEqual(['a']);
    accept = true;
    drain?.();
    expect(written).toEqual(['a', 'b', 'c']);
  });

  it('writes through rather than dropping output once the queue cap is hit', () => {
    const written: string[] = [];
    const stdout: BackpressureWritable = {
      write: (c) => {
        written.push(c);
        return false;
      },
      once: () => undefined,
    };
    const w = createBackpressureAwareWriter(stdout, 2); // 2-byte cap
    w('a'); // paused
    w('bb'); // exactly fills the cap → queued
    w('c'); // over cap → written straight through, not dropped
    expect(written).toEqual(['a', 'c']);
  });
});
