/**
 * usePresence Hook
 *
 * Manages user presence and typing indicators via WebSocket.
 * - Tracks which users are currently online
 * - Sends/receives typing indicator events
 * - Handles user presence announcements
 */

import { useState, useEffect, useCallback, useRef } from 'react';

/** User presence information */
export interface UserPresence {
  /** Username (GitHub username in cloud mode) */
  username: string;
  /** Optional avatar URL */
  avatarUrl?: string;
  /** When the user came online */
  connectedAt: string;
  /** Last activity timestamp */
  lastSeen: string;
  /** Whether user is currently typing */
  isTyping?: boolean;
}

/** Typing indicator information */
export interface TypingIndicator {
  /** Username of the person typing */
  username: string;
  /** Avatar URL if available */
  avatarUrl?: string;
  /** Timestamp when typing started */
  startedAt: number;
}

export interface UsePresenceOptions {
  /** Current user info (if logged in) */
  currentUser?: {
    username: string;
    avatarUrl?: string;
  };
  /** WebSocket URL (defaults to same as main WebSocket) */
  wsUrl?: string;
  /** Whether to auto-connect */
  autoConnect?: boolean;
}

export interface UsePresenceReturn {
  /** List of online users */
  onlineUsers: UserPresence[];
  /** Currently typing users (excluding self) */
  typingUsers: TypingIndicator[];
  /** Send typing indicator */
  sendTyping: (isTyping: boolean) => void;
  /** Whether connected to presence system */
  isConnected: boolean;
}

/**
 * Get the presence WebSocket URL
 */
function getPresenceUrl(): string {
  const isDev = process.env.NODE_ENV === 'development';

  if (typeof window === 'undefined') {
    return 'ws://localhost:3889/ws/presence';
  }

  // Dev mode only: Next.js on 3888, dashboard server on 3889
  // In production (static export), use same host regardless of port
  if (isDev && window.location.port === '3888') {
    const host = window.location.hostname || 'localhost';
    return `ws://${host}:3889/ws/presence`;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/presence`;
}

export function usePresence(options: UsePresenceOptions = {}): UsePresenceReturn {
  const { currentUser, wsUrl, autoConnect = true } = options;

  const [onlineUsers, setOnlineUsers] = useState<UserPresence[]>([]);
  const [typingUsers, setTypingUsers] = useState<TypingIndicator[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Clear stale typing indicators (after 3 seconds of no update)
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setTypingUsers((prev) =>
        prev.filter((t) => now - t.startedAt < 3000)
      );
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const connect = useCallback(() => {
    if (!currentUser) return; // Don't connect without user info
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const url = wsUrl || getPresenceUrl();

    try {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        setIsConnected(true);

        // Announce presence
        ws.send(JSON.stringify({
          type: 'presence',
          action: 'join',
          user: {
            username: currentUser.username,
            avatarUrl: currentUser.avatarUrl,
          },
        }));
      };

      ws.onclose = () => {
        setIsConnected(false);
        wsRef.current = null;

        // Reconnect after 2 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, 2000);
      };

      ws.onerror = (event) => {
        console.error('[usePresence] Error:', event);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          switch (msg.type) {
            case 'presence_list':
              // Full list of online users
              setOnlineUsers(msg.users || []);
              break;

            case 'presence_join':
              // User came online
              setOnlineUsers((prev) => {
                const filtered = prev.filter((u) => u.username !== msg.user.username);
                return [...filtered, msg.user];
              });
              break;

            case 'presence_leave':
              // User went offline
              setOnlineUsers((prev) =>
                prev.filter((u) => u.username !== msg.username)
              );
              setTypingUsers((prev) =>
                prev.filter((t) => t.username !== msg.username)
              );
              break;

            case 'typing':
              // Typing indicator update
              if (msg.username === currentUser?.username) break; // Ignore self

              if (msg.isTyping) {
                setTypingUsers((prev) => {
                  const filtered = prev.filter((t) => t.username !== msg.username);
                  return [
                    ...filtered,
                    {
                      username: msg.username,
                      avatarUrl: msg.avatarUrl,
                      startedAt: Date.now(),
                    },
                  ];
                });
              } else {
                setTypingUsers((prev) =>
                  prev.filter((t) => t.username !== msg.username)
                );
              }
              break;
          }
        } catch (e) {
          console.error('[usePresence] Failed to parse message:', e);
        }
      };

      wsRef.current = ws;
    } catch (e) {
      console.error('[usePresence] Failed to create WebSocket:', e);
    }
  }, [currentUser, wsUrl]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      // Send leave message before closing
      if (wsRef.current.readyState === WebSocket.OPEN && currentUser) {
        wsRef.current.send(JSON.stringify({
          type: 'presence',
          action: 'leave',
          username: currentUser.username,
        }));
      }
      wsRef.current.close();
      wsRef.current = null;
    }

    setIsConnected(false);
  }, [currentUser]);

  // Send typing indicator
  const sendTyping = useCallback((isTyping: boolean) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (!currentUser) return;

    // Clear any existing timeout first
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }

    wsRef.current.send(JSON.stringify({
      type: 'typing',
      isTyping,
      username: currentUser.username,
      avatarUrl: currentUser.avatarUrl,
    }));

    // Only set auto-clear timeout when starting to type
    if (isTyping) {
      typingTimeoutRef.current = setTimeout(() => {
        typingTimeoutRef.current = null;
        sendTyping(false);
      }, 3000);
    }
  }, [currentUser]);

  // Connect when user is available
  useEffect(() => {
    if (autoConnect && currentUser) {
      connect();
    }

    return () => {
      disconnect();
    };
  }, [autoConnect, currentUser, connect, disconnect]);

  // Send leave on page unload
  useEffect(() => {
    const handleUnload = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN && currentUser) {
        wsRef.current.send(JSON.stringify({
          type: 'presence',
          action: 'leave',
          username: currentUser.username,
        }));
      }
    };

    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, [currentUser]);

  return {
    onlineUsers,
    typingUsers,
    sendTyping,
    isConnected,
  };
}
