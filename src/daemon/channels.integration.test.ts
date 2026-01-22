/**
 * Integration tests for channel auto-rejoin functionality.
 * Tests the full daemon restart cycle where agents rejoin channels.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { Router } from './router.js';
import { SqliteStorageAdapter } from '../storage/sqlite-adapter.js';
import type { Connection } from './connection.js';
import type { Envelope } from '../protocol/types.js';
import type { ChannelJoinPayload } from '../protocol/channels.js';

/**
 * Mock Connection for testing.
 */
class MockConnection implements Pick<Connection, 'id' | 'agentName' | 'sessionId' | 'send' | 'getNextSeq' | 'close'> {
  id: string;
  agentName: string | undefined;
  sessionId: string;
  entityType: 'agent' | 'user';
  sentEnvelopes: Envelope[] = [];
  private sequences: Map<string, number> = new Map();

  constructor(id: string, agentName?: string, sessionId: string = 'session-1') {
    this.id = id;
    this.agentName = agentName;
    this.sessionId = sessionId;
    this.entityType = 'agent';
  }

  send(envelope: Envelope): boolean {
    this.sentEnvelopes.push(envelope);
    return true;
  }

  getNextSeq(topic: string, peer: string): number {
    const key = `${topic}:${peer}`;
    const seq = (this.sequences.get(key) ?? 0) + 1;
    this.sequences.set(key, seq);
    return seq;
  }

  close(): void {
    // Mock close
  }
}

/**
 * Helper to create a channel join envelope.
 */
function createChannelJoinEnvelope(
  from: string,
  channel: string
): Envelope<ChannelJoinPayload> {
  return {
    v: 1,
    type: 'CHANNEL_JOIN',
    id: `join-${Date.now()}-${Math.random()}`,
    ts: Date.now(),
    from,
    payload: {
      channel,
    },
  };
}

