/**
 * Unix/TCP Socket Transport for Node.js environments.
 * @agent-relay/sdk
 */

import net from 'node:net';
import type { Transport, TransportConfig, TransportEvents, TransportState } from './types.js';

export interface SocketTransportConfig extends TransportConfig {
  /** Unix socket path or TCP host:port */
  socketPath: string;
}

/**
 * Socket-based transport for Unix sockets and TCP connections.
 * This is the default transport for Node.js environments.
 */
export class SocketTransport implements Transport {
  private socket?: net.Socket;
  private config: SocketTransportConfig;
  private events: TransportEvents = {};
  private _state: TransportState = 'disconnected';

  constructor(config: SocketTransportConfig) {
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

  connect(): Promise<void> {
    if (this._state !== 'disconnected') {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      this._state = 'connecting';

      const timeout = setTimeout(() => {
        if (this._state === 'connecting') {
          this.socket?.destroy();
          this._state = 'disconnected';
          reject(new Error('Connection timeout'));
        }
      }, this.config.connectTimeout);

      this.socket = net.createConnection(this.config.socketPath, () => {
        clearTimeout(timeout);
        this._state = 'connected';
        this.events.onConnect?.();
        resolve();
      });

      this.socket.on('data', (data) => {
        // Convert Buffer to Uint8Array for consistent interface
        this.events.onData?.(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      });

      this.socket.on('close', () => {
        this._state = 'disconnected';
        this.events.onClose?.();
      });

      this.socket.on('error', (err) => {
        clearTimeout(timeout);
        if (this._state === 'connecting') {
          this._state = 'disconnected';
          reject(err);
        }
        this.events.onError?.(err);
      });
    });
  }

  disconnect(): void {
    if (!this.socket || this._state === 'disconnected') {
      return;
    }

    this._state = 'closing';
    this.socket.end();
    this.socket = undefined;
    this._state = 'disconnected';
  }

  send(data: Uint8Array | Buffer): boolean {
    if (!this.socket || this._state !== 'connected') {
      return false;
    }

    try {
      // Ensure we're sending a Buffer
      const buffer = data instanceof Buffer ? data : Buffer.from(data);
      this.socket.write(buffer);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Create a socket transport for Unix/TCP connections.
 */
export function createSocketTransport(socketPath: string, config?: TransportConfig): SocketTransport {
  return new SocketTransport({ socketPath, ...config });
}
