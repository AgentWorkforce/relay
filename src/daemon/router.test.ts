/**
 * Unit tests for the Router class.
 * Tests agent registration, message routing, broadcasts, and topic subscriptions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Router } from './router.js';
import type { Connection } from './connection.js';
import type { StorageAdapter, StoredMessage } from '../storage/adapter.js';
import type { Envelope, SendPayload, DeliverEnvelope, AckPayload } from '../protocol/types.js';

/**
 * Mock Connection class for testing.
 */
class MockConnection implements Pick<Connection, 'id' | 'agentName' | 'sessionId' | 'send' | 'getNextSeq' | 'close'> {
  id: string;
  agentName: string | undefined;
  sessionId: string;
  sentEnvelopes: Envelope[] = [];
  private sequences: Map<string, number> = new Map();
  sendMock = vi.fn();
  closeMock = vi.fn();
  private sendReturnValue = true;

  constructor(id: string, agentName?: string, sessionId = 'session-1') {
    this.id = id;
    this.agentName = agentName;
    this.sessionId = sessionId;
  }

  send(envelope: Envelope): boolean {
    this.sentEnvelopes.push(envelope);
    this.sendMock(envelope);
    return this.sendReturnValue;
  }

  setSendReturnValue(value: boolean): void {
    this.sendReturnValue = value;
  }

  getNextSeq(topic: string, peer: string): number {
    const key = `${topic}:${peer}`;
    const seq = (this.sequences.get(key) ?? 0) + 1;
    this.sequences.set(key, seq);
    return seq;
  }

  close(): void {
    this.closeMock();
  }

  clearSent(): void {
    this.sentEnvelopes = [];
  }
}

/**
 * Helper to create a SEND envelope.
 */
function createSendEnvelope(from: string, to: string, topic?: string): Envelope<SendPayload> {
  return {
    v: 1,
    type: 'SEND',
    id: 'msg-1',
    ts: Date.now(),
    from,
    to,
    topic,
    payload: {
      kind: 'message',
      body: 'test message',
    },
  };
}

