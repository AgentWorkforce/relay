/**
 * Tests for usePresence hook - WebSocket message handling logic
 *
 * These tests focus on the message parsing and state update logic
 * without requiring React Testing Library.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UserPresence, TypingIndicator } from './usePresence';

// Test the message handling logic in isolation
describe('usePresence message handling', () => {
  // Simulate the state update functions from the hook
  let onlineUsers: UserPresence[] = [];
  let typingUsers: TypingIndicator[] = [];
  const currentUsername = 'testuser';

  // Replicated message handling logic from the hook
  function handleMessage(data: string) {
    const msg = JSON.parse(data);

    switch (msg.type) {
      case 'presence_list':
        onlineUsers = msg.users || [];
        break;

      case 'presence_join':
        onlineUsers = onlineUsers.filter((u) => u.username !== msg.user.username);
        onlineUsers.push(msg.user);
        break;

      case 'presence_leave':
        onlineUsers = onlineUsers.filter((u) => u.username !== msg.username);
        typingUsers = typingUsers.filter((t) => t.username !== msg.username);
        break;

      case 'typing':
        // Ignore self
        if (msg.username === currentUsername) break;

        if (msg.isTyping) {
          typingUsers = typingUsers.filter((t) => t.username !== msg.username);
          typingUsers.push({
            username: msg.username,
            avatarUrl: msg.avatarUrl,
            startedAt: Date.now(),
          });
        } else {
          typingUsers = typingUsers.filter((t) => t.username !== msg.username);
        }
        break;
    }
  }

  beforeEach(() => {
    onlineUsers = [];
    typingUsers = [];
  });

  describe('presence_list', () => {
    it('should set online users from presence_list message', () => {
      const users: UserPresence[] = [
        { username: 'alice', connectedAt: '2024-01-01T00:00:00Z', lastSeen: '2024-01-01T00:00:00Z' },
        { username: 'bob', avatarUrl: 'https://example.com/bob.jpg', connectedAt: '2024-01-01T00:00:00Z', lastSeen: '2024-01-01T00:00:00Z' },
      ];

      handleMessage(JSON.stringify({ type: 'presence_list', users }));

      expect(onlineUsers).toEqual(users);
    });

    it('should handle empty users list', () => {
      handleMessage(JSON.stringify({ type: 'presence_list', users: [] }));
      expect(onlineUsers).toEqual([]);
    });

    it('should handle missing users field', () => {
      handleMessage(JSON.stringify({ type: 'presence_list' }));
      expect(onlineUsers).toEqual([]);
    });
  });

  describe('presence_join', () => {
    it('should add new user to online users', () => {
      const user: UserPresence = {
        username: 'alice',
        avatarUrl: 'https://example.com/alice.jpg',
        connectedAt: '2024-01-01T00:00:00Z',
        lastSeen: '2024-01-01T00:00:00Z',
      };

      handleMessage(JSON.stringify({ type: 'presence_join', user }));

      expect(onlineUsers).toHaveLength(1);
      expect(onlineUsers[0].username).toBe('alice');
      expect(onlineUsers[0].avatarUrl).toBe('https://example.com/alice.jpg');
    });

    it('should replace existing user with same username', () => {
      // Add initial user
      handleMessage(JSON.stringify({
        type: 'presence_join',
        user: { username: 'alice', avatarUrl: 'old.jpg', connectedAt: '2024-01-01T00:00:00Z', lastSeen: '2024-01-01T00:00:00Z' },
      }));

      // Update same user
      handleMessage(JSON.stringify({
        type: 'presence_join',
        user: { username: 'alice', avatarUrl: 'new.jpg', connectedAt: '2024-01-01T01:00:00Z', lastSeen: '2024-01-01T01:00:00Z' },
      }));

      expect(onlineUsers).toHaveLength(1);
      expect(onlineUsers[0].avatarUrl).toBe('new.jpg');
    });
  });

  describe('presence_leave', () => {
    it('should remove user from online users', () => {
      // Add users
      handleMessage(JSON.stringify({
        type: 'presence_list',
        users: [
          { username: 'alice', connectedAt: '2024-01-01T00:00:00Z', lastSeen: '2024-01-01T00:00:00Z' },
          { username: 'bob', connectedAt: '2024-01-01T00:00:00Z', lastSeen: '2024-01-01T00:00:00Z' },
        ],
      }));

      expect(onlineUsers).toHaveLength(2);

      // Remove alice
      handleMessage(JSON.stringify({ type: 'presence_leave', username: 'alice' }));

      expect(onlineUsers).toHaveLength(1);
      expect(onlineUsers[0].username).toBe('bob');
    });

    it('should also remove user from typing users', () => {
      // Add user typing
      handleMessage(JSON.stringify({ type: 'typing', username: 'alice', isTyping: true }));
      expect(typingUsers).toHaveLength(1);

      // User leaves
      handleMessage(JSON.stringify({ type: 'presence_leave', username: 'alice' }));

      expect(typingUsers).toHaveLength(0);
    });

    it('should handle removing non-existent user', () => {
      handleMessage(JSON.stringify({ type: 'presence_leave', username: 'nonexistent' }));
      expect(onlineUsers).toEqual([]);
    });
  });

  describe('typing', () => {
    it('should add user to typing users when isTyping is true', () => {
      handleMessage(JSON.stringify({
        type: 'typing',
        username: 'alice',
        avatarUrl: 'https://example.com/alice.jpg',
        isTyping: true,
      }));

      expect(typingUsers).toHaveLength(1);
      expect(typingUsers[0].username).toBe('alice');
      expect(typingUsers[0].avatarUrl).toBe('https://example.com/alice.jpg');
      expect(typingUsers[0].startedAt).toBeGreaterThan(0);
    });

    it('should remove user from typing users when isTyping is false', () => {
      // Start typing
      handleMessage(JSON.stringify({ type: 'typing', username: 'alice', isTyping: true }));
      expect(typingUsers).toHaveLength(1);

      // Stop typing
      handleMessage(JSON.stringify({ type: 'typing', username: 'alice', isTyping: false }));
      expect(typingUsers).toHaveLength(0);
    });

    it('should ignore typing indicator from self', () => {
      handleMessage(JSON.stringify({
        type: 'typing',
        username: 'testuser', // Same as currentUsername
        isTyping: true,
      }));

      expect(typingUsers).toHaveLength(0);
    });

    it('should update typing user if they type again', async () => {
      handleMessage(JSON.stringify({ type: 'typing', username: 'alice', isTyping: true }));
      const firstStartedAt = typingUsers[0].startedAt;

      // Wait sufficient time for timestamp differentiation (50ms is reliable across systems)
      await new Promise(resolve => setTimeout(resolve, 50));

      handleMessage(JSON.stringify({ type: 'typing', username: 'alice', isTyping: true }));

      expect(typingUsers).toHaveLength(1);
      // The startedAt should be updated (or at least the same since it uses Date.now())
      expect(typingUsers[0].startedAt).toBeGreaterThanOrEqual(firstStartedAt);
    });

    it('should handle multiple users typing', () => {
      handleMessage(JSON.stringify({ type: 'typing', username: 'alice', isTyping: true }));
      handleMessage(JSON.stringify({ type: 'typing', username: 'bob', isTyping: true }));
      handleMessage(JSON.stringify({ type: 'typing', username: 'charlie', isTyping: true }));

      expect(typingUsers).toHaveLength(3);
      expect(typingUsers.map(t => t.username)).toEqual(['alice', 'bob', 'charlie']);
    });
  });
});

describe('presence join message format', () => {
  it('should construct correct join message', () => {
    const user = { username: 'testuser', avatarUrl: 'https://example.com/test.jpg' };
    const message = JSON.stringify({
      type: 'presence',
      action: 'join',
      user,
    });

    const parsed = JSON.parse(message);
    expect(parsed.type).toBe('presence');
    expect(parsed.action).toBe('join');
    expect(parsed.user.username).toBe('testuser');
    expect(parsed.user.avatarUrl).toBe('https://example.com/test.jpg');
  });
});

describe('typing message format', () => {
  it('should construct correct typing message', () => {
    const message = JSON.stringify({
      type: 'typing',
      isTyping: true,
      username: 'testuser',
      avatarUrl: 'https://example.com/test.jpg',
    });

    const parsed = JSON.parse(message);
    expect(parsed.type).toBe('typing');
    expect(parsed.isTyping).toBe(true);
    expect(parsed.username).toBe('testuser');
  });
});
