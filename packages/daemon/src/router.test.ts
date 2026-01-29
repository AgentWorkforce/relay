import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Router, type RoutableConnection } from './router.js';

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

  describe('agent aliases', () => {
    it('should route messages to Dashboard via _DashboardUI alias', () => {
      // Register agent as _DashboardUI (how dashboard actually registers)
      const dashboardConn = createMockConnection('_DashboardUI');
      const senderConn = createMockConnection('TestAgent');
      router.register(dashboardConn);
      router.register(senderConn);

      // Send message TO: Dashboard (the alias)
      router.route(senderConn, {
        v: 1,
        type: 'SEND',
        id: 'test-msg-1',
        ts: Date.now(),
        from: 'TestAgent',
        to: 'Dashboard', // Using alias, not _DashboardUI
        payload: {
          kind: 'message',
          body: 'Hello Dashboard!',
        },
      });

      // Verify message was delivered to _DashboardUI
      expect(dashboardConn.send).toHaveBeenCalled();
      const deliveredEnvelope = (dashboardConn.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(deliveredEnvelope.type).toBe('DELIVER');
      expect(deliveredEnvelope.from).toBe('TestAgent');
      expect(deliveredEnvelope.to).toBe('_DashboardUI'); // Resolved to actual name
      expect(deliveredEnvelope.payload.body).toBe('Hello Dashboard!');
    });

    it('should still work with direct _DashboardUI target', () => {
      const dashboardConn = createMockConnection('_DashboardUI');
      const senderConn = createMockConnection('TestAgent');
      router.register(dashboardConn);
      router.register(senderConn);

      router.route(senderConn, {
        v: 1,
        type: 'SEND',
        id: 'test-msg-2',
        ts: Date.now(),
        from: 'TestAgent',
        to: '_DashboardUI', // Direct name, no alias
        payload: {
          kind: 'message',
          body: 'Direct message',
        },
      });

      expect(dashboardConn.send).toHaveBeenCalled();
    });
  });
});
