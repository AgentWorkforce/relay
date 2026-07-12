import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for {@link HarnessDriverClient.subscribeWorkerStream}'s
 * backpressure policy: the per-iterator queue is bounded, dropping the
 * oldest buffered chunk (and logging once) rather than growing without
 * limit when the consumer isn't pulling fast enough.
 *
 * `BrokerTransport` constructs `new WebSocket(...)` internally, so we mock
 * the `ws` module with a controllable fake and grab the live instance.
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
const { HarnessDriverClient } = await import('./client.js');

function emitWorkerStream(socket: FakeWebSocket, name: string, chunk: string): void {
  socket.emit('message', Buffer.from(JSON.stringify({ kind: 'worker_stream', name, stream: 'stdout', chunk })));
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('subscribeWorkerStream backpressure', () => {
  it('drops the oldest buffered chunk once the queue exceeds maxQueueSize, warning once', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = new HarnessDriverClient({ baseUrl: 'http://x' });

    const iterable = client.subscribeWorkerStream('Worker', { maxQueueSize: 3 });
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    const iterator = iterable[Symbol.asyncIterator]();

    // Never call .next() — every chunk lands in the queue.
    for (const chunk of ['a', 'b', 'c', 'd', 'e']) {
      emitWorkerStream(socket, 'Worker', chunk);
    }

    const drained: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { value, done } = await iterator.next();
      expect(done).toBe(false);
      drained.push(value as string);
    }

    // Oldest ('a', 'b') were dropped to make room; only the most recent 3 remain.
    expect(drained).toEqual(['c', 'd', 'e']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('subscribeWorkerStream');
  });

  it('does not drop chunks when under the cap', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = new HarnessDriverClient({ baseUrl: 'http://x' });

    const iterable = client.subscribeWorkerStream('Worker', { maxQueueSize: 3 });
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    const iterator = iterable[Symbol.asyncIterator]();
    emitWorkerStream(socket, 'Worker', 'a');
    emitWorkerStream(socket, 'Worker', 'b');

    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'a' });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'b' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('defaults to a bounded queue when maxQueueSize is not specified', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = new HarnessDriverClient({ baseUrl: 'http://x' });

    const iterable = client.subscribeWorkerStream('Worker');
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    const iterator = iterable[Symbol.asyncIterator]();
    // Comfortably below the default cap (10000) — nothing should be dropped.
    for (let i = 0; i < 50; i += 1) {
      emitWorkerStream(socket, 'Worker', String(i));
    }

    await expect(iterator.next()).resolves.toEqual({ done: false, value: '0' });
    expect(warn).not.toHaveBeenCalled();
  });
});
