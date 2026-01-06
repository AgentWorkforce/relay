/**
 * Unit tests for channel functionality in the Router class.
 * TDD: Writing tests before implementation.
 *
 * Tests channel operations:
 * - Channel creation and management
 * - User and agent channel membership
 * - Channel message routing
 * - DM (direct message) support
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Router } from './router.js';
import type { Connection } from './connection.js';
import type { StorageAdapter, StoredMessage } from '../storage/adapter.js';
import type { Envelope, SendPayload, DeliverEnvelope } from '../protocol/types.js';
import type {
  ChannelJoinPayload,
  ChannelLeavePayload,
  ChannelMessagePayload,
} from '../protocol/channels.js';

/**
 * Mock Connection class for testing.
 */
class MockConnection implements Pick<Connection, 'id' | 'agentName' | 'sessionId' | 'send' | 'getNextSeq' | 'close'> {
  id: string;
  agentName: string | undefined;
  sessionId: string;
  entityType: 'agent' | 'user';
  sentEnvelopes: Envelope[] = [];
  private sequences: Map<string, number> = new Map();
  sendMock = vi.fn();
  closeMock = vi.fn();
  private sendReturnValue = true;

  constructor(
    id: string,
    agentName?: string,
    options?: { sessionId?: string; entityType?: 'agent' | 'user' }
  ) {
    this.id = id;
    this.agentName = agentName;
    this.sessionId = options?.sessionId ?? 'session-1';
    this.entityType = options?.entityType ?? 'agent';
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
    this.sendMock.mockClear();
  }
}

/**
 * Helper to create a channel message envelope.
 */
function createChannelMessageEnvelope(
  from: string,
  channel: string,
  body: string
): Envelope<ChannelMessagePayload> {
  return {
    v: 1,
    type: 'CHANNEL_MESSAGE',
    id: `msg-${Date.now()}`,
    ts: Date.now(),
    from,
    payload: {
      channel,
      body,
    },
  };
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
    id: `join-${Date.now()}`,
    ts: Date.now(),
    from,
    payload: {
      channel,
    },
  };
}

/**
 * Helper to create a channel leave envelope.
 */
function createChannelLeaveEnvelope(
  from: string,
  channel: string
): Envelope<ChannelLeavePayload> {
  return {
    v: 1,
    type: 'CHANNEL_LEAVE',
    id: `leave-${Date.now()}`,
    ts: Date.now(),
    from,
    payload: {
      channel,
    },
  };
}

