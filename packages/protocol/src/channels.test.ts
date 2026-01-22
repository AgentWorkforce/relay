/**
 * Protocol tests for channels and user messaging.
 * TDD: Writing tests before implementation.
 *
 * This tests the new protocol types for:
 * - EntityType (agent vs user)
 * - Channel operations (join, leave, message)
 * - Direct messaging between users and agents
 */

import { describe, it, expect } from 'vitest';
import {
  EntityType,
  ChannelJoinPayload,
  ChannelLeavePayload,
  ChannelMessagePayload,
  ChannelInfoPayload,
  isChannelMessage,
  isUserEntity,
  isAgentEntity,
  createChannelJoinEnvelope,
  createChannelLeaveEnvelope,
  createChannelMessageEnvelope,
  PROTOCOL_VERSION,
} from './channels.js';

describe('EntityType', () => {
  it('should have agent type', () => {
    const entityType: EntityType = 'agent';
    expect(entityType).toBe('agent');
  });

  it('should have user type', () => {
    const entityType: EntityType = 'user';
    expect(entityType).toBe('user');
  });
});

describe('isUserEntity', () => {
  it('should return true for user entity type', () => {
    expect(isUserEntity('user')).toBe(true);
  });

  it('should return false for agent entity type', () => {
    expect(isUserEntity('agent')).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isUserEntity(undefined)).toBe(false);
  });
});

describe('isAgentEntity', () => {
  it('should return true for agent entity type', () => {
    expect(isAgentEntity('agent')).toBe(true);
  });

  it('should return false for user entity type', () => {
    expect(isAgentEntity('user')).toBe(false);
  });

  it('should return true for undefined (default is agent)', () => {
    expect(isAgentEntity(undefined)).toBe(true);
  });
});

describe('ChannelJoinPayload', () => {
  it('should have required channel field', () => {
    const payload: ChannelJoinPayload = {
      channel: 'general',
    };
    expect(payload.channel).toBe('general');
  });

  it('should support optional metadata', () => {
    const payload: ChannelJoinPayload = {
      channel: 'engineering',
      displayName: 'Alice',
      avatarUrl: 'https://example.com/alice.png',
    };
    expect(payload.channel).toBe('engineering');
    expect(payload.displayName).toBe('Alice');
    expect(payload.avatarUrl).toBe('https://example.com/alice.png');
  });
});

describe('ChannelLeavePayload', () => {
  it('should have required channel field', () => {
    const payload: ChannelLeavePayload = {
      channel: 'general',
    };
    expect(payload.channel).toBe('general');
  });

  it('should support optional reason', () => {
    const payload: ChannelLeavePayload = {
      channel: 'general',
      reason: 'Signing off for the day',
    };
    expect(payload.reason).toBe('Signing off for the day');
  });
});

describe('ChannelMessagePayload', () => {
  it('should have required channel and body fields', () => {
    const payload: ChannelMessagePayload = {
      channel: 'general',
      body: 'Hello everyone!',
    };
    expect(payload.channel).toBe('general');
    expect(payload.body).toBe('Hello everyone!');
  });

  it('should support optional thread for threaded replies', () => {
    const payload: ChannelMessagePayload = {
      channel: 'general',
      body: 'This is a reply',
      thread: 'msg-123',
    };
    expect(payload.thread).toBe('msg-123');
  });

  it('should support optional attachments', () => {
    const payload: ChannelMessagePayload = {
      channel: 'engineering',
      body: 'Check this out',
      attachments: [
        { id: 'att-1', filename: 'screenshot.png', mimeType: 'image/png', size: 1024 },
      ],
    };
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments![0].filename).toBe('screenshot.png');
  });

  it('should support optional metadata for rich content', () => {
    const payload: ChannelMessagePayload = {
      channel: 'general',
      body: 'Code review ready',
      data: {
        pullRequestUrl: 'https://github.com/org/repo/pull/123',
        status: 'ready_for_review',
      },
    };
    expect(payload.data?.pullRequestUrl).toBe('https://github.com/org/repo/pull/123');
  });

  it('should support mentions', () => {
    const payload: ChannelMessagePayload = {
      channel: 'general',
      body: 'Hey @alice, can you review this?',
      mentions: ['alice'],
    };
    expect(payload.mentions).toContain('alice');
  });
});

describe('ChannelInfoPayload', () => {
  it('should contain channel metadata', () => {
    const payload: ChannelInfoPayload = {
      channel: 'engineering',
      name: 'Engineering Team',
      description: 'For engineering discussions',
      members: [
        { name: 'Alice', entityType: 'user' },
        { name: 'Bob', entityType: 'user' },
        { name: 'CodeReviewer', entityType: 'agent' },
      ],
      createdAt: '2024-01-01T00:00:00Z',
    };
    expect(payload.channel).toBe('engineering');
    expect(payload.members).toHaveLength(3);
    expect(payload.members[0].entityType).toBe('user');
    expect(payload.members[2].entityType).toBe('agent');
  });

  it('should support topic field', () => {
    const payload: ChannelInfoPayload = {
      channel: 'general',
      name: 'General',
      topic: 'All things relay',
      members: [],
      createdAt: '2024-01-01T00:00:00Z',
    };
    expect(payload.topic).toBe('All things relay');
  });
});

