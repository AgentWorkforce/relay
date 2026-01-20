import { describe, it, expect, vi } from 'vitest';
import type { Envelope, AckPayload, SendEnvelope } from '../protocol/types.js';
import { PROTOCOL_VERSION } from '../protocol/types.js';
import { Daemon } from './server.js';
import type { Connection } from './connection.js';

const makeConnection = (id: string, agentName: string): Connection => ({
  id,
  agentName,
  send: vi.fn(),
} as unknown as Connection);

const createDaemon = () => {
  const daemon = new Daemon({ socketPath: '/tmp/agent-relay-test.sock', pidFilePath: '/tmp/agent-relay-test.sock.pid' });
  const router = {
    route: vi.fn(),
    handleAck: vi.fn(),
    handleMembershipUpdate: vi.fn(),
  };
  (daemon as unknown as { router: typeof router }).router = router;
  return { daemon, router };
};

describe('Daemon pending ACK tracking', () => {
  it('forwards ACK with correlationId to sender and clears pending', () => {
    const { daemon, router } = createDaemon();
    const sender = makeConnection('conn-sender', 'Sender');
    const receiver = makeConnection('conn-receiver', 'Receiver');

    const sendEnvelope: SendEnvelope = {
      v: PROTOCOL_VERSION,
      type: 'SEND',
      id: 'm-1',
      ts: Date.now(),
      from: 'Sender',
      to: 'Receiver',
      payload: {
        kind: 'message',
        body: 'ping',
      },
      payload_meta: {
        sync: {
          correlationId: 'corr-1',
          blocking: true,
        },
      },
    };

    (daemon as any).handleMessage(sender, sendEnvelope);
    expect((daemon as any).pendingAcks.has('corr-1')).toBe(true);

    const ackEnvelope: Envelope<AckPayload> = {
      v: PROTOCOL_VERSION,
      type: 'ACK',
      id: 'a-1',
      ts: Date.now(),
      payload: {
        ack_id: 'd-1',
        seq: 1,
        correlationId: 'corr-1',
        response: 'OK',
      },
    };

    (daemon as any).handleAck(receiver, ackEnvelope);
    expect(router.handleAck).toHaveBeenCalledWith(receiver, ackEnvelope);
    expect((daemon as any).pendingAcks.has('corr-1')).toBe(false);
    expect(sender.send).toHaveBeenCalledTimes(1);
    const forwarded = (sender.send as unknown as { mock: { calls: any[][] } }).mock.calls[0][0];
    expect(forwarded.type).toBe('ACK');
    expect(forwarded.payload.correlationId).toBe('corr-1');
  });

  it('sends ERROR to sender on ACK timeout', async () => {
    vi.useFakeTimers();
    try {
      const { daemon } = createDaemon();
      const sender = makeConnection('conn-sender', 'Sender');

      const sendEnvelope: SendEnvelope = {
        v: PROTOCOL_VERSION,
        type: 'SEND',
        id: 'm-2',
        ts: Date.now(),
        from: 'Sender',
        to: 'Receiver',
        payload: {
          kind: 'message',
          body: 'ping',
        },
        payload_meta: {
          sync: {
            correlationId: 'corr-timeout',
            blocking: true,
            timeoutMs: 50,
          },
        },
      };

      (daemon as any).handleMessage(sender, sendEnvelope);
      await vi.advanceTimersByTimeAsync(60);

      expect(sender.send).toHaveBeenCalledTimes(1);
      const errorEnvelope = (sender.send as unknown as { mock: { calls: any[][] } }).mock.calls[0][0];
      expect(errorEnvelope.type).toBe('ERROR');
      expect(errorEnvelope.payload.message).toContain('ACK timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects duplicate correlationId with ERROR', () => {
    const { daemon } = createDaemon();
    const sender = makeConnection('conn-sender', 'Sender');

    const sendEnvelope: SendEnvelope = {
      v: PROTOCOL_VERSION,
      type: 'SEND',
      id: 'm-dup-1',
      ts: Date.now(),
      from: 'Sender',
      to: 'Receiver',
      payload: { kind: 'message', body: 'first' },
      payload_meta: {
        sync: { correlationId: 'dup-corr', blocking: true },
      },
    };

    // First SEND should register successfully
    (daemon as any).handleMessage(sender, sendEnvelope);
    expect((daemon as any).pendingAcks.has('dup-corr')).toBe(true);

    // Second SEND with same correlationId should fail
    const sender2 = makeConnection('conn-sender2', 'Sender2');
    const dupEnvelope: SendEnvelope = {
      ...sendEnvelope,
      id: 'm-dup-2',
      from: 'Sender2',
    };
    (daemon as any).handleMessage(sender2, dupEnvelope);

    // Should send ERROR to second sender
    expect(sender2.send).toHaveBeenCalledTimes(1);
    const errorEnvelope = (sender2.send as unknown as { mock: { calls: any[][] } }).mock.calls[0][0];
    expect(errorEnvelope.type).toBe('ERROR');
    expect(errorEnvelope.payload.message).toContain('Duplicate correlationId');
  });

  it('sends ERROR when blocking SEND missing correlationId', () => {
    const { daemon } = createDaemon();
    const sender = makeConnection('conn-sender', 'Sender');

    const sendEnvelope: SendEnvelope = {
      v: PROTOCOL_VERSION,
      type: 'SEND',
      id: 'm-no-corr',
      ts: Date.now(),
      from: 'Sender',
      to: 'Receiver',
      payload: { kind: 'message', body: 'test' },
      payload_meta: {
        sync: { blocking: true } as any, // Missing correlationId
      },
    };

    (daemon as any).handleMessage(sender, sendEnvelope);

    expect(sender.send).toHaveBeenCalledTimes(1);
    const errorEnvelope = (sender.send as unknown as { mock: { calls: any[][] } }).mock.calls[0][0];
    expect(errorEnvelope.type).toBe('ERROR');
    expect(errorEnvelope.payload.message).toContain('Missing sync correlationId');
  });

  it('clears pending ACKs when connection disconnects', () => {
    vi.useFakeTimers();
    try {
      const { daemon } = createDaemon();
      const sender = makeConnection('conn-cleanup', 'Sender');

      const sendEnvelope: SendEnvelope = {
        v: PROTOCOL_VERSION,
        type: 'SEND',
        id: 'm-cleanup',
        ts: Date.now(),
        from: 'Sender',
        to: 'Receiver',
        payload: { kind: 'message', body: 'test' },
        payload_meta: {
          sync: { correlationId: 'cleanup-corr', blocking: true, timeoutMs: 60000 },
        },
      };

      (daemon as any).handleMessage(sender, sendEnvelope);
      expect((daemon as any).pendingAcks.has('cleanup-corr')).toBe(true);

      // Simulate connection cleanup
      (daemon as any).clearPendingAcksForConnection('conn-cleanup');
      expect((daemon as any).pendingAcks.has('cleanup-corr')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores ACK without correlationId', () => {
    const { daemon, router } = createDaemon();
    const receiver = makeConnection('conn-receiver', 'Receiver');

    const ackEnvelope: Envelope<AckPayload> = {
      v: PROTOCOL_VERSION,
      type: 'ACK',
      id: 'a-no-corr',
      ts: Date.now(),
      payload: {
        ack_id: 'd-1',
        seq: 1,
        // No correlationId
      },
    };

    (daemon as any).handleAck(receiver, ackEnvelope);

    // Should still call router.handleAck for standard ACK processing
    expect(router.handleAck).toHaveBeenCalledWith(receiver, ackEnvelope);
    // But no forwarding (no pending to match)
  });

  it('ignores ACK with unmatched correlationId', () => {
    const { daemon, router } = createDaemon();
    const sender = makeConnection('conn-sender', 'Sender');
    const receiver = makeConnection('conn-receiver', 'Receiver');

    // Register a pending ACK
    const sendEnvelope: SendEnvelope = {
      v: PROTOCOL_VERSION,
      type: 'SEND',
      id: 'm-unmatched',
      ts: Date.now(),
      from: 'Sender',
      to: 'Receiver',
      payload: { kind: 'message', body: 'test' },
      payload_meta: {
        sync: { correlationId: 'expected-corr', blocking: true },
      },
    };
    (daemon as any).handleMessage(sender, sendEnvelope);

    // ACK with different correlationId
    const ackEnvelope: Envelope<AckPayload> = {
      v: PROTOCOL_VERSION,
      type: 'ACK',
      id: 'a-wrong-corr',
      ts: Date.now(),
      payload: {
        ack_id: 'd-1',
        seq: 1,
        correlationId: 'wrong-corr',
      },
    };

    (daemon as any).handleAck(receiver, ackEnvelope);

    // Router still receives it
    expect(router.handleAck).toHaveBeenCalledWith(receiver, ackEnvelope);
    // But original pending is still there (not resolved)
    expect((daemon as any).pendingAcks.has('expected-corr')).toBe(true);
    // Sender not notified
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('uses default timeout when timeoutMs not specified', async () => {
    vi.useFakeTimers();
    try {
      const { daemon } = createDaemon();
      const sender = makeConnection('conn-default-timeout', 'Sender');

      const sendEnvelope: SendEnvelope = {
        v: PROTOCOL_VERSION,
        type: 'SEND',
        id: 'm-default-timeout',
        ts: Date.now(),
        from: 'Sender',
        to: 'Receiver',
        payload: { kind: 'message', body: 'test' },
        payload_meta: {
          sync: { correlationId: 'default-timeout-corr', blocking: true },
          // No timeoutMs - should use default (30000ms)
        },
      };

      (daemon as any).handleMessage(sender, sendEnvelope);
      expect((daemon as any).pendingAcks.has('default-timeout-corr')).toBe(true);

      // Advance 29 seconds - should still be pending
      await vi.advanceTimersByTimeAsync(29000);
      expect((daemon as any).pendingAcks.has('default-timeout-corr')).toBe(true);

      // Advance past 30 seconds - should timeout
      await vi.advanceTimersByTimeAsync(2000);
      expect((daemon as any).pendingAcks.has('default-timeout-corr')).toBe(false);
      expect(sender.send).toHaveBeenCalledTimes(1);
      const errorEnvelope = (sender.send as unknown as { mock: { calls: any[][] } }).mock.calls[0][0];
      expect(errorEnvelope.type).toBe('ERROR');
    } finally {
      vi.useRealTimers();
    }
  });
});