describe('Router - Channel Support', () => {
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

  describe('Channel Join', () => {
    it('should allow a user to join a channel', () => {
      const user = new MockConnection('conn-1', 'alice', { entityType: 'user' });
      router.register(user);

      const joinEnvelope = createChannelJoinEnvelope('alice', '#general');
      router.handleChannelJoin(user, joinEnvelope);

      expect(router.getChannelMembers('#general')).toContain('alice');
    });

    it('should allow an agent to join a channel', () => {
      const agent = new MockConnection('conn-1', 'CodeReviewer', { entityType: 'agent' });
      router.register(agent);

      const joinEnvelope = createChannelJoinEnvelope('CodeReviewer', '#engineering');
      router.handleChannelJoin(agent, joinEnvelope);

      expect(router.getChannelMembers('#engineering')).toContain('CodeReviewer');
    });

    it('should allow multiple members to join the same channel', () => {
      const alice = new MockConnection('conn-1', 'alice', { entityType: 'user' });
      const bob = new MockConnection('conn-2', 'bob', { entityType: 'user' });
      const agent = new MockConnection('conn-3', 'CodeReviewer', { entityType: 'agent' });

      router.register(alice);
      router.register(bob);
      router.register(agent);

      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#general'));
      router.handleChannelJoin(bob, createChannelJoinEnvelope('bob', '#general'));
      router.handleChannelJoin(agent, createChannelJoinEnvelope('CodeReviewer', '#general'));

      const members = router.getChannelMembers('#general');
      expect(members).toContain('alice');
      expect(members).toContain('bob');
      expect(members).toContain('CodeReviewer');
      expect(members).toHaveLength(3);
    });

    it('should broadcast join notification to existing channel members', () => {
      const alice = new MockConnection('conn-1', 'alice', { entityType: 'user' });
      const bob = new MockConnection('conn-2', 'bob', { entityType: 'user' });

      router.register(alice);
      router.register(bob);

      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#general'));
      alice.clearSent();

      router.handleChannelJoin(bob, createChannelJoinEnvelope('bob', '#general'));

      // Alice should receive notification that Bob joined
      expect(alice.sendMock).toHaveBeenCalled();
      const notification = alice.sentEnvelopes.find(e => e.type === 'CHANNEL_JOIN');
      expect(notification).toBeDefined();
      expect(notification?.from).toBe('bob');
    });

    it('should not duplicate join if already a member', () => {
      const alice = new MockConnection('conn-1', 'alice', { entityType: 'user' });
      router.register(alice);

      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#general'));
      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#general'));

      // Should only appear once
      const members = router.getChannelMembers('#general');
      const aliceCount = members.filter(m => m === 'alice').length;
      expect(aliceCount).toBe(1);
    });
  });

  describe('Channel Leave', () => {
    it('should remove member from channel on leave', () => {
      const alice = new MockConnection('conn-1', 'alice', { entityType: 'user' });
      router.register(alice);

      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#general'));
      expect(router.getChannelMembers('#general')).toContain('alice');

      router.handleChannelLeave(alice, createChannelLeaveEnvelope('alice', '#general'));
      expect(router.getChannelMembers('#general')).not.toContain('alice');
    });

    it('should broadcast leave notification to remaining members', () => {
      const alice = new MockConnection('conn-1', 'alice', { entityType: 'user' });
      const bob = new MockConnection('conn-2', 'bob', { entityType: 'user' });

      router.register(alice);
      router.register(bob);

      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#general'));
      router.handleChannelJoin(bob, createChannelJoinEnvelope('bob', '#general'));
      bob.clearSent();

      router.handleChannelLeave(alice, createChannelLeaveEnvelope('alice', '#general'));

      // Bob should receive notification that Alice left
      expect(bob.sendMock).toHaveBeenCalled();
      const notification = bob.sentEnvelopes.find(e => e.type === 'CHANNEL_LEAVE');
      expect(notification).toBeDefined();
      expect(notification?.from).toBe('alice');
    });

    it('should remove member from all channels on disconnect', () => {
      const alice = new MockConnection('conn-1', 'alice', { entityType: 'user' });
      router.register(alice);

      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#general'));
      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#engineering'));

      expect(router.getChannelMembers('#general')).toContain('alice');
      expect(router.getChannelMembers('#engineering')).toContain('alice');

      router.unregister(alice);

      expect(router.getChannelMembers('#general')).not.toContain('alice');
      expect(router.getChannelMembers('#engineering')).not.toContain('alice');
    });

    it('should handle leave from channel not joined gracefully', () => {
      const alice = new MockConnection('conn-1', 'alice', { entityType: 'user' });
      router.register(alice);

      // Should not throw
      expect(() => {
        router.handleChannelLeave(alice, createChannelLeaveEnvelope('alice', '#nonexistent'));
      }).not.toThrow();
    });
  });

  describe('Channel Message Routing', () => {
    it('should route message to all channel members except sender', () => {
      const alice = new MockConnection('conn-1', 'alice', { entityType: 'user' });
      const bob = new MockConnection('conn-2', 'bob', { entityType: 'user' });
      const charlie = new MockConnection('conn-3', 'charlie', { entityType: 'user' });

      router.register(alice);
      router.register(bob);
      router.register(charlie);

      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#general'));
      router.handleChannelJoin(bob, createChannelJoinEnvelope('bob', '#general'));
      router.handleChannelJoin(charlie, createChannelJoinEnvelope('charlie', '#general'));

      alice.clearSent();
      bob.clearSent();
      charlie.clearSent();

      const msgEnvelope = createChannelMessageEnvelope('alice', '#general', 'Hello everyone!');
      router.routeChannelMessage(alice, msgEnvelope);

      // Alice should NOT receive her own message
      expect(alice.sendMock).not.toHaveBeenCalled();

      // Bob and Charlie should receive the message
      expect(bob.sendMock).toHaveBeenCalled();
      expect(charlie.sendMock).toHaveBeenCalled();

      const bobMsg = bob.sentEnvelopes.find(e => e.type === 'CHANNEL_MESSAGE');
      expect(bobMsg?.from).toBe('alice');
      expect((bobMsg?.payload as ChannelMessagePayload).body).toBe('Hello everyone!');
    });

    it('should not route message to non-members', () => {
      const alice = new MockConnection('conn-1', 'alice', { entityType: 'user' });
      const bob = new MockConnection('conn-2', 'bob', { entityType: 'user' });
      const outsider = new MockConnection('conn-3', 'outsider', { entityType: 'user' });

      router.register(alice);
      router.register(bob);
      router.register(outsider);

      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#private'));
      router.handleChannelJoin(bob, createChannelJoinEnvelope('bob', '#private'));
      // outsider does NOT join

      alice.clearSent();
      bob.clearSent();
      outsider.clearSent();

      const msgEnvelope = createChannelMessageEnvelope('alice', '#private', 'Secret message');
      router.routeChannelMessage(alice, msgEnvelope);

      expect(bob.sendMock).toHaveBeenCalled();
      expect(outsider.sendMock).not.toHaveBeenCalled();
    });

    it('should route message from agent to user in same channel', () => {
      const agent = new MockConnection('conn-1', 'CodeReviewer', { entityType: 'agent' });
      const user = new MockConnection('conn-2', 'alice', { entityType: 'user' });

      router.register(agent);
      router.register(user);

      router.handleChannelJoin(agent, createChannelJoinEnvelope('CodeReviewer', '#engineering'));
      router.handleChannelJoin(user, createChannelJoinEnvelope('alice', '#engineering'));

      agent.clearSent();
      user.clearSent();

      const msgEnvelope = createChannelMessageEnvelope('CodeReviewer', '#engineering', 'PR looks good!');
      router.routeChannelMessage(agent, msgEnvelope);

      expect(user.sendMock).toHaveBeenCalled();
      const received = user.sentEnvelopes.find(e => e.type === 'CHANNEL_MESSAGE');
      expect(received?.from).toBe('CodeReviewer');
    });

    it('should route message from user to agent in same channel', () => {
      const agent = new MockConnection('conn-1', 'CodeReviewer', { entityType: 'agent' });
      const user = new MockConnection('conn-2', 'alice', { entityType: 'user' });

      router.register(agent);
      router.register(user);

      router.handleChannelJoin(agent, createChannelJoinEnvelope('CodeReviewer', '#engineering'));
      router.handleChannelJoin(user, createChannelJoinEnvelope('alice', '#engineering'));

      agent.clearSent();
      user.clearSent();

      const msgEnvelope = createChannelMessageEnvelope('alice', '#engineering', 'Can you review my PR?');
      router.routeChannelMessage(user, msgEnvelope);

      expect(agent.sendMock).toHaveBeenCalled();
      const received = agent.sentEnvelopes.find(e => e.type === 'CHANNEL_MESSAGE');
      expect(received?.from).toBe('alice');
    });

    it('should persist channel messages', async () => {
      const alice = new MockConnection('conn-1', 'alice', { entityType: 'user' });
      const bob = new MockConnection('conn-2', 'bob', { entityType: 'user' });

      router.register(alice);
      router.register(bob);

      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#general'));
      router.handleChannelJoin(bob, createChannelJoinEnvelope('bob', '#general'));

      const msgEnvelope = createChannelMessageEnvelope('alice', '#general', 'Persistent message');
      router.routeChannelMessage(alice, msgEnvelope);

      // Give async storage a moment
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(saved.length).toBeGreaterThan(0);
      const savedMsg = saved.find(m => m.body === 'Persistent message');
      expect(savedMsg).toBeDefined();
      expect(savedMsg?.from).toBe('alice');
    });
  });

  describe('Direct Messages (DM)', () => {
    it('should route DM between two users', () => {
      const alice = new MockConnection('conn-1', 'alice', { entityType: 'user' });
      const bob = new MockConnection('conn-2', 'bob', { entityType: 'user' });

      router.register(alice);
      router.register(bob);

      // Both join the DM channel
      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', 'dm:alice:bob'));
      router.handleChannelJoin(bob, createChannelJoinEnvelope('bob', 'dm:alice:bob'));

      alice.clearSent();
      bob.clearSent();

      const dmEnvelope = createChannelMessageEnvelope('alice', 'dm:alice:bob', 'Hey Bob, private message!');
      router.routeChannelMessage(alice, dmEnvelope);

      expect(bob.sendMock).toHaveBeenCalled();
      expect(alice.sendMock).not.toHaveBeenCalled(); // Sender doesn't receive own message

      const received = bob.sentEnvelopes.find(e => e.type === 'CHANNEL_MESSAGE');
      expect((received?.payload as ChannelMessagePayload).body).toBe('Hey Bob, private message!');
    });

    it('should route DM between user and agent', () => {
      const user = new MockConnection('conn-1', 'alice', { entityType: 'user' });
      const agent = new MockConnection('conn-2', 'Assistant', { entityType: 'agent' });

      router.register(user);
      router.register(agent);

      // Both join the DM channel
      router.handleChannelJoin(user, createChannelJoinEnvelope('alice', 'dm:alice:Assistant'));
      router.handleChannelJoin(agent, createChannelJoinEnvelope('Assistant', 'dm:alice:Assistant'));

      user.clearSent();
      agent.clearSent();

      // User sends to agent
      const dm1 = createChannelMessageEnvelope('alice', 'dm:alice:Assistant', 'Can you help me?');
      router.routeChannelMessage(user, dm1);

      expect(agent.sendMock).toHaveBeenCalled();

      agent.clearSent();
      user.clearSent();

      // Agent responds
      const dm2 = createChannelMessageEnvelope('Assistant', 'dm:alice:Assistant', 'Of course! How can I help?');
      router.routeChannelMessage(agent, dm2);

      expect(user.sendMock).toHaveBeenCalled();
    });

    it('should support group DM with multiple participants', () => {
      const alice = new MockConnection('conn-1', 'alice', { entityType: 'user' });
      const bob = new MockConnection('conn-2', 'bob', { entityType: 'user' });
      const charlie = new MockConnection('conn-3', 'charlie', { entityType: 'user' });

      router.register(alice);
      router.register(bob);
      router.register(charlie);

      const groupDm = 'dm:alice:bob:charlie';
      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', groupDm));
      router.handleChannelJoin(bob, createChannelJoinEnvelope('bob', groupDm));
      router.handleChannelJoin(charlie, createChannelJoinEnvelope('charlie', groupDm));

      alice.clearSent();
      bob.clearSent();
      charlie.clearSent();

      const msg = createChannelMessageEnvelope('alice', groupDm, 'Group message');
      router.routeChannelMessage(alice, msg);

      // Both Bob and Charlie should receive, but not Alice
      expect(alice.sendMock).not.toHaveBeenCalled();
      expect(bob.sendMock).toHaveBeenCalled();
      expect(charlie.sendMock).toHaveBeenCalled();
    });
  });

  describe('User Entity Registration', () => {
    it('should track user entity type separately from agents', () => {
      const user = new MockConnection('conn-1', 'alice', { entityType: 'user' });
      const agent = new MockConnection('conn-2', 'CodeReviewer', { entityType: 'agent' });

      router.register(user);
      router.register(agent);

      expect(router.isUser('alice')).toBe(true);
      expect(router.isUser('CodeReviewer')).toBe(false);
      expect(router.isAgent('alice')).toBe(false);
      expect(router.isAgent('CodeReviewer')).toBe(true);
    });

    it('should return all users', () => {
      const user1 = new MockConnection('conn-1', 'alice', { entityType: 'user' });
      const user2 = new MockConnection('conn-2', 'bob', { entityType: 'user' });
      const agent = new MockConnection('conn-3', 'CodeReviewer', { entityType: 'agent' });

      router.register(user1);
      router.register(user2);
      router.register(agent);

      const users = router.getUsers();
      expect(users).toContain('alice');
      expect(users).toContain('bob');
      expect(users).not.toContain('CodeReviewer');
      expect(users).toHaveLength(2);
    });

    it('should return all agents (excluding users)', () => {
      const user = new MockConnection('conn-1', 'alice', { entityType: 'user' });
      const agent1 = new MockConnection('conn-2', 'CodeReviewer', { entityType: 'agent' });
      const agent2 = new MockConnection('conn-3', 'TestRunner', { entityType: 'agent' });

      router.register(user);
      router.register(agent1);
      router.register(agent2);

      const agents = router.getAgents();
      expect(agents).toContain('CodeReviewer');
      expect(agents).toContain('TestRunner');
      expect(agents).not.toContain('alice');
    });
  });

  describe('Channel Listing', () => {
    it('should list all channels', () => {
      const alice = new MockConnection('conn-1', 'alice', { entityType: 'user' });
      router.register(alice);

      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#general'));
      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#engineering'));
      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', 'dm:alice:bob'));

      const channels = router.getChannels();
      expect(channels).toContain('#general');
      expect(channels).toContain('#engineering');
      expect(channels).toContain('dm:alice:bob');
    });

    it('should list channels for a specific user', () => {
      const alice = new MockConnection('conn-1', 'alice', { entityType: 'user' });
      const bob = new MockConnection('conn-2', 'bob', { entityType: 'user' });

      router.register(alice);
      router.register(bob);

      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#general'));
      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#alice-only'));
      router.handleChannelJoin(bob, createChannelJoinEnvelope('bob', '#general'));
      router.handleChannelJoin(bob, createChannelJoinEnvelope('bob', '#bob-only'));

      const aliceChannels = router.getChannelsForMember('alice');
      expect(aliceChannels).toContain('#general');
      expect(aliceChannels).toContain('#alice-only');
      expect(aliceChannels).not.toContain('#bob-only');
    });

    it('should delete empty channels', () => {
      const alice = new MockConnection('conn-1', 'alice', { entityType: 'user' });
      router.register(alice);

      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#temp'));
      expect(router.getChannels()).toContain('#temp');

      router.handleChannelLeave(alice, createChannelLeaveEnvelope('alice', '#temp'));
      // Empty channel should be removed
      expect(router.getChannels()).not.toContain('#temp');
    });
  });

  describe('Channel Thread Support', () => {
    it('should support threaded messages in channels', () => {
      const alice = new MockConnection('conn-1', 'alice', { entityType: 'user' });
      const bob = new MockConnection('conn-2', 'bob', { entityType: 'user' });

      router.register(alice);
      router.register(bob);

      router.handleChannelJoin(alice, createChannelJoinEnvelope('alice', '#general'));
      router.handleChannelJoin(bob, createChannelJoinEnvelope('bob', '#general'));

      alice.clearSent();
      bob.clearSent();

      // Parent message
      const parentMsg: Envelope<ChannelMessagePayload> = {
        v: 1,
        type: 'CHANNEL_MESSAGE',
        id: 'parent-123',
        ts: Date.now(),
        from: 'alice',
        payload: {
          channel: '#general',
          body: 'Starting a thread',
        },
      };
      router.routeChannelMessage(alice, parentMsg);

      bob.clearSent();

      // Threaded reply
      const threadedReply: Envelope<ChannelMessagePayload> = {
        v: 1,
        type: 'CHANNEL_MESSAGE',
        id: 'reply-456',
        ts: Date.now(),
        from: 'bob',
        payload: {
          channel: '#general',
          body: 'This is a reply',
          thread: 'parent-123',
        },
      };
      router.routeChannelMessage(bob, threadedReply);

      // Alice should receive the threaded reply
      expect(alice.sendMock).toHaveBeenCalled();
      const received = alice.sentEnvelopes.find(e => e.type === 'CHANNEL_MESSAGE');
      expect((received?.payload as ChannelMessagePayload).thread).toBe('parent-123');
    });
  });

  describe('Integration with existing SEND/DELIVER', () => {
    it('should still support direct agent-to-agent messaging via SEND', () => {
      const agent1 = new MockConnection('conn-1', 'agent1', { entityType: 'agent' });
      const agent2 = new MockConnection('conn-2', 'agent2', { entityType: 'agent' });

      router.register(agent1);
      router.register(agent2);

      // Traditional SEND message (not channel)
      const sendEnvelope: Envelope<SendPayload> = {
        v: 1,
        type: 'SEND',
        id: 'msg-1',
        ts: Date.now(),
        from: 'agent1',
        to: 'agent2',
        payload: {
          kind: 'message',
          body: 'Direct message via SEND',
        },
      };

      router.route(agent1, sendEnvelope);

      expect(agent2.sendMock).toHaveBeenCalled();
      const delivered = agent2.sentEnvelopes.find(e => e.type === 'DELIVER') as DeliverEnvelope;
      expect(delivered.payload.body).toBe('Direct message via SEND');
    });

    it('should allow user to send direct message to agent via SEND', () => {
      const user = new MockConnection('conn-1', 'alice', { entityType: 'user' });
      const agent = new MockConnection('conn-2', 'CodeReviewer', { entityType: 'agent' });

      router.register(user);
      router.register(agent);

      const sendEnvelope: Envelope<SendPayload> = {
        v: 1,
        type: 'SEND',
        id: 'msg-1',
        ts: Date.now(),
        from: 'alice',
        to: 'CodeReviewer',
        payload: {
          kind: 'message',
          body: 'User to agent direct message',
        },
      };

      router.route(user, sendEnvelope);

      expect(agent.sendMock).toHaveBeenCalled();
      const delivered = agent.sentEnvelopes.find(e => e.type === 'DELIVER') as DeliverEnvelope;
      expect(delivered.payload.body).toBe('User to agent direct message');
    });
  });
});
