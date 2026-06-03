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
