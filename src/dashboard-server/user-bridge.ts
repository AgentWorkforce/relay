/**
 * User Bridge - Bridges dashboard WebSocket users to the relay daemon.
 *
 * This module allows human users connected via WebSocket to:
 * - Register as "user" entities in the relay daemon
 * - Join/leave channels
 * - Send/receive messages through the relay daemon
 * - Communicate with agents and other users
 */

import type { WebSocket } from 'ws';

/**
 * Relay client interface (subset of RelayClient for dependency injection)
 */
export interface IRelayClient {
  connect(): Promise<void>;
  disconnect(): void;
  state: string;
  sendMessage(
    to: string,
    body: string,
    kind?: string,
    data?: unknown,
    thread?: string
  ): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onMessage?: (from: string, payload: any, messageId: string, meta?: any, originalTo?: string) => void;
}

/**
 * Factory function type for creating relay clients
 */
export type RelayClientFactory = (options: {
  socketPath: string;
  agentName: string;
  entityType: 'user';
  displayName?: string;
  avatarUrl?: string;
}) => Promise<IRelayClient>;

/**
 * User session state
 */
interface UserSession {
  username: string;
  relayClient: IRelayClient;
  webSocket: WebSocket;
  channels: Set<string>;
  avatarUrl?: string;
}

/**
 * Options for creating a UserBridge
 */
export interface UserBridgeOptions {
  socketPath: string;
  createRelayClient: RelayClientFactory;
}

/**
 * Message options for sending
 */
export interface SendMessageOptions {
  thread?: string;
  data?: Record<string, unknown>;
}

/**
 * UserBridge manages the connection between dashboard WebSocket users
 * and the relay daemon.
 */
export class UserBridge {
  private readonly socketPath: string;
  private readonly createRelayClient: RelayClientFactory;
  private readonly users = new Map<string, UserSession>();

  constructor(options: UserBridgeOptions) {
    this.socketPath = options.socketPath;
    this.createRelayClient = options.createRelayClient;
  }

  /**
   * Register a user with the relay daemon.
   * Creates a relay client connection for the user.
   */
  async registerUser(
    username: string,
    webSocket: WebSocket,
    options?: { avatarUrl?: string; displayName?: string }
  ): Promise<void> {
    // If user already registered, unregister first
    if (this.users.has(username)) {
      this.unregisterUser(username);
    }

    // Create relay client for this user
    const relayClient = await this.createRelayClient({
      socketPath: this.socketPath,
      agentName: username,
      entityType: 'user',
      displayName: options?.displayName,
      avatarUrl: options?.avatarUrl,
    });

    // Connect to daemon
    await relayClient.connect();

    // Set up message handler to forward messages to WebSocket
    relayClient.onMessage = (from, payload, _messageId, _meta, _originalTo) => {
      const body = typeof payload === 'object' && payload !== null && 'body' in payload
        ? (payload as { body: string }).body
        : String(payload);
      this.handleIncomingMessage(username, from, body, payload);
    };

    // Create session
    const session: UserSession = {
      username,
      relayClient,
      webSocket,
      channels: new Set(),
      avatarUrl: options?.avatarUrl,
    };

    this.users.set(username, session);

    // Set up WebSocket close handler
    webSocket.on('close', () => {
      this.unregisterUser(username);
    });

    console.log(`[user-bridge] User ${username} registered with relay daemon`);
  }

  /**
   * Unregister a user and disconnect their relay client.
   */
  unregisterUser(username: string): void {
    const session = this.users.get(username);
    if (!session) return;

    session.relayClient.disconnect();
    this.users.delete(username);

    console.log(`[user-bridge] User ${username} unregistered from relay daemon`);
  }

  /**
   * Check if a user is registered.
   */
  isUserRegistered(username: string): boolean {
    return this.users.has(username);
  }

  /**
   * Get list of all registered users.
   */
  getRegisteredUsers(): string[] {
    return Array.from(this.users.keys());
  }

  /**
   * Join a channel.
   */
  async joinChannel(username: string, channel: string): Promise<boolean> {
    const session = this.users.get(username);
    if (!session) {
      console.warn(`[user-bridge] Cannot join channel - user ${username} not registered`);
      return false;
    }

    // Send channel join via relay client
    session.relayClient.sendMessage(channel, '', 'channel_join');

    // Track membership
    session.channels.add(channel);

    console.log(`[user-bridge] User ${username} joined channel ${channel}`);
    return true;
  }

  /**
   * Leave a channel.
   */
  async leaveChannel(username: string, channel: string): Promise<boolean> {
    const session = this.users.get(username);
    if (!session) {
      console.warn(`[user-bridge] Cannot leave channel - user ${username} not registered`);
      return false;
    }

    // Send channel leave via relay client
    session.relayClient.sendMessage(channel, '', 'channel_leave');

    // Update membership
    session.channels.delete(channel);

    console.log(`[user-bridge] User ${username} left channel ${channel}`);
    return true;
  }

  /**
   * Get channels a user has joined.
   */
  getUserChannels(username: string): string[] {
    const session = this.users.get(username);
    return session ? Array.from(session.channels) : [];
  }

  /**
   * Send a message to a channel.
   */
  async sendChannelMessage(
    username: string,
    channel: string,
    body: string,
    options?: SendMessageOptions
  ): Promise<boolean> {
    const session = this.users.get(username);
    if (!session) {
      console.warn(`[user-bridge] Cannot send - user ${username} not registered`);
      return false;
    }

    return session.relayClient.sendMessage(
      channel,
      body,
      'message',
      options?.data,
      options?.thread
    );
  }

  /**
   * Send a direct message to another user or agent.
   */
  async sendDirectMessage(
    fromUsername: string,
    toName: string,
    body: string,
    options?: SendMessageOptions
  ): Promise<boolean> {
    const session = this.users.get(fromUsername);
    if (!session) {
      console.warn(`[user-bridge] Cannot send DM - user ${fromUsername} not registered`);
      return false;
    }

    return session.relayClient.sendMessage(
      toName,
      body,
      'message',
      options?.data,
      options?.thread
    );
  }

  /**
   * Handle incoming message from relay daemon.
   */
  private handleIncomingMessage(
    username: string,
    from: string,
    body: string,
    envelope: unknown
  ): void {
    const session = this.users.get(username);
    if (!session) return;

    const ws = session.webSocket;
    if (ws.readyState !== 1) return; // Not OPEN

    // Determine message type from envelope
    const env = envelope as { type?: string; payload?: { channel?: string; body?: string }; from?: string; to?: string };

    if (env.type === 'CHANNEL_MESSAGE') {
      // Channel message
      ws.send(JSON.stringify({
        type: 'channel_message',
        channel: env.payload?.channel,
        from,
        body: env.payload?.body || body,
        timestamp: new Date().toISOString(),
      }));
    } else {
      // Direct message (DELIVER)
      ws.send(JSON.stringify({
        type: 'direct_message',
        from,
        body: (env.payload as { body?: string })?.body || body,
        timestamp: new Date().toISOString(),
      }));
    }
  }

  /**
   * Dispose of all user sessions.
   */
  dispose(): void {
    for (const [username] of this.users) {
      this.unregisterUser(username);
    }
    console.log('[user-bridge] Disposed all user sessions');
  }
}
