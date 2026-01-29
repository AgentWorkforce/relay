/**
 * useAgentLogs Hook
 *
 * React hook for streaming live PTY output from agents via WebSocket.
 * Connects to the agent log streaming endpoint and provides real-time updates.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

export interface LogLine {
  id: string;
  timestamp: number;
  content: string;
  type: 'stdout' | 'stderr' | 'system' | 'input';
  agentName?: string;
}

export interface UseAgentLogsOptions {
  agentName: string;
  /** Maximum number of lines to keep in buffer */
  maxLines?: number;
  /** Auto-connect on mount */
  autoConnect?: boolean;
  /** Enable reconnection on disconnect */
  reconnect?: boolean;
  /** Maximum reconnection attempts */
  maxReconnectAttempts?: number;
}

export interface UseAgentLogsReturn {
  logs: LogLine[];
  isConnected: boolean;
  isConnecting: boolean;
  error: Error | null;
  connect: () => void;
  disconnect: () => void;
  clear: () => void;
}

/**
 * Get WebSocket URL for agent log streaming
 */
function getLogStreamUrl(agentName: string): string {
  const path = `/ws/logs/${encodeURIComponent(agentName)}`;
  const isDev = process.env.NODE_ENV === 'development';

  // Server-side / tests: assume dashboard server is running locally on dev port
  if (typeof window === 'undefined') {
    return `ws://localhost:3889${path}`;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const { hostname, port } = window.location;

  // Next.js dev runs the UI on 3888 with the dashboard server on 3889 (rewrites
  // don't support WS upgrades). Only reroute in development to avoid breaking
  // production deployments that also bind to 3888.
  if (isDev && port === '3888') {
    const host = hostname || 'localhost';
    return `${protocol}//${host}:3889${path}`;
  }

  return `${protocol}//${window.location.host}${path}`;
}

/**
 * Generate a unique ID for log lines
 */
let logIdCounter = 0;
function generateLogId(): string {
  return `log-${Date.now()}-${++logIdCounter}`;
}

export function useAgentLogs(options: UseAgentLogsOptions): UseAgentLogsReturn {
  const {
    agentName,
    maxLines = 5000,
    autoConnect = true,
    reconnect = true,
    maxReconnectAttempts = Infinity,
  } = options;

  const [logs, setLogs] = useState<LogLine[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const agentNameRef = useRef(agentName);
  const shouldReconnectRef = useRef(true);
  const isConnectingRef = useRef(false);
  // Track manual close state per-WebSocket instance to avoid race conditions
  // when React remounts quickly (e.g., StrictMode). Using WeakMap ensures
  // each WebSocket tracks its own "was this a manual close" state.
  const manualCloseMapRef = useRef(new WeakMap<WebSocket, boolean>());
  // Track if we've successfully received data per-WebSocket instance
  const hasReceivedDataMapRef = useRef(new WeakMap<WebSocket, boolean>());

  // Keep agent name ref updated
  agentNameRef.current = agentName;

  const connect = useCallback(() => {
    // Ensure reconnects are allowed for this session
    shouldReconnectRef.current = true;

    // Prevent multiple connections - use ref to avoid dependency on state
    if (wsRef.current?.readyState === WebSocket.OPEN ||
        wsRef.current?.readyState === WebSocket.CONNECTING ||
        isConnectingRef.current) {
      return;
    }

    isConnectingRef.current = true;
    setIsConnecting(true);
    setError(null);

    const url = getLogStreamUrl(agentNameRef.current);

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      // Initialize per-WebSocket state
      manualCloseMapRef.current.set(ws, false);
      hasReceivedDataMapRef.current.set(ws, false);

      ws.onopen = () => {
        isConnectingRef.current = false;
        setIsConnected(true);
        setIsConnecting(false);
        setError(null);
        reconnectAttemptsRef.current = 0;

        // Add system message for connection
        setLogs((prev) => [
          ...prev,
          {
            id: generateLogId(),
            timestamp: Date.now(),
            content: `Connected to ${agentNameRef.current} log stream`,
            type: 'system',
            agentName: agentNameRef.current,
          },
        ]);
      };

      ws.onclose = (event) => {
        // Read per-WebSocket state (isolated from other connections)
        const wasManualClose = manualCloseMapRef.current.get(ws) ?? false;
        const hadReceivedData = hasReceivedDataMapRef.current.get(ws) ?? false;

        isConnectingRef.current = false;
        setIsConnected(false);
        setIsConnecting(false);
        wsRef.current = null;

        // Clear any pending reconnect when a close happens
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }

        // Skip logging/reconnecting for intentional disconnects (cleanup, user toggle)
        if (wasManualClose) {
          return;
        }

        // Don't reconnect if agent was not found (custom close code 4404)
        // This prevents infinite reconnect loops for non-existent agents
        if (event.code === 4404) {
          return;
        }

        // Add system message for disconnection, but only if:
        // 1. The close was not clean (code 1006 or similar)
        // 2. We had actually received data (to avoid false positives from transient connection issues)
        // Code 1006 is very common and happens during normal operations (React remounts,
        // network hiccups, etc.) - only show error if we had an established data stream
        if (!event.wasClean && hadReceivedData) {
          const willReconnect =
            shouldReconnectRef.current &&
            reconnect &&
            reconnectAttemptsRef.current < maxReconnectAttempts;

          setLogs((prev) => [
            ...prev,
            {
              id: generateLogId(),
              timestamp: Date.now(),
              content: willReconnect
                ? `Lost connection to log stream (code: ${event.code}). Reconnecting...`
                : `Disconnected from log stream (code: ${event.code})`,
              type: 'system',
              agentName: agentNameRef.current,
            },
          ]);
        }

        // Schedule reconnect if enabled
        if (
          shouldReconnectRef.current &&
          reconnect &&
          reconnectAttemptsRef.current < maxReconnectAttempts
        ) {
          const delay = Math.min(
            1000 * Math.pow(2, reconnectAttemptsRef.current),
            30000
          );
          reconnectAttemptsRef.current++;

          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, delay);
        }
      };

      ws.onerror = () => {
        isConnectingRef.current = false;
        setError(new Error('WebSocket connection error'));
        setIsConnecting(false);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          // Handle error messages from server
          if (data.type === 'error') {
            setError(new Error(data.error || `Failed to stream logs for ${data.agent || agentNameRef.current}`));
            setLogs((prev) => [
              ...prev,
              {
                id: generateLogId(),
                timestamp: Date.now(),
                content: `Error: ${data.error || 'Unknown error'}`,
                type: 'system',
                agentName: data.agent || agentNameRef.current,
              },
            ]);
            return;
          }

          // Handle subscribed confirmation
          if (data.type === 'subscribed') {
            console.log(`[useAgentLogs] Subscribed to ${data.agent}`);
            return;
          }

          // Handle history (initial log dump)
          if (data.type === 'history' && Array.isArray(data.lines)) {
            // Mark as having received data - connection is established
            if (data.lines.length > 0) {
              hasReceivedDataMapRef.current.set(ws, true);
            }
            setLogs((prev) => {
              const historyLines: LogLine[] = data.lines.map((line: string) => ({
                id: generateLogId(),
                timestamp: Date.now(),
                content: line,
                type: 'stdout' as const,
                agentName: data.agent || agentNameRef.current,
              }));
              return [...prev, ...historyLines].slice(-maxLines);
            });
            return;
          }

          // Handle different message formats - mark as having received data for all actual log messages
          if (typeof data === 'string') {
            // Simple string message
            hasReceivedDataMapRef.current.set(ws, true);
            setLogs((prev) => {
              const newLogs = [
                ...prev,
                {
                  id: generateLogId(),
                  timestamp: Date.now(),
                  content: data,
                  type: 'stdout' as const,
                  agentName: agentNameRef.current,
                },
              ];
              return newLogs.slice(-maxLines);
            });
          } else if (data.type === 'log' || data.type === 'output') {
            // Structured log message
            hasReceivedDataMapRef.current.set(ws, true);
            setLogs((prev) => {
              const logType: LogLine['type'] = data.stream === 'stderr' ? 'stderr' : 'stdout';
              const newLogs: LogLine[] = [
                ...prev,
                {
                  id: generateLogId(),
                  timestamp: data.timestamp || Date.now(),
                  content: data.content || data.data || data.message || '',
                  type: logType,
                  agentName: data.agentName || agentNameRef.current,
                },
              ];
              return newLogs.slice(-maxLines);
            });
          } else if (data.lines && Array.isArray(data.lines)) {
            // Batch of lines
            hasReceivedDataMapRef.current.set(ws, true);
            setLogs((prev) => {
              const newLines: LogLine[] = data.lines.map((line: string | { content: string; type?: string }) => {
                const lineType: LogLine['type'] = (typeof line === 'object' && line.type === 'stderr') ? 'stderr' : 'stdout';
                return {
                  id: generateLogId(),
                  timestamp: Date.now(),
                  content: typeof line === 'string' ? line : line.content,
                  type: lineType,
                  agentName: agentNameRef.current,
                };
              });
              return [...prev, ...newLines].slice(-maxLines);
            });
          }
        } catch {
          // Handle plain text messages
          if (typeof event.data === 'string') {
            hasReceivedDataMapRef.current.set(ws, true);
            setLogs((prev) => {
              const newLogs = [
                ...prev,
                {
                  id: generateLogId(),
                  timestamp: Date.now(),
                  content: event.data,
                  type: 'stdout' as const,
                  agentName: agentNameRef.current,
                },
              ];
              return newLogs.slice(-maxLines);
            });
          }
        }
      };
    } catch (e) {
      isConnectingRef.current = false;
      setError(e instanceof Error ? e : new Error('Failed to create WebSocket'));
      setIsConnecting(false);
    }
  }, [maxLines, reconnect, maxReconnectAttempts]);

  const disconnect = useCallback(() => {
    // Prevent reconnection attempts after an intentional disconnect
    shouldReconnectRef.current = false;

    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Mark this WebSocket as manually closed before closing it
    // This prevents the false positive error message on close
    if (wsRef.current) {
      manualCloseMapRef.current.set(wsRef.current, true);
      wsRef.current.close();
      wsRef.current = null;
    }

    isConnectingRef.current = false;
    setIsConnected(false);
    setIsConnecting(false);
  }, []);

  const clear = useCallback(() => {
    setLogs([]);
  }, []);

  // Auto-connect on mount or agent change
  useEffect(() => {
    if (autoConnect && agentName) {
      connect();
    }

    return () => {
      disconnect();
    };
  }, [agentName, autoConnect, connect, disconnect]);

  return {
    logs,
    isConnected,
    isConnecting,
    error,
    connect,
    disconnect,
    clear,
  };
}
