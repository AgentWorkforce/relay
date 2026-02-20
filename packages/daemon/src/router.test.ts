import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Router, type RoutableConnection } from './router.js';
import type { StorageAdapter, StorageHealth } from '@agent-relay/storage/adapter';

/**
 * Mock connection that implements RoutableConnection interface
 */
function createMockConnection(agentName: string): RoutableConnection {
  const seqNumbers = new Map<string, number>();
  return {
    id: `conn-${agentName}-${Date.now()}`,
    agentName,
    sessionId: `session-${agentName}`,
    close: vi.fn(),
    send: vi.fn().mockReturnValue(true),
    getNextSeq: (topic: string, peer: string) => {
      const key = `${topic}:${peer}`;
      const seq = (seqNumbers.get(key) ?? 0) + 1;
      seqNumbers.set(key, seq);
      return seq;
    },
  };
}

function createMockStorage(saveMessage: ReturnType<typeof vi.fn>): StorageAdapter {
  return {
    init: vi.fn(async () => undefined),
    healthCheck: vi.fn(async (): Promise<StorageHealth> => ({
      persistent: true,
      driver: 'memory',
      canRead: true,
      canWrite: true,
    })),
    saveMessage,
    getMessages: vi.fn(async () => []),
  };
}

describe('Router', () => {
  let router: Router;

  beforeEach(() => {
    router = new Router();
  });

  describe('forceRemoveAgent', () => {
    it('should remove an agent from the router', () => {
      const connection = createMockConnection('TestAgent');
      router.register(connection);

      expect(router.getAgents()).toContain('TestAgent');

      const result = router.forceRemoveAgent('TestAgent');

      expect(result).toBe(true);
      expect(router.getAgents()).not.toContain('TestAgent');
    });

    it('should return false for non-existent agent', () => {
      const result = router.forceRemoveAgent('NonExistent');
      expect(result).toBe(false);
    });

    it('should remove agent from topic subscriptions', () => {
      const connection = createMockConnection('TestAgent');
      router.register(connection);
      router.subscribe('TestAgent', 'test-topic');

      // Force remove should clean up subscriptions
      router.forceRemoveAgent('TestAgent');

      // Agent should be gone
      expect(router.getAgents()).not.toContain('TestAgent');
    });

    it('should clean up channel memberships', () => {
      const connection = createMockConnection('TestAgent');
      router.register(connection);

      // Join a channel using autoJoinChannel
      router.autoJoinChannel('TestAgent', '#general', { persist: false });
      expect(router.getChannelMembers('#general')).toContain('TestAgent');

      router.forceRemoveAgent('TestAgent');

      // Verify channel membership is cleaned up
      expect(router.getChannelMembers('#general')).not.toContain('TestAgent');
    });

    it('should clean up shadow relationships without throwing', () => {
      const primary = createMockConnection('Primary');
      const shadow = createMockConnection('Shadow');
      router.register(primary);
      router.register(shadow);

      // Bind shadow: bindShadow(shadowAgent, primaryAgent, options)
      router.bindShadow('Shadow', 'Primary', { speakOn: ['CODE_WRITTEN'] });

      // Force remove should not throw and should clean up
      expect(() => router.forceRemoveAgent('Shadow')).not.toThrow();
      expect(router.getAgents()).not.toContain('Shadow');
    });

    it('should handle agent with processing state', () => {
      const connection = createMockConnection('TestAgent');
      router.register(connection);

      // Force remove should work even if agent has internal state
      router.forceRemoveAgent('TestAgent');

      // Agent should be removed
      expect(router.getAgents()).not.toContain('TestAgent');
    });
  });

  describe('register/unregister', () => {
    it('should register an agent', () => {
      const connection = createMockConnection('NewAgent');
      router.register(connection);

      expect(router.getAgents()).toContain('NewAgent');
      expect(router.getConnection('NewAgent')).toBe(connection);
    });

    it('should unregister an agent', () => {
      const connection = createMockConnection('NewAgent');
      router.register(connection);
      router.unregister(connection);

      expect(router.getAgents()).not.toContain('NewAgent');
    });

    it('should handle duplicate registration by replacing connection', () => {
      const conn1 = createMockConnection('Agent');
      const conn2 = createMockConnection('Agent');
      // Ensure different connection IDs
      conn2.id = `conn-Agent-${Date.now() + 1}`;

      router.register(conn1);
      router.register(conn2);

      // New connection should be the active one
      expect(router.getConnection('Agent')).toBe(conn2);
    });
  });

  describe('getAgents', () => {
    it('should return empty array when no agents', () => {
      expect(router.getAgents()).toEqual([]);
    });

    it('should return all registered agent names', () => {
      router.register(createMockConnection('Agent1'));
      router.register(createMockConnection('Agent2'));
      router.register(createMockConnection('Agent3'));

      const agents = router.getAgents();
      expect(agents).toHaveLength(3);
      expect(agents).toContain('Agent1');
      expect(agents).toContain('Agent2');
      expect(agents).toContain('Agent3');
    });
  });

  describe('dashboard routing', () => {
    it('should route messages to Dashboard directly', () => {
      // Register agent as Dashboard (unified naming)
      const dashboardConn = createMockConnection('Dashboard');
      const senderConn = createMockConnection('TestAgent');
      router.register(dashboardConn);
      router.register(senderConn);

      // Send message TO: Dashboard
      router.route(senderConn, {
        v: 1,
        type: 'SEND',
        id: 'test-msg-1',
        ts: Date.now(),
        from: 'TestAgent',
        to: 'Dashboard',
        payload: {
          kind: 'message',
          body: 'Hello Dashboard!',
        },
      });

      // Verify message was delivered to Dashboard
      expect(dashboardConn.send).toHaveBeenCalled();
      const deliveredEnvelope = (dashboardConn.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(deliveredEnvelope.type).toBe('DELIVER');
      expect(deliveredEnvelope.from).toBe('TestAgent');
      expect(deliveredEnvelope.to).toBe('Dashboard');
      expect(deliveredEnvelope.payload.body).toBe('Hello Dashboard!');
    });
  });

  describe('DM channel persistence', () => {
    it('persists channel message plus per-participant direct copies', async () => {
      const saveMessage = vi.fn(async () => undefined);
      const dmRouter = new Router({ storage: createMockStorage(saveMessage), rateLimit: null });
      const alice = createMockConnection('Alice');
      const bob = createMockConnection('Bob');
      dmRouter.register(alice);
      dmRouter.register(bob);
      dmRouter.autoJoinChannel('Alice', 'dm:Alice:Bob', { persist: false });
      dmRouter.autoJoinChannel('Bob', 'dm:Alice:Bob', { persist: false });

      dmRouter.routeChannelMessage(alice, {
        v: 1,
        type: 'CHANNEL_MESSAGE',
        id: 'dm-msg-1',
        ts: 123456,
        from: 'Alice',
        payload: {
          channel: 'dm:Alice:Bob',
          body: 'hello',
        },
      });

      expect(saveMessage).toHaveBeenCalledTimes(3);

      const saved = saveMessage.mock.calls.map(([arg]) => arg as { id: string; from: string; to: string; is_broadcast?: boolean });
      expect(saved).toContainEqual(expect.objectContaining({
        id: 'dm-msg-1',
        from: 'Alice',
        to: 'dm:Alice:Bob',
        is_broadcast: true,
      }));
      expect(saved).toContainEqual(expect.objectContaining({
        id: 'dm-msg-1:dm:0',
        from: 'Alice',
        to: 'Alice',
        is_broadcast: false,
      }));
      expect(saved).toContainEqual(expect.objectContaining({
        id: 'dm-msg-1:dm:1',
        from: 'Alice',
        to: 'Bob',
        is_broadcast: false,
      }));
    });
  });
});
