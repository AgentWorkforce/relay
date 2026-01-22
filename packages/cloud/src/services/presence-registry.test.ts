/**
 * Tests for PresenceRegistry service
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerUserPresence,
  unregisterUserPresence,
  updateUserLastSeen,
  isUserOnline,
  getOnlineUser,
  getOnlineUsers,
  getOnlineUsersForDiscovery,
  clearAllPresence,
} from './presence-registry.js';

describe('PresenceRegistry', () => {
  beforeEach(() => {
    // Clear all presence before each test
    clearAllPresence();
  });

  describe('registerUserPresence', () => {
    it('should register a new user', () => {
      registerUserPresence({
        username: 'alice',
        avatarUrl: 'https://avatars.githubusercontent.com/alice',
        connectedAt: '2026-01-18T00:00:00Z',
        lastSeen: '2026-01-18T00:00:00Z',
      });

      expect(isUserOnline('alice')).toBe(true);
    });

    it('should update existing user info on re-registration', () => {
      registerUserPresence({
        username: 'alice',
        connectedAt: '2026-01-18T00:00:00Z',
        lastSeen: '2026-01-18T00:00:00Z',
      });

      registerUserPresence({
        username: 'alice',
        avatarUrl: 'https://avatars.githubusercontent.com/alice-new',
        connectedAt: '2026-01-18T00:00:00Z',
        lastSeen: '2026-01-18T00:01:00Z',
      });

      const user = getOnlineUser('alice');
      expect(user?.avatarUrl).toBe('https://avatars.githubusercontent.com/alice-new');
    });

    it('should track multiple users', () => {
      registerUserPresence({
        username: 'alice',
        connectedAt: '2026-01-18T00:00:00Z',
        lastSeen: '2026-01-18T00:00:00Z',
      });

      registerUserPresence({
        username: 'bob',
        connectedAt: '2026-01-18T00:00:00Z',
        lastSeen: '2026-01-18T00:00:00Z',
      });

      expect(isUserOnline('alice')).toBe(true);
      expect(isUserOnline('bob')).toBe(true);
      expect(getOnlineUsers()).toHaveLength(2);
    });
  });

  describe('unregisterUserPresence', () => {
    it('should remove user from registry', () => {
      registerUserPresence({
        username: 'alice',
        connectedAt: '2026-01-18T00:00:00Z',
        lastSeen: '2026-01-18T00:00:00Z',
      });

      expect(isUserOnline('alice')).toBe(true);

      unregisterUserPresence('alice');

      expect(isUserOnline('alice')).toBe(false);
    });

    it('should handle unregistering non-existent user gracefully', () => {
      // Should not throw
      unregisterUserPresence('nonexistent');
      expect(isUserOnline('nonexistent')).toBe(false);
    });
  });

  describe('updateUserLastSeen', () => {
    it('should update lastSeen timestamp', async () => {
      registerUserPresence({
        username: 'alice',
        connectedAt: '2026-01-18T00:00:00Z',
        lastSeen: '2026-01-18T00:00:00Z',
      });

      const before = getOnlineUser('alice')?.lastSeen;
      expect(before).toBeDefined();

      // Wait to ensure timestamp changes
      await new Promise((r) => setTimeout(r, 20));

      updateUserLastSeen('alice');

      const after = getOnlineUser('alice')?.lastSeen;
      expect(after).toBeDefined();
      // After update with delay, lastSeen should be different
      expect(new Date(after!).getTime()).toBeGreaterThan(new Date(before!).getTime());
    });

    it('should handle updating non-existent user gracefully', () => {
      // Should not throw
      updateUserLastSeen('nonexistent');
    });
  });

  describe('isUserOnline', () => {
    it('should return true for online users', () => {
      registerUserPresence({
        username: 'alice',
        connectedAt: '2026-01-18T00:00:00Z',
        lastSeen: '2026-01-18T00:00:00Z',
      });

      expect(isUserOnline('alice')).toBe(true);
    });

    it('should return false for offline users', () => {
      expect(isUserOnline('nonexistent')).toBe(false);
    });
  });

  describe('getOnlineUser', () => {
    it('should return user info for online users', () => {
      registerUserPresence({
        username: 'alice',
        avatarUrl: 'https://avatars.githubusercontent.com/alice',
        connectedAt: '2026-01-18T00:00:00Z',
        lastSeen: '2026-01-18T00:00:00Z',
      });

      const user = getOnlineUser('alice');
      expect(user).toBeDefined();
      expect(user?.username).toBe('alice');
      expect(user?.avatarUrl).toBe('https://avatars.githubusercontent.com/alice');
    });

    it('should return undefined for offline users', () => {
      expect(getOnlineUser('nonexistent')).toBeUndefined();
    });
  });

  describe('getOnlineUsers', () => {
    it('should return empty array when no users online', () => {
      expect(getOnlineUsers()).toEqual([]);
    });

    it('should return all online users', () => {
      registerUserPresence({
        username: 'alice',
        connectedAt: '2026-01-18T00:00:00Z',
        lastSeen: '2026-01-18T00:00:00Z',
      });

      registerUserPresence({
        username: 'bob',
        connectedAt: '2026-01-18T00:00:00Z',
        lastSeen: '2026-01-18T00:00:00Z',
      });

      const users = getOnlineUsers();
      expect(users).toHaveLength(2);
      expect(users.map((u) => u.username).sort()).toEqual(['alice', 'bob']);
    });
  });

  describe('getOnlineUsersForDiscovery', () => {
    it('should return empty array when no users online', () => {
      expect(getOnlineUsersForDiscovery()).toEqual([]);
    });

    it('should return users in RemoteAgent format', () => {
      registerUserPresence({
        username: 'khaliqgant',
        avatarUrl: 'https://avatars.githubusercontent.com/khaliqgant',
        connectedAt: '2026-01-18T00:00:00Z',
        lastSeen: '2026-01-18T00:00:00Z',
      });

      const users = getOnlineUsersForDiscovery();
      expect(users).toHaveLength(1);

      const user = users[0];
      expect(user.name).toBe('khaliqgant');
      expect(user.status).toBe('online');
      expect(user.daemonId).toBe('cloud');
      expect(user.daemonName).toBe('Cloud Dashboard');
      expect(user.machineId).toBe('cloud');
      expect(user.isHuman).toBe(true);
      expect(user.avatarUrl).toBe('https://avatars.githubusercontent.com/khaliqgant');
    });

    it('should include all online users', () => {
      registerUserPresence({
        username: 'alice',
        connectedAt: '2026-01-18T00:00:00Z',
        lastSeen: '2026-01-18T00:00:00Z',
      });

      registerUserPresence({
        username: 'bob',
        connectedAt: '2026-01-18T00:00:00Z',
        lastSeen: '2026-01-18T00:00:00Z',
      });

      const users = getOnlineUsersForDiscovery();
      expect(users).toHaveLength(2);
      expect(users.every((u) => u.daemonId === 'cloud')).toBe(true);
      expect(users.every((u) => u.isHuman === true)).toBe(true);
    });
  });

  describe('clearAllPresence', () => {
    it('should remove all users from registry', () => {
      registerUserPresence({
        username: 'alice',
        connectedAt: '2026-01-18T00:00:00Z',
        lastSeen: '2026-01-18T00:00:00Z',
      });

      registerUserPresence({
        username: 'bob',
        connectedAt: '2026-01-18T00:00:00Z',
        lastSeen: '2026-01-18T00:00:00Z',
      });

      expect(getOnlineUsers()).toHaveLength(2);

      clearAllPresence();

      expect(getOnlineUsers()).toHaveLength(0);
    });
  });
});
