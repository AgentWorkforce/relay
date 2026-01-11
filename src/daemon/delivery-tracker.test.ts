import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DeliveryTracker, type DeliveryTrackerConnection } from './delivery-tracker.js';
import type { DeliverEnvelope } from '../protocol/types.js';

function createDeliverEnvelope(id: string, from = 'agent1', to = 'agent2'): DeliverEnvelope {
  return {
    v: 1,
    type: 'DELIVER',
    id,
    ts: Date.now(),
    from,
    to,
    payload: {
      kind: 'message',
      body: 'test message',
    },
    delivery: {
      seq: 1,
      session_id: 'session-1',
    },
  };
}

class MockConnection implements DeliveryTrackerConnection {
  id: string;
  sent: DeliverEnvelope[] = [];
  sendMock = vi.fn();
  private sendReturnValue = true;

  constructor(id: string) {
    this.id = id;
  }

  send(envelope: DeliverEnvelope): boolean {
    this.sent.push(envelope);
    this.sendMock(envelope);
    return this.sendReturnValue;
  }

  setSendReturnValue(value: boolean): void {
    this.sendReturnValue = value;
  }
}

describe('DeliveryTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks deliveries and clears on ACK from same connection', () => {
    const conn = new MockConnection('conn-1');
    const tracker = new DeliveryTracker({
      getConnection: (id) => (id === conn.id ? conn : undefined),
      delivery: { ackTimeoutMs: 10, maxAttempts: 2, deliveryTtlMs: 100 },
    });

    tracker.track(conn, createDeliverEnvelope('deliver-1'));
    expect(tracker.pendingCount).toBe(1);

    tracker.handleAck(conn.id, 'deliver-1');
    expect(tracker.pendingCount).toBe(0);
  });

  it('ignores ACKs from a different connection', () => {
    const conn = new MockConnection('conn-1');
    const tracker = new DeliveryTracker({
      getConnection: (id) => (id === conn.id ? conn : undefined),
      delivery: { ackTimeoutMs: 10, maxAttempts: 2, deliveryTtlMs: 100 },
    });

    tracker.track(conn, createDeliverEnvelope('deliver-1'));
    tracker.handleAck('conn-2', 'deliver-1');
    expect(tracker.pendingCount).toBe(1);
  });

  it('retries until max attempts then drops', () => {
    const conn = new MockConnection('conn-1');
    const tracker = new DeliveryTracker({
      getConnection: (id) => (id === conn.id ? conn : undefined),
      delivery: { ackTimeoutMs: 5, maxAttempts: 3, deliveryTtlMs: 100 },
    });

    tracker.track(conn, createDeliverEnvelope('deliver-1'));
    expect(tracker.pendingCount).toBe(1);

    vi.advanceTimersByTime(5 * 3 + 1);
    expect(conn.sent).toHaveLength(2);
    expect(tracker.pendingCount).toBe(0);
  });

  it('drops after TTL expires', () => {
    const conn = new MockConnection('conn-1');
    const updateMessageStatus = vi.fn();
    const tracker = new DeliveryTracker({
      getConnection: (id) => (id === conn.id ? conn : undefined),
      delivery: { ackTimeoutMs: 5, maxAttempts: 10, deliveryTtlMs: 12 },
      storage: {
        init: async () => {},
        saveMessage: async () => {},
        getMessages: async () => [],
        updateMessageStatus,
      },
    });

    tracker.track(conn, createDeliverEnvelope('deliver-1'));
    vi.advanceTimersByTime(16);

    expect(tracker.pendingCount).toBe(0);
    expect(updateMessageStatus).toHaveBeenCalledWith('deliver-1', 'failed');
  });

  it('clears pending deliveries for a connection', () => {
    const conn = new MockConnection('conn-1');
    const tracker = new DeliveryTracker({
      getConnection: (id) => (id === conn.id ? conn : undefined),
      delivery: { ackTimeoutMs: 10, maxAttempts: 2, deliveryTtlMs: 100 },
    });

    tracker.track(conn, createDeliverEnvelope('deliver-1'));
    tracker.track(conn, createDeliverEnvelope('deliver-2'));
    expect(tracker.pendingCount).toBe(2);

    tracker.clearPendingForConnection(conn.id);
    expect(tracker.pendingCount).toBe(0);
  });
});
