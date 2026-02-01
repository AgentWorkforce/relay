/**
 * Transport module for relay client communication.
 * @agent-relay/sdk
 *
 * Provides transport abstraction and implementations:
 * - SocketTransport: Unix/TCP sockets (Node.js only)
 * - WebSocketTransport: WebSocket connections (Node.js and Browser)
 *
 * Auto-detection selects the appropriate transport based on environment.
 */

// Types
export type {
  Transport,
  TransportConfig,
  TransportEvents,
  TransportState,
  TransportFactory,
} from './types.js';

// Socket transport (Node.js)
export {
  SocketTransport,
  createSocketTransport,
  type SocketTransportConfig,
} from './socket-transport.js';

// WebSocket transport (Node.js and Browser)
export {
  WebSocketTransport,
  createWebSocketTransport,
  socketPathToWsUrl,
  type WebSocketTransportConfig,
} from './websocket-transport.js';

// Re-export types from types.ts for convenience
import type { Transport, TransportConfig } from './types.js';
import { SocketTransport, type SocketTransportConfig } from './socket-transport.js';
import { WebSocketTransport, type WebSocketTransportConfig, socketPathToWsUrl } from './websocket-transport.js';

/**
 * Environment detection result.
 */
export interface EnvironmentInfo {
  /** Running in browser environment */
  isBrowser: boolean;
  /** Running in Node.js environment */
  isNode: boolean;
  /** WebSocket API is available */
  hasWebSocket: boolean;
  /** Unix sockets are available (Node.js only) */
  hasUnixSockets: boolean;
}

/**
 * Detect the current runtime environment.
 */
export function detectEnvironment(): EnvironmentInfo {
  const isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined';
  const isNode = typeof process !== 'undefined' &&
    process.versions != null &&
    process.versions.node != null;
  const hasWebSocket = typeof WebSocket !== 'undefined' || isNode; // 'ws' can provide WebSocket in Node
  const hasUnixSockets = isNode; // Only Node.js supports Unix sockets

  return {
    isBrowser,
    isNode,
    hasWebSocket,
    hasUnixSockets,
  };
}

/**
 * Options for creating an auto-detected transport.
 */
export interface AutoTransportOptions extends TransportConfig {
  /** Unix socket path (for Node.js socket transport) */
  socketPath?: string;
  /** WebSocket URL (for WebSocket transport) */
  wsUrl?: string;
  /** WebSocket host (used with port to construct URL) */
  wsHost?: string;
  /** WebSocket port (default: 3888) */
  wsPort?: number;
  /** WebSocket path (default: /ws) */
  wsPath?: string;
  /** Use secure WebSocket (wss://) */
  wsSecure?: boolean;
  /** Force a specific transport type */
  forceTransport?: 'socket' | 'websocket';
}

/**
 * Create a transport automatically based on environment and options.
 *
 * In browser environments, WebSocket transport is always used.
 * In Node.js, Unix socket is preferred if socketPath is provided,
 * otherwise WebSocket is used if wsUrl or wsHost is provided.
 *
 * @param options - Transport configuration options
 * @returns Configured transport instance
 *
 * @example Browser usage
 * ```typescript
 * const transport = createAutoTransport({
 *   wsUrl: 'wss://relay.example.com/ws'
 * });
 * ```
 *
 * @example Node.js with Unix socket
 * ```typescript
 * const transport = createAutoTransport({
 *   socketPath: '/tmp/agent-relay.sock'
 * });
 * ```
 *
 * @example Node.js with WebSocket
 * ```typescript
 * const transport = createAutoTransport({
 *   wsHost: 'localhost',
 *   wsPort: 3888
 * });
 * ```
 */
export function createAutoTransport(options: AutoTransportOptions): Transport {
  const env = detectEnvironment();
  const { forceTransport, ...config } = options;

  // Forced transport type
  if (forceTransport === 'websocket') {
    return createWsTransportFromOptions(options);
  }
  if (forceTransport === 'socket') {
    if (!options.socketPath) {
      throw new Error('socketPath is required when forcing socket transport');
    }
    if (!env.hasUnixSockets) {
      throw new Error('Unix sockets are not available in this environment');
    }
    return new SocketTransport({
      socketPath: options.socketPath,
      connectTimeout: config.connectTimeout,
    });
  }

  // Auto-detect: Browser always uses WebSocket
  if (env.isBrowser) {
    return createWsTransportFromOptions(options);
  }

  // Node.js: prefer Unix socket if path is provided
  if (env.isNode && options.socketPath) {
    return new SocketTransport({
      socketPath: options.socketPath,
      connectTimeout: config.connectTimeout,
    });
  }

  // Fall back to WebSocket
  return createWsTransportFromOptions(options);
}

/**
 * Create WebSocket transport from options.
 */
function createWsTransportFromOptions(options: AutoTransportOptions): WebSocketTransport {
  let url = options.wsUrl;

  if (!url) {
    // Construct URL from components
    const host = options.wsHost ?? 'localhost';
    const port = options.wsPort ?? 3888;
    const path = options.wsPath ?? '/ws';
    const secure = options.wsSecure ?? false;
    url = socketPathToWsUrl(host, port, path, secure);
  }

  return new WebSocketTransport({
    url,
    connectTimeout: options.connectTimeout,
  });
}

/**
 * Check if running in a browser environment.
 */
export function isBrowser(): boolean {
  return detectEnvironment().isBrowser;
}

/**
 * Check if running in Node.js environment.
 */
export function isNode(): boolean {
  return detectEnvironment().isNode;
}
