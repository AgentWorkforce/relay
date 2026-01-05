import { describe, it, expect, vi } from 'vitest';
import type { Socket } from 'node:net';
import { Connection } from './connection.js';
import { encodeFrame, FrameParser } from '../protocol/framing.js';
import { PROTOCOL_VERSION, type Envelope, type HelloPayload, type WelcomePayload } from '../protocol/types.js';

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

  it('accepts resume token when resumeHandler returns a session', async () => {
    const socket = new MockSocket();
    const parser = new FrameParser();
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
    socket.emit('data', encodeFrame(hello));

    await new Promise((r) => setTimeout(r, 0));

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

        socket.emit('data', encodeFrame(makeHello('agent-a')));
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

        socket.emit('data', encodeFrame(makeHello('agent-a')));
        expect(connection.state).toBe('ACTIVE');

        // Simulate slow but valid pong responses every 40ms (within 60ms timeout)
        for (let i = 0; i < 3; i++) {
          await vi.advanceTimersByTimeAsync(40);
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

        socket.emit('data', encodeFrame(makeHello('agent-a')));
        expect(connection.state).toBe('ACTIVE');

        // Wait past timeout before sending pong
        await vi.advanceTimersByTimeAsync(50);

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

        socket.emit('data', encodeFrame(makeHello('agent-a')));
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
});
