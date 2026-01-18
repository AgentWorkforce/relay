/**
 * Presence Registry - Shared registry for tracking online users across cloud server.
 *
 * This singleton module allows both the WebSocket handler in server.ts and the
 * daemons API routes to access the current list of online users.
 */

export interface PresenceUserInfo {
  username: string;
  avatarUrl?: string;
  connectedAt: string;
  lastSeen: string;
  /** Optional workspace context for the user */
  workspaceId?: string;
}

interface PresenceState {
  info: PresenceUserInfo;
  connectionCount: number;
}

/**
 * In-memory registry of online users.
 * Key: username
 * Value: presence state with connection count
 */
const onlineUsers = new Map<string, PresenceState>();

/**
 * Register a user connection
 */
export function registerUserPresence(info: PresenceUserInfo): void {
  const existing = onlineUsers.get(info.username);
  if (existing) {
    // Update info and increment connection count
    existing.info = { ...existing.info, ...info, lastSeen: new Date().toISOString() };
    existing.connectionCount++;
  } else {
    onlineUsers.set(info.username, {
      info: { ...info, lastSeen: new Date().toISOString() },
      connectionCount: 1,
    });
  }
}

/**
 * Update last seen time for a user
 */
export function updateUserLastSeen(username: string): void {
  const state = onlineUsers.get(username);
  if (state) {
    state.info.lastSeen = new Date().toISOString();
  }
}

/**
 * Unregister a user connection
 */
export function unregisterUserPresence(username: string): void {
  const state = onlineUsers.get(username);
  if (state) {
    state.connectionCount--;
    if (state.connectionCount <= 0) {
      onlineUsers.delete(username);
    }
  }
}

/**
 * Check if a user is online
 */
export function isUserOnline(username: string): boolean {
  return onlineUsers.has(username);
}

/**
 * Get info for a specific online user
 */
export function getOnlineUser(username: string): PresenceUserInfo | undefined {
  return onlineUsers.get(username)?.info;
}

/**
 * Get list of all online users
 */
export function getOnlineUsers(): PresenceUserInfo[] {
  return Array.from(onlineUsers.values()).map((state) => state.info);
}

/**
 * Get online users formatted for remote agent discovery.
 * Returns in the same format as RemoteAgent so daemons can route to users.
 */
export function getOnlineUsersForDiscovery(): Array<{
  name: string;
  status: string;
  daemonId: string;
  daemonName: string;
  machineId: string;
  isHuman: boolean;
  avatarUrl?: string;
}> {
  return getOnlineUsers().map((user) => ({
    name: user.username,
    status: 'online',
    // Use special "cloud" identifier so daemon knows to route via cloud
    daemonId: 'cloud',
    daemonName: 'Cloud Dashboard',
    machineId: 'cloud',
    isHuman: true,
    avatarUrl: user.avatarUrl,
  }));
}

/**
 * Clear all presence (for testing or shutdown)
 */
export function clearAllPresence(): void {
  onlineUsers.clear();
}
