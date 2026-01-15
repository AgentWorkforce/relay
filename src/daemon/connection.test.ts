import { describe, it, expect, vi } from 'vitest';
import type { Socket } from 'node:net';
import { Connection } from './connection.js';
import { encodeFrameLegacy, FrameParser } from '../protocol/framing.js';
import { PROTOCOL_VERSION, type Envelope, type HelloPayload, type WelcomePayload } from '../protocol/types.js';

class MockSocket {
  private handlers: Map<string, Array<(...args: any[]) => void>> = new Map();
  private onceHandlers: Map<string, Array<(...args: any[]) => void>> = new Map();
  public written: Buffer[] = [];
  public destroyed = false;

  on(event: string, handler: (...args: any[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  once(event: string, handler: (...args: any[]) => void): this {
    const list = this.onceHandlers.get(event) ?? [];
    list.push(handler);
    this.onceHandlers.set(event, list);
    return this;
  }

  removeListener(event: string, handler: (...args: any[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    const index = list.indexOf(handler);
    if (index >= 0) {
      list.splice(index, 1);
    }

    const onceList = this.onceHandlers.get(event) ?? [];
    const onceIndex = onceList.indexOf(handler);
    if (onceIndex >= 0) {
      onceList.splice(onceIndex, 1);
    }

    return this;
  }

  write(data: Buffer): boolean {
    this.written.push(data);
    return true;
  }

  end(): void {
    this.emit('close');
  }

  destroy(): void {
    this.destroyed = true;
  }

  emit(event: string, ...args: any[]): void {
    // Fire regular handlers
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
    // Fire and clear once handlers
    const onceList = this.onceHandlers.get(event) ?? [];
    this.onceHandlers.set(event, []);
    for (const handler of onceList) {
      handler(...args);
    }
  }
}

function makeHello(agent: string): Envelope<HelloPayload> {
  return {
    v: PROTOCOL_VERSION,
    type: 'HELLO',
    id: 'hello-1',
    ts: Date.now(),
    payload: {
      agent,
      capabilities: {
        ack: true,
        resume: false,
        max_inflight: 256,
        supports_topics: true,
      },
    },
  };
}

describe('Connection', () => {
  it('transitions to ACTIVE after HELLO and fires onActive', async () => {
    const socket = new MockSocket();
    const connection = new Connection(socket as unknown as Socket, { heartbeatMs: 50 });
    const onActive = vi.fn();
    connection.onActive = onActive;

    socket.emit('data', encodeFrameLegacy(makeHello('agent-a')));

    expect(connection.state).toBe('ACTIVE');
    expect(onActive).toHaveBeenCalledTimes(1);
    // Wait for write queue to drain (uses setImmediate)
    await new Promise((r) => setImmediate(r));
    expect(socket.written.length).toBeGreaterThan(0);
  });

  it('drops a client that never PONGs after heartbeat timeout', async () => {
    const socket = new MockSocket();
    const connection = new Connection(socket as unknown as Socket, { heartbeatMs: 10 });
    const onError = vi.fn();
    connection.onError = onError;

    socket.emit('data', encodeFrameLegacy(makeHello('agent-a')));
    expect(connection.state).toBe('ACTIVE');

    await new Promise((r) => setTimeout(r, 100));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
  });

  it('accepts resume token when resumeHandler returns a session', async () => {
    const socket = new MockSocket();
    const parser = new FrameParser();
    parser.setLegacyMode(true);
    const resumeHandler = vi.fn().mockResolvedValue({
      sessionId: 'session-resume',
      resumeToken: 'token-abc',
      seedSequences: [{ topic: 'chat', peer: 'peerA', seq: 5 }],
    });
    const connection = new Connection(socket as unknown as Socket, { heartbeatMs: 50, resumeHandler });
    const onActive = vi.fn();
    connection.onActive = onActive;

    const hello = makeHello('agent-a');
    hello.payload.session = { resume_token: 'token-abc' };
    socket.emit('data', encodeFrameLegacy(hello));

    // Wait for the async resumeHandler to complete
    await vi.waitFor(() => {
      expect(connection.state).toBe('ACTIVE');
    });

    expect(connection.state).toBe('ACTIVE');
    expect(connection.sessionId).toBe('session-resume');
    expect(connection.resumeToken).toBe('token-abc');
    expect(connection.isResumed).toBe(true);
    expect(connection.getNextSeq('chat', 'peerA')).toBe(6); // seeded to 5, next is 6
    expect(onActive).toHaveBeenCalledTimes(1);

    const welcome = parser.push(socket.written[0])?.[0] as Envelope<WelcomePayload>;
    expect(welcome.payload.resume_token).toBe('token-abc');
    expect(welcome.payload.session_id).toBe('session-resume');
  });

  describe('heartbeat timeout configuration', () => {
    it('uses configurable heartbeatTimeoutMultiplier', async () => {
      vi.useFakeTimers();
      try {
        const socket = new MockSocket();
        // 10ms heartbeat * 2 multiplier = 20ms timeout
        const connection = new Connection(socket as unknown as Socket, {
          heartbeatMs: 10,
          heartbeatTimeoutMultiplier: 2,
        });
        const onError = vi.fn();
        connection.onError = onError;

        socket.emit('data', encodeFrameLegacy(makeHello('agent-a')));
        expect(connection.state).toBe('ACTIVE');

        // Wait less than timeout (20ms) - should still be alive
        await vi.advanceTimersByTimeAsync(15);
        expect(onError).not.toHaveBeenCalled();
        expect(connection.state).toBe('ACTIVE');

        // Wait past timeout - should be dead
        await vi.advanceTimersByTimeAsync(30);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(socket.destroyed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('survives with slow but timely pong responses', async () => {
      vi.useFakeTimers();
      try {
        const socket = new MockSocket();
        // 20ms heartbeat * 3 multiplier = 60ms timeout
        const connection = new Connection(socket as unknown as Socket, {
          heartbeatMs: 20,
          heartbeatTimeoutMultiplier: 3,
        });
        const onError = vi.fn();
        const onPong = vi.fn();
        connection.onError = onError;
        connection.onPong = onPong;

        socket.emit('data', encodeFrameLegacy(makeHello('agent-a')));
        expect(connection.state).toBe('ACTIVE');

        // Simulate slow but valid pong responses every 40ms (within 60ms timeout)
        for (let i = 0; i < 3; i++) {
          await vi.advanceTimersByTimeAsync(40);
          // Send PONG before timeout expires
          socket.emit('data', encodeFrameLegacy({
            v: PROTOCOL_VERSION,
            type: 'PONG',
            id: `pong-${i}`,
            ts: Date.now(),
            payload: { nonce: 'test' },
          }));
        }

        // Connection should still be alive after multiple slow pongs
        expect(onError).not.toHaveBeenCalled();
        expect(connection.state).toBe('ACTIVE');
        expect(onPong).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('dies when pong arrives too late', async () => {
      vi.useFakeTimers();
      try {
        const socket = new MockSocket();
        // 10ms heartbeat * 2 multiplier = 20ms timeout
        const connection = new Connection(socket as unknown as Socket, {
          heartbeatMs: 10,
          heartbeatTimeoutMultiplier: 2,
        });
        const onError = vi.fn();
        connection.onError = onError;

        socket.emit('data', encodeFrameLegacy(makeHello('agent-a')));
        expect(connection.state).toBe('ACTIVE');

        // Wait past timeout before sending pong
        await vi.advanceTimersByTimeAsync(50);

        // Connection should already be dead
        expect(onError).toHaveBeenCalledTimes(1);
        expect(socket.destroyed).toBe(true);

        // Late pong should have no effect (connection already dead)
        socket.emit('data', encodeFrameLegacy({
          v: PROTOCOL_VERSION,
          type: 'PONG',
          id: 'late-pong',
          ts: Date.now(),
          payload: { nonce: 'test' },
        }));

        // Error count should not increase
        expect(onError).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('uses default multiplier of 6 when not specified', async () => {
      vi.useFakeTimers();
      try {
        const socket = new MockSocket();
        // 10ms heartbeat * 6 (default) = 60ms timeout
        const connection = new Connection(socket as unknown as Socket, {
          heartbeatMs: 10,
          // heartbeatTimeoutMultiplier not specified - should default to 6
        });
        const onError = vi.fn();
        connection.onError = onError;

        socket.emit('data', encodeFrameLegacy(makeHello('agent-a')));
        expect(connection.state).toBe('ACTIVE');

        // Wait 40ms - should still be alive (timeout is 60ms)
        await vi.advanceTimersByTimeAsync(40);
        expect(onError).not.toHaveBeenCalled();
        expect(connection.state).toBe('ACTIVE');

        // Wait total of 80ms - should be dead
        await vi.advanceTimersByTimeAsync(50);
        expect(onError).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('write queue and backpressure', () => {
    it('uses write queue for sending messages', async () => {
      const socket = new MockSocket();
      const connection = new Connection(socket as unknown as Socket, { heartbeatMs: 50 });

      socket.emit('data', encodeFrameLegacy(makeHello('agent-a')));
      expect(connection.state).toBe('ACTIVE');

      // Wait for write queue to drain
      await new Promise((r) => setImmediate(r));

      // Should have sent WELCOME
      expect(socket.written.length).toBeGreaterThan(0);
    });

    it('drops messages when queue is full', async () => {
      const socket = new MockSocket();
      const connection = new Connection(socket as unknown as Socket, {
        heartbeatMs: 50,
        maxWriteQueueSize: 5,
      });

      socket.emit('data', encodeFrameLegacy(makeHello('agent-a')));

      // Block the drain loop by making socket always return false
      socket.write = () => false;

      // Fill the queue
      for (let i = 0; i < 10; i++) {
        connection.send({
          v: PROTOCOL_VERSION,
          type: 'PING',
          id: `ping-${i}`,
          ts: Date.now(),
          payload: { nonce: 'test' },
        });
      }

      // Queue should be at max size, some should have been dropped
      expect(connection.writeQueueLength).toBeLessThanOrEqual(5);
    });

    it('signals backpressure when queue exceeds high water mark', async () => {
      const socket = new MockSocket();
      socket.write = () => false; // Block writes

      const connection = new Connection(socket as unknown as Socket, {
        heartbeatMs: 50,
        maxWriteQueueSize: 2000,
        writeQueueHighWaterMark: 5,
        writeQueueLowWaterMark: 2,
      });

      const onBackpressure = vi.fn();
      connection.onBackpressure = onBackpressure;

      socket.emit('data', encodeFrameLegacy(makeHello('agent-a')));

      // Send enough to exceed high water mark
      for (let i = 0; i < 10; i++) {
        connection.send({
          v: PROTOCOL_VERSION,
          type: 'PING',
          id: `pressure-${i}`,
          ts: Date.now(),
          payload: { nonce: 'test' },
        });
      }

      // Wait for drain scheduling
      await new Promise((r) => setImmediate(r));

      expect(connection.backpressured).toBe(true);
      expect(onBackpressure).toHaveBeenCalledWith(true);
    });

    it('releases backpressure when queue drains below low water mark', async () => {
      const socket = new MockSocket();
      let blockWrites = true;
      socket.write = () => !blockWrites;

      const connection = new Connection(socket as unknown as Socket, {
        heartbeatMs: 50,
        maxWriteQueueSize: 2000,
        writeQueueHighWaterMark: 5,
        writeQueueLowWaterMark: 2,
      });

      const onBackpressure = vi.fn();
      connection.onBackpressure = onBackpressure;

      socket.emit('data', encodeFrameLegacy(makeHello('agent-a')));

      // Fill queue to trigger backpressure
      for (let i = 0; i < 10; i++) {
        connection.send({
          v: PROTOCOL_VERSION,
          type: 'PING',
          id: `drain-${i}`,
          ts: Date.now(),
          payload: { nonce: 'test' },
        });
      }

      await new Promise((r) => setImmediate(r));
      expect(connection.backpressured).toBe(true);

      // Allow writes
      blockWrites = false;

      // Trigger drain by simulating socket drain event
      socket.emit('drain');

      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Queue should be empty, backpressure released
      expect(connection.writeQueueLength).toBe(0);
      expect(connection.backpressured).toBe(false);
      expect(onBackpressure).toHaveBeenCalledWith(false);
    });

    it('waits for socket drain event when buffer is full', async () => {
      const socket = new MockSocket();
      let writeCount = 0;

      // First write returns true, subsequent return false
      socket.write = () => {
        writeCount++;
        return writeCount <= 1;
      };

      const connection = new Connection(socket as unknown as Socket, { heartbeatMs: 50 });

      socket.emit('data', encodeFrameLegacy(makeHello('agent-a')));

      // Queue multiple messages
      for (let i = 0; i < 5; i++) {
        connection.send({
          v: PROTOCOL_VERSION,
          type: 'PING',
          id: `wait-${i}`,
          ts: Date.now(),
          payload: { nonce: 'test' },
        });
      }

      await new Promise((r) => setImmediate(r));

      // Not all messages written yet (waiting for drain)
      expect(connection.writeQueueLength).toBeGreaterThan(0);

      // Allow all writes
      socket.write = () => true;
      socket.emit('drain');

      await new Promise((r) => setImmediate(r));

      // All messages should now be drained
      expect(connection.writeQueueLength).toBe(0);
    });

    it('clears write queue on close', async () => {
      const socket = new MockSocket();
      socket.write = () => false; // Block writes

      const connection = new Connection(socket as unknown as Socket, { heartbeatMs: 50 });

      socket.emit('data', encodeFrameLegacy(makeHello('agent-a')));

      // Queue some messages
      for (let i = 0; i < 5; i++) {
        connection.send({
          v: PROTOCOL_VERSION,
          type: 'PING',
          id: `close-queue-${i}`,
          ts: Date.now(),
          payload: { nonce: 'test' },
        });
      }

      await new Promise((r) => setImmediate(r));
      expect(connection.writeQueueLength).toBeGreaterThan(0);

      // Trigger close
      socket.emit('close');

      expect(connection.writeQueueLength).toBe(0);
      expect(connection.backpressured).toBe(false);
    });

    it('does not send to closed connection', async () => {
      const socket = new MockSocket();
      const connection = new Connection(socket as unknown as Socket, { heartbeatMs: 50 });

      socket.emit('data', encodeFrameLegacy(makeHello('agent-a')));
      socket.emit('close');

      expect(connection.state).toBe('CLOSED');

      const result = connection.send({
        v: PROTOCOL_VERSION,
        type: 'PING',
        id: 'after-close',
        ts: Date.now(),
        payload: { nonce: 'test' },
      });

      expect(result).toBe(false);
    });
  });
});
