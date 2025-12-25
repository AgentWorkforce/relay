import { describe, it, expect, vi } from 'vitest';
import type { Socket } from 'node:net';
import { Connection } from './connection.js';
import { encodeFrame } from '../protocol/framing.js';
import { PROTOCOL_VERSION, type Envelope, type HelloPayload } from '../protocol/types.js';

class MockSocket {
  private handlers: Map<string, Array<(...args: any[]) => void>> = new Map();
  public written: Buffer[] = [];
  public destroyed = false;

  on(event: string, handler: (...args: any[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
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
    for (const handler of this.handlers.get(event) ?? []) {
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
  it('transitions to ACTIVE after HELLO and fires onActive', () => {
    const socket = new MockSocket();
    const connection = new Connection(socket as unknown as Socket, { heartbeatMs: 50 });
    const onActive = vi.fn();
    connection.onActive = onActive;

    socket.emit('data', encodeFrame(makeHello('agent-a')));

    expect(connection.state).toBe('ACTIVE');
    expect(onActive).toHaveBeenCalledTimes(1);
    expect(socket.written.length).toBeGreaterThan(0);
  });

  it('drops a client that never PONGs after heartbeat timeout', async () => {
    const socket = new MockSocket();
    const connection = new Connection(socket as unknown as Socket, { heartbeatMs: 10 });
    const onError = vi.fn();
    connection.onError = onError;

    socket.emit('data', encodeFrame(makeHello('agent-a')));
    expect(connection.state).toBe('ACTIVE');

    await new Promise((r) => setTimeout(r, 100));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
  });

  describe('heartbeat timeout configuration', () => {
    it('uses configurable heartbeatTimeoutMultiplier', async () => {
      const socket = new MockSocket();
      // 10ms heartbeat * 2 multiplier = 20ms timeout
      const connection = new Connection(socket as unknown as Socket, {
        heartbeatMs: 10,
        heartbeatTimeoutMultiplier: 2,
      });
      const onError = vi.fn();
      connection.onError = onError;

      socket.emit('data', encodeFrame(makeHello('agent-a')));
      expect(connection.state).toBe('ACTIVE');

      // Wait less than timeout (20ms) - should still be alive
      await new Promise((r) => setTimeout(r, 15));
      expect(onError).not.toHaveBeenCalled();
      expect(connection.state).toBe('ACTIVE');

      // Wait past timeout - should be dead
      await new Promise((r) => setTimeout(r, 30));
      expect(onError).toHaveBeenCalledTimes(1);
      expect(socket.destroyed).toBe(true);
    });

    it('survives with slow but timely pong responses', async () => {
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

      socket.emit('data', encodeFrame(makeHello('agent-a')));
      expect(connection.state).toBe('ACTIVE');

      // Simulate slow but valid pong responses every 40ms (within 60ms timeout)
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 40));
        // Send PONG before timeout expires
        socket.emit('data', encodeFrame({
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
    });

    it('dies when pong arrives too late', async () => {
      const socket = new MockSocket();
      // 10ms heartbeat * 2 multiplier = 20ms timeout
      const connection = new Connection(socket as unknown as Socket, {
        heartbeatMs: 10,
        heartbeatTimeoutMultiplier: 2,
      });
      const onError = vi.fn();
      connection.onError = onError;

      socket.emit('data', encodeFrame(makeHello('agent-a')));
      expect(connection.state).toBe('ACTIVE');

      // Wait past timeout before sending pong
      await new Promise((r) => setTimeout(r, 50));

      // Connection should already be dead
      expect(onError).toHaveBeenCalledTimes(1);
      expect(socket.destroyed).toBe(true);

      // Late pong should have no effect (connection already dead)
      socket.emit('data', encodeFrame({
        v: PROTOCOL_VERSION,
        type: 'PONG',
        id: 'late-pong',
        ts: Date.now(),
        payload: { nonce: 'test' },
      }));

      // Error count should not increase
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('uses default multiplier of 6 when not specified', async () => {
      const socket = new MockSocket();
      // 10ms heartbeat * 6 (default) = 60ms timeout
      const connection = new Connection(socket as unknown as Socket, {
        heartbeatMs: 10,
        // heartbeatTimeoutMultiplier not specified - should default to 6
      });
      const onError = vi.fn();
      connection.onError = onError;

      socket.emit('data', encodeFrame(makeHello('agent-a')));
      expect(connection.state).toBe('ACTIVE');

      // Wait 40ms - should still be alive (timeout is 60ms)
      await new Promise((r) => setTimeout(r, 40));
      expect(onError).not.toHaveBeenCalled();
      expect(connection.state).toBe('ACTIVE');

      // Wait total of 80ms - should be dead
      await new Promise((r) => setTimeout(r, 50));
      expect(onError).toHaveBeenCalledTimes(1);
    });
  });
});
