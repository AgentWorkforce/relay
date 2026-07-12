import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for {@link BrokerTransport}'s events-WS lifecycle:
 * - stale close handlers (from a socket superseded by disconnect()+connect())
 *   must not clobber the live socket's state or schedule a duplicate reconnect
 * - message decoding must use `rawDataToString` so fragmented/binary RawData
 *   doesn't get silently dropped
 * - reconnects back off exponentially (capped) instead of retrying at a fixed
 *   2s forever
 *
 * `BrokerTransport` constructs `new WebSocket(...)` internally, so we mock the
 * `ws` module with a controllable fake and grab live instances by index.
 */

type Listener = (...args: unknown[]) => void;

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly url: string;
  readonly listeners = new Map<string, Listener[]>();
  closed = false;

  constructor(url: string, _options?: unknown) {
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

  close(): void {
    this.closed = true;
  }
}

vi.mock('ws', () => ({ default: FakeWebSocket }));

// Import after the mock is registered.
const { BrokerTransport } = await import('./transport.js');

function socketAt(index: number): FakeWebSocket {
  const socket = FakeWebSocket.instances[index];
  if (!socket) throw new Error(`no FakeWebSocket constructed at index ${index}`);
  return socket;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BrokerTransport events WS — stale close guard', () => {
  it('ignores a late close from a socket superseded by disconnect()+connect() (no double delivery, no leaked reconnect)', () => {
    const transport = new BrokerTransport({ baseUrl: 'http://x' });

    transport.connect();
    const socketA = socketAt(0);
    socketA.emit('open');

    // disconnect() synchronously nulls `this.ws` and closes A, but A's real
    // 'close' handshake hasn't fired yet.
    transport.disconnect();
    expect(socketA.closed).toBe(true);

    // connect() before A's close event races in — creates socket B.
    transport.connect();
    expect(FakeWebSocket.instances).toHaveLength(2);
    const socketB = socketAt(1);
    socketB.emit('open');
    expect(transport.connected).toBe(true);

    // A's belated close handshake fires. Pre-fix, this clobbered
    // `_connected`/`this.ws` and scheduled a third connect even though B is
    // live.
    socketA.emit('close');

    expect(transport.connected).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Only B feeds listeners — a message on B must be delivered exactly once.
    const received: unknown[] = [];
    transport.onEvent((event) => received.push(event));
    socketB.emit('message', Buffer.from(JSON.stringify({ kind: 'agent_spawned', name: 'Worker' })));

    expect(received).toHaveLength(1);

    // A stale message on the superseded socket must not be processed either.
    socketA.emit('message', Buffer.from(JSON.stringify({ kind: 'agent_spawned', name: 'Ghost' })));
    expect(received).toHaveLength(1);
  });

  it('ignores a late open/error from a superseded socket', () => {
    const transport = new BrokerTransport({ baseUrl: 'http://x' });

    transport.connect();
    const socketA = socketAt(0);
    transport.disconnect();
    transport.connect();
    const socketB = socketAt(1);

    // A's belated 'open' must not mark the transport connected while B (not
    // yet open) is the live socket.
    socketA.emit('open');
    expect(transport.connected).toBe(false);

    socketB.emit('open');
    expect(transport.connected).toBe(true);

    // A late 'error'/'close' pair from the stale socket must not flip
    // `connected` back to false for the live connection.
    socketA.emit('error', new Error('boom'));
    socketA.emit('close');
    expect(transport.connected).toBe(true);
  });
});

describe('BrokerTransport events WS — message decoding', () => {
  it('decodes a fragmented Buffer[] RawData frame instead of silently dropping it', () => {
    const transport = new BrokerTransport({ baseUrl: 'http://x' });
    transport.connect();
    const socket = socketAt(0);
    socket.emit('open');

    const received: unknown[] = [];
    transport.onEvent((event) => received.push(event));

    const payload = JSON.stringify({ kind: 'agent_spawned', name: 'Worker' });
    const midpoint = Math.floor(payload.length / 2);
    const fragments = [
      Buffer.from(payload.slice(0, midpoint)),
      Buffer.from(payload.slice(midpoint)),
    ];

    socket.emit('message', fragments);

    expect(received).toEqual([{ kind: 'agent_spawned', name: 'Worker' }]);
  });

  it('decodes an ArrayBuffer RawData frame', () => {
    const transport = new BrokerTransport({ baseUrl: 'http://x' });
    transport.connect();
    const socket = socketAt(0);
    socket.emit('open');

    const received: unknown[] = [];
    transport.onEvent((event) => received.push(event));

    const payload = JSON.stringify({ kind: 'agent_spawned', name: 'Worker' });
    const arrayBuffer = new TextEncoder().encode(payload).buffer;

    socket.emit('message', arrayBuffer);

    expect(received).toEqual([{ kind: 'agent_spawned', name: 'Worker' }]);
  });
});

describe('BrokerTransport events WS — reconnect backoff', () => {
  it('backs off exponentially up to a cap, and resets after a successful connect', () => {
    vi.useFakeTimers();
    const transport = new BrokerTransport({ baseUrl: 'http://x' });

    transport.connect();
    socketAt(0).emit('close');
    expect(FakeWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(1999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2); // reconnect #1 at 2s

    socketAt(1).emit('close');
    vi.advanceTimersByTime(3999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3); // reconnect #2 at 4s (doubled)

    socketAt(2).emit('close');
    vi.advanceTimersByTime(7999);
    expect(FakeWebSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(4); // reconnect #3 at 8s (doubled again)

    // A successful open resets the backoff to the initial delay.
    socketAt(3).emit('open');
    socketAt(3).emit('close');
    vi.advanceTimersByTime(1999);
    expect(FakeWebSocket.instances).toHaveLength(4);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(5); // back to 2s after reset
  });

  it('caps the backoff delay instead of growing without bound', () => {
    vi.useFakeTimers();
    const transport = new BrokerTransport({ baseUrl: 'http://x' });

    transport.connect();
    // Repeatedly fail without ever opening, until backoff should be capped.
    // 2s, 4s, 8s, 16s, 30s(capped), 30s(capped) ...
    const expectedDelays = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (let i = 0; i < expectedDelays.length; i += 1) {
      const socket = socketAt(i);
      socket.emit('close');
      const delay = expectedDelays[i];
      vi.advanceTimersByTime(delay - 1);
      expect(FakeWebSocket.instances).toHaveLength(i + 1);
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances).toHaveLength(i + 2);
    }
  });
});
