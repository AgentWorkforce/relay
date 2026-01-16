/**
 * Tests for the User Bridge functionality.
 * TDD: Tests for bridging dashboard WebSocket users to the relay daemon.
 *
 * The user bridge allows human users connected via WebSocket to:
 * - Register as "user" entities in the relay daemon
 * - Join/leave channels
 * - Send/receive messages through the relay daemon
 * - Communicate with agents and other users
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UserBridge } from './user-bridge.js';

// Mock WebSocket
class MockWebSocket {
  public sentMessages: unknown[] = [];
  public readyState = 1; // OPEN
  private eventHandlers = new Map<string, ((...args: unknown[]) => void)[]>();

  send(data: string): void {
    this.sentMessages.push(JSON.parse(data));
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    const handlers = this.eventHandlers.get(event) || [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);
  }

  emit(event: string, ...args: unknown[]): void {
    const handlers = this.eventHandlers.get(event) || [];
    for (const handler of handlers) {
      handler(...args);
    }
  }

  removeAllListeners(event?: string): void {
    if (event) {
      this.eventHandlers.delete(event);
    } else {
      this.eventHandlers.clear();
    }
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.emit('close');
  }

  clearSent(): void {
    this.sentMessages = [];
  }
}

// Mock RelayClient
class MockRelayClient {
  public connected = false;
  public agentName: string;
  public entityType?: string;
  public sentMessages: Array<{ to: string; body: string; kind: string; thread?: string }> = [];
  public channelJoins: Array<{ channel: string; displayName?: string }> = [];
  public channelLeaves: Array<{ channel: string; reason?: string }> = [];
  public channelMessages: Array<{ channel: string; body: string; options?: { thread?: string; data?: Record<string, unknown> } }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public onMessage?: (from: string, payload: any, messageId: string, meta?: any, originalTo?: string) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public onChannelMessage?: (from: string, channel: string, body: string, envelope: any) => void;

  constructor(options: { socketPath: string; agentName: string; entityType?: string }) {
    this.agentName = options.agentName;
    this.entityType = options.entityType;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
  }

  get state(): string {
    return this.connected ? 'READY' : 'DISCONNECTED';
  }

  sendMessage(
    to: string,
    body: string,
    kind: string = 'message',
    _data?: unknown,
    thread?: string
  ): boolean {
    this.sentMessages.push({ to, body, kind, thread });
    return true;
  }

  // Channel operations
  joinChannel(channel: string, displayName?: string): boolean {
    this.channelJoins.push({ channel, displayName });
    return true;
  }

  leaveChannel(channel: string, reason?: string): boolean {
    this.channelLeaves.push({ channel, reason });
    return true;
  }

  sendChannelMessage(
    channel: string,
    body: string,
    options?: { thread?: string; mentions?: string[]; attachments?: unknown[]; data?: Record<string, unknown> }
  ): boolean {
    this.channelMessages.push({
      channel,
      body,
      options: {
        thread: options?.thread,
        data: options?.data,
      },
    });
    return true;
  }

  // Test helper to simulate receiving a direct message
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  simulateIncomingMessage(from: string, body: string, envelope: any): void {
    // Pass the payload from the envelope, not the entire envelope
    const payload = envelope?.payload || { body };
    this.onMessage?.(from, payload, 'test-msg-id', undefined, undefined);
  }

  // Test helper to simulate receiving a channel message
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  simulateIncomingChannelMessage(from: string, channel: string, body: string, envelope: any): void {
    this.onChannelMessage?.(from, channel, body, envelope);
  }

  clearSent(): void {
    this.sentMessages = [];
    this.channelJoins = [];
    this.channelLeaves = [];
    this.channelMessages = [];
  }
}

describe('UserBridge', () => {
  let bridge: UserBridge;
  let mockWs: MockWebSocket;
  let mockRelayClient: MockRelayClient;
  let relayClientFactory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockWs = new MockWebSocket();
    mockRelayClient = new MockRelayClient({
      socketPath: '/tmp/test.sock',
      agentName: 'alice',
      entityType: 'user',
    });

    relayClientFactory = vi.fn().mockResolvedValue(mockRelayClient);

    bridge = new UserBridge({
      socketPath: '/tmp/test.sock',
      createRelayClient: relayClientFactory,
    });
  });

  afterEach(() => {
    bridge.dispose();
  });

  describe('User Registration', () => {
    it('should register a user with the relay daemon', async () => {
      await bridge.registerUser('alice', mockWs as unknown as WebSocket, {
        avatarUrl: 'https://example.com/alice.png',
      });

      expect(relayClientFactory).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: 'alice',
          entityType: 'user',
        })
      );
      expect(mockRelayClient.connected).toBe(true);
    });

    it('should track registered users', async () => {
      await bridge.registerUser('alice', mockWs as unknown as WebSocket);

      expect(bridge.isUserRegistered('alice')).toBe(true);
      expect(bridge.isUserRegistered('bob')).toBe(false);
    });

    it('should allow multiple users to register', async () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();

      const client1 = new MockRelayClient({ socketPath: '/tmp/test.sock', agentName: 'alice', entityType: 'user' });
      const client2 = new MockRelayClient({ socketPath: '/tmp/test.sock', agentName: 'bob', entityType: 'user' });

      relayClientFactory
        .mockResolvedValueOnce(client1)
        .mockResolvedValueOnce(client2);

      await bridge.registerUser('alice', ws1 as unknown as WebSocket);
      await bridge.registerUser('bob', ws2 as unknown as WebSocket);

      expect(bridge.isUserRegistered('alice')).toBe(true);
      expect(bridge.isUserRegistered('bob')).toBe(true);
      expect(bridge.getRegisteredUsers()).toContain('alice');
      expect(bridge.getRegisteredUsers()).toContain('bob');
    });

    it('should handle re-registration of same user', async () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();

      await bridge.registerUser('alice', ws1 as unknown as WebSocket);
      await bridge.registerUser('alice', ws2 as unknown as WebSocket);

      // Should reuse or replace, not duplicate
      expect(bridge.getRegisteredUsers().filter(u => u === 'alice')).toHaveLength(1);
    });
  });

  describe('User Unregistration', () => {
    it('should unregister a user and disconnect relay client', async () => {
      await bridge.registerUser('alice', mockWs as unknown as WebSocket);
      expect(bridge.isUserRegistered('alice')).toBe(true);

      bridge.unregisterUser('alice');

      expect(bridge.isUserRegistered('alice')).toBe(false);
      expect(mockRelayClient.connected).toBe(false);
    });

    it('should handle unregistering non-existent user gracefully', () => {
      expect(() => bridge.unregisterUser('nonexistent')).not.toThrow();
    });
  });

  describe('Channel Operations', () => {
    beforeEach(async () => {
      await bridge.registerUser('alice', mockWs as unknown as WebSocket);
      mockRelayClient.clearSent();
    });

    it('should send channel join to relay daemon', async () => {
      await bridge.joinChannel('alice', '#general');

      expect(mockRelayClient.channelJoins).toContainEqual(
        expect.objectContaining({
          channel: '#general',
          displayName: 'alice',
        })
      );
    });

    it('should send channel leave to relay daemon', async () => {
      await bridge.leaveChannel('alice', '#general');

      expect(mockRelayClient.channelLeaves).toContainEqual(
        expect.objectContaining({
          channel: '#general',
        })
      );
    });

    it('should track user channel membership', async () => {
      await bridge.joinChannel('alice', '#general');
      await bridge.joinChannel('alice', '#engineering');

      const channels = bridge.getUserChannels('alice');
      expect(channels).toContain('#general');
      expect(channels).toContain('#engineering');
    });

    it('should remove channel from membership on leave', async () => {
      await bridge.joinChannel('alice', '#general');
      await bridge.joinChannel('alice', '#engineering');
      await bridge.leaveChannel('alice', '#general');

      const channels = bridge.getUserChannels('alice');
      expect(channels).not.toContain('#general');
      expect(channels).toContain('#engineering');
    });
  });

  describe('Message Sending', () => {
    beforeEach(async () => {
      await bridge.registerUser('alice', mockWs as unknown as WebSocket);
      mockRelayClient.clearSent();
    });

    it('should send channel message via relay client', async () => {
      await bridge.sendChannelMessage('alice', '#general', 'Hello everyone!');

      expect(mockRelayClient.channelMessages).toContainEqual(
        expect.objectContaining({
          channel: '#general',
          body: 'Hello everyone!',
        })
      );
    });

    it('should send direct message to another user', async () => {
      await bridge.sendDirectMessage('alice', 'bob', 'Hey Bob!');

      expect(mockRelayClient.sentMessages).toContainEqual(
        expect.objectContaining({
          to: 'bob',
          body: 'Hey Bob!',
          kind: 'message',
        })
      );
    });

    it('should send direct message to agent', async () => {
      await bridge.sendDirectMessage('alice', 'CodeReviewer', 'Review my PR please');

      expect(mockRelayClient.sentMessages).toContainEqual(
        expect.objectContaining({
          to: 'CodeReviewer',
          body: 'Review my PR please',
          kind: 'message',
        })
      );
    });

    it('should support threaded messages', async () => {
      await bridge.sendChannelMessage('alice', '#general', 'Reply to thread', {
        thread: 'parent-msg-123',
      });

      expect(mockRelayClient.channelMessages).toContainEqual(
        expect.objectContaining({
          channel: '#general',
          body: 'Reply to thread',
          options: { thread: 'parent-msg-123' },
        })
      );
    });
  });

  describe('Message Receiving', () => {
    beforeEach(async () => {
      await bridge.registerUser('alice', mockWs as unknown as WebSocket);
      mockWs.clearSent();
    });

    it('should forward incoming channel messages to WebSocket', () => {
      mockRelayClient.simulateIncomingChannelMessage('bob', '#general', 'Hello Alice!', {
        type: 'CHANNEL_MESSAGE',
        payload: {
          channel: '#general',
          body: 'Hello Alice!',
        },
      });

      expect(mockWs.sentMessages).toContainEqual(
        expect.objectContaining({
          type: 'channel_message',
          channel: '#general',
          from: 'bob',
          body: 'Hello Alice!',
        })
      );
    });

    it('should forward incoming direct messages to WebSocket', () => {
      mockRelayClient.simulateIncomingMessage('bob', 'Private message', {
        type: 'DELIVER',
        from: 'bob',
        to: 'alice',
        payload: {
          body: 'Private message',
        },
      });

      expect(mockWs.sentMessages).toContainEqual(
        expect.objectContaining({
          type: 'direct_message',
          from: 'bob',
          body: 'Private message',
        })
      );
    });

    it('should forward agent messages to WebSocket', () => {
      mockRelayClient.simulateIncomingMessage('CodeReviewer', 'PR approved!', {
        type: 'DELIVER',
        from: 'CodeReviewer',
        to: 'alice',
        payload: {
          body: 'PR approved!',
        },
      });

      expect(mockWs.sentMessages).toContainEqual(
        expect.objectContaining({
          type: 'direct_message',
          from: 'CodeReviewer',
          body: 'PR approved!',
        })
      );
    });
  });

  describe('WebSocket Disconnect Handling', () => {
    it('should unregister user when WebSocket closes', async () => {
      await bridge.registerUser('alice', mockWs as unknown as WebSocket);
      expect(bridge.isUserRegistered('alice')).toBe(true);

      mockWs.close();

      expect(bridge.isUserRegistered('alice')).toBe(false);
    });

    it('should disconnect relay client when WebSocket closes', async () => {
      await bridge.registerUser('alice', mockWs as unknown as WebSocket);
      expect(mockRelayClient.connected).toBe(true);

      mockWs.close();

      expect(mockRelayClient.connected).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should handle send to unregistered user gracefully', async () => {
      const result = await bridge.sendChannelMessage('nonexistent', '#general', 'test');
      expect(result).toBe(false);
    });

    it('should handle relay client connection failure', async () => {
      relayClientFactory.mockRejectedValueOnce(new Error('Connection failed'));

      await expect(
        bridge.registerUser('alice', mockWs as unknown as WebSocket)
      ).rejects.toThrow('Connection failed');

      expect(bridge.isUserRegistered('alice')).toBe(false);
    });
  });

  describe('Disposal', () => {
    it('should disconnect all users on dispose', async () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();

      const client1 = new MockRelayClient({ socketPath: '/tmp/test.sock', agentName: 'alice', entityType: 'user' });
      const client2 = new MockRelayClient({ socketPath: '/tmp/test.sock', agentName: 'bob', entityType: 'user' });

      relayClientFactory
        .mockResolvedValueOnce(client1)
        .mockResolvedValueOnce(client2);

      await bridge.registerUser('alice', ws1 as unknown as WebSocket);
      await bridge.registerUser('bob', ws2 as unknown as WebSocket);

      bridge.dispose();

      expect(client1.connected).toBe(false);
      expect(client2.connected).toBe(false);
      expect(bridge.getRegisteredUsers()).toHaveLength(0);
    });
  });

  describe('WebSocket Update (Multi-tab/Reconnection)', () => {
    it('should update WebSocket for existing user', async () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();

      await bridge.registerUser('alice', ws1 as unknown as WebSocket);
      expect(bridge.isUserRegistered('alice')).toBe(true);

      // Update to new WebSocket
      const updated = bridge.updateWebSocket('alice', ws2 as unknown as WebSocket);
      expect(updated).toBe(true);
    });

    it('should return false when updating WebSocket for unregistered user', () => {
      const ws = new MockWebSocket();
      const updated = bridge.updateWebSocket('nonexistent', ws as unknown as WebSocket);
      expect(updated).toBe(false);
    });

    it('should forward direct messages to updated WebSocket', async () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();

      await bridge.registerUser('alice', ws1 as unknown as WebSocket);

      // Update to new WebSocket
      bridge.updateWebSocket('alice', ws2 as unknown as WebSocket);

      // Simulate incoming direct message
      mockRelayClient.onMessage?.('Agent1', { body: 'Hello Alice!' }, 'msg-123', {}, 'alice');

      // Message should be sent to ws2, not ws1
      expect(ws2.sentMessages).toHaveLength(1);
      expect(ws2.sentMessages[0]).toMatchObject({
        type: 'direct_message',
        from: 'Agent1',
        body: 'Hello Alice!',
      });

      // ws1 should not receive the message
      expect(ws1.sentMessages).toHaveLength(0);
    });

    it('should handle multiple WebSocket updates (reconnection chain)', async () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      const ws3 = new MockWebSocket();

      await bridge.registerUser('alice', ws1 as unknown as WebSocket);

      // First reconnection
      bridge.updateWebSocket('alice', ws2 as unknown as WebSocket);

      // Second reconnection
      bridge.updateWebSocket('alice', ws3 as unknown as WebSocket);

      // Simulate incoming message
      mockRelayClient.onMessage?.('Agent1', { body: 'Latest message' }, 'msg-456', {}, 'alice');

      // Only ws3 should receive the message
      expect(ws3.sentMessages).toHaveLength(1);
      expect(ws2.sentMessages).toHaveLength(0);
      expect(ws1.sentMessages).toHaveLength(0);
    });

    it('should remove close handlers from old WebSocket', async () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();

      await bridge.registerUser('alice', ws1 as unknown as WebSocket);
      expect(bridge.isUserRegistered('alice')).toBe(true);

      // Update to new WebSocket
      bridge.updateWebSocket('alice', ws2 as unknown as WebSocket);

      // Closing old WebSocket should NOT unregister the user
      // (because the close handler was removed)
      ws1.close();
      expect(bridge.isUserRegistered('alice')).toBe(true);
    });
  });
});
