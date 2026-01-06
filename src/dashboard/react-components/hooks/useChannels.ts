/**
 * useChannels Hook
 *
 * Manages channel-based messaging via the presence WebSocket.
 * - Join/leave channels
 * - Send/receive channel messages
 * - Send/receive direct messages
 * - Track joined channels
 */

import { useState, useEffect, useCallback, useRef } from 'react';

/** Channel message from server */
export interface ChannelMessage {
  id: string;
  type: 'channel_message' | 'direct_message';
  channel?: string;
  from: string;
  to?: string;
  body: string;
  thread?: string;
  timestamp: string;
}

export interface UseChannelsOptions {
  /** Current user info (if logged in) */
  currentUser?: {
    username: string;
    avatarUrl?: string;
  };
  /** WebSocket URL (defaults to same as main WebSocket) */
  wsUrl?: string;
  /** Whether to auto-connect */
  autoConnect?: boolean;
  /** Callback when a message is received */
  onMessage?: (message: ChannelMessage) => void;
}

export interface UseChannelsReturn {
  /** List of channels user has joined */
  channels: string[];
  /** Join a channel */
  joinChannel: (channel: string) => void;
  /** Leave a channel */
  leaveChannel: (channel: string) => void;
  /** Send a message to a channel */
  sendChannelMessage: (channel: string, body: string, thread?: string) => void;
  /** Send a direct message */
  sendDirectMessage: (to: string, body: string, thread?: string) => void;
  /** Whether connected */
  isConnected: boolean;
  /** Recent messages (last 100) */
  messages: ChannelMessage[];
}

/**
 * Get the presence WebSocket URL
 */
function getPresenceUrl(): string {
  const isDev = process.env.NODE_ENV === 'development';

  if (typeof window === 'undefined') {
    return 'ws://localhost:3889/ws/presence';
  }

  if (isDev && window.location.port === '3888') {
    const host = window.location.hostname || 'localhost';
    return `ws://${host}:3889/ws/presence`;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/presence`;
}

const MAX_MESSAGES = 100;

export function useChannels(options: UseChannelsOptions = {}): UseChannelsReturn {
  const { currentUser, wsUrl, autoConnect = true, onMessage } = options;

  const [channels, setChannels] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isConnectingRef = useRef(false);
  const currentUserRef = useRef(currentUser);
  const onMessageRef = useRef(onMessage);
  currentUserRef.current = currentUser;
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    const user = currentUserRef.current;
    if (!user) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    if (isConnectingRef.current) return;

    isConnectingRef.current = true;
    const url = wsUrl || getPresenceUrl();

    try {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        isConnectingRef.current = false;
        setIsConnected(true);

        const currentUserInfo = currentUserRef.current;
        if (currentUserInfo) {
          // Announce presence (this registers with UserBridge on server)
          ws.send(JSON.stringify({
            type: 'presence',
            action: 'join',
            user: {
              username: currentUserInfo.username,
              avatarUrl: currentUserInfo.avatarUrl,
            },
          }));
        }
      };

      ws.onclose = () => {
        isConnectingRef.current = false;
        setIsConnected(false);
        wsRef.current = null;

        if (currentUserRef.current) {
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, 2000);
        }
      };

      ws.onerror = (event) => {
        console.error('[useChannels] Error:', event);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          switch (msg.type) {
            case 'channel_joined':
              if (msg.success) {
                setChannels((prev) => {
                  if (prev.includes(msg.channel)) return prev;
                  return [...prev, msg.channel];
                });
              }
              break;

            case 'channel_left':
              if (msg.success) {
                setChannels((prev) => prev.filter((c) => c !== msg.channel));
              }
              break;

            case 'channel_message': {
              const channelMsg: ChannelMessage = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                type: 'channel_message',
                channel: msg.channel,
                from: msg.from,
                body: msg.body,
                thread: msg.thread,
                timestamp: msg.timestamp || new Date().toISOString(),
              };
              setMessages((prev) => {
                const updated = [...prev, channelMsg];
                return updated.slice(-MAX_MESSAGES);
              });
              onMessageRef.current?.(channelMsg);
              break;
            }

            case 'direct_message': {
              const dmMsg: ChannelMessage = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                type: 'direct_message',
                from: msg.from,
                to: currentUserRef.current?.username,
                body: msg.body,
                thread: msg.thread,
                timestamp: msg.timestamp || new Date().toISOString(),
              };
              setMessages((prev) => {
                const updated = [...prev, dmMsg];
                return updated.slice(-MAX_MESSAGES);
              });
              onMessageRef.current?.(dmMsg);
              break;
            }
          }
        } catch (e) {
          console.error('[useChannels] Failed to parse message:', e);
        }
      };

      wsRef.current = ws;
    } catch (e) {
      console.error('[useChannels] Failed to create WebSocket:', e);
    }
  }, [wsUrl]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    isConnectingRef.current = false;

    if (wsRef.current) {
      const ws = wsRef.current;
      ws.onclose = null;
      ws.onerror = null;

      const user = currentUserRef.current;
      if (ws.readyState === WebSocket.OPEN && user) {
        ws.send(JSON.stringify({
          type: 'presence',
          action: 'leave',
          username: user.username,
        }));
      }
      ws.close();
      wsRef.current = null;
    }

    setIsConnected(false);
    setChannels([]);
  }, []);

  const joinChannel = useCallback((channel: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    wsRef.current.send(JSON.stringify({
      type: 'channel_join',
      channel,
    }));
  }, []);

  const leaveChannel = useCallback((channel: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    wsRef.current.send(JSON.stringify({
      type: 'channel_leave',
      channel,
    }));
  }, []);

  const sendChannelMessage = useCallback((channel: string, body: string, thread?: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    wsRef.current.send(JSON.stringify({
      type: 'channel_message',
      channel,
      body,
      thread,
    }));
  }, []);

  const sendDirectMessage = useCallback((to: string, body: string, thread?: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    wsRef.current.send(JSON.stringify({
      type: 'direct_message',
      to,
      body,
      thread,
    }));
  }, []);

  // Connect when user is available
  useEffect(() => {
    if (!autoConnect || !currentUserRef.current) return;

    if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
      return;
    }

    connect();

    return () => {
      disconnect();
    };
  }, [autoConnect, currentUser?.username, connect, disconnect]);

  // Send leave on page unload
  useEffect(() => {
    const handleUnload = () => {
      const user = currentUserRef.current;
      if (wsRef.current?.readyState === WebSocket.OPEN && user) {
        wsRef.current.send(JSON.stringify({
          type: 'presence',
          action: 'leave',
          username: user.username,
        }));
      }
    };

    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, []);

  return {
    channels,
    joinChannel,
    leaveChannel,
    sendChannelMessage,
    sendDirectMessage,
    isConnected,
    messages,
  };
}
