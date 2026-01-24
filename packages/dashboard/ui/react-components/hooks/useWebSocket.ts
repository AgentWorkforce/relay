/**
 * useWebSocket Hook
 *
 * React hook for managing WebSocket connection to the dashboard server.
 * Provides real-time updates for agents, messages, and fleet data.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Agent, Message, Session, AgentSummary, FleetData } from '../../types';

export interface DashboardData {
  agents: Agent[];
  users?: Agent[]; // Human users (cli === 'dashboard')
  messages: Message[];
  sessions?: Session[];
  summaries?: AgentSummary[];
  fleet?: FleetData;
}

export interface UseWebSocketOptions {
  url?: string;
  autoConnect?: boolean;
  reconnect?: boolean;
  maxReconnectAttempts?: number;
  reconnectDelay?: number;
}

export interface UseWebSocketReturn {
  data: DashboardData | null;
  isConnected: boolean;
  isReconnecting: boolean;
  error: Error | null;
  connect: () => void;
  disconnect: () => void;
  sendMessage: (message: unknown) => void;
}

const DEFAULT_OPTIONS: Required<UseWebSocketOptions> = {
  url: '',
  autoConnect: true,
  reconnect: true,
  maxReconnectAttempts: 10,
  reconnectDelay: 1000,
};

// localStorage keys
const SESSION_ID_KEY = 'agent-relay-ws-session-id';
const MESSAGE_QUEUE_KEY = 'agent-relay-ws-message-queue';

/**
 * Generate or retrieve session ID from localStorage
 */
function getOrCreateSessionId(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  
  let sessionId = localStorage.getItem(SESSION_ID_KEY);
  if (!sessionId) {
    sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    localStorage.setItem(SESSION_ID_KEY, sessionId);
  }
  return sessionId;
}

/**
 * Get message queue from localStorage
 */
function getMessageQueue(): unknown[] {
  if (typeof window === 'undefined') {
    return [];
  }
  
  try {
    const queue = localStorage.getItem(MESSAGE_QUEUE_KEY);
    return queue ? JSON.parse(queue) : [];
  } catch {
    return [];
  }
}

/**
 * Save message queue to localStorage
 */
function saveMessageQueue(queue: unknown[]): void {
  if (typeof window === 'undefined') {
    return;
  }
  
  try {
    localStorage.setItem(MESSAGE_QUEUE_KEY, JSON.stringify(queue));
  } catch (err) {
    console.error('[useWebSocket] Failed to save message queue:', err);
  }
}

/**
 * Clear message queue from localStorage
 */
function clearMessageQueue(): void {
  if (typeof window === 'undefined') {
    return;
  }
  
  localStorage.removeItem(MESSAGE_QUEUE_KEY);
}

/**
 * Get the default WebSocket URL based on the current page location
 *
 * In dev mode (Next.js on 3888), WebSocket connects to dashboard server on 3889
 * because Next.js rewrites don't support WebSocket upgrade requests.
 *
 * In production, everything runs on the same port.
 */
function getDefaultUrl(): string {
  const isDev = process.env.NODE_ENV === 'development';

  if (typeof window === 'undefined') {
    return 'ws://localhost:3889/ws';
  }

  // Dev mode only: Next.js on 3888, dashboard server on 3889
  // In production (static export), use same host regardless of port
  if (isDev && window.location.port === '3888') {
    const host = window.location.hostname || 'localhost';
    return `ws://${host}:3889/ws`;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Production: use the same host (works with tunnels/proxies)
  return `${protocol}//${window.location.host}/ws`;
}

export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketReturn {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const [data, setData] = useState<DashboardData | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const sessionIdRef = useRef<string>('');
  const lastMessageIdRef = useRef<string | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    // Initialize session ID if not set
    if (!sessionIdRef.current) {
      sessionIdRef.current = getOrCreateSessionId();
    }

    // Compute URL at connection time (always on client)
    const wsUrl = opts.url || getDefaultUrl();

    try {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setIsConnected(true);
        setIsReconnecting(false);
        setError(null);
        reconnectAttemptsRef.current = 0;

        // Send session ID to server for reconnection tracking
        if (sessionIdRef.current) {
          ws.send(JSON.stringify({
            type: 'session_init',
            sessionId: sessionIdRef.current,
            lastMessageId: lastMessageIdRef.current,
          }));
        }

        // Send queued messages
        const queue = getMessageQueue();
        if (queue.length > 0) {
          queue.forEach((msg) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(msg));
            }
          });
          clearMessageQueue();
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        wsRef.current = null;

        // Schedule reconnect if enabled
        if (opts.reconnect && reconnectAttemptsRef.current < opts.maxReconnectAttempts) {
          setIsReconnecting(true);
          
          // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
          const baseDelay = 1000; // 1 second
          const delay = Math.min(
            baseDelay * Math.pow(2, reconnectAttemptsRef.current),
            30000 // max 30 seconds
          );
          reconnectAttemptsRef.current++;

          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, delay);
        } else {
          setIsReconnecting(false);
        }
      };

      ws.onerror = (event) => {
        setError(new Error('WebSocket connection error'));
        console.error('[useWebSocket] Error:', event);
      };

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          
          // Handle missed messages sync response
          if (parsed.type === 'missed_messages' && Array.isArray(parsed.messages)) {
            // Process missed messages
            parsed.messages.forEach((msg: DashboardData) => {
              setData(msg);
            });
            // Update last message ID if provided
            if (parsed.lastMessageId) {
              lastMessageIdRef.current = parsed.lastMessageId;
            }
          } else if (parsed.type === 'session_restored') {
            // Session was restored, update last message ID if provided
            if (parsed.lastMessageId) {
              lastMessageIdRef.current = parsed.lastMessageId;
            }
            // Process initial data
            if (parsed.data) {
              setData(parsed.data as DashboardData);
            }
          } else {
            // Regular data update
            const dashboardData = parsed as DashboardData;
            setData(dashboardData);
            // Update last message ID if available in the data
            if (dashboardData.messages && dashboardData.messages.length > 0) {
              const lastMsg = dashboardData.messages[dashboardData.messages.length - 1];
              if (lastMsg.id) {
                lastMessageIdRef.current = lastMsg.id;
              }
            }
          }
        } catch (e) {
          console.error('[useWebSocket] Failed to parse message:', e);
        }
      };

      wsRef.current = ws;
    } catch (e) {
      setError(e instanceof Error ? e : new Error('Failed to create WebSocket'));
      setIsReconnecting(false);
    }
  }, [opts.url, opts.reconnect, opts.maxReconnectAttempts, opts.reconnectDelay]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setIsConnected(false);
    setIsReconnecting(false);
  }, []);

  /**
   * Send a message through WebSocket. If disconnected, queue it for later.
   */
  const sendMessage = useCallback((message: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    } else {
      // Queue message for when connection is restored
      const queue = getMessageQueue();
      queue.push(message);
      saveMessageQueue(queue);
    }
  }, []);

  // Auto-connect on mount
  useEffect(() => {
    if (opts.autoConnect) {
      connect();
    }

    return () => {
      disconnect();
    };
  }, [opts.autoConnect, connect, disconnect]);

  return {
    data,
    isConnected,
    isReconnecting,
    error,
    connect,
    disconnect,
    sendMessage,
  };
}
