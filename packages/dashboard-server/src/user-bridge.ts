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
  // Channel operations
  joinChannel(channel: string, displayName?: string): boolean;
  leaveChannel(channel: string, reason?: string): boolean;
  sendChannelMessage(
    channel: string,
    body: string,
    options?: { thread?: string; mentions?: string[]; attachments?: unknown[]; data?: Record<string, unknown> }
  ): boolean;
  // Admin channel operations
  adminJoinChannel?(channel: string, member: string): boolean;
  adminRemoveMember?(channel: string, member: string): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onMessage?: (from: string, payload: any, messageId: string, meta?: any, originalTo?: string) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onChannelMessage?: (from: string, channel: string, body: string, envelope: any) => void;
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
 * User session state - supports multiple WebSocket connections (multi-tab)
 */
interface UserSession {
  username: string;
  relayClient: IRelayClient;
  /** Multiple WebSocket connections for multi-tab support */
  webSockets: Set<WebSocket>;
  channels: Set<string>;
  avatarUrl?: string;
}

/**
 * User info for avatar lookups
 */
export interface UserInfo {
  avatarUrl?: string;
}

/**
 * Options for creating a UserBridge
 */
export interface UserBridgeOptions {
  socketPath: string;
  createRelayClient: RelayClientFactory;
  loadPersistedChannels?: (username: string) => Promise<string[]>;
  /** Optional callback to look up user info (avatar URL) by username */
  lookupUserInfo?: (username: string) => UserInfo | undefined;
}

/**
 * Message options for sending
 */
export interface SendMessageOptions {
  thread?: string;
  data?: Record<string, unknown>;
  attachments?: unknown[];
}

/**
 * UserBridge manages the connection between dashboard WebSocket users
 * and the relay daemon.
 */
export class UserBridge {
  private readonly socketPath: string;
  private readonly createRelayClient: RelayClientFactory;
  private readonly loadPersistedChannels?: (username: string) => Promise<string[]>;
  private readonly lookupUserInfo?: (username: string) => UserInfo | undefined;
  private readonly users = new Map<string, UserSession>();

  constructor(options: UserBridgeOptions) {
    this.socketPath = options.socketPath;
    this.createRelayClient = options.createRelayClient;
    this.loadPersistedChannels = options.loadPersistedChannels;
    this.lookupUserInfo = options.lookupUserInfo;
  }

