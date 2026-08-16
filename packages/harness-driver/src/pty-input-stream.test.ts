import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for {@link PtyInputStream}'s pipelining: queued keystrokes are
 * sent eagerly (no stop-and-wait), settled FIFO as acks arrive, and the
 * stream reports an input→ack SRTT for adaptive predictive echo.
 *
 * `PtyInputStream` constructs `new WebSocket(...)` internally, so we mock the
 * `ws` module with a controllable fake and grab the live instance.
 */

type Listener = (...args: unknown[]) => void;

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly url: string;
  readonly listeners = new Map<string, Listener[]>();
  /** Every send() call: the payload plus its completion callback. */
  readonly sends: Array<{ data: unknown; cb: (err?: Error) => void }> = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  on(event: string, listener: Listener): this {
    const bucket = this.listeners.get(event) ?? [];
    bucket.push(listener);
    this.listeners.set(event, bucket);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }

  send(data: unknown, cb: (err?: Error) => void): void {
    this.sends.push({ data, cb });
  }

  close(): void {
    this.closed = true;
  }

  /** Test helper: complete the WS open + broker readiness handshake. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
    this.emit('message', Buffer.from(JSON.stringify({ type: 'pty_input_ready', name: 'agent' })));
  }

  /** Test helper: deliver one ack (FIFO settles the oldest in-flight send). */
  ack(bytesWritten?: number): void {
    this.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'pty_input_ack', name: 'agent', bytes_written: bytesWritten }))
    );
  }

  /**
   * Test helper: deliver a `pty_input_error` frame, as the broker now sends
   * when the worker reports the PTY write failed (instead of a premature ack).
   */
  errorFrame(code = 'pty_write_failed', message = 'broken pipe'): void {
    this.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'pty_input_error', code, message, retryable: false }))
    );
  }
}

vi.mock('ws', () => ({ default: FakeWebSocket }));