describe('Channel Auto-Rejoin Integration Tests', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    // Create temporary directory for SQLite database
    tmpDir = path.join('/tmp', `channels-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, 'agent-relay.sqlite');
  });

  afterEach(() => {
    // Clean up temporary files
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should restore channel memberships across daemon restart', async () => {
    // Phase 1: Agent joins channels before "daemon restart"
    {
      const storage = new SqliteStorageAdapter({ dbPath });
      await storage.init();

      const router = new Router({ storage });

      // Alice joins #general and #engineering
      const alice = new MockConnection('conn-1', 'alice');
      router.register(alice);
      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#general'));
      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#engineering'));

      // Verify membership in memory
      expect(router.getChannelMembers('#general')).toContain('alice');
      expect(router.getChannelMembers('#engineering')).toContain('alice');

      // Simulate memberships being persisted by checking storage
      const allMessages = await storage.getMessages({ order: 'asc' });
      const membershipMessages = allMessages.filter(m =>
        (m.data as any)?._channelMembership?.member === 'alice'
      );
      expect(membershipMessages.length).toBeGreaterThan(0);

      await storage.close?.();
    }

    // Phase 2: Daemon restarts - in-memory state is lost
    // Router is recreated, channels map is empty

    // Phase 3: Agent reconnects after restart
    {
      const storage = new SqliteStorageAdapter({ dbPath });
      await storage.init();

      // Create new router (simulating daemon restart)
      const router = new Router({ storage });

      // Alice reconnects
      const alice = new MockConnection('conn-2', 'alice');
      router.register(alice);

      // Before auto-rejoin, alice is not in any channels
      expect(router.getChannelMembers('#general')).not.toContain('alice');
      expect(router.getChannelMembers('#engineering')).not.toContain('alice');

      // Auto-rejoin channels
      await router.autoRejoinChannelsForAgent('alice');

      // Verify alice is back in both channels
      expect(router.getChannelMembers('#general')).toContain('alice');
      expect(router.getChannelMembers('#engineering')).toContain('alice');

      await storage.close?.();
    }
  });

  it('should handle multiple agents rejoining different channels', async () => {
    // Phase 1: Multiple agents join channels
    {
      const storage = new SqliteStorageAdapter({ dbPath });
      await storage.init();

      const router = new Router({ storage });

      // Alice joins #general and #engineering
      const alice = new MockConnection('conn-1', 'alice');
      router.register(alice);
      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#general'));
      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#engineering'));

      // Bob joins #general and #marketing
      const bob = new MockConnection('conn-2', 'bob');
      router.register(bob);
      router.handleChannelJoin(bob, createChannelJoinEnvelope('bob', '#general'));
      router.handleChannelJoin(bob, createChannelJoinEnvelope('bob', '#marketing'));

      // Charlie joins #engineering
      const charlie = new MockConnection('conn-3', 'charlie');
      router.register(charlie);
      router.handleChannelJoin(charlie, createChannelJoinEnvelope('charlie', '#engineering'));

      await storage.close?.();
    }

    // Phase 2: Daemon restarts and agents reconnect
    {
      const storage = new SqliteStorageAdapter({ dbPath });
      await storage.init();

      const router = new Router({ storage });

      // Alice reconnects
      const alice = new MockConnection('conn-1', 'alice');
      router.register(alice);
      await router.autoRejoinChannelsForAgent('alice');

      // Bob reconnects
      const bob = new MockConnection('conn-2', 'bob');
      router.register(bob);
      await router.autoRejoinChannelsForAgent('bob');

      // Charlie reconnects
      const charlie = new MockConnection('conn-3', 'charlie');
      router.register(charlie);
      await router.autoRejoinChannelsForAgent('charlie');

      // Verify all rejoin to correct channels
      expect(router.getChannelMembers('#general')).toContain('alice');
      expect(router.getChannelMembers('#general')).toContain('bob');

      expect(router.getChannelMembers('#engineering')).toContain('alice');
      expect(router.getChannelMembers('#engineering')).toContain('charlie');

      expect(router.getChannelMembers('#marketing')).toContain('bob');

      // Channels should have correct member counts
      expect(router.getChannelMembers('#general')).toHaveLength(2); // alice, bob
      expect(router.getChannelMembers('#engineering')).toHaveLength(2); // alice, charlie
      expect(router.getChannelMembers('#marketing')).toHaveLength(1); // bob

      await storage.close?.();
    }
  });

  it('should handle agents joining channels after restart', async () => {
    // Phase 1: Alice joins channels
    {
      const storage = new SqliteStorageAdapter({ dbPath });
      await storage.init();

      const router = new Router({ storage });

      const alice = new MockConnection('conn-1', 'alice');
      router.register(alice);
      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#general'));

      await storage.close?.();
    }

    // Phase 2: After restart, alice rejoins, then bob joins same channel
    {
      const storage = new SqliteStorageAdapter({ dbPath });
      await storage.init();

      const router = new Router({ storage });

      // Alice reconnects and auto-rejoins
      const alice = new MockConnection('conn-1', 'alice');
      router.register(alice);
      await router.autoRejoinChannelsForAgent('alice');

      // Bob joins the same channel
      const bob = new MockConnection('conn-2', 'bob');
      router.register(bob);
      router.handleChannelJoin(bob, createChannelJoinEnvelope('bob', '#general'));

      // Both should be in #general
      expect(router.getChannelMembers('#general')).toContain('alice');
      expect(router.getChannelMembers('#general')).toContain('bob');
      expect(router.getChannelMembers('#general')).toHaveLength(2);

      await storage.close?.();
    }
  });

  it('should respect join/leave history during restart', async () => {
    // Phase 1: Alice joins then leaves channels
    {
      const storage = new SqliteStorageAdapter({ dbPath });
      await storage.init();

      const router = new Router({ storage });

      const alice = new MockConnection('conn-1', 'alice');
      router.register(alice);

      // Alice joins #general
      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#general'));
      expect(router.getChannelMembers('#general')).toContain('alice');

      // Alice joins #engineering
      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#engineering'));
      expect(router.getChannelMembers('#engineering')).toContain('alice');

      // Alice leaves #engineering
      router.handleChannelLeave(
        alice,
        {
          v: 1,
          type: 'CHANNEL_LEAVE',
          id: `leave-${Date.now()}`,
          ts: Date.now(),
          from: 'alice',
          payload: { channel: '#engineering' },
        }
      );
      expect(router.getChannelMembers('#engineering')).not.toContain('alice');

      await storage.close?.();
    }

    // Phase 2: After restart, verify alice is in #general but not #engineering
    {
      const storage = new SqliteStorageAdapter({ dbPath });
      await storage.init();

      const router = new Router({ storage });

      const alice = new MockConnection('conn-1', 'alice');
      router.register(alice);
      await router.autoRejoinChannelsForAgent('alice');

      // Alice should be in #general (never left)
      expect(router.getChannelMembers('#general')).toContain('alice');

      // Alice should NOT be in #engineering (left it)
      expect(router.getChannelMembers('#engineering')).not.toContain('alice');

      await storage.close?.();
    }
  });

  it('should handle agent with no persisted channels after restart', async () => {
    // Phase 1: Agent is registered but never joins any channels
    {
      const storage = new SqliteStorageAdapter({ dbPath });
      await storage.init();

      const router = new Router({ storage });

      const alice = new MockConnection('conn-1', 'alice');
      router.register(alice);
      // Alice doesn't join any channels

      await storage.close?.();
    }

    // Phase 2: After restart, verify no channels are restored
    {
      const storage = new SqliteStorageAdapter({ dbPath });
      await storage.init();

      const router = new Router({ storage });

      const alice = new MockConnection('conn-1', 'alice');
      router.register(alice);
      await router.autoRejoinChannelsForAgent('alice');

      // No channels should exist
      expect(router.getChannels()).toHaveLength(0);

      await storage.close?.();
    }
  });
});
