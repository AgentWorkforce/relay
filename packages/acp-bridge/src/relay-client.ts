/**
 * Relay Daemon Client for ACP Bridge
 *
 * Connects to the relay daemon and handles message routing.
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { RelayMessage, BridgeEvent, BridgeEventListener } from './types.js';

// Inline protocol types to avoid circular dependency issues
const PROTOCOL_VERSION = 1;

interface Envelope<T = unknown> {
  v: number;
  type: string;
  id: string;
  ts: number;
  from?: string;
  to?: string | '*';
  payload: T;
}

interface HelloPayload {
  agent: string;
  capabilities: {
    ack: boolean;
    resume: boolean;
    max_inflight: number;
    supports_topics: boolean;
  };
  cli?: string;
  program?: string;
}

interface WelcomePayload {
  session_id: string;
  server: {
    max_frame_bytes: number;
    heartbeat_ms: number;
  };
}

interface SendPayload {
  kind: string;
  body: string;
  thread?: string;
}

interface DeliverEnvelope extends Envelope<SendPayload> {
  delivery: {
    seq: number;
    session_id: string;
  };
}

interface AckPayload {
  ack_id: string;
  seq: number;
}

/**
 * Frame parser for length-prefixed JSON messages
 */
class FrameParser {
  private buffer = Buffer.alloc(0);
  private readonly onFrame: (data: Envelope) => void;

  constructor(onFrame: (data: Envelope) => void) {
    this.onFrame = onFrame;
  }

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.tryParse();
  }

  private tryParse(): void {
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + length) {
        break; // Wait for more data
      }

      const jsonStr = this.buffer.subarray(4, 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(4 + length);

      try {
        const envelope = JSON.parse(jsonStr) as Envelope;
        this.onFrame(envelope);
      } catch {
        // Skip malformed frames
      }
    }
  }
}

/**
 * Encodes an envelope as a length-prefixed frame
 */
function encodeFrame(envelope: Envelope): Buffer {
  const json = JSON.stringify(envelope);
  const jsonBuf = Buffer.from(json, 'utf8');
  const frame = Buffer.alloc(4 + jsonBuf.length);
  frame.writeUInt32BE(jsonBuf.length, 0);
  jsonBuf.copy(frame, 4);
  return frame;
}

export interface RelayClientConfig {
  /** Agent name for identification */
  agentName: string;
  /** Socket path to connect to */
  socketPath: string;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Client for connecting to the relay daemon
 */
export class RelayClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private parser: FrameParser | null = null;
  private sessionId: string | null = null;
  private connected = false;
  private readonly config: RelayClientConfig;
  private messageHandlers = new Map<string, (envelope: Envelope) => void>();
  private pendingAcks = new Map<string, { resolve: (ack: AckPayload) => void; reject: (err: Error) => void }>();

  constructor(config: RelayClientConfig) {
    super();
    this.config = config;
  }

  /**
   * Connect to the relay daemon
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.config.socketPath);

      this.parser = new FrameParser((envelope) => this.handleEnvelope(envelope));

      this.socket.on('connect', () => {
        this.debug('Connected to relay daemon');
        this.sendHello();
      });

      this.socket.on('data', (chunk) => {
        this.parser?.push(chunk);
      });

      this.socket.on('error', (err) => {
        this.debug('Socket error:', err.message);
        if (!this.connected) {
          reject(err);
        }
        this.emit('event', { type: 'error', error: err } as BridgeEvent);
      });

      this.socket.on('close', () => {
        this.debug('Socket closed');
        this.connected = false;
        this.emit('event', { type: 'disconnected' } as BridgeEvent);
      });

      // Wait for WELCOME message to resolve
      const welcomeHandler = (envelope: Envelope) => {
        if (envelope.type === 'WELCOME') {
          this.connected = true;
          this.sessionId = (envelope.payload as WelcomePayload).session_id;
          this.removeListener('_welcome', welcomeHandler);
          this.emit('event', { type: 'connected' } as BridgeEvent);
          resolve();
        } else if (envelope.type === 'ERROR') {
          this.removeListener('_welcome', welcomeHandler);
          reject(new Error((envelope.payload as { message: string }).message));
        }
      };
      this.on('_welcome', welcomeHandler);

      // Timeout for connection
      setTimeout(() => {
        if (!this.connected) {
          this.removeListener('_welcome', welcomeHandler);
          reject(new Error('Connection timeout'));
        }
      }, 5000);
    });
  }

  /**
   * Disconnect from the relay daemon
   */
  disconnect(): void {
    if (this.socket) {
      this.sendEnvelope({
        v: PROTOCOL_VERSION,
        type: 'BYE',
        id: randomUUID(),
        ts: Date.now(),
        payload: {},
      });
      this.socket.end();
      this.socket = null;
    }
  }

