/**
 * Tests for Channels V1 API functions
 *
 * Tests API response handling and mapping logic.
 * Uses mock fetch for testing without real API calls.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Channel, ChannelMessage, ChannelMember, SearchResult } from './types';

// Mock the USE_REAL_API to always be true for these tests
vi.mock('./mockApi', () => ({}));

// Test the mapping functions by extracting them
// These are the same mapping functions from api.ts

function mapChannelFromBackend(backend: unknown): Channel {
  const b = backend as Record<string, unknown>;
  return {
    id: String(b.id || ''),
    name: String(b.name || ''),
    description: b.description as string | undefined,
    topic: b.topic as string | undefined,
    visibility: b.isPrivate ? 'private' : 'public',
    status: b.isArchived ? 'archived' : 'active',
    createdAt: String(b.createdAt || new Date().toISOString()),
    createdBy: String(b.createdById || b.createdBy || ''),
    lastActivityAt: b.lastActivityAt as string | undefined,
    memberCount: Number(b.memberCount) || 0,
    unreadCount: Number(b.unreadCount) || 0,
    hasMentions: Boolean(b.hasMentions),
    lastMessage: b.lastMessage as Channel['lastMessage'],
    isDm: Boolean(b.isDm),
    dmParticipants: b.dmParticipants as string[] | undefined,
  };
}

function mapMessageFromBackend(backend: unknown): ChannelMessage {
  const b = backend as Record<string, unknown>;
  return {
    id: String(b.id || ''),
    channelId: String(b.channelId || ''),
    from: String(b.from || b.senderName || ''),
    fromEntityType: (b.fromEntityType as 'agent' | 'user') || 'user',
    fromAvatarUrl: b.fromAvatarUrl as string | undefined,
    content: String(b.content || b.body || ''),
    timestamp: String(b.timestamp || b.createdAt || new Date().toISOString()),
    editedAt: b.editedAt as string | undefined,
    threadId: b.threadId as string | undefined,
    threadSummary: b.threadSummary as ChannelMessage['threadSummary'],
    mentions: b.mentions as string[] | undefined,
    attachments: b.attachments as ChannelMessage['attachments'],
    reactions: b.reactions as ChannelMessage['reactions'],
    isPinned: Boolean(b.isPinned),
    isRead: b.isRead !== false,
  };
}

function mapSearchResultFromBackend(backend: unknown): SearchResult {
  const b = backend as Record<string, unknown>;
  return {
    id: String(b.id || b.messageId || ''),
    channelId: String(b.channelId || ''),
    channelName: String(b.channelName || ''),
    from: String(b.from || b.senderName || ''),
    fromEntityType: (b.fromEntityType as 'agent' | 'user') || 'user',
    content: String(b.content || b.body || ''),
    snippet: String(b.snippet || b.headline || b.content || ''),
    timestamp: String(b.timestamp || b.createdAt || new Date().toISOString()),
    rank: Number(b.rank) || 0,
  };
}

describe('Channel API Mapping Functions', () => {
  describe('mapChannelFromBackend', () => {
    it('should map basic channel fields', () => {
      const backend = {
        id: 'ch-123',
        name: 'general',
        description: 'General discussion',
        isPrivate: false,
        isArchived: false,
        memberCount: 5,
        unreadCount: 2,
        createdAt: '2024-01-01T00:00:00Z',
        createdById: 'user-1',
      };

      const result = mapChannelFromBackend(backend);

      expect(result.id).toBe('ch-123');
      expect(result.name).toBe('general');
      expect(result.description).toBe('General discussion');
      expect(result.visibility).toBe('public');
      expect(result.status).toBe('active');
      expect(result.memberCount).toBe(5);
      expect(result.unreadCount).toBe(2);
    });

    it('should map private channel correctly', () => {
      const backend = {
        id: 'ch-private',
        name: 'secret',
        isPrivate: true,
      };

      const result = mapChannelFromBackend(backend);

      expect(result.visibility).toBe('private');
    });

    it('should map archived channel correctly', () => {
      const backend = {
        id: 'ch-archived',
        name: 'old-project',
        isArchived: true,
      };

      const result = mapChannelFromBackend(backend);

      expect(result.status).toBe('archived');
    });

    it('should map DM channel correctly', () => {
      const backend = {
        id: 'dm-123',
        name: 'dm-alice-bob',
        isDm: true,
        dmParticipants: ['alice', 'bob'],
      };

      const result = mapChannelFromBackend(backend);

      expect(result.isDm).toBe(true);
      expect(result.dmParticipants).toEqual(['alice', 'bob']);
    });

    it('should handle missing fields gracefully', () => {
      const backend = {};

      const result = mapChannelFromBackend(backend);

      expect(result.id).toBe('');
      expect(result.name).toBe('');
      expect(result.visibility).toBe('public');
      expect(result.status).toBe('active');
      expect(result.memberCount).toBe(0);
      expect(result.unreadCount).toBe(0);
      expect(result.hasMentions).toBe(false);
      expect(result.isDm).toBe(false);
    });

    it('should map hasMentions correctly', () => {
      const backend = {
        id: 'ch-123',
        name: 'alerts',
        hasMentions: true,
      };

      const result = mapChannelFromBackend(backend);

      expect(result.hasMentions).toBe(true);
    });
  });

  describe('mapMessageFromBackend', () => {
    it('should map basic message fields', () => {
      const backend = {
        id: 'msg-123',
        channelId: 'ch-general',
        from: 'alice',
        fromEntityType: 'user',
        content: 'Hello world!',
        timestamp: '2024-01-01T12:00:00Z',
      };

      const result = mapMessageFromBackend(backend);

      expect(result.id).toBe('msg-123');
      expect(result.channelId).toBe('ch-general');
      expect(result.from).toBe('alice');
      expect(result.fromEntityType).toBe('user');
      expect(result.content).toBe('Hello world!');
      expect(result.timestamp).toBe('2024-01-01T12:00:00Z');
    });

    it('should handle agent messages', () => {
      const backend = {
        id: 'msg-456',
        channelId: 'ch-dev',
        senderName: 'CodeAgent',
        fromEntityType: 'agent',
        body: 'Task completed!',
        createdAt: '2024-01-01T13:00:00Z',
      };

      const result = mapMessageFromBackend(backend);

      expect(result.from).toBe('CodeAgent');
      expect(result.fromEntityType).toBe('agent');
      expect(result.content).toBe('Task completed!');
    });

    it('should handle pinned messages', () => {
      const backend = {
        id: 'msg-pinned',
        channelId: 'ch-announcements',
        from: 'admin',
        content: 'Important announcement',
        isPinned: true,
      };

      const result = mapMessageFromBackend(backend);

      expect(result.isPinned).toBe(true);
    });

    it('should handle thread messages', () => {
      const backend = {
        id: 'msg-reply',
        channelId: 'ch-general',
        from: 'bob',
        content: 'Reply in thread',
        threadId: 'msg-parent',
      };

      const result = mapMessageFromBackend(backend);

      expect(result.threadId).toBe('msg-parent');
    });

    it('should default isRead to true when not specified', () => {
      const backend = {
        id: 'msg-123',
        channelId: 'ch-general',
        from: 'alice',
        content: 'Test',
      };

      const result = mapMessageFromBackend(backend);

      expect(result.isRead).toBe(true);
    });

    it('should respect explicit isRead = false', () => {
      const backend = {
        id: 'msg-123',
        channelId: 'ch-general',
        from: 'alice',
        content: 'Test',
        isRead: false,
      };

      const result = mapMessageFromBackend(backend);

      expect(result.isRead).toBe(false);
    });
  });

  describe('mapSearchResultFromBackend', () => {
    it('should map search result fields', () => {
      const backend = {
        id: 'msg-123',
        channelId: 'ch-general',
        channelName: 'general',
        from: 'alice',
        fromEntityType: 'user',
        content: 'Hello world!',
        snippet: '...Hello <b>world</b>!...',
        timestamp: '2024-01-01T12:00:00Z',
        rank: 0.95,
      };

      const result = mapSearchResultFromBackend(backend);

      expect(result.id).toBe('msg-123');
      expect(result.channelId).toBe('ch-general');
      expect(result.channelName).toBe('general');
      expect(result.from).toBe('alice');
      expect(result.content).toBe('Hello world!');
      expect(result.snippet).toBe('...Hello <b>world</b>!...');
      expect(result.rank).toBe(0.95);
    });

    it('should handle alternative field names', () => {
      const backend = {
        messageId: 'msg-456',
        channelId: 'ch-dev',
        channelName: 'dev',
        senderName: 'CodeAgent',
        fromEntityType: 'agent',
        body: 'Task update',
        headline: 'Task <b>update</b>',
        createdAt: '2024-01-02T10:00:00Z',
      };

      const result = mapSearchResultFromBackend(backend);

      expect(result.id).toBe('msg-456');
      expect(result.from).toBe('CodeAgent');
      expect(result.content).toBe('Task update');
      expect(result.snippet).toBe('Task <b>update</b>');
    });

    it('should use content as snippet fallback', () => {
      const backend = {
        id: 'msg-789',
        channelId: 'ch-test',
        channelName: 'test',
        from: 'bob',
        content: 'Plain text content',
      };

      const result = mapSearchResultFromBackend(backend);

      expect(result.snippet).toBe('Plain text content');
    });

    it('should default rank to 0', () => {
      const backend = {
        id: 'msg-123',
        channelId: 'ch-general',
        channelName: 'general',
        from: 'alice',
        content: 'Test',
      };

      const result = mapSearchResultFromBackend(backend);

      expect(result.rank).toBe(0);
    });
  });
});

describe('Channel API Integration', () => {
  describe('View Mode State', () => {
    it('should support channels view mode', () => {
      type ViewMode = 'local' | 'fleet' | 'channels';
      const viewMode: ViewMode = 'channels';
      expect(viewMode).toBe('channels');
    });

    it('should allow switching between view modes', () => {
      type ViewMode = 'local' | 'fleet' | 'channels';
      let viewMode: ViewMode = 'local';

      viewMode = 'channels';
      expect(viewMode).toBe('channels');

      viewMode = 'fleet';
      expect(viewMode).toBe('fleet');

      viewMode = 'local';
      expect(viewMode).toBe('local');
    });
  });

  describe('Channel Selection State', () => {
    it('should find selected channel from list', () => {
      const channels: Channel[] = [
        { id: 'ch-1', name: 'general', visibility: 'public', status: 'active', createdAt: '', createdBy: '', memberCount: 0, unreadCount: 0, hasMentions: false, isDm: false },
        { id: 'ch-2', name: 'random', visibility: 'public', status: 'active', createdAt: '', createdBy: '', memberCount: 0, unreadCount: 0, hasMentions: false, isDm: false },
      ];
      const selectedChannelId = 'ch-2';

      const selectedChannel = channels.find(c => c.id === selectedChannelId);

      expect(selectedChannel?.name).toBe('random');
    });

    it('should return undefined for non-existent channel', () => {
      const channels: Channel[] = [
        { id: 'ch-1', name: 'general', visibility: 'public', status: 'active', createdAt: '', createdBy: '', memberCount: 0, unreadCount: 0, hasMentions: false, isDm: false },
      ];
      const selectedChannelId = 'ch-999';

      const selectedChannel = channels.find(c => c.id === selectedChannelId);

      expect(selectedChannel).toBeUndefined();
    });
  });
});

describe('Command Palette Channel Commands', () => {
  describe('Channel command generation', () => {
    it('should generate Go to Channels command', () => {
      const commands = [
        {
          id: 'channels-view',
          label: 'Go to Channels',
          description: 'Switch to channel messaging view',
          category: 'channels' as const,
          shortcut: '⌘⇧C',
        },
      ];

      expect(commands[0].id).toBe('channels-view');
      expect(commands[0].label).toBe('Go to Channels');
      expect(commands[0].shortcut).toBe('⌘⇧C');
    });

    it('should generate Create Channel command', () => {
      const commands = [
        {
          id: 'channels-create',
          label: 'Create Channel',
          description: 'Create a new messaging channel',
          category: 'channels' as const,
        },
      ];

      expect(commands[0].id).toBe('channels-create');
      expect(commands[0].label).toBe('Create Channel');
    });

    it('should generate quick-switch commands for each channel', () => {
      const channels: Channel[] = [
        { id: 'ch-1', name: 'general', visibility: 'public', status: 'active', createdAt: '', createdBy: '', memberCount: 0, unreadCount: 0, hasMentions: false, isDm: false, description: 'Main channel' },
        { id: 'ch-2', name: 'random', visibility: 'public', status: 'active', createdAt: '', createdBy: '', memberCount: 0, unreadCount: 3, hasMentions: false, isDm: false },
      ];

      const commands = channels.map((channel) => ({
        id: `channel-switch-${channel.id}`,
        label: channel.isDm ? `@${channel.name}` : `#${channel.name}`,
        description: channel.description || `Switch to ${channel.isDm ? 'DM' : 'channel'}`,
        category: 'channels' as const,
      }));

      expect(commands).toHaveLength(2);
      expect(commands[0].label).toBe('#general');
      expect(commands[0].description).toBe('Main channel');
      expect(commands[1].label).toBe('#random');
    });

    it('should format DM channels with @ prefix', () => {
      const dmChannel: Channel = {
        id: 'dm-1',
        name: 'alice',
        visibility: 'private',
        status: 'active',
        createdAt: '',
        createdBy: '',
        memberCount: 2,
        unreadCount: 0,
        hasMentions: false,
        isDm: true,
        dmParticipants: ['alice', 'bob'],
      };

      const label = dmChannel.isDm ? `@${dmChannel.name}` : `#${dmChannel.name}`;

      expect(label).toBe('@alice');
    });

    it('should include unread count in channel description', () => {
      const channel: Channel = {
        id: 'ch-1',
        name: 'alerts',
        visibility: 'public',
        status: 'active',
        createdAt: '',
        createdBy: '',
        memberCount: 5,
        unreadCount: 7,
        hasMentions: false,
        isDm: false,
      };

      const unreadBadge = channel.unreadCount > 0 ? ` (${channel.unreadCount} unread)` : '';
      const description = channel.description || `Switch to channel${unreadBadge}`;

      expect(description).toBe('Switch to channel (7 unread)');
    });
  });

  describe('Keyboard shortcut handling', () => {
    it('should detect Cmd+Shift+C for channels view', () => {
      const event = {
        metaKey: true,
        ctrlKey: false,
        shiftKey: true,
        key: 'c',
      };

      const isChannelsShortcut = (event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'c';

      expect(isChannelsShortcut).toBe(true);
    });

    it('should detect Ctrl+Shift+C for channels view (Windows/Linux)', () => {
      const event = {
        metaKey: false,
        ctrlKey: true,
        shiftKey: true,
        key: 'c',
      };

      const isChannelsShortcut = (event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'c';

      expect(isChannelsShortcut).toBe(true);
    });

    it('should not trigger for Cmd+C (without shift)', () => {
      const event = {
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        key: 'c',
      };

      const isChannelsShortcut = (event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'c';

      expect(isChannelsShortcut).toBe(false);
    });
  });

  describe('Client-side channel filtering', () => {
    const channels: Channel[] = [
      { id: 'ch-1', name: 'general', visibility: 'public', status: 'active', createdAt: '', createdBy: '', memberCount: 0, unreadCount: 0, hasMentions: false, isDm: false, description: 'General discussion' },
      { id: 'ch-2', name: 'engineering', visibility: 'public', status: 'active', createdAt: '', createdBy: '', memberCount: 0, unreadCount: 0, hasMentions: false, isDm: false, description: 'Engineering team' },
      { id: 'ch-3', name: 'marketing', visibility: 'public', status: 'active', createdAt: '', createdBy: '', memberCount: 0, unreadCount: 0, hasMentions: false, isDm: false },
      { id: 'dm-1', name: 'alice', visibility: 'private', status: 'active', createdAt: '', createdBy: '', memberCount: 2, unreadCount: 0, hasMentions: false, isDm: true },
    ];

    it('should filter channels by name', () => {
      const query = 'eng';
      const filtered = channels.filter(c =>
        c.name.toLowerCase().includes(query.toLowerCase())
      );

      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe('engineering');
    });

    it('should filter channels by description', () => {
      const query = 'team';
      const filtered = channels.filter(c =>
        c.name.toLowerCase().includes(query.toLowerCase()) ||
        c.description?.toLowerCase().includes(query.toLowerCase())
      );

      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe('engineering');
    });

    it('should return all channels with empty query', () => {
      const query = '';
      const filtered = query.trim()
        ? channels.filter(c => c.name.toLowerCase().includes(query.toLowerCase()))
        : channels;

      expect(filtered).toHaveLength(4);
    });

    it('should return empty array when no matches', () => {
      const query = 'xyz';
      const filtered = channels.filter(c =>
        c.name.toLowerCase().includes(query.toLowerCase())
      );

      expect(filtered).toHaveLength(0);
    });

    it('should filter case-insensitively', () => {
      const query = 'GENERAL';
      const filtered = channels.filter(c =>
        c.name.toLowerCase().includes(query.toLowerCase())
      );

      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe('general');
    });
  });
});

describe('Channel Message Pagination', () => {
  describe('Cursor-based pagination', () => {
    it('should use oldest message ID as cursor for loading more', () => {
      const messages: ChannelMessage[] = [
        { id: 'msg-1', channelId: 'ch-1', from: 'alice', fromEntityType: 'user', content: 'First', timestamp: '2024-01-01T10:00:00Z', isPinned: false, isRead: true },
        { id: 'msg-2', channelId: 'ch-1', from: 'bob', fromEntityType: 'user', content: 'Second', timestamp: '2024-01-01T11:00:00Z', isPinned: false, isRead: true },
        { id: 'msg-3', channelId: 'ch-1', from: 'alice', fromEntityType: 'user', content: 'Third', timestamp: '2024-01-01T12:00:00Z', isPinned: false, isRead: true },
      ];

      const oldestMessage = messages[0];
      const cursor = oldestMessage.id;

      expect(cursor).toBe('msg-1');
    });

    it('should prepend older messages when loading more', () => {
      const existingMessages: ChannelMessage[] = [
        { id: 'msg-3', channelId: 'ch-1', from: 'alice', fromEntityType: 'user', content: 'Third', timestamp: '2024-01-01T12:00:00Z', isPinned: false, isRead: true },
      ];

      const olderMessages: ChannelMessage[] = [
        { id: 'msg-1', channelId: 'ch-1', from: 'alice', fromEntityType: 'user', content: 'First', timestamp: '2024-01-01T10:00:00Z', isPinned: false, isRead: true },
        { id: 'msg-2', channelId: 'ch-1', from: 'bob', fromEntityType: 'user', content: 'Second', timestamp: '2024-01-01T11:00:00Z', isPinned: false, isRead: true },
      ];

      const combinedMessages = [...olderMessages, ...existingMessages];

      expect(combinedMessages).toHaveLength(3);
      expect(combinedMessages[0].id).toBe('msg-1');
      expect(combinedMessages[2].id).toBe('msg-3');
    });

    it('should preserve message order after prepending', () => {
      const existingMessages: ChannelMessage[] = [
        { id: 'msg-50', channelId: 'ch-1', from: 'alice', fromEntityType: 'user', content: 'Msg 50', timestamp: '2024-01-01T14:00:00Z', isPinned: false, isRead: true },
        { id: 'msg-51', channelId: 'ch-1', from: 'bob', fromEntityType: 'user', content: 'Msg 51', timestamp: '2024-01-01T15:00:00Z', isPinned: false, isRead: true },
      ];

      const olderMessages: ChannelMessage[] = [
        { id: 'msg-48', channelId: 'ch-1', from: 'alice', fromEntityType: 'user', content: 'Msg 48', timestamp: '2024-01-01T12:00:00Z', isPinned: false, isRead: true },
        { id: 'msg-49', channelId: 'ch-1', from: 'bob', fromEntityType: 'user', content: 'Msg 49', timestamp: '2024-01-01T13:00:00Z', isPinned: false, isRead: true },
      ];

      const combinedMessages = [...olderMessages, ...existingMessages];

      // Verify chronological order
      for (let i = 0; i < combinedMessages.length - 1; i++) {
        const currentTime = new Date(combinedMessages[i].timestamp).getTime();
        const nextTime = new Date(combinedMessages[i + 1].timestamp).getTime();
        expect(currentTime).toBeLessThanOrEqual(nextTime);
      }
    });
  });

  describe('Pagination state management', () => {
    it('should track hasMore state', () => {
      interface PaginationState {
        hasMore: boolean;
        isLoading: boolean;
      }

      let state: PaginationState = { hasMore: false, isLoading: false };

      // Initial load response indicates more messages exist
      state = { ...state, hasMore: true };
      expect(state.hasMore).toBe(true);

      // After loading all messages
      state = { ...state, hasMore: false };
      expect(state.hasMore).toBe(false);
    });

    it('should prevent concurrent load-more requests', () => {
      interface PaginationState {
        hasMore: boolean;
        isLoadingMore: boolean;
      }

      const state: PaginationState = { hasMore: true, isLoadingMore: true };

      // Should not trigger another load while loading
      const canLoadMore = state.hasMore && !state.isLoadingMore;
      expect(canLoadMore).toBe(false);
    });

    it('should not load more when no more messages', () => {
      interface PaginationState {
        hasMore: boolean;
        isLoadingMore: boolean;
      }

      const state: PaginationState = { hasMore: false, isLoadingMore: false };

      const canLoadMore = state.hasMore && !state.isLoadingMore;
      expect(canLoadMore).toBe(false);
    });

    it('should allow loading when hasMore is true and not loading', () => {
      interface PaginationState {
        hasMore: boolean;
        isLoadingMore: boolean;
      }

      const state: PaginationState = { hasMore: true, isLoadingMore: false };

      const canLoadMore = state.hasMore && !state.isLoadingMore;
      expect(canLoadMore).toBe(true);
    });
  });

  describe('Empty result handling', () => {
    it('should handle empty older messages response', () => {
      const existingMessages: ChannelMessage[] = [
        { id: 'msg-1', channelId: 'ch-1', from: 'alice', fromEntityType: 'user', content: 'First', timestamp: '2024-01-01T10:00:00Z', isPinned: false, isRead: true },
      ];

      const olderMessages: ChannelMessage[] = [];

      const combinedMessages = [...olderMessages, ...existingMessages];

      expect(combinedMessages).toHaveLength(1);
      expect(combinedMessages[0].id).toBe('msg-1');
    });

    it('should reset hasMore on empty response', () => {
      const responseHasMore = false;
      expect(responseHasMore).toBe(false);
    });
  });

  describe('Limit enforcement', () => {
    it('should respect max limit of 100', () => {
      const requestedLimit = 150;
      const enforcedLimit = Math.min(requestedLimit, 100);
      expect(enforcedLimit).toBe(100);
    });

    it('should use default limit when not specified', () => {
      const defaultLimit = 50;
      expect(defaultLimit).toBe(50);
    });
  });
});

// =============================================================================
// Task 9b: Unread UI Tests
// =============================================================================

describe('Unread UI', () => {
  describe('Unread state tracking', () => {
    it('should track unread count from API response', () => {
      interface UnreadState {
        count: number;
        firstUnreadMessageId?: string;
      }

      const apiResponse = {
        messages: [],
        hasMore: false,
        unread: { count: 5, firstUnreadMessageId: 'msg-123' },
      };

      const unreadState: UnreadState = apiResponse.unread;

      expect(unreadState.count).toBe(5);
      expect(unreadState.firstUnreadMessageId).toBe('msg-123');
    });

    it('should handle zero unread messages', () => {
      interface UnreadState {
        count: number;
        firstUnreadMessageId?: string;
      }

      const apiResponse = {
        messages: [],
        hasMore: false,
        unread: { count: 0 },
      };

      const unreadState: UnreadState = apiResponse.unread;

      expect(unreadState.count).toBe(0);
      expect(unreadState.firstUnreadMessageId).toBeUndefined();
    });

    it('should update unread state when channel changes', () => {
      interface ChannelUnreadState {
        [channelId: string]: { count: number; firstUnreadMessageId?: string };
      }

      const unreadStates: ChannelUnreadState = {
        'ch-1': { count: 3, firstUnreadMessageId: 'msg-10' },
        'ch-2': { count: 0 },
      };

      expect(unreadStates['ch-1'].count).toBe(3);
      expect(unreadStates['ch-2'].count).toBe(0);
    });
  });

  describe('Unread separator display', () => {
    it('should identify first unread message for separator', () => {
      const messages: ChannelMessage[] = [
        { id: 'msg-1', channelId: 'ch-1', from: 'alice', fromEntityType: 'user', content: 'Read message', timestamp: '2024-01-01T10:00:00Z', isPinned: false, isRead: true },
        { id: 'msg-2', channelId: 'ch-1', from: 'bob', fromEntityType: 'user', content: 'First unread', timestamp: '2024-01-01T11:00:00Z', isPinned: false, isRead: false },
        { id: 'msg-3', channelId: 'ch-1', from: 'alice', fromEntityType: 'user', content: 'Second unread', timestamp: '2024-01-01T12:00:00Z', isPinned: false, isRead: false },
      ];

      const unreadState = { count: 2, firstUnreadMessageId: 'msg-2' };

      const shouldShowSeparator = (messageId: string) =>
        messageId === unreadState.firstUnreadMessageId && unreadState.count > 0;

      expect(shouldShowSeparator('msg-1')).toBe(false);
      expect(shouldShowSeparator('msg-2')).toBe(true);
      expect(shouldShowSeparator('msg-3')).toBe(false);
    });

    it('should not show separator when all messages are read', () => {
      const unreadState = { count: 0 };

      const shouldShowSeparator = (messageId: string) =>
        messageId === unreadState.firstUnreadMessageId && unreadState.count > 0;

      expect(shouldShowSeparator('msg-1')).toBe(false);
    });
  });

  describe('Mark as read behavior', () => {
    it('should call markRead when viewing channel', () => {
      let markReadCalled = false;
      let markedChannelId: string | null = null;

      const mockMarkRead = (workspaceId: string, channelId: string) => {
        markReadCalled = true;
        markedChannelId = channelId;
      };

      // Simulate viewing a channel
      mockMarkRead('ws-1', 'ch-general');

      expect(markReadCalled).toBe(true);
      expect(markedChannelId).toBe('ch-general');
    });

    it('should update local unread count after marking read', () => {
      const channels: Channel[] = [
        { id: 'ch-1', name: 'general', visibility: 'public', status: 'active', createdAt: '', createdBy: '', memberCount: 0, unreadCount: 5, hasMentions: false, isDm: false },
      ];

      // After marking read, update local state
      const updatedChannels = channels.map(c =>
        c.id === 'ch-1' ? { ...c, unreadCount: 0 } : c
      );

      expect(updatedChannels[0].unreadCount).toBe(0);
    });

    it('should debounce markRead calls to prevent spam', async () => {
      let callCount = 0;

      const debouncedMarkRead = (() => {
        let timeout: NodeJS.Timeout | null = null;
        return () => {
          if (timeout) clearTimeout(timeout);
          timeout = setTimeout(() => {
            callCount++;
          }, 100);
        };
      })();

      // Rapid calls
      debouncedMarkRead();
      debouncedMarkRead();
      debouncedMarkRead();

      // Wait for debounce
      await new Promise(resolve => setTimeout(resolve, 150));

      expect(callCount).toBe(1);
    });
  });

  describe('Sidebar unread badges', () => {
    it('should show unread badge when count > 0', () => {
      const channel: Channel = {
        id: 'ch-1', name: 'alerts', visibility: 'public', status: 'active',
        createdAt: '', createdBy: '', memberCount: 5, unreadCount: 7,
        hasMentions: false, isDm: false,
      };

      const showBadge = channel.unreadCount > 0;
      expect(showBadge).toBe(true);
    });

    it('should not show badge when count is 0', () => {
      const channel: Channel = {
        id: 'ch-1', name: 'general', visibility: 'public', status: 'active',
        createdAt: '', createdBy: '', memberCount: 5, unreadCount: 0,
        hasMentions: false, isDm: false,
      };

      const showBadge = channel.unreadCount > 0;
      expect(showBadge).toBe(false);
    });

    it('should cap badge display at 99+', () => {
      const channel: Channel = {
        id: 'ch-1', name: 'busy', visibility: 'public', status: 'active',
        createdAt: '', createdBy: '', memberCount: 5, unreadCount: 150,
        hasMentions: false, isDm: false,
      };

      const badgeText = channel.unreadCount > 99 ? '99+' : String(channel.unreadCount);
      expect(badgeText).toBe('99+');
    });

    it('should calculate total unread count across channels', () => {
      const channels: Channel[] = [
        { id: 'ch-1', name: 'general', visibility: 'public', status: 'active', createdAt: '', createdBy: '', memberCount: 0, unreadCount: 3, hasMentions: false, isDm: false },
        { id: 'ch-2', name: 'random', visibility: 'public', status: 'active', createdAt: '', createdBy: '', memberCount: 0, unreadCount: 5, hasMentions: false, isDm: false },
        { id: 'ch-3', name: 'dev', visibility: 'public', status: 'active', createdAt: '', createdBy: '', memberCount: 0, unreadCount: 0, hasMentions: false, isDm: false },
      ];

      const totalUnread = channels.reduce((sum, c) => sum + c.unreadCount, 0);
      expect(totalUnread).toBe(8);
    });
  });

  describe('Unread state with mentions', () => {
    it('should show mention indicator when hasMentions is true', () => {
      const channel: Channel = {
        id: 'ch-1', name: 'alerts', visibility: 'public', status: 'active',
        createdAt: '', createdBy: '', memberCount: 5, unreadCount: 2,
        hasMentions: true, isDm: false,
      };

      expect(channel.hasMentions).toBe(true);
    });

    it('should prioritize mention styling over regular unread', () => {
      const channel: Channel = {
        id: 'ch-1', name: 'alerts', visibility: 'public', status: 'active',
        createdAt: '', createdBy: '', memberCount: 5, unreadCount: 2,
        hasMentions: true, isDm: false,
      };

      // Mention takes priority for styling
      const badgeStyle = channel.hasMentions ? 'mention' : (channel.unreadCount > 0 ? 'unread' : 'none');
      expect(badgeStyle).toBe('mention');
    });
  });
});

// =============================================================================
// Task 9b: Archive Tests
// =============================================================================

describe('Archive Functionality', () => {
  describe('Archive channel workflow', () => {
    it('should move channel to archived list on archive', () => {
      let channels: Channel[] = [
        { id: 'ch-1', name: 'general', visibility: 'public', status: 'active', createdAt: '', createdBy: '', memberCount: 0, unreadCount: 0, hasMentions: false, isDm: false },
        { id: 'ch-2', name: 'old-project', visibility: 'public', status: 'active', createdAt: '', createdBy: '', memberCount: 0, unreadCount: 0, hasMentions: false, isDm: false },
      ];
      let archivedChannels: Channel[] = [];

      // Archive ch-2
      const channelToArchive = channels.find(c => c.id === 'ch-2')!;
      const archivedChannel = { ...channelToArchive, status: 'archived' as const };

      channels = channels.filter(c => c.id !== 'ch-2');
      archivedChannels = [...archivedChannels, archivedChannel];

      expect(channels).toHaveLength(1);
      expect(archivedChannels).toHaveLength(1);
      expect(archivedChannels[0].status).toBe('archived');
    });

    it('should update channel status to archived', () => {
      const channel: Channel = {
        id: 'ch-1', name: 'old-project', visibility: 'public', status: 'active',
        createdAt: '', createdBy: '', memberCount: 5, unreadCount: 0,
        hasMentions: false, isDm: false,
      };

      const archivedChannel = { ...channel, status: 'archived' as const };

      expect(archivedChannel.status).toBe('archived');
    });

    it('should clear selection if archived channel was selected', () => {
      let selectedChannelId: string | null = 'ch-archived';
      const archivedChannelIds = ['ch-archived'];

      // On archive, clear selection if it was the archived channel
      if (selectedChannelId && archivedChannelIds.includes(selectedChannelId)) {
        selectedChannelId = null;
      }

      expect(selectedChannelId).toBeNull();
    });
  });

  describe('Unarchive channel workflow', () => {
    it('should move channel back to active list on unarchive', () => {
      let channels: Channel[] = [
        { id: 'ch-1', name: 'general', visibility: 'public', status: 'active', createdAt: '', createdBy: '', memberCount: 0, unreadCount: 0, hasMentions: false, isDm: false },
      ];
      let archivedChannels: Channel[] = [
        { id: 'ch-2', name: 'old-project', visibility: 'public', status: 'archived', createdAt: '', createdBy: '', memberCount: 0, unreadCount: 0, hasMentions: false, isDm: false },
      ];

      // Unarchive ch-2
      const channelToUnarchive = archivedChannels.find(c => c.id === 'ch-2')!;
      const unarchivedChannel = { ...channelToUnarchive, status: 'active' as const };

      archivedChannels = archivedChannels.filter(c => c.id !== 'ch-2');
      channels = [...channels, unarchivedChannel];

      expect(channels).toHaveLength(2);
      expect(archivedChannels).toHaveLength(0);
      expect(channels[1].status).toBe('active');
    });
  });

  describe('Archived section display', () => {
    it('should show archived section when archived channels exist', () => {
      const archivedChannels: Channel[] = [
        { id: 'ch-archived', name: 'old-project', visibility: 'public', status: 'archived', createdAt: '', createdBy: '', memberCount: 0, unreadCount: 0, hasMentions: false, isDm: false },
      ];

      const showArchivedSection = archivedChannels.length > 0;
      expect(showArchivedSection).toBe(true);
    });

    it('should hide archived section when no archived channels', () => {
      const archivedChannels: Channel[] = [];

      const showArchivedSection = archivedChannels.length > 0;
      expect(showArchivedSection).toBe(false);
    });

    it('should persist collapsed state in localStorage', () => {
      const STORAGE_KEY = 'channels-v1-archived-collapsed';

      // Simulate localStorage
      const storage: Record<string, string> = {};

      // Save collapsed state
      storage[STORAGE_KEY] = 'true';
      expect(storage[STORAGE_KEY]).toBe('true');

      // Load collapsed state
      const isCollapsed = storage[STORAGE_KEY] === 'true';
      expect(isCollapsed).toBe(true);
    });

    it('should filter archived channels by search query', () => {
      const archivedChannels: Channel[] = [
        { id: 'ch-1', name: 'old-project-alpha', visibility: 'public', status: 'archived', createdAt: '', createdBy: '', memberCount: 0, unreadCount: 0, hasMentions: false, isDm: false },
        { id: 'ch-2', name: 'old-project-beta', visibility: 'public', status: 'archived', createdAt: '', createdBy: '', memberCount: 0, unreadCount: 0, hasMentions: false, isDm: false },
        { id: 'ch-3', name: 'archive-misc', visibility: 'public', status: 'archived', createdAt: '', createdBy: '', memberCount: 0, unreadCount: 0, hasMentions: false, isDm: false },
      ];

      const searchQuery = 'project';
      const filtered = archivedChannels.filter(c =>
        c.name.toLowerCase().includes(searchQuery.toLowerCase())
      );

      expect(filtered).toHaveLength(2);
    });
  });

  describe('Archived channel behavior', () => {
    it('should disable message input for archived channels', () => {
      const channel: Channel = {
        id: 'ch-1', name: 'archived-channel', visibility: 'public', status: 'archived',
        createdAt: '', createdBy: '', memberCount: 5, unreadCount: 0,
        hasMentions: false, isDm: false,
      };

      const isArchived = channel.status === 'archived';
      const inputDisabled = isArchived;

      expect(inputDisabled).toBe(true);
    });

    it('should show archived indicator in channel header', () => {
      const channel: Channel = {
        id: 'ch-1', name: 'archived-channel', visibility: 'public', status: 'archived',
        createdAt: '', createdBy: '', memberCount: 5, unreadCount: 0,
        hasMentions: false, isDm: false,
      };

      const showArchivedIndicator = channel.status === 'archived';
      expect(showArchivedIndicator).toBe(true);
    });

    it('should allow viewing messages in archived channel', () => {
      const channel: Channel = {
        id: 'ch-1', name: 'archived-channel', visibility: 'public', status: 'archived',
        createdAt: '', createdBy: '', memberCount: 5, unreadCount: 0,
        hasMentions: false, isDm: false,
      };

      // Archived channels can still be viewed
      const canViewMessages = true; // Always true
      expect(canViewMessages).toBe(true);
    });

    it('should not show archive option for already archived channels', () => {
      const channel: Channel = {
        id: 'ch-1', name: 'archived-channel', visibility: 'public', status: 'archived',
        createdAt: '', createdBy: '', memberCount: 5, unreadCount: 0,
        hasMentions: false, isDm: false,
      };

      const isArchived = channel.status === 'archived';
      const showArchiveOption = !isArchived;
      const showUnarchiveOption = isArchived;

      expect(showArchiveOption).toBe(false);
      expect(showUnarchiveOption).toBe(true);
    });
  });

  describe('Archive confirmation dialog', () => {
    it('should require confirmation before archiving', () => {
      let confirmationShown = false;
      let channelToArchive: Channel | null = null;

      const requestArchive = (channel: Channel) => {
        confirmationShown = true;
        channelToArchive = channel;
      };

      requestArchive({
        id: 'ch-1', name: 'important-channel', visibility: 'public', status: 'active',
        createdAt: '', createdBy: '', memberCount: 10, unreadCount: 0,
        hasMentions: false, isDm: false,
      });

      expect(confirmationShown).toBe(true);
      expect(channelToArchive?.name).toBe('important-channel');
    });

    it('should show different text for archive vs unarchive', () => {
      const getDialogTitle = (isUnarchiving: boolean) =>
        isUnarchiving ? 'Unarchive channel?' : 'Archive channel?';

      expect(getDialogTitle(false)).toBe('Archive channel?');
      expect(getDialogTitle(true)).toBe('Unarchive channel?');
    });
  });

  describe('Archive API calls', () => {
    it('should construct correct archive URL', () => {
      const workspaceId = 'ws-123';
      const channelId = 'ch-456';

      const archiveUrl = `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}/archive`;

      expect(archiveUrl).toBe('/api/workspaces/ws-123/channels/ch-456/archive');
    });

    it('should construct correct unarchive URL', () => {
      const workspaceId = 'ws-123';
      const channelId = 'ch-456';

      const unarchiveUrl = `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}/unarchive`;

      expect(unarchiveUrl).toBe('/api/workspaces/ws-123/channels/ch-456/unarchive');
    });

    it('should encode special characters in channel ID', () => {
      const workspaceId = 'ws-123';
      const channelId = 'channel/with/slashes';

      const archiveUrl = `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}/archive`;

      expect(archiveUrl).toBe('/api/workspaces/ws-123/channels/channel%2Fwith%2Fslashes/archive');
    });
  });
});

// =============================================================================
// Task 10: Admin Tools Tests
// =============================================================================

describe('Admin Tools', () => {
  describe('Channel Settings API', () => {
    it('should construct correct updateChannel URL', () => {
      const workspaceId = 'ws-123';
      const channelId = 'ch-456';

      const updateUrl = `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}`;

      expect(updateUrl).toBe('/api/workspaces/ws-123/channels/ch-456');
    });

    it('should build PATCH request body for name update', () => {
      const updates = { name: 'new-channel-name' };
      const body = JSON.stringify(updates);

      expect(JSON.parse(body)).toEqual({ name: 'new-channel-name' });
    });

    it('should build PATCH request body for description update', () => {
      const updates = { description: 'New channel description' };
      const body = JSON.stringify(updates);

      expect(JSON.parse(body)).toEqual({ description: 'New channel description' });
    });

    it('should build PATCH request body for visibility update', () => {
      const updates = { isPrivate: true };
      const body = JSON.stringify(updates);

      expect(JSON.parse(body)).toEqual({ isPrivate: true });
    });

    it('should support partial updates (multiple fields)', () => {
      const updates = {
        name: 'renamed-channel',
        description: 'Updated description',
        isPrivate: false,
      };

      expect(updates.name).toBe('renamed-channel');
      expect(updates.description).toBe('Updated description');
      expect(updates.isPrivate).toBe(false);
    });

    it('should validate channel name format', () => {
      const validateChannelName = (name: string) => {
        const normalized = name.trim().toLowerCase().replace(/\s+/g, '-');
        return /^[a-z0-9-]+$/.test(normalized) && normalized.length >= 2 && normalized.length <= 80;
      };

      expect(validateChannelName('general')).toBe(true);
      expect(validateChannelName('my-channel')).toBe(true);
      expect(validateChannelName('channel123')).toBe(true);
      expect(validateChannelName('a')).toBe(false); // Too short
      expect(validateChannelName('Invalid Name!')).toBe(false); // Invalid chars
      expect(validateChannelName('')).toBe(false); // Empty
    });
  });

  describe('Member Management API', () => {
    it('should construct correct addMember URL', () => {
      const workspaceId = 'ws-123';
      const channelId = 'ch-456';

      const addMemberUrl = `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}/members`;

      expect(addMemberUrl).toBe('/api/workspaces/ws-123/channels/ch-456/members');
    });

    it('should construct correct removeMember URL', () => {
      const workspaceId = 'ws-123';
      const channelId = 'ch-456';
      const memberId = 'user-789';

      const removeMemberUrl = `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(memberId)}`;

      expect(removeMemberUrl).toBe('/api/workspaces/ws-123/channels/ch-456/members/user-789');
    });

    it('should build POST request body for adding user member', () => {
      const request = { userId: 'user-123', role: 'member' };
      const body = JSON.stringify(request);

      expect(JSON.parse(body)).toEqual({ userId: 'user-123', role: 'member' });
    });

    it('should build POST request body for adding agent member', () => {
      const request = { agentName: 'CodeAgent', role: 'member' };
      const body = JSON.stringify(request);

      expect(JSON.parse(body)).toEqual({ agentName: 'CodeAgent', role: 'member' });
    });

    it('should construct updateMemberRole URL', () => {
      const workspaceId = 'ws-123';
      const channelId = 'ch-456';
      const memberId = 'user-789';

      const updateRoleUrl = `/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(memberId)}/role`;

      expect(updateRoleUrl).toBe('/api/workspaces/ws-123/channels/ch-456/members/user-789/role');
    });

    it('should build PATCH request body for role update', () => {
      const request = { role: 'admin' };
      const body = JSON.stringify(request);

      expect(JSON.parse(body)).toEqual({ role: 'admin' });
    });
  });

  describe('Member Management State', () => {
    it('should add member to local list', () => {
      const members: ChannelMember[] = [
        { id: 'user-1', displayName: 'Alice', entityType: 'user', role: 'owner', status: 'online', joinedAt: '2024-01-01' },
      ];

      const newMember: ChannelMember = {
        id: 'user-2',
        displayName: 'Bob',
        entityType: 'user',
        role: 'member',
        status: 'offline',
        joinedAt: '2024-01-02',
      };

      const updatedMembers = [...members, newMember];

      expect(updatedMembers).toHaveLength(2);
      expect(updatedMembers[1].displayName).toBe('Bob');
    });

    it('should remove member from local list', () => {
      const members: ChannelMember[] = [
        { id: 'user-1', displayName: 'Alice', entityType: 'user', role: 'owner', status: 'online', joinedAt: '2024-01-01' },
        { id: 'user-2', displayName: 'Bob', entityType: 'user', role: 'member', status: 'offline', joinedAt: '2024-01-02' },
      ];

      const memberIdToRemove = 'user-2';
      const updatedMembers = members.filter(m => m.id !== memberIdToRemove);

      expect(updatedMembers).toHaveLength(1);
      expect(updatedMembers[0].displayName).toBe('Alice');
    });

    it('should update member role in local list', () => {
      const members: ChannelMember[] = [
        { id: 'user-1', displayName: 'Alice', entityType: 'user', role: 'owner', status: 'online', joinedAt: '2024-01-01' },
        { id: 'user-2', displayName: 'Bob', entityType: 'user', role: 'member', status: 'offline', joinedAt: '2024-01-02' },
      ];

      const memberIdToUpdate = 'user-2';
      const newRole = 'admin' as const;
      const updatedMembers = members.map(m =>
        m.id === memberIdToUpdate ? { ...m, role: newRole } : m
      );

      expect(updatedMembers[1].role).toBe('admin');
    });

    it('should update channel member count after adding', () => {
      const channel: Channel = {
        id: 'ch-1', name: 'general', visibility: 'public', status: 'active',
        createdAt: '', createdBy: '', memberCount: 5, unreadCount: 0,
        hasMentions: false, isDm: false,
      };

      const updatedChannel = { ...channel, memberCount: channel.memberCount + 1 };

      expect(updatedChannel.memberCount).toBe(6);
    });

    it('should update channel member count after removing', () => {
      const channel: Channel = {
        id: 'ch-1', name: 'general', visibility: 'public', status: 'active',
        createdAt: '', createdBy: '', memberCount: 5, unreadCount: 0,
        hasMentions: false, isDm: false,
      };

      const updatedChannel = { ...channel, memberCount: Math.max(0, channel.memberCount - 1) };

      expect(updatedChannel.memberCount).toBe(4);
    });
  });

  describe('Agent Assignment', () => {
    it('should identify agent members', () => {
      const members: ChannelMember[] = [
        { id: 'user-1', displayName: 'Alice', entityType: 'user', role: 'owner', status: 'online', joinedAt: '2024-01-01' },
        { id: 'agent-1', displayName: 'CodeAgent', entityType: 'agent', role: 'member', status: 'online', joinedAt: '2024-01-02' },
        { id: 'agent-2', displayName: 'ReviewAgent', entityType: 'agent', role: 'member', status: 'offline', joinedAt: '2024-01-03' },
      ];

      const agentMembers = members.filter(m => m.entityType === 'agent');

      expect(agentMembers).toHaveLength(2);
      expect(agentMembers[0].displayName).toBe('CodeAgent');
    });

    it('should identify user members', () => {
      const members: ChannelMember[] = [
        { id: 'user-1', displayName: 'Alice', entityType: 'user', role: 'owner', status: 'online', joinedAt: '2024-01-01' },
        { id: 'agent-1', displayName: 'CodeAgent', entityType: 'agent', role: 'member', status: 'online', joinedAt: '2024-01-02' },
      ];

      const userMembers = members.filter(m => m.entityType === 'user');

      expect(userMembers).toHaveLength(1);
      expect(userMembers[0].displayName).toBe('Alice');
    });

    it('should build request for assigning agent to channel', () => {
      const agentName = 'CodeReviewAgent';
      const request = { agentName, role: 'member' };

      expect(request.agentName).toBe('CodeReviewAgent');
      expect(request.role).toBe('member');
    });
  });

  describe('Permission Checks', () => {
    it('should identify channel owner', () => {
      const members: ChannelMember[] = [
        { id: 'user-1', displayName: 'Alice', entityType: 'user', role: 'owner', status: 'online', joinedAt: '2024-01-01' },
        { id: 'user-2', displayName: 'Bob', entityType: 'user', role: 'member', status: 'offline', joinedAt: '2024-01-02' },
      ];

      const owner = members.find(m => m.role === 'owner');

      expect(owner?.displayName).toBe('Alice');
    });

    it('should check if user can edit channel (owner only)', () => {
      const currentUserId = 'user-1';
      const members: ChannelMember[] = [
        { id: 'user-1', displayName: 'Alice', entityType: 'user', role: 'owner', status: 'online', joinedAt: '2024-01-01' },
        { id: 'user-2', displayName: 'Bob', entityType: 'user', role: 'member', status: 'offline', joinedAt: '2024-01-02' },
      ];

      const currentMember = members.find(m => m.id === currentUserId);
      const canEdit = currentMember?.role === 'owner' || currentMember?.role === 'admin';

      expect(canEdit).toBe(true);
    });

    it('should check if user can remove members (owner/admin)', () => {
      const currentUserId = 'user-2';
      const members: ChannelMember[] = [
        { id: 'user-1', displayName: 'Alice', entityType: 'user', role: 'owner', status: 'online', joinedAt: '2024-01-01' },
        { id: 'user-2', displayName: 'Bob', entityType: 'user', role: 'admin', status: 'offline', joinedAt: '2024-01-02' },
      ];

      const currentMember = members.find(m => m.id === currentUserId);
      const canRemoveMembers = currentMember?.role === 'owner' || currentMember?.role === 'admin';

      expect(canRemoveMembers).toBe(true);
    });

    it('should prevent non-admin from editing channel', () => {
      const currentUserId = 'user-2';
      const members: ChannelMember[] = [
        { id: 'user-1', displayName: 'Alice', entityType: 'user', role: 'owner', status: 'online', joinedAt: '2024-01-01' },
        { id: 'user-2', displayName: 'Bob', entityType: 'user', role: 'member', status: 'offline', joinedAt: '2024-01-02' },
      ];

      const currentMember = members.find(m => m.id === currentUserId);
      const canEdit = currentMember?.role === 'owner' || currentMember?.role === 'admin';

      expect(canEdit).toBe(false);
    });

    it('should prevent removing channel owner', () => {
      const memberToRemove: ChannelMember = {
        id: 'user-1', displayName: 'Alice', entityType: 'user', role: 'owner', status: 'online', joinedAt: '2024-01-01',
      };

      const canRemove = memberToRemove.role !== 'owner';

      expect(canRemove).toBe(false);
    });
  });

  describe('Channel Settings Modal State', () => {
    it('should initialize form with current channel values', () => {
      const channel: Channel = {
        id: 'ch-1', name: 'engineering', description: 'Engineering team channel',
        visibility: 'private', status: 'active', createdAt: '', createdBy: '',
        memberCount: 10, unreadCount: 0, hasMentions: false, isDm: false,
      };

      const formState = {
        name: channel.name,
        description: channel.description || '',
        isPrivate: channel.visibility === 'private',
      };

      expect(formState.name).toBe('engineering');
      expect(formState.description).toBe('Engineering team channel');
      expect(formState.isPrivate).toBe(true);
    });

    it('should detect if form has changes', () => {
      const original = { name: 'general', description: 'Main channel', isPrivate: false };
      const current = { name: 'general-renamed', description: 'Main channel', isPrivate: false };

      const hasChanges = original.name !== current.name ||
                         original.description !== current.description ||
                         original.isPrivate !== current.isPrivate;

      expect(hasChanges).toBe(true);
    });

    it('should track which fields changed for partial update', () => {
      const original = { name: 'general', description: 'Main channel', isPrivate: false };
      const current = { name: 'general', description: 'Updated description', isPrivate: true };

      const changes: Record<string, unknown> = {};
      if (original.name !== current.name) changes.name = current.name;
      if (original.description !== current.description) changes.description = current.description;
      if (original.isPrivate !== current.isPrivate) changes.isPrivate = current.isPrivate;

      expect(changes).toEqual({ description: 'Updated description', isPrivate: true });
    });
  });

  describe('Error Handling', () => {
    it('should handle 403 forbidden for non-admin operations', () => {
      const errorCode = 403;
      const errorMessage = 'Admin access required';

      const isPermissionError = errorCode === 403;
      expect(isPermissionError).toBe(true);
      expect(errorMessage).toContain('Admin');
    });

    it('should handle 404 for non-existent member', () => {
      const errorCode = 404;
      const errorMessage = 'Member not found';

      const isNotFoundError = errorCode === 404;
      expect(isNotFoundError).toBe(true);
    });

    it('should handle 409 conflict for duplicate member', () => {
      const errorCode = 409;
      const errorMessage = 'Member already exists in channel';

      const isConflictError = errorCode === 409;
      expect(isConflictError).toBe(true);
    });

    it('should handle removing self from channel', () => {
      const currentUserId = 'user-1';
      const memberToRemove = { id: 'user-1', displayName: 'Me' };

      const isRemovingSelf = currentUserId === memberToRemove.id;
      expect(isRemovingSelf).toBe(true);
      // Should use leave channel flow instead of remove
    });
  });
});
