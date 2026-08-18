import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AnsiBoundaryScanner,
  captureAndRenderSnapshot,
  clampStatusLineText,
  createBackpressureAwareWriter,
  DEFAULT_STATUS_LINE_COLS,
  pickInitialTerminalCols,
  fitStatusLineText,
  LOCAL_TERMINAL_RESET_SEQUENCE,
  reserveStatusLineRow,
  resetLocalTerminalOnDetach,
  restoreInboundDeliveryModeOnDetach,
  StatusLineController,
  StatusLineInvalidationScanner,
  StreamSyncBuffer,
  TerminalScrollRegionTracker,
  type AttachSnapshotConnection,
  type AttachSnapshotDeps,
  type BackpressureWritable,
} from './attach.js';
import { createBrokerClient } from './attach-broker.js';
import type { BrokerConnection } from './broker-connection.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reserveStatusLineRow', () => {
  it('gives a TUI one fewer row and column', () => {
    expect(reserveStatusLineRow({ rows: 40, cols: 120 })).toEqual({ rows: 39, cols: 119 });
  });

  it('keeps degenerate terminals usable and leaves non-TTY output alone', () => {
    expect(reserveStatusLineRow({ rows: 1, cols: 80 })).toEqual({ rows: 1, cols: 80 });
    expect(reserveStatusLineRow({ rows: 2, cols: 80 })).toEqual({ rows: 2, cols: 80 });
    expect(reserveStatusLineRow(null)).toBeNull();
  });
});

describe('fitStatusLineText', () => {
  it('leaves the autowrap column unused and marks truncation', () => {
    expect(fitStatusLineText('1234567890', 8)).toBe('123456~');
  });

  it('conservatively accounts for non-ASCII names', () => {
    expect(fitStatusLineText('A🤖BC', 5)).toBe('A🤖~');
    expect(fitStatusLineText('short', undefined)).toBe('short');
  });
});