// Import after the mock is registered.
const { PtyInputStream } = await import('./transport.js');

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error('no FakeWebSocket constructed');
  return socket;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PtyInputStream pipelining', () => {
  it('sends every queued keystroke without waiting for prior acks', async () => {
    const stream = new PtyInputStream({ url: 'ws://x/api/input/agent/stream' });
    const socket = lastSocket();
    socket.open();
    await stream.waitUntilOpen();

    // Three keystrokes typed faster than any ack returns.
    const p1 = stream.send('a');
    const p2 = stream.send('b');
    const p3 = stream.send('c');
    await Promise.resolve();

    // All three are on the wire — NOT serialized one-ack-at-a-time.
    expect(socket.sends.map((s) => s.data)).toEqual(['a', 'b', 'c']);

    // Acks settle them in send order.
    socket.ack(1);
    await expect(p1).resolves.toMatchObject({ bytes_written: 1 });
    socket.ack(1);
    await expect(p2).resolves.toMatchObject({ bytes_written: 1 });
    socket.ack(1);
    await expect(p3).resolves.toMatchObject({ bytes_written: 1 });
  });

  it('reports a smoothed input→ack SRTT once acks arrive', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const stream = new PtyInputStream({ url: 'ws://x/api/input/agent/stream' });
    const socket = lastSocket();
    socket.open();
    await stream.waitUntilOpen();

    expect(stream.srttMs).toBeNull();

    const p = stream.send('a');
    await Promise.resolve();
    vi.setSystemTime(40); // 40ms round-trip
    socket.ack(1);
    await p;

    expect(stream.srttMs).toBe(40);
  });

  it('rejects past the high water mark (backpressure)', async () => {
    const stream = new PtyInputStream({
      url: 'ws://x/api/input/agent/stream',
      highWaterMarkBytes: 4,
    });
    const socket = lastSocket();
    socket.open();
    await stream.waitUntilOpen();

    const ok = stream.send('abcd'); // exactly at the mark
    await Promise.resolve();
    await expect(stream.send('e')).rejects.toMatchObject({ code: 'input_backpressure' });

    socket.ack(4);
    await expect(ok).resolves.toMatchObject({ bytes_written: 4 });
  });

  it('rejects the in-flight send when the worker reports a write failure', async () => {
    // The broker now holds the ack until the PTY write is confirmed and sends a
    // pty_input_error frame if the worker's write fails. The send() must reject
    // (not resolve) so the CLI predictive-echo rollback runs for a keystroke
    // that never reached the agent.
    const stream = new PtyInputStream({ url: 'ws://x/api/input/agent/stream' });
    const socket = lastSocket();
    socket.open();
    await stream.waitUntilOpen();

    const p = stream.send('x');
    await Promise.resolve();
    expect(socket.sends.map((s) => s.data)).toEqual(['x']);

    socket.errorFrame('pty_write_failed', 'broken pipe');

    await expect(p).rejects.toMatchObject({ code: 'pty_write_failed' });
    expect(stream.closed).toBe(true);
  });

  it('relay#1544 MUST-FIRE: a worker_timeout on one write must not close the stream', async () => {
    // The broker keeps the socket open for `worker_timeout` (the write may
    // simply be a busy worker, not a dead one — see
    // `pty_input_error_is_connection_fatal` on the broker side). Only that
    // one write should reject; the stream itself must stay usable so the
    // next keystroke doesn't have to go through a full reconnect. Before the
    // fix, `handleMessage` closed on every `pty_input_error` unconditionally
    // and this assertion on `stream.closed` failed.
    const stream = new PtyInputStream({ url: 'ws://x/api/input/agent/stream' });
    const socket = lastSocket();
    socket.open();
    await stream.waitUntilOpen();

    const p1 = stream.send('x');
    await Promise.resolve();
    socket.errorFrame('worker_timeout', 'worker_timeout: worker did not respond in time');

    await expect(p1).rejects.toMatchObject({ code: 'worker_timeout' });
    expect(stream.closed).toBe(false);

    // The stream is still usable for the next keystroke.
    const p2 = stream.send('y');
    await Promise.resolve();
    socket.ack(1);
    await expect(p2).resolves.toMatchObject({ bytes_written: 1 });
  });

  it('relay#1544 MUST-NOT-FIRE: a confirmed-dead worker still closes the stream', async () => {
    // `worker_disappeared` means the worker was reaped independently — a
    // genuine outage, not a slow ack. This must still close the stream so
    // the CLI's existing reconnect-on-close recovery still runs.
    const stream = new PtyInputStream({ url: 'ws://x/api/input/agent/stream' });
    const socket = lastSocket();
    socket.open();
    await stream.waitUntilOpen();

    const p = stream.send('x');
    await Promise.resolve();
    socket.errorFrame('worker_disappeared', "worker 'agent' exited before responding");

    await expect(p).rejects.toMatchObject({ code: 'worker_disappeared' });
    expect(stream.closed).toBe(true);
  });

  it('fails all in-flight and queued frames on close', async () => {
    const stream = new PtyInputStream({ url: 'ws://x/api/input/agent/stream' });
    const socket = lastSocket();
    socket.open();
    await stream.waitUntilOpen();

    const p1 = stream.send('a');
    const p2 = stream.send('b');
    await Promise.resolve();
    socket.emit('close', 1006, Buffer.from('gone'));

    await expect(p1).rejects.toMatchObject({ code: 'input_stream_closed' });
    await expect(p2).rejects.toMatchObject({ code: 'input_stream_closed' });
  });
});

describe('PtyInputStream after its socket closes', () => {
  /**
   * The CLI's recovery logic (attach-input-recovery.ts) is built on the
   * assumption that this stream never heals itself, so that assumption is
   * pinned here. If PtyInputStream ever grows its own reconnect, this test
   * fails and the CLI-side recovery must be revisited rather than silently
   * doubling up.
   */
  it('latches closed and rejects every later send with the same message', async () => {
    const stream = new PtyInputStream({ url: 'ws://x/api/input/agent/stream' });
    const socket = lastSocket();
    socket.open();
    await stream.waitUntilOpen();

    // An idle-timeout reap or a PTY worker restart: abnormal close, no warning.
    socket.emit('close', 1006, Buffer.from(''));
    expect(stream.closed).toBe(true);

    const messages: string[] = [];
    for (let i = 0; i < 50; i++) {
      await stream.send('x').catch((err: Error) => messages.push(err.message));
    }

    // Every send rejects — no retry, no backoff, no self-heal. This exact
    // string is what used to reach the terminal once per keystroke (#1419).
    expect(messages).toHaveLength(50);
    expect([...new Set(messages)]).toEqual(['PTY input stream is closed']);
    // Nothing was put back on the wire, and no replacement socket was opened.
    expect(socket.sends).toHaveLength(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