describe('isChannelMessage', () => {
  it('should return true for CHANNEL_MESSAGE type', () => {
    const envelope = {
      v: 1,
      type: 'CHANNEL_MESSAGE' as const,
      id: 'msg-1',
      ts: Date.now(),
      payload: { channel: 'general', body: 'Hello' },
    };
    expect(isChannelMessage(envelope)).toBe(true);
  });

  it('should return false for SEND type', () => {
    const envelope = {
      v: 1,
      type: 'SEND' as const,
      id: 'msg-1',
      ts: Date.now(),
      payload: { kind: 'message', body: 'Hello' },
    };
    expect(isChannelMessage(envelope)).toBe(false);
  });
});

describe('createChannelJoinEnvelope', () => {
  it('should create valid CHANNEL_JOIN envelope', () => {
    const envelope = createChannelJoinEnvelope('alice', 'general');

    expect(envelope.v).toBe(PROTOCOL_VERSION);
    expect(envelope.type).toBe('CHANNEL_JOIN');
    expect(envelope.from).toBe('alice');
    expect(envelope.payload.channel).toBe('general');
    expect(envelope.id).toBeDefined();
    expect(envelope.ts).toBeDefined();
  });

  it('should include optional display name', () => {
    const envelope = createChannelJoinEnvelope('alice', 'general', {
      displayName: 'Alice Smith',
    });

    expect(envelope.payload.displayName).toBe('Alice Smith');
  });
});

describe('createChannelLeaveEnvelope', () => {
  it('should create valid CHANNEL_LEAVE envelope', () => {
    const envelope = createChannelLeaveEnvelope('alice', 'general');

    expect(envelope.v).toBe(PROTOCOL_VERSION);
    expect(envelope.type).toBe('CHANNEL_LEAVE');
    expect(envelope.from).toBe('alice');
    expect(envelope.payload.channel).toBe('general');
  });

  it('should include optional reason', () => {
    const envelope = createChannelLeaveEnvelope('alice', 'general', 'Switching to another channel');

    expect(envelope.payload.reason).toBe('Switching to another channel');
  });
});

describe('createChannelMessageEnvelope', () => {
  it('should create valid CHANNEL_MESSAGE envelope', () => {
    const envelope = createChannelMessageEnvelope('alice', 'general', 'Hello everyone!');

    expect(envelope.v).toBe(PROTOCOL_VERSION);
    expect(envelope.type).toBe('CHANNEL_MESSAGE');
    expect(envelope.from).toBe('alice');
    expect(envelope.payload.channel).toBe('general');
    expect(envelope.payload.body).toBe('Hello everyone!');
  });

  it('should include optional thread', () => {
    const envelope = createChannelMessageEnvelope('alice', 'general', 'Reply here', {
      thread: 'msg-parent-123',
    });

    expect(envelope.payload.thread).toBe('msg-parent-123');
  });

  it('should include optional mentions', () => {
    const envelope = createChannelMessageEnvelope('alice', 'general', 'Hey @bob', {
      mentions: ['bob'],
    });

    expect(envelope.payload.mentions).toContain('bob');
  });

  it('should include optional attachments', () => {
    const envelope = createChannelMessageEnvelope('alice', 'general', 'See attached', {
      attachments: [
        { id: 'att-1', filename: 'doc.pdf', mimeType: 'application/pdf', size: 2048 },
      ],
    });

    expect(envelope.payload.attachments).toHaveLength(1);
  });
});

describe('Direct Message Protocol', () => {
  it('should support DM between two users', () => {
    // DMs use the existing SEND/DELIVER but with entityType context
    const dmPayload: ChannelMessagePayload = {
      channel: 'dm:alice:bob', // Convention: dm:<user1>:<user2> (sorted alphabetically)
      body: 'Hey Bob!',
    };
    expect(dmPayload.channel.startsWith('dm:')).toBe(true);
  });

  it('should support DM between user and agent', () => {
    const dmPayload: ChannelMessagePayload = {
      channel: 'dm:CodeReviewer:alice', // dm:<agent>:<user>
      body: 'Can you review my PR?',
    };
    expect(dmPayload.channel.startsWith('dm:')).toBe(true);
  });

  it('should support group DM', () => {
    const groupDmPayload: ChannelMessagePayload = {
      channel: 'dm:alice:bob:charlie', // Multiple participants
      body: 'Group discussion',
    };
    expect(groupDmPayload.channel.split(':').length).toBeGreaterThan(2);
  });
});

describe('Channel naming conventions', () => {
  it('should use # prefix for public channels', () => {
    const channelName = '#general';
    expect(channelName.startsWith('#')).toBe(true);
  });

  it('should use dm: prefix for direct messages', () => {
    const dmChannel = 'dm:alice:bob';
    expect(dmChannel.startsWith('dm:')).toBe(true);
  });

  it('should support private channels with lock prefix', () => {
    const privateChannel = 'private:engineering-leads';
    expect(privateChannel.startsWith('private:')).toBe(true);
  });
});
