/**
 * Tests to verify SDK RelayClient compatibility with dashboard requirements.
 * These tests ensure the migration from @agent-relay/wrapper to @agent-relay/sdk
 * doesn't break the dashboard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RelayClient } from '@agent-relay/sdk';
import type { IRelayClient, RelayClientFactory } from './user-bridge.js';

describe('SDK RelayClient compatibility with IRelayClient interface', () => {
  describe('interface compliance', () => {
    it('should have all required properties from IRelayClient', () => {
      const client = new RelayClient({
        agentName: 'test',
        socketPath: '/tmp/test.sock',
      });

      // Required properties
      expect(client).toHaveProperty('state');
      expect(client).toHaveProperty('connect');
      expect(client).toHaveProperty('disconnect');
      expect(client).toHaveProperty('sendMessage');
      expect(client).toHaveProperty('joinChannel');
      expect(client).toHaveProperty('leaveChannel');
      expect(client).toHaveProperty('sendChannelMessage');

      // Optional admin methods
      expect(client).toHaveProperty('adminJoinChannel');
      expect(client).toHaveProperty('adminRemoveMember');

      // Callbacks
      expect(client).toHaveProperty('onMessage');
      expect(client).toHaveProperty('onChannelMessage');
    });

    it('should have correct method signatures', () => {
      const client = new RelayClient({
        agentName: 'test',
        socketPath: '/tmp/test.sock',
      });

      // Verify method types
      expect(typeof client.connect).toBe('function');
      expect(typeof client.disconnect).toBe('function');
      expect(typeof client.sendMessage).toBe('function');
      expect(typeof client.joinChannel).toBe('function');
      expect(typeof client.leaveChannel).toBe('function');
      expect(typeof client.sendChannelMessage).toBe('function');
      expect(typeof client.adminJoinChannel).toBe('function');
      expect(typeof client.adminRemoveMember).toBe('function');
    });

    it('should be assignable to IRelayClient type', () => {
      const client = new RelayClient({
        agentName: 'test',
        socketPath: '/tmp/test.sock',
      });

      // This should compile without error if types are compatible
      const iClient: IRelayClient = client;
      expect(iClient).toBeDefined();
    });
  });

  describe('state property', () => {
    it('should start in DISCONNECTED state', () => {
      const client = new RelayClient({
        agentName: 'test',
        socketPath: '/tmp/test.sock',
      });

      expect(client.state).toBe('DISCONNECTED');
    });

    it('should expose state as string (compatible with IRelayClient)', () => {
      const client = new RelayClient({
        agentName: 'test',
        socketPath: '/tmp/test.sock',
      });

      expect(typeof client.state).toBe('string');
    });
  });

  describe('sendMessage method signature', () => {
    it('should accept parameters in correct order: (to, body, kind?, data?, thread?)', () => {
      const client = new RelayClient({
        agentName: 'test',
        socketPath: '/tmp/test.sock',
        quiet: true,
      });

      // Should not throw - method accepts these params
      // Returns false because not connected, but signature is correct
      const result = client.sendMessage('target', 'body', 'message', { key: 'value' }, 'thread-1');
      expect(typeof result).toBe('boolean');
    });

    it('should return boolean', () => {
      const client = new RelayClient({
        agentName: 'test',
        socketPath: '/tmp/test.sock',
        quiet: true,
      });

      const result = client.sendMessage('target', 'message');
      expect(typeof result).toBe('boolean');
      expect(result).toBe(false); // Not connected
    });
  });

  describe('channel methods', () => {
    it('joinChannel should accept (channel, displayName?)', () => {
      const client = new RelayClient({
        agentName: 'test',
        socketPath: '/tmp/test.sock',
        quiet: true,
      });

      const result1 = client.joinChannel('#general');
      const result2 = client.joinChannel('#general', 'Display Name');

      expect(typeof result1).toBe('boolean');
      expect(typeof result2).toBe('boolean');
    });

    it('leaveChannel should accept (channel, reason?)', () => {
      const client = new RelayClient({
        agentName: 'test',
        socketPath: '/tmp/test.sock',
        quiet: true,
      });

      const result1 = client.leaveChannel('#general');
      const result2 = client.leaveChannel('#general', 'Leaving');

      expect(typeof result1).toBe('boolean');
      expect(typeof result2).toBe('boolean');
    });

    it('sendChannelMessage should accept options with thread, mentions, attachments, data', () => {
      const client = new RelayClient({
        agentName: 'test',
        socketPath: '/tmp/test.sock',
        quiet: true,
      });

      const result = client.sendChannelMessage('#general', 'Hello', {
        thread: 'thread-1',
        mentions: ['user1', 'user2'],
        attachments: [],
        data: { custom: 'data' },
      });

      expect(typeof result).toBe('boolean');
    });
  });

  describe('admin channel methods', () => {
    it('adminJoinChannel should accept (channel, member)', () => {
      const client = new RelayClient({
        agentName: 'test',
        socketPath: '/tmp/test.sock',
        quiet: true,
      });

      const result = client.adminJoinChannel('#general', 'new-member');
      expect(typeof result).toBe('boolean');
    });

    it('adminRemoveMember should accept (channel, member)', () => {
      const client = new RelayClient({
        agentName: 'test',
        socketPath: '/tmp/test.sock',
        quiet: true,
      });

      const result = client.adminRemoveMember('#general', 'member-to-remove');
      expect(typeof result).toBe('boolean');
    });
  });

  describe('callbacks', () => {
    it('should allow setting onMessage callback', () => {
      const client = new RelayClient({
        agentName: 'test',
        socketPath: '/tmp/test.sock',
      });

      const handler = vi.fn();
      client.onMessage = handler;

      expect(client.onMessage).toBe(handler);
    });

    it('should allow setting onChannelMessage callback', () => {
      const client = new RelayClient({
        agentName: 'test',
        socketPath: '/tmp/test.sock',
      });

      const handler = vi.fn();
      client.onChannelMessage = handler;

      expect(client.onChannelMessage).toBe(handler);
    });

    it('should allow setting onStateChange callback', () => {
      const client = new RelayClient({
        agentName: 'test',
        socketPath: '/tmp/test.sock',
      });

      const handler = vi.fn();
      client.onStateChange = handler;

      expect(client.onStateChange).toBe(handler);
    });

    it('should allow setting onError callback', () => {
      const client = new RelayClient({
        agentName: 'test',
        socketPath: '/tmp/test.sock',
      });

      const handler = vi.fn();
      client.onError = handler;

      expect(client.onError).toBe(handler);
    });
  });

  describe('RelayClientFactory compatibility', () => {
    it('should work as a factory function for user-bridge', async () => {
      // This simulates how the dashboard creates clients for the user-bridge
      const createRelayClient: RelayClientFactory = async (options) => {
        const client = new RelayClient({
          socketPath: options.socketPath,
          agentName: options.agentName,
          entityType: options.entityType,
          displayName: options.displayName,
          avatarUrl: options.avatarUrl,
          quiet: true,
          reconnect: false,
        });
        // Note: We don't actually connect in this test
        return client;
      };

      const client = await createRelayClient({
        socketPath: '/tmp/test.sock',
        agentName: 'testuser',
        entityType: 'user',
        displayName: 'Test User',
        avatarUrl: 'https://example.com/avatar.png',
      });

      expect(client).toBeDefined();
      expect(client.state).toBe('DISCONNECTED');
    });
  });

  describe('ClientConfig compatibility', () => {
    it('should accept all config options used by dashboard', () => {
      // All options used in dashboard server
      const client = new RelayClient({
        socketPath: '/tmp/agent-relay.sock',
        agentName: 'Dashboard',
        entityType: 'agent',
        quiet: true,
        reconnect: true,
        maxReconnectAttempts: 10,
        reconnectDelayMs: 100,
        reconnectMaxDelayMs: 30000,
      });

      expect(client).toBeDefined();
      expect(client.agentName).toBe('Dashboard');
    });

    it('should accept user entity type config', () => {
      const client = new RelayClient({
        socketPath: '/tmp/agent-relay.sock',
        agentName: 'testuser',
        entityType: 'user',
        displayName: 'Test User',
        avatarUrl: 'https://example.com/avatar.png',
        quiet: true,
        reconnect: true,
      });

      expect(client).toBeDefined();
      expect(client.agentName).toBe('testuser');
    });
  });
});
