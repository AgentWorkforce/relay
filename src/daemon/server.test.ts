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
  it('registers blocking SEND with generated correlationId and returns promise', () => {
    const { daemon, router } = createDaemon();
    const sender = makeConnection('conn-sender', 'Sender');

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
          blocking: true,
        },
      },
    };

    const promise = (daemon as any).handleMessage(sender, sendEnvelope);
    expect(promise).toBeInstanceOf(Promise);

    expect(router.route).toHaveBeenCalledTimes(1);
    const routedEnvelope = (router.route as unknown as { mock: { calls: any[][] } }).mock.calls[0][1] as SendEnvelope;
    const correlationId = routedEnvelope.payload_meta?.sync?.correlationId;
    expect(correlationId).toBeTruthy();
    expect((daemon as any).pendingAcks.has(correlationId)).toBe(true);
  });

  it('resolves pending promise when ACK with correlationId arrives', async () => {
    const { daemon, router } = createDaemon();
    const sender = makeConnection('conn-sender', 'Sender');
    const receiver = makeConnection('conn-receiver', 'Receiver');

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
          blocking: true,
        },
      },
    };

    const promise = (daemon as any).handleMessage(sender, sendEnvelope) as Promise<AckPayload>;
    const [correlationId] = Array.from((daemon as any).pendingAcks.keys());

    const ackPayload: AckPayload = {
      ack_id: 'd-1',
      seq: 1,
      correlationId,
      response: 'OK',
    };

    const ackEnvelope: Envelope<AckPayload> = {
      v: PROTOCOL_VERSION,
      type: 'ACK',
      id: 'a-1',
      ts: Date.now(),
      payload: ackPayload,
    };

    (daemon as any).handleAck(receiver, ackEnvelope);

    await expect(promise).resolves.toEqual(ackPayload);
    expect(router.handleAck).toHaveBeenCalledWith(receiver, ackEnvelope);
    expect((daemon as any).pendingAcks.has(correlationId)).toBe(false);
    expect(sender.send).toHaveBeenCalledTimes(1);
    const forwarded = (sender.send as unknown as { mock: { calls: any[][] } }).mock.calls[0][0];
    expect(forwarded.type).toBe('ACK');
    expect(forwarded.payload.correlationId).toBe(correlationId);
  });

  it('rejects with TimeoutError when ACK does not arrive in time', async () => {
    vi.useFakeTimers();
    try {
      const { daemon } = createDaemon();
      const sender = makeConnection('conn-sender', 'Sender');

      const sendEnvelope: SendEnvelope = {
        v: PROTOCOL_VERSION,
        type: 'SEND',
        id: 'm-timeout',
        ts: Date.now(),
        from: 'Sender',
        to: 'Receiver',
        payload: {
          kind: 'message',
          body: 'ping',
        },
        payload_meta: {
          sync: {
            blocking: true,
            timeoutMs: 50,
          },
        },
      };

      const promise = (daemon as any).handleMessage(sender, sendEnvelope) as Promise<AckPayload>;
      await vi.advanceTimersByTimeAsync(60);

      await expect(promise).rejects.toMatchObject({ name: 'TimeoutError' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores duplicate ACKs for the same correlationId', async () => {
    const { daemon } = createDaemon();
    const sender = makeConnection('conn-sender', 'Sender');
    const receiver = makeConnection('conn-receiver', 'Receiver');

    const sendEnvelope: SendEnvelope = {
      v: PROTOCOL_VERSION,
      type: 'SEND',
      id: 'm-dup-ack',
      ts: Date.now(),
      from: 'Sender',
      to: 'Receiver',
      payload: {
        kind: 'message',
        body: 'ping',
      },
      payload_meta: {
        sync: {
          blocking: true,
        },
      },
    };

    const promise = (daemon as any).handleMessage(sender, sendEnvelope) as Promise<AckPayload>;
    const [correlationId] = Array.from((daemon as any).pendingAcks.keys());

    const ackEnvelope: Envelope<AckPayload> = {
      v: PROTOCOL_VERSION,
      type: 'ACK',
      id: 'a-dup-ack',
      ts: Date.now(),
      payload: {
        ack_id: 'd-1',
        seq: 1,
        correlationId,
      },
    };

    (daemon as any).handleAck(receiver, ackEnvelope);
    await promise;

    (daemon as any).handleAck(receiver, ackEnvelope);
    expect(sender.send).toHaveBeenCalledTimes(1);
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
      },
    };

    (daemon as any).handleAck(receiver, ackEnvelope);

    expect(router.handleAck).toHaveBeenCalledWith(receiver, ackEnvelope);
  });

  it('ignores ACK with unmatched correlationId', () => {
    const { daemon, router } = createDaemon();
    const sender = makeConnection('conn-sender', 'Sender');
    const receiver = makeConnection('conn-receiver', 'Receiver');

    const sendEnvelope: SendEnvelope = {
      v: PROTOCOL_VERSION,
      type: 'SEND',
      id: 'm-unmatched',
      ts: Date.now(),
      from: 'Sender',
      to: 'Receiver',
      payload: { kind: 'message', body: 'test' },
      payload_meta: {
        sync: { blocking: true },
      },
    };
    (daemon as any).handleMessage(sender, sendEnvelope);

    const [expectedCorrelationId] = Array.from((daemon as any).pendingAcks.keys());

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

    expect(router.handleAck).toHaveBeenCalledWith(receiver, ackEnvelope);
    expect((daemon as any).pendingAcks.has(expectedCorrelationId)).toBe(true);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('clears pending ACKs when connection disconnects', async () => {
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
        sync: { blocking: true, timeoutMs: 60000 },
      },
    };

    const promise = (daemon as any).handleMessage(sender, sendEnvelope) as Promise<AckPayload>;
    expect((daemon as any).pendingAcks.size).toBe(1);

    (daemon as any).clearPendingAcksForConnection('conn-cleanup');
    expect((daemon as any).pendingAcks.size).toBe(0);

    await expect(promise).rejects.toThrow('Connection closed');
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
          sync: { blocking: true },
        },
      };

      const promise = (daemon as any).handleMessage(sender, sendEnvelope) as Promise<AckPayload>;
      const [correlationId] = Array.from((daemon as any).pendingAcks.keys());

      await vi.advanceTimersByTimeAsync(29000);
      expect((daemon as any).pendingAcks.has(correlationId)).toBe(true);

      await vi.advanceTimersByTimeAsync(2000);
      expect((daemon as any).pendingAcks.has(correlationId)).toBe(false);
      await expect(promise).rejects.toMatchObject({ name: 'TimeoutError' });
    } finally {
      vi.useRealTimers();
    }
  });
});