describe('Router', () => {
  let router: Router;
  let storage: StorageAdapter;
  let saved: StoredMessage[];

  beforeEach(() => {
    saved = [];
    storage = {
      init: async () => {},
      saveMessage: async (message) => { saved.push(message); },
      getMessages: async () => saved,
    };
    router = new Router({ storage });
  });

  describe('Registration', () => {
    it('should register a connection with agent name', () => {
      const conn = new MockConnection('conn-1', 'agent1');
      router.register(conn);

      expect(router.getAgents()).toEqual(['agent1']);
      expect(router.getConnection('agent1')).toBe(conn);
      expect(router.connectionCount).toBe(1);
    });

    it('should register a connection without agent name', () => {
      const conn = new MockConnection('conn-1');
      router.register(conn);

      expect(router.getAgents()).toEqual([]);
      expect(router.connectionCount).toBe(1);
    });

    it('should handle duplicate agent names by closing old connection', () => {
      const conn1 = new MockConnection('conn-1', 'agent1');
      const conn2 = new MockConnection('conn-2', 'agent1');

      router.register(conn1);
      router.register(conn2);

      expect(conn1.closeMock).toHaveBeenCalledOnce();
      expect(router.getAgents()).toEqual(['agent1']);
      expect(router.getConnection('agent1')).toBe(conn2);
      expect(router.connectionCount).toBe(1); // conn1 was removed
    });

    it('should not close connection when re-registering same connection', () => {
      const conn = new MockConnection('conn-1', 'agent1');

      router.register(conn);
      router.register(conn); // Re-register same connection

      expect(conn.closeMock).not.toHaveBeenCalled();
      expect(router.connectionCount).toBe(1);
    });

    it('should register multiple agents', () => {
      const conn1 = new MockConnection('conn-1', 'agent1');
      const conn2 = new MockConnection('conn-2', 'agent2');
      const conn3 = new MockConnection('conn-3', 'agent3');

      router.register(conn1);
      router.register(conn2);
      router.register(conn3);

      expect(router.getAgents()).toEqual(['agent1', 'agent2', 'agent3']);
      expect(router.connectionCount).toBe(3);
    });
  });

  describe('Unregistration', () => {
    it('should unregister a connection', () => {
      const conn = new MockConnection('conn-1', 'agent1');
      router.register(conn);
      router.unregister(conn);

      expect(router.getAgents()).toEqual([]);
      expect(router.getConnection('agent1')).toBeUndefined();
      expect(router.connectionCount).toBe(0);
    });

    it('should not remove agent if different connection is registered', () => {
      const conn1 = new MockConnection('conn-1', 'agent1');
      const conn2 = new MockConnection('conn-2', 'agent1');

      router.register(conn1);
      router.register(conn2); // This replaces conn1
      router.unregister(conn1); // Try to unregister old connection

      expect(router.getAgents()).toEqual(['agent1']);
      expect(router.getConnection('agent1')).toBe(conn2);
    });

    it('should remove connection from all topic subscriptions', () => {
      const conn = new MockConnection('conn-1', 'agent1');
      router.register(conn);
      router.subscribe('agent1', 'topic1');
      router.subscribe('agent1', 'topic2');

      router.unregister(conn);

      // Verify agent is removed from subscriptions by checking broadcast
      const conn2 = new MockConnection('conn-2', 'agent2');
      router.register(conn2);
      router.subscribe('agent2', 'topic1');

      const envelope = createSendEnvelope('agent2', '*', 'topic1');
      router.route(conn2, envelope);

      // Should not send to unregistered agent1
      expect(conn.sendMock).not.toHaveBeenCalled();
    });

    it('should handle unregistering connection without agent name', () => {
      const conn = new MockConnection('conn-1');
      router.register(conn);
      router.unregister(conn);

      expect(router.connectionCount).toBe(0);
    });
  });

  describe('getAgents', () => {
    it('should return empty array when no agents registered', () => {
      expect(router.getAgents()).toEqual([]);
    });

    it('should return list of registered agent names', () => {
      const conn1 = new MockConnection('conn-1', 'agent1');
      const conn2 = new MockConnection('conn-2', 'agent2');
      const conn3 = new MockConnection('conn-3'); // No agent name

      router.register(conn1);
      router.register(conn2);
      router.register(conn3);

      const agents = router.getAgents();
      expect(agents).toHaveLength(2);
      expect(agents).toContain('agent1');
      expect(agents).toContain('agent2');
    });
  });

  describe('getConnection', () => {
    it('should return connection for registered agent', () => {
      const conn = new MockConnection('conn-1', 'agent1');
      router.register(conn);

      expect(router.getConnection('agent1')).toBe(conn);
    });

    it('should return undefined for unregistered agent', () => {
      expect(router.getConnection('nonexistent')).toBeUndefined();
    });
  });

  describe('connectionCount', () => {
    it('should return 0 for no connections', () => {
      expect(router.connectionCount).toBe(0);
    });

    it('should return correct count for registered connections', () => {
      const conn1 = new MockConnection('conn-1', 'agent1');
      const conn2 = new MockConnection('conn-2', 'agent2');

      router.register(conn1);
      expect(router.connectionCount).toBe(1);

      router.register(conn2);
      expect(router.connectionCount).toBe(2);

      router.unregister(conn1);
      expect(router.connectionCount).toBe(1);
    });
  });

  describe('Delivery reliability (ACK)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('tracks pending deliveries and clears on ACK', () => {
      router = new Router({
        storage,
        delivery: { ackTimeoutMs: 10, maxAttempts: 3, deliveryTtlMs: 100 },
      });
      const sender = new MockConnection('conn-1', 'agent1');
      const receiver = new MockConnection('conn-2', 'agent2');
      router.register(sender);
      router.register(receiver);

      const envelope = createSendEnvelope('agent1', 'agent2');
      router.route(sender, envelope);

      expect(router.pendingDeliveryCount).toBe(1);
      expect(receiver.sentEnvelopes).toHaveLength(1);
      const deliverId = receiver.sentEnvelopes[0].id;

      const ackEnvelope: Envelope<AckPayload> = {
        v: 1,
        type: 'ACK',
        id: 'ack-1',
        ts: Date.now(),
        payload: {
          ack_id: deliverId,
          seq: 1,
        },
      };

      router.handleAck(receiver, ackEnvelope);
      expect(router.pendingDeliveryCount).toBe(0);
    });

    it('retries until maxAttempts then drops pending delivery', () => {
      router = new Router({
        storage,
        delivery: { ackTimeoutMs: 5, maxAttempts: 3, deliveryTtlMs: 100 },
      });
      const sender = new MockConnection('conn-1', 'agent1');
      const receiver = new MockConnection('conn-2', 'agent2');
      router.register(sender);
      router.register(receiver);

      const envelope = createSendEnvelope('agent1', 'agent2');
      router.route(sender, envelope);

      expect(receiver.sentEnvelopes).toHaveLength(1);
      expect(router.pendingDeliveryCount).toBe(1);

      // Advance timers to trigger retries
      vi.advanceTimersByTime(5 * 3 + 1);

      // Initial send + 2 retries (maxAttempts = 3)
      expect(receiver.sentEnvelopes.length).toBe(3);
      expect(router.pendingDeliveryCount).toBe(0);
    });

    it('clears pending deliveries when connection unregisters', () => {
      router = new Router({
        storage,
        delivery: { ackTimeoutMs: 50, maxAttempts: 2, deliveryTtlMs: 100 },
      });
      const sender = new MockConnection('conn-1', 'agent1');
      const receiver = new MockConnection('conn-2', 'agent2');
      router.register(sender);
      router.register(receiver);

      const envelope = createSendEnvelope('agent1', 'agent2');
      router.route(sender, envelope);
      expect(router.pendingDeliveryCount).toBe(1);

      router.unregister(receiver);
      expect(router.pendingDeliveryCount).toBe(0);
    });

    it('persists ACK status to storage when handler is available', () => {
      const updateMessageStatus = vi.fn();
      router = new Router({
        storage: {
          init: async () => {},
          saveMessage: async () => {},
          getMessages: async () => [],
          updateMessageStatus,
        },
      });

      const sender = new MockConnection('conn-1', 'agent1');
      const receiver = new MockConnection('conn-2', 'agent2');
      router.register(sender);
      router.register(receiver);

      const envelope = createSendEnvelope('agent1', 'agent2');
      router.route(sender, envelope);
      const deliverId = receiver.sentEnvelopes[0].id;

      const ackEnvelope: Envelope<AckPayload> = {
        v: 1,
        type: 'ACK',
        id: 'ack-storage',
        ts: Date.now(),
        payload: {
          ack_id: deliverId,
          seq: 1,
        },
      };

      router.handleAck(receiver, ackEnvelope);
      expect(updateMessageStatus).toHaveBeenCalledWith(deliverId, 'acked');
    });
  });

  describe('Direct routing', () => {
    it('should route message to correct recipient', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      const recipient = new MockConnection('conn-2', 'agent2');

      router.register(sender);
      router.register(recipient);

      const envelope = createSendEnvelope('agent1', 'agent2');
      router.route(sender, envelope);

      expect(recipient.sendMock).toHaveBeenCalledOnce();
      const sent = recipient.sentEnvelopes[0] as DeliverEnvelope;
      expect(sent.type).toBe('DELIVER');
      expect(sent.from).toBe('agent1');
      expect(sent.to).toBe('agent2');
      expect(sent.payload.body).toBe('test message');
    });

    it('should not route message if sender has no agent name', () => {
      const sender = new MockConnection('conn-1'); // No agent name
      const recipient = new MockConnection('conn-2', 'agent2');

      router.register(sender);
      router.register(recipient);

      const envelope = createSendEnvelope('agent1', 'agent2');
      router.route(sender, envelope);

      expect(recipient.sendMock).not.toHaveBeenCalled();
    });

    it('should not route message to unknown recipient', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      router.register(sender);

      const envelope = createSendEnvelope('agent1', 'unknown');
      router.route(sender, envelope);

      // No error thrown, just no delivery
      expect(sender.sendMock).not.toHaveBeenCalled();
    });

    it('should create DELIVER envelope with correct fields', () => {
      const sender = new MockConnection('conn-1', 'agent1', 'session-sender');
      const recipient = new MockConnection('conn-2', 'agent2', 'session-recipient');

      router.register(sender);
      router.register(recipient);

      const envelope = createSendEnvelope('agent1', 'agent2', 'test-topic');
      router.route(sender, envelope);

      const delivered = recipient.sentEnvelopes[0] as DeliverEnvelope;
      expect(delivered.v).toBe(1);
      expect(delivered.type).toBe('DELIVER');
      expect(delivered.id).toBeDefined();
      expect(delivered.ts).toBeDefined();
      expect(delivered.from).toBe('agent1');
      expect(delivered.to).toBe('agent2');
      expect(delivered.topic).toBe('test-topic');
      expect(delivered.payload).toEqual({
        kind: 'message',
        body: 'test message',
      });
      expect(delivered.delivery).toBeDefined();
      expect(delivered.delivery.seq).toBe(1);
      expect(delivered.delivery.session_id).toBe('session-recipient');
    });

    it('should include delivery info with sequence number', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      const recipient = new MockConnection('conn-2', 'agent2');

      router.register(sender);
      router.register(recipient);

      const envelope = createSendEnvelope('agent1', 'agent2');
      router.route(sender, envelope);

      const delivered = recipient.sentEnvelopes[0] as DeliverEnvelope;
      expect(delivered.delivery).toBeDefined();
      expect(delivered.delivery.seq).toBe(1);
      expect(delivered.delivery.session_id).toBe('session-1');
    });

    it('should increment sequence numbers per stream', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      const recipient = new MockConnection('conn-2', 'agent2');

      router.register(sender);
      router.register(recipient);

      // Send three messages
      for (let i = 0; i < 3; i++) {
        const envelope = createSendEnvelope('agent1', 'agent2', 'topic1');
        router.route(sender, envelope);
      }

      expect(recipient.sentEnvelopes).toHaveLength(3);
      expect((recipient.sentEnvelopes[0] as DeliverEnvelope).delivery.seq).toBe(1);
      expect((recipient.sentEnvelopes[1] as DeliverEnvelope).delivery.seq).toBe(2);
      expect((recipient.sentEnvelopes[2] as DeliverEnvelope).delivery.seq).toBe(3);
    });

    it('should maintain separate sequence numbers per topic', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      const recipient = new MockConnection('conn-2', 'agent2');

      router.register(sender);
      router.register(recipient);

      // Send to topic1
      router.route(sender, createSendEnvelope('agent1', 'agent2', 'topic1'));
      router.route(sender, createSendEnvelope('agent1', 'agent2', 'topic1'));

      // Send to topic2
      router.route(sender, createSendEnvelope('agent1', 'agent2', 'topic2'));

      expect(recipient.sentEnvelopes).toHaveLength(3);
      expect((recipient.sentEnvelopes[0] as DeliverEnvelope).delivery.seq).toBe(1); // topic1
      expect((recipient.sentEnvelopes[1] as DeliverEnvelope).delivery.seq).toBe(2); // topic1
      expect((recipient.sentEnvelopes[2] as DeliverEnvelope).delivery.seq).toBe(1); // topic2 starts at 1
    });

    it('should maintain separate sequence numbers per peer', () => {
      const sender1 = new MockConnection('conn-1', 'agent1');
      const sender2 = new MockConnection('conn-2', 'agent2');
      const recipient = new MockConnection('conn-3', 'agent3');

      router.register(sender1);
      router.register(sender2);
      router.register(recipient);

      // Send from agent1
      router.route(sender1, createSendEnvelope('agent1', 'agent3', 'topic1'));
      router.route(sender1, createSendEnvelope('agent1', 'agent3', 'topic1'));

      // Send from agent2
      router.route(sender2, createSendEnvelope('agent2', 'agent3', 'topic1'));

      expect(recipient.sentEnvelopes).toHaveLength(3);
      // Separate streams per peer
      const msg1 = recipient.sentEnvelopes[0] as DeliverEnvelope;
      const msg2 = recipient.sentEnvelopes[1] as DeliverEnvelope;
      const msg3 = recipient.sentEnvelopes[2] as DeliverEnvelope;

      expect(msg1.from).toBe('agent1');
      expect(msg1.delivery.seq).toBe(1);

      expect(msg2.from).toBe('agent1');
      expect(msg2.delivery.seq).toBe(2);

      expect(msg3.from).toBe('agent2');
      expect(msg3.delivery.seq).toBe(1); // Different peer, starts at 1
    });
  });

  describe('Broadcast routing', () => {
    it('should broadcast to all agents except sender when to is "*"', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      const recipient1 = new MockConnection('conn-2', 'agent2');
      const recipient2 = new MockConnection('conn-3', 'agent3');

      router.register(sender);
      router.register(recipient1);
      router.register(recipient2);

      const envelope = createSendEnvelope('agent1', '*');
      router.route(sender, envelope);

      expect(sender.sendMock).not.toHaveBeenCalled();
      expect(recipient1.sendMock).toHaveBeenCalledOnce();
      expect(recipient2.sendMock).toHaveBeenCalledOnce();
    });

    it('should not send broadcast message to sender', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      const recipient = new MockConnection('conn-2', 'agent2');

      router.register(sender);
      router.register(recipient);

      const envelope = createSendEnvelope('agent1', '*');
      router.route(sender, envelope);

      expect(sender.sendMock).not.toHaveBeenCalled();
      expect(recipient.sendMock).toHaveBeenCalledOnce();
    });

    it('should not send broadcast when no other agents', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      router.register(sender);

      const envelope = createSendEnvelope('agent1', '*');
      router.route(sender, envelope);

      expect(sender.sendMock).not.toHaveBeenCalled();
    });

    it('should create correct DELIVER envelopes for each recipient', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      const recipient1 = new MockConnection('conn-2', 'agent2');
      const recipient2 = new MockConnection('conn-3', 'agent3');

      router.register(sender);
      router.register(recipient1);
      router.register(recipient2);

      // Broadcast without topic goes to all agents
      const envelope = createSendEnvelope('agent1', '*');
      router.route(sender, envelope);

      expect(recipient1.sentEnvelopes.length).toBeGreaterThan(0);
      expect(recipient2.sentEnvelopes.length).toBeGreaterThan(0);

      const delivered1 = recipient1.sentEnvelopes[0] as DeliverEnvelope;
      expect(delivered1.from).toBe('agent1');
      expect(delivered1.to).toBe('agent2');

      const delivered2 = recipient2.sentEnvelopes[0] as DeliverEnvelope;
      expect(delivered2.from).toBe('agent1');
      expect(delivered2.to).toBe('agent3');
    });
  });

  describe('Topic subscriptions', () => {
    it('should subscribe agent to topic', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      const subscriber = new MockConnection('conn-2', 'agent2');
      const nonSubscriber = new MockConnection('conn-3', 'agent3');

      router.register(sender);
      router.register(subscriber);
      router.register(nonSubscriber);

      router.subscribe('agent2', 'sports');

      const envelope = createSendEnvelope('agent1', '*', 'sports');
      router.route(sender, envelope);

      expect(subscriber.sendMock).toHaveBeenCalledOnce();
      expect(nonSubscriber.sendMock).not.toHaveBeenCalled();
    });

    it('should allow multiple subscriptions to same topic', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      const sub1 = new MockConnection('conn-2', 'agent2');
      const sub2 = new MockConnection('conn-3', 'agent3');

      router.register(sender);
      router.register(sub1);
      router.register(sub2);

      router.subscribe('agent2', 'news');
      router.subscribe('agent3', 'news');

      const envelope = createSendEnvelope('agent1', '*', 'news');
      router.route(sender, envelope);

      expect(sub1.sendMock).toHaveBeenCalledOnce();
      expect(sub2.sendMock).toHaveBeenCalledOnce();
    });

    it('should allow agent to subscribe to multiple topics', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      const subscriber = new MockConnection('conn-2', 'agent2');

      router.register(sender);
      router.register(subscriber);

      router.subscribe('agent2', 'sports');
      router.subscribe('agent2', 'news');

      // Send to sports
      const envelope1 = createSendEnvelope('agent1', '*', 'sports');
      router.route(sender, envelope1);
      expect(subscriber.sendMock).toHaveBeenCalledTimes(1);

      subscriber.clearSent();
      subscriber.sendMock.mockClear();

      // Send to news
      const envelope2 = createSendEnvelope('agent1', '*', 'news');
      router.route(sender, envelope2);
      expect(subscriber.sendMock).toHaveBeenCalledTimes(1);
    });

    it('should unsubscribe agent from topic', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      const subscriber = new MockConnection('conn-2', 'agent2');

      router.register(sender);
      router.register(subscriber);

      router.subscribe('agent2', 'sports');
      router.unsubscribe('agent2', 'sports');

      const envelope = createSendEnvelope('agent1', '*', 'sports');
      router.route(sender, envelope);

      expect(subscriber.sendMock).not.toHaveBeenCalled();
    });

    it('should handle unsubscribe from non-existent topic', () => {
      const subscriber = new MockConnection('conn-1', 'agent1');
      router.register(subscriber);

      // Should not throw
      expect(() => {
        router.unsubscribe('agent1', 'nonexistent');
      }).not.toThrow();
    });

    it('should handle unsubscribe of non-subscribed agent', () => {
      const subscriber = new MockConnection('conn-1', 'agent1');
      router.register(subscriber);

      router.subscribe('agent1', 'sports');

      // Should not throw
      expect(() => {
        router.unsubscribe('agent2', 'sports'); // Different agent
      }).not.toThrow();
    });

    it('should broadcast to all agents when no topic specified', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      const sub1 = new MockConnection('conn-2', 'agent2');
      const sub2 = new MockConnection('conn-3', 'agent3');

      router.register(sender);
      router.register(sub1);
      router.register(sub2);

      router.subscribe('agent2', 'sports');

      // Broadcast without topic should go to all
      const envelope = createSendEnvelope('agent1', '*');
      router.route(sender, envelope);

      expect(sub1.sendMock).toHaveBeenCalledOnce();
      expect(sub2.sendMock).toHaveBeenCalledOnce();
    });

    it('should only broadcast to topic subscribers when topic specified', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      const sportsSub = new MockConnection('conn-2', 'agent2');
      const newsSub = new MockConnection('conn-3', 'agent3');
      const noSub = new MockConnection('conn-4', 'agent4');

      router.register(sender);
      router.register(sportsSub);
      router.register(newsSub);
      router.register(noSub);

      router.subscribe('agent2', 'sports');
      router.subscribe('agent3', 'news');

      const envelope = createSendEnvelope('agent1', '*', 'sports');
      router.route(sender, envelope);

      expect(sportsSub.sendMock).toHaveBeenCalledOnce();
      expect(newsSub.sendMock).not.toHaveBeenCalled();
      expect(noSub.sendMock).not.toHaveBeenCalled();
    });

    it('should remove agent from all subscriptions on unregister', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      const subscriber = new MockConnection('conn-2', 'agent2');
      const otherSub = new MockConnection('conn-3', 'agent3');

      router.register(sender);
      router.register(subscriber);
      router.register(otherSub);

      router.subscribe('agent2', 'sports');
      router.subscribe('agent2', 'news');
      router.subscribe('agent3', 'sports');

      router.unregister(subscriber);

      // Send to sports - should only reach agent3
      const envelope1 = createSendEnvelope('agent1', '*', 'sports');
      router.route(sender, envelope1);
      expect(subscriber.sendMock).not.toHaveBeenCalled();
      expect(otherSub.sendMock).toHaveBeenCalledOnce();

      otherSub.clearSent();
      otherSub.sendMock.mockClear();

      // Send to news - should reach nobody (agent2 was only subscriber)
      const envelope2 = createSendEnvelope('agent1', '*', 'news');
      router.route(sender, envelope2);
      expect(subscriber.sendMock).not.toHaveBeenCalled();
      expect(otherSub.sendMock).not.toHaveBeenCalled();
    });

    it('should not broadcast to non-existent topic subscribers', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      const agent2 = new MockConnection('conn-2', 'agent2');

      router.register(sender);
      router.register(agent2);

      // No subscriptions to 'weather'
      const envelope = createSendEnvelope('agent1', '*', 'weather');
      router.route(sender, envelope);

      expect(agent2.sendMock).not.toHaveBeenCalled();
    });

    it('should not send to sender even if subscribed to topic', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      const recipient = new MockConnection('conn-2', 'agent2');

      router.register(sender);
      router.register(recipient);

      router.subscribe('agent1', 'sports');
      router.subscribe('agent2', 'sports');

      const envelope = createSendEnvelope('agent1', '*', 'sports');
      router.route(sender, envelope);

      expect(sender.sendMock).not.toHaveBeenCalled();
      expect(recipient.sendMock).toHaveBeenCalledOnce();
    });
  });

  describe('Replay on resume', () => {
    it('replays pending messages to a resumed connection', async () => {
      const pending: StoredMessage[] = [{
        id: 'deliver-1',
        ts: Date.now(),
        from: 'agent1',
        to: 'agent2',
        topic: 'chat',
        kind: 'message',
        body: 'missed you',
        status: 'unread',
        is_urgent: false,
        deliverySeq: 3,
        deliverySessionId: 'session-resume',
        sessionId: 'session-resume',
      }];

      const storage: StorageAdapter = {
        init: async () => {},
        saveMessage: async () => {},
        getMessages: async () => [],
        getPendingMessagesForSession: async () => pending,
      };

      router = new Router({ storage });
      const receiver = new MockConnection('conn-2', 'agent2', 'session-resume');

      await router.replayPending(receiver);

      expect(receiver.sentEnvelopes).toHaveLength(1);
      const deliver = receiver.sentEnvelopes[0] as DeliverEnvelope;
      expect(deliver.id).toBe('deliver-1');
      expect(deliver.delivery.seq).toBe(3);
      expect(deliver.from).toBe('agent1');
    });
  });

  describe('Edge cases', () => {
    it('should handle routing with undefined topic', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      const recipient = new MockConnection('conn-2', 'agent2');

      router.register(sender);
      router.register(recipient);

      const envelope = createSendEnvelope('agent1', 'agent2');
      envelope.topic = undefined;
      router.route(sender, envelope);

      const delivered = recipient.sentEnvelopes[0] as DeliverEnvelope;
      expect(delivered.topic).toBeUndefined();
    });

    it('should handle empty agent name in subscribe', () => {
      expect(() => {
        router.subscribe('', 'sports');
      }).not.toThrow();
    });

    it('should handle empty topic name in subscribe', () => {
      const conn = new MockConnection('conn-1', 'agent1');
      router.register(conn);

      expect(() => {
        router.subscribe('agent1', '');
      }).not.toThrow();
    });

    it('should handle duplicate subscription', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      const subscriber = new MockConnection('conn-2', 'agent2');

      router.register(sender);
      router.register(subscriber);

      router.subscribe('agent2', 'sports');
      router.subscribe('agent2', 'sports'); // Duplicate

      const envelope = createSendEnvelope('agent1', '*', 'sports');
      router.route(sender, envelope);

      // Should only send once
      expect(subscriber.sendMock).toHaveBeenCalledOnce();
    });

    it('should handle route with null/undefined to field', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      const recipient = new MockConnection('conn-2', 'agent2');

      router.register(sender);
      router.register(recipient);

      const envelope = createSendEnvelope('agent1', 'agent2');
      envelope.to = undefined;
      router.route(sender, envelope);

      // Should not route anywhere
      expect(recipient.sendMock).not.toHaveBeenCalled();
    });

    it('should handle connection with send failure', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      const recipient = new MockConnection('conn-2', 'agent2');
      recipient.setSendReturnValue(false); // Simulate send failure

      router.register(sender);
      router.register(recipient);

      const envelope = createSendEnvelope('agent1', 'agent2');

      // Should not throw even if send fails
      expect(() => {
        router.route(sender, envelope);
      }).not.toThrow();

      expect(recipient.sendMock).toHaveBeenCalledOnce();
    });

    it('should handle large number of agents', () => {
      const sender = new MockConnection('conn-sender', 'sender');
      router.register(sender);

      const recipients: MockConnection[] = [];
      for (let i = 0; i < 100; i++) {
        const conn = new MockConnection(`conn-${i}`, `agent${i}`);
        recipients.push(conn);
        router.register(conn);
      }

      const envelope = createSendEnvelope('sender', '*');
      router.route(sender, envelope);

      recipients.forEach(recipient => {
        expect(recipient.sendMock).toHaveBeenCalledOnce();
      });
    });

    it('should handle large number of subscriptions', () => {
      const sender = new MockConnection('conn-sender', 'sender');
      router.register(sender);

      const subscriber = new MockConnection('conn-sub', 'subscriber');
      router.register(subscriber);

      // Subscribe to 100 topics
      for (let i = 0; i < 100; i++) {
        router.subscribe('subscriber', `topic${i}`);
      }

      // Should receive messages on any topic
      const envelope = createSendEnvelope('sender', '*', 'topic50');
      router.route(sender, envelope);

      expect(subscriber.sendMock).toHaveBeenCalledOnce();
    });
  });

  describe('Persistence', () => {
    it('persists delivered direct messages', () => {
      const fromConn = new MockConnection('from-1', 'agentA');
      const toConn = new MockConnection('to-1', 'agentB');
      router.register(fromConn);
      router.register(toConn);

      const envelope = createSendEnvelope('agentA', 'agentB', 'topic1');
      router.route(fromConn, envelope);

      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        from: 'agentA',
        to: 'agentB',
        topic: 'topic1',
        body: 'test message',
      });
    });

    it('persists broadcast deliveries to subscribers', () => {
      const sender = new MockConnection('sender', 'agentA');
      const sub1 = new MockConnection('sub1', 'agentB');
      const sub2 = new MockConnection('sub2', 'agentC');
      router.register(sender);
      router.register(sub1);
      router.register(sub2);
      router.subscribe('agentB', 'topic1');
      router.subscribe('agentC', 'topic1');

      const envelope = createSendEnvelope('agentA', '*', 'topic1');
      router.route(sender, envelope);

      expect(saved).toHaveLength(2);
      const recipients = saved.map(s => s.to).sort();
      expect(recipients).toEqual(['agentB', 'agentC']);
    });
  });

  describe('Cross-machine routing', () => {
    it('should set cross-machine handler via constructor', () => {
      const mockHandler = {
        sendCrossMachineMessage: vi.fn().mockResolvedValue(true),
        isRemoteAgent: vi.fn().mockReturnValue(undefined),
      };

      const routerWithHandler = new Router({
        storage,
        crossMachineHandler: mockHandler,
      });

      const sender = new MockConnection('conn-1', 'agent1');
      routerWithHandler.register(sender);

      const envelope = createSendEnvelope('agent1', 'unknown-agent');
      routerWithHandler.route(sender, envelope);

      // Should have checked if agent is remote
      expect(mockHandler.isRemoteAgent).toHaveBeenCalledWith('unknown-agent');
    });

    it('should set cross-machine handler via setCrossMachineHandler', () => {
      const mockHandler = {
        sendCrossMachineMessage: vi.fn().mockResolvedValue(true),
        isRemoteAgent: vi.fn().mockReturnValue(undefined),
      };

      router.setCrossMachineHandler(mockHandler);

      const sender = new MockConnection('conn-1', 'agent1');
      router.register(sender);

      const envelope = createSendEnvelope('agent1', 'unknown-agent');
      router.route(sender, envelope);

      expect(mockHandler.isRemoteAgent).toHaveBeenCalledWith('unknown-agent');
    });

    it('should route to remote agent when local agent not found', async () => {
      const mockHandler = {
        sendCrossMachineMessage: vi.fn().mockResolvedValue(true),
        isRemoteAgent: vi.fn().mockReturnValue({
          name: 'remote-agent',
          status: 'online',
          daemonId: 'daemon-123',
          daemonName: 'remote-machine',
          machineId: 'machine-456',
        }),
      };

      router.setCrossMachineHandler(mockHandler);

      const sender = new MockConnection('conn-1', 'local-agent');
      router.register(sender);

      const envelope = createSendEnvelope('local-agent', 'remote-agent');
      router.route(sender, envelope);

      // Wait for async cross-machine send
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockHandler.isRemoteAgent).toHaveBeenCalledWith('remote-agent');
      expect(mockHandler.sendCrossMachineMessage).toHaveBeenCalledWith(
        'daemon-123',
        'remote-agent',
        'local-agent',
        'test message',
        expect.objectContaining({
          kind: 'message',
        })
      );
    });

    it('should prefer local routing over remote when agent is local', () => {
      const mockHandler = {
        sendCrossMachineMessage: vi.fn().mockResolvedValue(true),
        isRemoteAgent: vi.fn().mockReturnValue({
          name: 'agent2',
          status: 'online',
          daemonId: 'daemon-123',
          daemonName: 'remote-machine',
          machineId: 'machine-456',
        }),
      };

      router.setCrossMachineHandler(mockHandler);

      const sender = new MockConnection('conn-1', 'agent1');
      const localAgent = new MockConnection('conn-2', 'agent2');
      router.register(sender);
      router.register(localAgent);

      const envelope = createSendEnvelope('agent1', 'agent2');
      router.route(sender, envelope);

      // Should route locally, not check remote
      expect(mockHandler.isRemoteAgent).not.toHaveBeenCalled();
      expect(mockHandler.sendCrossMachineMessage).not.toHaveBeenCalled();
      expect(localAgent.sendMock).toHaveBeenCalledOnce();
    });

    it('should not route remotely if no cross-machine handler configured', () => {
      const sender = new MockConnection('conn-1', 'agent1');
      router.register(sender);

      const envelope = createSendEnvelope('agent1', 'unknown-remote');
      router.route(sender, envelope);

      // Should just fail silently, no error thrown
      expect(sender.sendMock).not.toHaveBeenCalled();
    });

    it('should not route remotely if agent not found in remote lookup', () => {
      const mockHandler = {
        sendCrossMachineMessage: vi.fn().mockResolvedValue(true),
        isRemoteAgent: vi.fn().mockReturnValue(undefined), // Not found
      };

      router.setCrossMachineHandler(mockHandler);

      const sender = new MockConnection('conn-1', 'agent1');
      router.register(sender);

      const envelope = createSendEnvelope('agent1', 'nonexistent');
      router.route(sender, envelope);

      expect(mockHandler.isRemoteAgent).toHaveBeenCalledWith('nonexistent');
      expect(mockHandler.sendCrossMachineMessage).not.toHaveBeenCalled();
    });

    it('should pass message metadata to cross-machine handler', async () => {
      const mockHandler = {
        sendCrossMachineMessage: vi.fn().mockResolvedValue(true),
        isRemoteAgent: vi.fn().mockReturnValue({
          name: 'remote-agent',
          status: 'online',
          daemonId: 'daemon-123',
          daemonName: 'remote-machine',
          machineId: 'machine-456',
        }),
      };

      router.setCrossMachineHandler(mockHandler);

      const sender = new MockConnection('conn-1', 'local-agent');
      router.register(sender);

      const envelope: Envelope<SendPayload> = {
        v: 1,
        type: 'SEND',
        id: 'msg-with-metadata',
        ts: Date.now(),
        from: 'local-agent',
        to: 'remote-agent',
        topic: 'important-topic',
        payload: {
          kind: 'action',
          body: 'do something',
          thread: 'thread-123',
          data: { custom: 'data' },
        },
      };
      router.route(sender, envelope);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockHandler.sendCrossMachineMessage).toHaveBeenCalledWith(
        'daemon-123',
        'remote-agent',
        'local-agent',
        'do something',
        expect.objectContaining({
          topic: 'important-topic',
          thread: 'thread-123',
          kind: 'action',
          data: { custom: 'data' },
          originalId: 'msg-with-metadata',
        })
      );
    });

    it('should handle cross-machine send failure gracefully', async () => {
      const mockHandler = {
        sendCrossMachineMessage: vi.fn().mockResolvedValue(false),
        isRemoteAgent: vi.fn().mockReturnValue({
          name: 'remote-agent',
          status: 'online',
          daemonId: 'daemon-123',
          daemonName: 'remote-machine',
          machineId: 'machine-456',
        }),
      };

      router.setCrossMachineHandler(mockHandler);

      const sender = new MockConnection('conn-1', 'local-agent');
      router.register(sender);

      const envelope = createSendEnvelope('local-agent', 'remote-agent');

      // Should not throw
      expect(() => {
        router.route(sender, envelope);
      }).not.toThrow();

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockHandler.sendCrossMachineMessage).toHaveBeenCalled();
    });

    it('should handle cross-machine send error gracefully', async () => {
      const mockHandler = {
        sendCrossMachineMessage: vi.fn().mockRejectedValue(new Error('Network error')),
        isRemoteAgent: vi.fn().mockReturnValue({
          name: 'remote-agent',
          status: 'online',
          daemonId: 'daemon-123',
          daemonName: 'remote-machine',
          machineId: 'machine-456',
        }),
      };

      router.setCrossMachineHandler(mockHandler);

      const sender = new MockConnection('conn-1', 'local-agent');
      router.register(sender);

      const envelope = createSendEnvelope('local-agent', 'remote-agent');

      // Should not throw
      expect(() => {
        router.route(sender, envelope);
      }).not.toThrow();

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockHandler.sendCrossMachineMessage).toHaveBeenCalled();
    });

    it('should persist cross-machine messages when storage is available', async () => {
      const mockHandler = {
        sendCrossMachineMessage: vi.fn().mockResolvedValue(true),
        isRemoteAgent: vi.fn().mockReturnValue({
          name: 'remote-agent',
          status: 'online',
          daemonId: 'daemon-123',
          daemonName: 'remote-machine',
          machineId: 'machine-456',
        }),
      };

      router.setCrossMachineHandler(mockHandler);

      const sender = new MockConnection('conn-1', 'local-agent');
      router.register(sender);

      const envelope = createSendEnvelope('local-agent', 'remote-agent');
      router.route(sender, envelope);

      await new Promise(resolve => setTimeout(resolve, 50));

      // Should have saved the cross-machine message
      expect(saved.length).toBeGreaterThanOrEqual(1);
      const savedMsg = saved.find(m => m.to === 'remote-agent');
      expect(savedMsg).toBeDefined();
      expect(savedMsg?.data?._crossMachine).toBe(true);
      expect(savedMsg?.data?._targetDaemon).toBe('daemon-123');
      expect(savedMsg?.data?._targetDaemonName).toBe('remote-machine');
    });
  });
});