  /**
   * Get the relay client for a user if they are registered.
   * This allows external code to reuse the userBridge's relay client
   * instead of creating a duplicate connection.
   */
  getRelayClient(username: string): IRelayClient | undefined {
    return this.users.get(username)?.relayClient;
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
    // If user already registered, just update the WebSocket (multi-tab support)
    if (this.users.has(username)) {
      console.log(`[user-bridge] User ${username} already registered, updating WebSocket`);
      this.updateWebSocket(username, webSocket);
      return;
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

    // Set up message handler to forward direct messages to WebSocket
    relayClient.onMessage = (from, payload, _messageId, _meta, _originalTo) => {
      const body = typeof payload === 'object' && payload !== null && 'body' in payload
        ? (payload as { body: string }).body
        : String(payload);
      this.handleIncomingDirectMessage(username, from, body, payload);
    };

    // Set up channel message handler to forward channel messages to WebSocket
    relayClient.onChannelMessage = (from, channel, body, envelope) => {
      this.handleIncomingChannelMessage(username, from, channel, body, envelope);
    };

    // Create session with WebSocket set for multi-tab support
    const session: UserSession = {
      username,
      relayClient,
      webSockets: new Set([webSocket]),
      channels: new Set(),
      avatarUrl: options?.avatarUrl,
    };

    this.users.set(username, session);
    console.log(`[user-bridge] User registered: ${username} (total users: ${this.users.size}, connections: 1)`);

    // Auto-join user to #general channel
    // Note: The daemon auto-joins on connect, but we need to track locally too
    session.channels.add('#general');

    if (this.loadPersistedChannels) {
      try {
        const persistedChannels = await this.loadPersistedChannels(username);
        for (const channel of persistedChannels) {
          if (channel === '#general') continue;
          if (session.channels.has(channel)) continue;
          session.relayClient.joinChannel(channel, username);
          session.channels.add(channel);
        }
      } catch (err) {
        console.error(`[user-bridge] Failed to restore persisted channels for ${username}:`, err);
      }
    }

    // Set up WebSocket close handler to remove this specific connection
    webSocket.on('close', () => {
      this.removeWebSocket(username, webSocket);
    });

    console.log(`[user-bridge] User ${username} registered with relay daemon`);
  }

  /**
   * Remove a specific WebSocket connection from a user's session.
   * If this was the last connection, unregister the user entirely.
   */
  private removeWebSocket(username: string, webSocket: WebSocket): void {
    const session = this.users.get(username);
    if (!session) return;

    session.webSockets.delete(webSocket);
    console.log(`[user-bridge] WebSocket closed for ${username} (${session.webSockets.size} connections remaining)`);

    // Only unregister if ALL connections are closed
    if (session.webSockets.size === 0) {
      this.unregisterUser(username);
    }
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
   * Add a new WebSocket connection for an existing user session.
   * This is needed when a user opens a new tab.
   */
  updateWebSocket(username: string, newWebSocket: WebSocket): boolean {
    const session = this.users.get(username);
    if (!session) {
      console.log(`[user-bridge] Cannot add WebSocket - user ${username} not registered`);
      return false;
    }

    // Add the new WebSocket to the set
    session.webSockets.add(newWebSocket);

    // Set up close handler to remove this specific connection
    newWebSocket.on('close', () => {
      this.removeWebSocket(username, newWebSocket);
    });

    console.log(`[user-bridge] Added WebSocket for user ${username} (${session.webSockets.size} connections)`);
    return true;
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

    // Send CHANNEL_JOIN via relay client
    const success = session.relayClient.joinChannel(channel, username);

    if (success) {
      // Track membership
      session.channels.add(channel);
    }

    return success;
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

    // Send CHANNEL_LEAVE via relay client
    const success = session.relayClient.leaveChannel(channel);

    if (success) {
      // Update membership
      session.channels.delete(channel);
      console.log(`[user-bridge] User ${username} left channel ${channel}`);
    }

    return success;
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

    return session.relayClient.sendChannelMessage(channel, body, {
      thread: options?.thread,
      data: options?.data,
      attachments: options?.attachments,
    });
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
   * Handle incoming direct message from relay daemon.
   */
  private handleIncomingDirectMessage(
    username: string,
    from: string,
    body: string,
    payload: unknown
  ): void {
    // Skip channel messages - they are handled by handleIncomingChannelMessage
    // The relay client calls both onMessage and onChannelMessage for channel messages,
    // with _isChannelMessage flag set in the data for onMessage calls
    const payloadObj = payload as { body?: string; data?: { _isChannelMessage?: boolean } } | undefined;
    if (payloadObj?.data?._isChannelMessage) {
      return; // Skip - will be handled by onChannelMessage callback
    }

    const session = this.users.get(username);
    if (!session) return;

    // Look up sender's avatar if lookup function is available
    const senderInfo = this.lookupUserInfo?.(from);
    const fromAvatarUrl = senderInfo?.avatarUrl;
    // Determine entity type: user if they have info, agent otherwise
    const fromEntityType: 'user' | 'agent' = senderInfo ? 'user' : 'agent';

    const message = JSON.stringify({
      type: 'direct_message',
      from,
      fromAvatarUrl,
      fromEntityType,
      body: payloadObj?.body || body,
      timestamp: new Date().toISOString(),
    });

    // Send to ALL open WebSocket connections (multi-tab support)
    for (const ws of session.webSockets) {
      if (ws.readyState === 1) { // OPEN
        ws.send(message);
      }
    }
  }

  /**
   * Handle incoming channel message from relay daemon.
   */
  private handleIncomingChannelMessage(
    username: string,
    from: string,
    channel: string,
    body: string,
    envelope: unknown
  ): void {
    const session = this.users.get(username);
    if (!session) return;

    // Look up sender's avatar if lookup function is available
    const senderInfo = this.lookupUserInfo?.(from);
    const fromAvatarUrl = senderInfo?.avatarUrl;
    // Determine entity type: user if they have info, agent otherwise
    const fromEntityType: 'user' | 'agent' = senderInfo ? 'user' : 'agent';

    // Channel message
    const env = envelope as { payload?: { thread?: string; mentions?: string[] } } | undefined;
    const message = JSON.stringify({
      type: 'channel_message',
      channel,
      from,
      fromAvatarUrl,
      fromEntityType,
      body,
      thread: env?.payload?.thread,
      mentions: env?.payload?.mentions,
      timestamp: new Date().toISOString(),
    });

    // Send to ALL open WebSocket connections (multi-tab support)
    for (const ws of session.webSockets) {
      if (ws.readyState === 1) { // OPEN
        ws.send(message);
      }
    }
  }

  /**
   * Admin: Add a member to a channel (does not require member to be connected).
   * Used to sync channel memberships from database.
   * Uses the first available user session or creates a temporary one.
   */
  async adminJoinChannel(channel: string, member: string): Promise<boolean> {
    // Try to use an existing session
    const sessions = Array.from(this.users.values());
    if (sessions.length > 0) {
      const session = sessions[0];
      if (session.relayClient.adminJoinChannel) {
        console.log(`[user-bridge] Admin join: ${member} -> ${channel} (via ${session.username})`);
        return session.relayClient.adminJoinChannel(channel, member);
      }
    }

    // No sessions available - create a temporary system client
    try {
      console.log(`[user-bridge] Admin join: ${member} -> ${channel} (creating temp client)`);
      const tempClient = await this.createRelayClient({
        socketPath: this.socketPath,
        agentName: '__system__',
        entityType: 'user',
      });
      await tempClient.connect();

      // Give daemon time to complete handshake before sending admin commands.
      // 100ms is sufficient for local Unix socket handshake (typically <10ms),
      // but provides margin for the daemon to process the HELLO message and
      // set up internal state. This is a temporary client created just for
      // the admin operation, not a long-lived session.
      await new Promise(resolve => setTimeout(resolve, 100));

      if (tempClient.adminJoinChannel) {
        const result = tempClient.adminJoinChannel(channel, member);
        // Disconnect after a short delay to allow message to be sent
        setTimeout(() => tempClient.disconnect(), 200);
        return result;
      }

      tempClient.disconnect();
      return false;
    } catch (err) {
      console.error('[user-bridge] Failed to create temp client for admin join:', err);
      return false;
    }
  }

  /**
   * Admin: Remove a member from a channel (does not require member to be connected).
   * Used to remove channel members from dashboard.
   * Uses the first available user session or creates a temporary one.
   */
  async adminRemoveMember(channel: string, member: string): Promise<boolean> {
    // Try to use an existing session
    const sessions = Array.from(this.users.values());
    if (sessions.length > 0) {
      const session = sessions[0];
      if (session.relayClient.adminRemoveMember) {
        console.log(`[user-bridge] Admin remove: ${member} <- ${channel} (via ${session.username})`);
        return session.relayClient.adminRemoveMember(channel, member);
      }
    }

    // No sessions available - create a temporary system client
    try {
      console.log(`[user-bridge] Admin remove: ${member} <- ${channel} (creating temp client)`);
      const tempClient = await this.createRelayClient({
        socketPath: this.socketPath,
        agentName: '__system__',
        entityType: 'user',
      });
      await tempClient.connect();

      // Give daemon time to complete handshake before sending admin commands.
      // 100ms is sufficient for local Unix socket handshake (typically <10ms),
      // but provides margin for the daemon to process the HELLO message and
      // set up internal state. This is a temporary client created just for
      // the admin operation, not a long-lived session.
      await new Promise(resolve => setTimeout(resolve, 100));

      if (tempClient.adminRemoveMember) {
        const result = tempClient.adminRemoveMember(channel, member);
        // Disconnect after a short delay to allow message to be sent
        setTimeout(() => tempClient.disconnect(), 200);
        return result;
      }

      tempClient.disconnect();
      return false;
    } catch (err) {
      console.error('[user-bridge] Failed to create temp client for admin remove:', err);
      return false;
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