describe('StatusLineInvalidationScanner', () => {
  it('ignores ordinary cursor-addressed TUI output', () => {
    const scanner = new StatusLineInvalidationScanner();
    expect(scanner.push('\x1b[4;10Hhello\x1b[32mworld')).toBe(false);
  });

  it('detects display erases, resets, and alternate-screen switches across chunks', () => {
    const scanner = new StatusLineInvalidationScanner();
    expect(scanner.push('\x1b[')).toBe(false);
    expect(scanner.push('2J')).toBe(true);
    expect(scanner.push('ordinary follow-up')).toBe(false);
    expect(scanner.push('\x1b[?25;10')).toBe(false);
    expect(scanner.push('49h')).toBe(true);
    expect(scanner.push('\x1bc')).toBe(true);
  });
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

  it('returns cross-node hint in not_found message when fleetHint resolves a placement', async () => {
    const { deps, writes } = makeDeps({
      fetch: vi.fn(async () => new Response('', { status: 404 })),
      fleetHint: vi.fn(async () => "on node 'finn-mini'"),
    });

    const result = await captureAndRenderSnapshot(conn, 'remote-worker', deps);

    expect(result.status).toBe('not_found');
    expect(result.message).toContain('remote-worker');
    expect(result.message).toContain('finn-mini');
    expect(result.message).toContain('cross-node attach');
    expect(writes).toEqual([]);
  });

  it('falls back to "no agent named" message when fleetHint returns null', async () => {
    const { deps, writes } = makeDeps({
      fetch: vi.fn(async () => new Response('', { status: 404 })),
      fleetHint: vi.fn(async () => null),
    });

    const result = await captureAndRenderSnapshot(conn, 'Ghost', deps);

    expect(result.status).toBe('not_found');
    expect(result.message).toContain('Ghost');
    expect(result.message).not.toContain('cross-node');
    expect(writes).toEqual([]);
  });

  it('returns not_found when fleetHint rejects (never propagates)', async () => {
    const { deps, writes } = makeDeps({
      fetch: vi.fn(async () => new Response('', { status: 404 })),
      fleetHint: vi.fn(async () => Promise.reject(new Error('network failure'))),
    });

    const result = await captureAndRenderSnapshot(conn, 'Ghost', deps);

    expect(result.status).toBe('not_found');
    expect(result.message).toContain('Ghost');
    expect(result.message).not.toContain('cross-node');
    expect(writes).toEqual([]);
  });

  it('shell-quotes agent names with spaces in the suggested command', async () => {
    const { deps, writes } = makeDeps({
      fetch: vi.fn(async () => new Response('', { status: 404 })),
      fleetHint: vi.fn(async () => "on node 'finn-mini'"),
    });

    const result = await captureAndRenderSnapshot(conn, 'my agent name', deps);

    expect(result.status).toBe('not_found');
    // The suggested command must quote the name so it is not split by the shell.
    expect(result.message).toContain("'my agent name'");
    expect(result.message).not.toContain('attach my agent name ');
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

  it('suppresses post-reconcile stragglers at or below the snapshot watermark', () => {
    const sync = new StreamSyncBuffer();
    // Nothing buffered before reconcile; snapshot painted up to offset 10.
    expect(sync.reconcile(10)).toEqual([]);
    // A chunk still in-flight broker-side when the snapshot was captured
    // (end offset <= 10) arrives after reconcile — the snapshot already
    // painted it, so it must be dropped (returns false).
    expect(sync.push('straggler-below', 8)).toBe(false);
    expect(sync.push('straggler-edge', 10)).toBe(false);
    // Genuinely new output past the watermark passes through.
    expect(sync.push('fresh', 11)).toBe(true);
    // A live frame with no offset is applied rather than risk dropping output.
    expect(sync.push('untagged', undefined)).toBe(true);
  });

  it('does not arm a watermark when the broker reports no offset', () => {
    const sync = new StreamSyncBuffer();
    // Snapshot with no offset: buffered chunks drop, and there is nothing to
    // compare live frames against, so everything passes through afterwards.
    expect(sync.reconcile(undefined)).toEqual([]);
    expect(sync.push('a', 4)).toBe(true);
    expect(sync.push('b', 8)).toBe(true);
  });

  it('does not arm a watermark after flushAll (no snapshot painted)', () => {
    const sync = new StreamSyncBuffer();
    sync.push('early', 4);
    expect(sync.flushAll()).toEqual(['early']);
    // No snapshot was painted, so even low-offset frames are live output.
    expect(sync.push('low', 2)).toBe(true);
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

describe('TerminalScrollRegionTracker', () => {
  it('tracks narrow DECSTBM margins split across chunks and resets them', () => {
    const tracker = new TerminalScrollRegionTracker(9);
    tracker.push('frame\x1b[3;');
    expect(tracker.region).toEqual({ top: 1, bottom: 9 });
    tracker.setRows(12);
    tracker.push('8r');
    expect(tracker.region).toEqual({ top: 3, bottom: 8 });
    tracker.push('\x1b[r');
    expect(tracker.region).toEqual({ top: 1, bottom: 12 });
  });

  it('resets margins for a resized child and alternate-screen switch', () => {
    const tracker = new TerminalScrollRegionTracker(9);
    tracker.push('\x1b[2;7r');
    tracker.setRows(14);
    expect(tracker.region).toEqual({ top: 1, bottom: 14 });
    tracker.push('\x1b[2;8r\x1b[?25;10');
    tracker.push('49h');
    expect(tracker.region).toEqual({ top: 1, bottom: 14 });
    tracker.push('\x1b[3;7r\x1b[?1049l');
    expect(tracker.region).toEqual({ top: 2, bottom: 8 });
    tracker.push('\x1b[?1049h');
    expect(tracker.region).toEqual({ top: 1, bottom: 14 });
    tracker.push('\x1b[?6h');
    expect(tracker.isOriginMode).toBe(true);
    tracker.push('\x1bc');
    expect(tracker.isOriginMode).toBe(false);
    tracker.push('\x1b[2;8r\x1b[?1049h');
    expect(tracker.region).toEqual({ top: 1, bottom: 14 });
  });

  it('ignores CSI-looking bytes inside DCS payloads', () => {
    const tracker = new TerminalScrollRegionTracker(12);
    tracker.push('\x1bPtmux;\x1b[3;8r');
    tracker.push('\x1b\\');
    expect(tracker.region).toEqual({ top: 1, bottom: 12 });
    tracker.push('\x1b[4;9r');
    expect(tracker.region).toEqual({ top: 4, bottom: 9 });
    tracker.setRows(9);
    tracker.push('\x1b[10;20r');
    expect(tracker.region).toEqual({ top: 1, bottom: 9 });
    tracker.push('\x1b[3;7r\x1b[0;0r');
    expect(tracker.region).toEqual({ top: 1, bottom: 9 });
    tracker.push('\x1bPpayload\x9c\x1b[3;8r');
    expect(tracker.region).toEqual({ top: 3, bottom: 8 });
    tracker.push('\x1b[4;\x18' + '9r');
    expect(tracker.region).toEqual({ top: 3, bottom: 8 });
  });

  it('resets alternate margins on every supported alternate-screen re-entry', () => {
    for (const mode of ['47', '1047', '1049']) {
      const tracker = new TerminalScrollRegionTracker(10);
      tracker.push(`\x1b[?${mode}h\x1b[3;7r\x1b[?${mode}l\x1b[?${mode}h`);
      expect(tracker.region).toEqual({ top: 1, bottom: 10 });
    }
  });

  it('preserves margins for redundant alternate-screen set commands', () => {
    const tracker = new TerminalScrollRegionTracker(10);
    tracker.push('\x1b[?1049h\x1b[4;7r\x1b[?1049h');
    expect(tracker.region).toEqual({ top: 4, bottom: 7 });
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

  it('handles split C1 CSI and C1 string controls', () => {
    const s = new AnsiBoundaryScanner();
    s.push('\x9b3;');
    expect(s.atBoundary).toBe(false);
    s.push('8r');
    expect(s.atBoundary).toBe(true);
    s.push('\x90payload');
    expect(s.atBoundary).toBe(false);
    s.push('\x9c');
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

  it.each([
    ['CSI', '\x1b[', '2J'],
    ['OSC', '\x1b]0;title', '\x07'],
    ['DCS', '\x1bP$qm', '\x1b\\'],
  ])('never splices a status repaint into a delayed split %s sequence', (_name, start, end) => {
    const output: string[] = [];
    const t = fakeTimers();
    const c = new StatusLineController({
      render: () => 'STATUS',
      write: (s) => output.push(s),
      enabled: true,
      coalesceMs: 0,
      now: t.now,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    output.push(start);
    c.observeOutput(start);
    c.request();
    t.advance(10_000);
    expect(output).toEqual([start]);
    expect(t.pending()).toBe(0);

    output.push(end);
    c.observeOutput(end);
    expect(output).toEqual([start, end, 'STATUS']);
    expect(output.slice(0, 2).join('')).toBe(start + end);
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

  it('starts the remaining coalescing delay only after output returns to a boundary', () => {
    const writes: string[] = [];
    const t = fakeTimers();
    const c = new StatusLineController({
      render: () => 'S',
      write: (s) => writes.push(s),
      enabled: true,
      coalesceMs: 50,
      now: t.now,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    // Leading-edge paint establishes lastPaintAt so the next repaint falls
    // inside the coalescing window.
    c.request();
    expect(writes).toEqual(['S']);
    // Output ends mid-CSI, then a repaint is requested. No timer may force a
    // write into the incomplete sequence.
    c.observeOutput('\x1b[');
    c.request();
    expect(t.pending()).toBe(0);
    // A little later, output returns to a boundary. A coalescing timer is
    // armed for the remainder of the 50ms window (≈40ms from here).
    t.advance(10);
    c.observeOutput('0m'); // completes the CSI → boundary
    expect(writes).toEqual(['S']); // still deferred within the coalescing window
    expect(t.pending()).toBe(1);
    t.advance(40);
    expect(writes).toEqual(['S', 'S']);
    expect(t.pending()).toBe(0);
  });

  it('does not let a held repaint fire after dynamic status disablement', () => {
    const writes: string[] = [];
    const t = fakeTimers();
    let enabled = true;
    const c = new StatusLineController({
      render: () => 'S',
      write: (s) => writes.push(s),
      enabled: () => enabled,
      coalesceMs: 0,
      now: t.now,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    c.observeOutput('\x1b[');
    c.request();
    enabled = false;
    c.observeOutput('0m');
    expect(writes).toEqual([]);
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
function deliveryModeFetch(initial: 'manual_flush' | 'auto_inject', initialRevision = 1) {
  let mode: 'manual_flush' | 'auto_inject' = initial;
  let revision = initialRevision;
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
      const body = JSON.parse(String(init?.body)) as {
        mode: 'manual_flush' | 'auto_inject';
        expected_mode?: 'manual_flush' | 'auto_inject';
        expected_revision?: string;
      };
      // Simulate the broker's compare-and-set: when `expected_mode` is present
      // and no longer matches the current mode, no-op and report `matched:false`
      // with the unchanged current mode.
      if (
        (body.expected_mode !== undefined && body.expected_mode !== mode) ||
        (body.expected_revision !== undefined && body.expected_revision !== String(revision))
      ) {
        return new Response(
          JSON.stringify({ mode, flushed: 0, matched: false, revision: String(revision) }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      mode = body.mode;
      revision += 1;
      puts.push(body.mode);
      return new Response(JSON.stringify({ mode, flushed: 0, matched: true, revision: String(revision) }), {
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
    await restoreInboundDeliveryModeOnDetach(connection, 'A', 'auto_inject', 'manual_flush', '1', 'drive', {
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
    await restoreInboundDeliveryModeOnDetach(connection, 'A', 'auto_inject', 'manual_flush', '1', 'drive', {
      fetch: f.fetch,
      log: (...a: unknown[]) => logs.push(a),
    });
    expect(f.puts).toEqual([]); // left alone
    expect(f.getMode()).toBe('auto_inject');
    expect(logs.some((a) => String(a[0]).includes('another session changed'))).toBe(true);
  });

  it('does NOT restore after an ABA mode change advances the broker revision', async () => {
    const f = deliveryModeFetch('manual_flush', 3);
    const logs: unknown[][] = [];
    await restoreInboundDeliveryModeOnDetach(connection, 'A', 'auto_inject', 'manual_flush', '1', 'drive', {
      fetch: f.fetch,
      log: (...a: unknown[]) => logs.push(a),
    });
    expect(f.puts).toEqual([]);
    expect(f.getMode()).toBe('manual_flush');
    expect(logs.some((a) => String(a[0]).includes('another session changed'))).toBe(true);
  });

  it('fails closed and warns when a legacy broker reports no revision', async () => {
    const f = deliveryModeFetch('manual_flush');
    const logs: unknown[][] = [];
    await restoreInboundDeliveryModeOnDetach(connection, 'A', 'auto_inject', 'manual_flush', null, 'drive', {
      fetch: f.fetch,
      log: (...a: unknown[]) => logs.push(a),
    });
    expect(f.puts).toEqual([]);
    expect(f.getMode()).toBe('manual_flush');
    expect(logs.some((a) => String(a[0]).includes('did not report a mode revision'))).toBe(true);
  });

  it('leaves the mode untouched and warns when the pre-attach mode was unknown', async () => {
    const f = deliveryModeFetch('manual_flush');
    const logs: unknown[][] = [];
    await restoreInboundDeliveryModeOnDetach(connection, 'A', null, 'manual_flush', '1', 'drive', {
      fetch: f.fetch,
      log: (...a: unknown[]) => logs.push(a),
    });
    expect(f.puts).toEqual([]);
    expect(logs.some((a) => String(a[0]).includes('could not restore'))).toBe(true);
  });
});

describe('resetLocalTerminalOnDetach', () => {
  it('writes the full reset sequence when stdout is a TTY', () => {
    const writes: string[] = [];
    resetLocalTerminalOnDetach((c) => writes.push(c), true);
    expect(writes).toEqual([LOCAL_TERMINAL_RESET_SEQUENCE]);
  });

  it('is a no-op when stdout is not a TTY', () => {
    const writes: string[] = [];
    resetLocalTerminalOnDetach((c) => writes.push(c), false);
    expect(writes).toEqual([]);
  });

  it('heals the modes a snapshot/live stream can leave enabled', () => {
    // Spot-check the load-bearing controls: leave alt-screen, show cursor,
    // disable mouse reporting + bracketed paste, and reset app cursor keys.
    for (const seq of ['\x1b[?1049l', '\x1b[?25h', '\x1b[?1l', '\x1b[?1000l', '\x1b[?1006l', '\x1b[?2004l']) {
      expect(LOCAL_TERMINAL_RESET_SEQUENCE).toContain(seq);
    }
  });

  it('runs cursor-homing resets before leaving the alt screen (see #1251)', () => {
    // DECSTBM (`\x1b[r`) and DECOM reset (`\x1b[?6l`) both home the cursor.
    // `\x1b[?1049l` restores the main-buffer cursor saved on alt-screen entry,
    // so the homing controls must precede it — otherwise they clobber the
    // restored position and the shell prompt lands at top-left after detach.
    const stbm = LOCAL_TERMINAL_RESET_SEQUENCE.indexOf('\x1b[r');
    const origin = LOCAL_TERMINAL_RESET_SEQUENCE.indexOf('\x1b[?6l');
    const leaveAlt = LOCAL_TERMINAL_RESET_SEQUENCE.indexOf('\x1b[?1049l');
    expect(stbm).toBeGreaterThanOrEqual(0);
    expect(origin).toBeGreaterThanOrEqual(0);
    expect(leaveAlt).toBeGreaterThanOrEqual(0);
    expect(stbm).toBeLessThan(leaveAlt);
    expect(origin).toBeLessThan(leaveAlt);
    // The SGR reset stays last so nothing re-dirties attributes afterward.
    expect(LOCAL_TERMINAL_RESET_SEQUENCE.endsWith('\x1b[0m')).toBe(true);
  });
});

describe('guarded delivery-mode compatibility', () => {
  it('propagates a connection-specific request timeout to the SDK transport', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetch = (async () =>
      new Response(JSON.stringify({ mode: 'auto_inject' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof globalThis.fetch;
    const client = createBrokerClient({ url: 'http://localhost:3889', requestTimeoutMs: 162_500 }, fetch);

    await client.getInboundDeliveryMode('A');

    expect(timeout).toHaveBeenCalledWith(162_500);
    timeout.mockRestore();
  });

  it('treats an omitted matched field as a failed guard', async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ mode: 'auto_inject', flushed: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof globalThis.fetch;
    const client = createBrokerClient({ url: 'http://localhost:3889' }, fetch);

    const result = await client.setInboundDeliveryMode('A', 'auto_inject', {
      expectedMode: 'manual_flush',
      expectedRevision: '7',
    });

    expect(result.matched).toBe(false);
    expect(result.revision).toBeNull();
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
    w.write('a');
    w.write('b');
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
    w.write('a'); // write returns false → paused, drain registered
    w.write('b');
    w.write('c'); // held in the bounded queue
    expect(written).toEqual(['a']);
    accept = true;
    drain?.();
    expect(written).toEqual(['a', 'b', 'c']);
  });

  it('preserves FIFO order when the queue cap is hit (no reordering)', () => {
    const written: string[] = [];
    const stdout: BackpressureWritable = {
      write: (c) => {
        written.push(c);
        return false;
      },
      once: () => undefined,
    };
    const w = createBackpressureAwareWriter(stdout, 2); // 2-byte cap
    w.write('a'); // paused
    w.write('bb'); // exactly fills the cap → queued
    w.write('c'); // over cap → flush the queue first, then this chunk, in order
    // FIFO: 'bb' (already queued) must land before 'c', never after it.
    expect(written).toEqual(['a', 'bb', 'c']);
  });

  it('flushes buffered records in order before disposal', () => {
    const written: string[] = [];
    const accept = false;
    let drain: (() => void) | null = null;
    const stdout: BackpressureWritable = {
      write: (chunk) => {
        written.push(chunk);
        return accept;
      },
      once: (_event, listener) => {
        drain = listener;
        return undefined;
      },
      off: (_event, listener) => {
        if (listener === drain) drain = null;
        return undefined;
      },
    };
    const w = createBackpressureAwareWriter(stdout);
    w.write('first');
    w.write('second');
    w.write('third');
    w.flush();
    w.dispose();
    expect(written).toEqual(['first', 'second', 'third']);
  });

  it('drops the pending queue and unhooks drain on dispose', () => {
    const written: string[] = [];
    let accept = true;
    let drain: (() => void) | null = null;
    let offCalled = false;
    const stdout: BackpressureWritable = {
      write: (c) => {
        written.push(c);
        return accept;
      },
      once: (_event, fn) => {
        drain = fn;
        return undefined;
      },
      off: (_event, fn) => {
        // Unhooking the same listener that `once('drain', …)` registered.
        if (fn === drain) offCalled = true;
        return undefined;
      },
    };
    const w = createBackpressureAwareWriter(stdout);
    accept = false;
    w.write('a'); // paused, drain registered
    w.write('b'); // queued
    expect(written).toEqual(['a']);
    w.dispose();
    expect(offCalled).toBe(true);
    // A late drain (or further writes) must not flush the dropped queue.
    accept = true;
    drain?.();
    w.write('c');
    expect(written).toEqual(['a']);
  });
});

describe('pickInitialTerminalCols', () => {
  it('prefers the local terminal width over the agent PTY width', () => {
    expect(pickInitialTerminalCols({ rows: 24, cols: 66 }, 200)).toBe(66);
  });

  it('falls back to the snapshot width, then to undefined', () => {
    expect(pickInitialTerminalCols(null, 200)).toBe(200);
    expect(pickInitialTerminalCols(null, 0)).toBeUndefined();
    expect(pickInitialTerminalCols(null, undefined)).toBeUndefined();
  });
});

/**
 * Mirror of the renderer's column accounting, for assertions only.
 *
 * Deliberately a separate implementation rather than importing the production
 * one — a width assertion that reuses the code under test proves nothing.
 */
const ZERO_WIDTH: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f],
  [0x200d, 0x200d],
  [0xfe00, 0xfe0f],
];
const DOUBLE_WIDTH: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
];

function columnsOf(text: string): number {
  const hit = (code: number, ranges: ReadonlyArray<readonly [number, number]>) =>
    ranges.some(([lo, hi]) => code >= lo && code <= hi);
  let total = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (hit(code, ZERO_WIDTH)) continue;
    total += hit(code, DOUBLE_WIDTH) ? 2 : 1;
  }
  return total;
}

describe('clampStatusLineText', () => {
  const label = '[drive Gamemaster | delivery=manual_flush | pending=0 | Ctrl+] deliver | Ctrl+C detach]';

  it('passes a label that already fits through untouched', () => {
    expect(clampStatusLineText(label, 120)).toBe(label);
    expect(clampStatusLineText(label, label.length)).toBe(label);
  });

  it('never returns more characters than the terminal is wide', () => {
    for (const cols of [2, 10, 40, 66, 80, 86]) {
      expect(clampStatusLineText(label, cols).length).toBeLessThanOrEqual(cols);
    }
  });

  it('keeps the head and the tail so the verb and the key hints both survive', () => {
    const out = clampStatusLineText(label, 66);
    expect(out.startsWith('[drive Gamemaster')).toBe(true);
    expect(out.endsWith('Ctrl+C detach]')).toBe(true);
    expect(out).toContain('\u2026');
  });

  it('assumes 80 columns when the width is unknown', () => {
    expect(clampStatusLineText(label, undefined).length).toBeLessThanOrEqual(DEFAULT_STATUS_LINE_COLS);
    expect(clampStatusLineText(label, 0).length).toBeLessThanOrEqual(DEFAULT_STATUS_LINE_COLS);
  });

  // A code-unit count would pass these while the row still overflows, which
  // re-arms the wrap/scroll cascade the clamp exists to prevent.
  it('measures wide glyphs as two columns', () => {
    const wide = '[drive 名前ですよろしく | delivery=manual_flush | Ctrl+C detach]';
    for (const cols of [20, 40, 66]) {
      const out = clampStatusLineText(wide, cols);
      expect(columnsOf(out), `overflowed at ${cols}: ${JSON.stringify(out)}`).toBeLessThanOrEqual(cols);
    }
  });

  it('never splits a surrogate pair', () => {
    const emoji = `[drive ${'\u{1F680}'.repeat(20)} | Ctrl+C detach]`;
    for (const cols of [10, 25, 50]) {
      const out = clampStatusLineText(emoji, cols);
      expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      expect(columnsOf(out)).toBeLessThanOrEqual(cols);
    }
  });

  it('can reserve the final terminal column to avoid wrap-pending state', () => {
    expect(clampStatusLineText('1234567890', 10, true)).toBe('1234…7890');
  });

  it('degrades to a bare head rather than wrapping on a pathological width', () => {
    expect(clampStatusLineText(label, 1)).toBe('[');
    expect(clampStatusLineText(label, 0).length).toBeLessThanOrEqual(DEFAULT_STATUS_LINE_COLS);
  });
});
