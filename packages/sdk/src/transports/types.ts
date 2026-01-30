/**
 * Transport abstraction for relay client communication.
 * @agent-relay/sdk
 *
 * Defines the interface for different transport implementations:
 * - SocketTransport: Unix/TCP sockets (Node.js)
 * - WebSocketTransport: WebSocket connections (Node.js and Browser)
 */

/**
 * Transport connection state.
 */
export type TransportState = 'disconnected' | 'connecting' | 'connected' | 'closing';

/**
 * Transport event handlers.
 */
export interface TransportEvents {
  /** Called when transport connects successfully */
  onConnect?: () => void;
  /** Called when transport receives data */
  onData?: (data: Uint8Array) => void;
  /** Called when transport disconnects */
  onClose?: () => void;
  /** Called when transport encounters an error */
  onError?: (error: Error) => void;
}

/**
 * Transport configuration options.
 */
export interface TransportConfig {
  /** Connection timeout in milliseconds */
  connectTimeout?: number;
}

/**
 * Transport interface for relay client communication.
 *
 * Implementations must handle:
 * - Connection lifecycle (connect, disconnect)
 * - Binary data transmission
 * - Event callbacks for state changes
 */
export interface Transport {
  /** Current connection state */
  readonly state: TransportState;

  /**
   * Connect to the relay endpoint.
   * @throws Error if connection fails
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the relay.
   */
  disconnect(): void;

  /**
   * Send binary data to the relay.
   * @param data - Data to send (Buffer or Uint8Array)
   * @returns true if data was queued for sending
   */
  send(data: Uint8Array | Buffer): boolean;

  /**
   * Set event handlers.
   * @param events - Event handler callbacks
   */
  setEvents(events: TransportEvents): void;
}

/**
 * Transport factory function type.
 */
export type TransportFactory = (config?: TransportConfig) => Transport;
