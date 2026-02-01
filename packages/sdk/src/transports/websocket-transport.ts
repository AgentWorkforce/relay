/**
 * WebSocket Transport for browser and Node.js environments.
 * @agent-relay/sdk
 *
 * Uses native WebSocket in browsers and 'ws' package in Node.js.
 * The transport expects the daemon to have a WebSocket endpoint (e.g., /ws).
 */

import type { Transport, TransportConfig, TransportEvents, TransportState } from './types.js';

export interface WebSocketTransportConfig extends TransportConfig {
  /** WebSocket URL (e.g., ws://localhost:3888/ws) */
  url: string;
  /** Protocols to use in WebSocket handshake */
  protocols?: string | string[];
}

// Simple close event type (works in both browser and Node.js)
interface CloseEventLike {
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

// Simple message event type (works in both browser and Node.js)
interface MessageEventLike {
  data: ArrayBuffer | string | Buffer;
}

// Type for WebSocket (works in both browser and Node.js with 'ws')
interface WebSocketLike {
  readyState: number;
  CONNECTING: number;
  OPEN: number;
  CLOSING: number;
  CLOSED: number;
  send(data: ArrayBuffer | Uint8Array | string): void;
  close(): void;
  onopen: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEventLike) => void) | null;
  onerror: ((ev: Event | Error) => void) | null;
  onmessage: ((ev: MessageEventLike) => void) | null;
  binaryType: string;
}

// Constructor type for WebSocket
type WebSocketConstructor = new (url: string, protocols?: string | string[]) => WebSocketLike;

/**
 * WebSocket-based transport for browser and Node.js.
 *
 * In browsers, uses native WebSocket.
 * In Node.js, requires 'ws' package (optional dependency).
 */
export class WebSocketTransport implements Transport {
  private ws?: WebSocketLike;
  private config: WebSocketTransportConfig;
  private events: TransportEvents = {};
  private _state: TransportState = 'disconnected';
  private WebSocketImpl?: WebSocketConstructor;

  constructor(config: WebSocketTransportConfig) {
    this.config = {
      connectTimeout: 5000,
      ...config,
    };
  }

  get state(): TransportState {
    return this._state;
  }

  setEvents(events: TransportEvents): void {
    this.events = events;
  }

  /**
   * Get WebSocket implementation (native or 'ws' package).
   */
  private async getWebSocketImpl(): Promise<WebSocketConstructor> {
    if (this.WebSocketImpl) {
      return this.WebSocketImpl;
    }

    // Check for browser environment
    if (typeof globalThis !== 'undefined' && 'WebSocket' in globalThis) {
      this.WebSocketImpl = (globalThis as { WebSocket: WebSocketConstructor }).WebSocket;
      return this.WebSocketImpl;
    }

    // Node.js environment - try to load 'ws' package
    try {
      // Dynamic import of 'ws' for Node.js
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wsModule = await import('ws' as any) as any;
      const impl = wsModule.default || wsModule.WebSocket || wsModule;
      if (!impl) {
        throw new Error('ws module loaded but WebSocket constructor not found');
      }
      this.WebSocketImpl = impl as WebSocketConstructor;
      return this.WebSocketImpl;
    } catch {
      throw new Error(
        'WebSocket not available. In Node.js, install the "ws" package:\n' +
        '  npm install ws\n\n' +
        'In browsers, native WebSocket should be available.'
      );
    }
  }

  async connect(): Promise<void> {
    if (this._state !== 'disconnected') {
      return;
    }

    const WebSocketImpl = await this.getWebSocketImpl();

    return new Promise((resolve, reject) => {
      this._state = 'connecting';

      const timeout = setTimeout(() => {
        if (this._state === 'connecting') {
          this.ws?.close();
          this._state = 'disconnected';
          reject(new Error('Connection timeout'));
        }
      }, this.config.connectTimeout);

      try {
        this.ws = new WebSocketImpl(this.config.url, this.config.protocols);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          clearTimeout(timeout);
          this._state = 'connected';
          this.events.onConnect?.();
          resolve();
        };

        this.ws.onmessage = (event: MessageEventLike) => {
          // Handle binary data
          if (event.data instanceof ArrayBuffer) {
            this.events.onData?.(new Uint8Array(event.data));
          } else if (typeof event.data === 'string') {
            // Convert string to Uint8Array (shouldn't happen with binaryType = 'arraybuffer')
            const encoder = new TextEncoder();
            this.events.onData?.(encoder.encode(event.data));
          } else if (event.data && typeof (event.data as Buffer).buffer !== 'undefined') {
            // Handle Node.js Buffer
            const buf = event.data as Buffer;
            this.events.onData?.(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
          }
        };

        this.ws.onclose = () => {
          clearTimeout(timeout);
          this._state = 'disconnected';
          this.events.onClose?.();
        };

        this.ws.onerror = (event: Event | Error) => {
          clearTimeout(timeout);
          const error = event instanceof Error
            ? event
            : new Error('WebSocket error');
          if (this._state === 'connecting') {
            this._state = 'disconnected';
            reject(error);
          }
          this.events.onError?.(error);
        };
      } catch (err) {
        clearTimeout(timeout);
        this._state = 'disconnected';
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  disconnect(): void {
    if (!this.ws || this._state === 'disconnected') {
      return;
    }

    this._state = 'closing';
    this.ws.close();
    this.ws = undefined;
    this._state = 'disconnected';
  }

  send(data: Uint8Array | Buffer): boolean {
    if (!this.ws || this._state !== 'connected') {
      return false;
    }

    try {
      // WebSocket send accepts ArrayBuffer or Uint8Array
      // Convert Buffer to Uint8Array for browser compatibility
      let bytes: Uint8Array;
      if (data instanceof Uint8Array) {
        bytes = data;
      } else {
        // Handle Buffer (Node.js)
        const buf = data as Buffer;
        bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      }
      this.ws.send(bytes);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Create a WebSocket transport.
 *
 * @param url - WebSocket URL (e.g., ws://localhost:3888/ws)
 * @param config - Additional configuration options
 */
export function createWebSocketTransport(
  url: string,
  config?: Omit<WebSocketTransportConfig, 'url'>
): WebSocketTransport {
  return new WebSocketTransport({ url, ...config });
}

/**
 * Convert a socket path to WebSocket URL.
 * Useful when daemon provides both Unix socket and WebSocket endpoints.
 *
 * @param host - Host address (default: localhost)
 * @param port - Port number (default: 3888)
 * @param path - WebSocket path (default: /ws)
 * @param secure - Use wss:// instead of ws:// (default: false)
 */
export function socketPathToWsUrl(
  host = 'localhost',
  port = 3888,
  path = '/ws',
  secure = false
): string {
  const protocol = secure ? 'wss' : 'ws';
  return `${protocol}://${host}:${port}${path}`;
}