  /**
   * Send a message to another agent
   */
  async send(to: string, body: string, options?: { thread?: string; awaitAck?: boolean }): Promise<string> {
    const id = randomUUID();
    const envelope: Envelope<SendPayload> = {
      v: PROTOCOL_VERSION,
      type: 'SEND',
      id,
      ts: Date.now(),
      from: this.config.agentName,
      to,
      payload: {
        kind: 'message',
        body,
        thread: options?.thread,
      },
    };

    this.sendEnvelope(envelope);

    if (options?.awaitAck) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingAcks.delete(id);
          reject(new Error('ACK timeout'));
        }, 30000);

        this.pendingAcks.set(id, {
          resolve: () => {
            clearTimeout(timeout);
            resolve(id);
          },
          reject: (err) => {
            clearTimeout(timeout);
            reject(err);
          },
        });
      });
    }

    return id;
  }

  /**
   * Broadcast a message to all agents
   */
  async broadcast(body: string, options?: { thread?: string }): Promise<string> {
    return this.send('*', body, options);
  }

  /**
   * Register a handler for incoming messages
   */
  onMessage(handler: (message: RelayMessage) => void): () => void {
    const wrappedHandler = (envelope: Envelope) => {
      if (envelope.type === 'DELIVER') {
        const deliver = envelope as DeliverEnvelope;
        handler({
          id: deliver.id,
          from: deliver.from || 'unknown',
          body: deliver.payload.body,
          thread: deliver.payload.thread,
          timestamp: deliver.ts,
        });
      }
    };

    this.messageHandlers.set(handler.toString(), wrappedHandler);
    this.on('message', wrappedHandler);

    return () => {
      this.messageHandlers.delete(handler.toString());
      this.off('message', wrappedHandler);
    };
  }

  /**
   * Add event listener
   */
  onEvent(listener: BridgeEventListener): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  private sendHello(): void {
    const hello: Envelope<HelloPayload> = {
      v: PROTOCOL_VERSION,
      type: 'HELLO',
      id: randomUUID(),
      ts: Date.now(),
      payload: {
        agent: this.config.agentName,
        capabilities: {
          ack: true,
          resume: false,
          max_inflight: 10,
          supports_topics: true,
        },
        cli: 'acp-bridge',
        program: '@agent-relay/acp-bridge',
      },
    };

    this.sendEnvelope(hello);
  }

  private sendEnvelope(envelope: Envelope): void {
    if (this.socket && !this.socket.destroyed) {
      const frame = encodeFrame(envelope);
      this.socket.write(frame);
      this.debug('Sent:', envelope.type, envelope.id);
    }
  }

  private handleEnvelope(envelope: Envelope): void {
    this.debug('Received:', envelope.type, envelope.id);

    switch (envelope.type) {
      case 'WELCOME':
        this.emit('_welcome', envelope);
        break;

      case 'DELIVER':
        this.emit('message', envelope);
        break;

      case 'ACK': {
        const ack = envelope.payload as AckPayload;
        const pending = this.pendingAcks.get(ack.ack_id);
        if (pending) {
          this.pendingAcks.delete(ack.ack_id);
          pending.resolve(ack);
        }
        break;
      }

      case 'NACK': {
        const nack = envelope.payload as { ack_id: string; message?: string };
        const pending = this.pendingAcks.get(nack.ack_id);
        if (pending) {
          this.pendingAcks.delete(nack.ack_id);
          pending.reject(new Error(nack.message || 'Message rejected'));
        }
        break;
      }

      case 'PING':
        this.sendEnvelope({
          v: PROTOCOL_VERSION,
          type: 'PONG',
          id: randomUUID(),
          ts: Date.now(),
          payload: { nonce: (envelope.payload as { nonce: string }).nonce },
        });
        break;

      case 'ERROR':
        this.emit('event', {
          type: 'error',
          error: new Error((envelope.payload as { message: string }).message),
        } as BridgeEvent);
        break;
    }
  }

  private debug(...args: unknown[]): void {
    if (this.config.debug) {
      console.error('[RelayClient]', ...args);
    }
  }
}
