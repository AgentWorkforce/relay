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
        response: true,
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
});
