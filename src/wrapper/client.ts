/**
 * Relay Client
 * Connects to the daemon and handles message sending/receiving.
 */

import net from 'node:net';
import { v4 as uuid } from 'uuid';
import {
  type Envelope,
  type HelloPayload,
  type WelcomePayload,
  type SendPayload,
  type SendMeta,
  type SendEnvelope,
  type DeliverEnvelope,
  type ErrorPayload,
  type PayloadKind,
  type SpeakOnTrigger,
  type LogPayload,
  PROTOCOL_VERSION,
} from '../protocol/types.js';
import { encodeFrame, FrameParser } from '../protocol/framing.js';
import { DEFAULT_SOCKET_PATH } from '../daemon/server.js';

export type ClientState = 'DISCONNECTED' | 'CONNECTING' | 'HANDSHAKING' | 'READY' | 'BACKOFF';

export interface ClientConfig {
  socketPath: string;
  agentName: string;
  /** Optional CLI identifier to surface to the dashboard */
  cli?: string;
  /** Optional program identifier (e.g., 'claude', 'gpt-4o') */
  program?: string;
  /** Optional model identifier (e.g., 'claude-3-opus-2024-xx') */
  model?: string;
  /** Optional task description for registry/dashboard */
  task?: string;
  /** Optional working directory to surface in registry/dashboard */
  workingDirectory?: string;
  /** Suppress client-side console logging */
  quiet?: boolean;
  reconnect: boolean;
  maxReconnectAttempts: number;
  reconnectDelayMs: number;
  reconnectMaxDelayMs: number;
}

const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  socketPath: DEFAULT_SOCKET_PATH,
  agentName: 'agent',
  cli: undefined,
  quiet: false,
  reconnect: true,
  maxReconnectAttempts: 10,
  reconnectDelayMs: 100,
  reconnectMaxDelayMs: 30000,
};

export class RelayClient {
  private config: ClientConfig;
  private socket?: net.Socket;
  private parser: FrameParser;

  private _state: ClientState = 'DISCONNECTED';
  private sessionId?: string;
  private resumeToken?: string;
  private reconnectAttempts = 0;
  private reconnectDelay: number;
  private reconnectTimer?: NodeJS.Timeout;
  private _destroyed = false;
  private deliveredIds: Set<string> = new Set();
  private deliveredOrder: string[] = [];
  private readonly deliveredCacheLimit = 2000;

  // Event handlers
  /**
   * Handler for incoming messages.
   * @param from - The sender agent name
   * @param payload - The message payload
   * @param messageId - Unique message ID
   * @param meta - Optional message metadata
   * @param originalTo - Original 'to' field from sender (e.g., '*' for broadcasts)
   */
  onMessage?: (from: string, payload: SendPayload, messageId: string, meta?: SendMeta, originalTo?: string) => void;
  onStateChange?: (state: ClientState) => void;
  onError?: (error: Error) => void;

  constructor(config: Partial<ClientConfig> = {}) {
    this.config = { ...DEFAULT_CLIENT_CONFIG, ...config };
    this.parser = new FrameParser();
    this.reconnectDelay = this.config.reconnectDelayMs;
  }

  get state(): ClientState {
    return this._state;
  }

  get agentName(): string {
    return this.config.agentName;
  }

  /** Get the session ID assigned by the server */
  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Connect to the relay daemon.
   */
  connect(): Promise<void> {
    if (this._state !== 'DISCONNECTED' && this._state !== 'BACKOFF') {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const settleResolve = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const settleReject = (err: Error): void => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      this.setState('CONNECTING');

      this.socket = net.createConnection(this.config.socketPath, () => {
        this.setState('HANDSHAKING');
        this.sendHello();
      });

      this.socket.on('data', (data) => this.handleData(data));

      this.socket.on('close', () => {
        this.handleDisconnect();
      });

      this.socket.on('error', (err) => {
        if (this._state === 'CONNECTING') {
          settleReject(err);
        }
        this.handleError(err);
      });

      // Wait for WELCOME
      const checkReady = setInterval(() => {
        if (this._state === 'READY') {
          clearInterval(checkReady);
          clearTimeout(timeout);
          settleResolve();
        }
      }, 10);

      // Timeout
      const timeout = setTimeout(() => {
        if (this._state !== 'READY') {
          clearInterval(checkReady);
          this.socket?.destroy();
          settleReject(new Error('Connection timeout'));
        }
      }, 5000);
    });
  }

  /**
   * Disconnect from the relay daemon.
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.socket) {
      this.send({
        v: PROTOCOL_VERSION,
        type: 'BYE',
        id: uuid(),
        ts: Date.now(),
        payload: {},
      });
      this.socket.end();
      this.socket = undefined;
    }

    this.setState('DISCONNECTED');
  }

  /**
   * Permanently destroy the client. Disconnects and prevents any reconnection.
   */
  destroy(): void {
    this._destroyed = true;
    this.disconnect();
  }

  /**
   * Send a message to another agent.
   * @param to - Target agent name or '*' for broadcast
   * @param body - Message body
   * @param kind - Message type (default: 'message')
   * @param data - Optional structured data
   * @param thread - Optional thread ID for grouping related messages
   * @param meta - Optional message metadata (importance, replyTo, etc.)
   */
  sendMessage(to: string, body: string, kind: PayloadKind = 'message', data?: Record<string, unknown>, thread?: string, meta?: SendMeta): boolean {
    if (this._state !== 'READY') {
      return false;
    }

    const envelope: SendEnvelope = {
      v: PROTOCOL_VERSION,
      type: 'SEND',
      id: uuid(),
      ts: Date.now(),
      to,
      payload: {
        kind,
        body,
        data,
        thread,
      },
      payload_meta: meta,
    };

    return this.send(envelope);
  }

  /**
   * Broadcast a message to all agents.
   */
  broadcast(body: string, kind: PayloadKind = 'message', data?: Record<string, unknown>): boolean {
    return this.sendMessage('*', body, kind, data);
  }

  /**
   * Subscribe to a topic.
   */
  subscribe(topic: string): boolean {
    if (this._state !== 'READY') return false;

    return this.send({
      v: PROTOCOL_VERSION,
      type: 'SUBSCRIBE',
      id: uuid(),
      ts: Date.now(),
      topic,
      payload: {},
    });
  }

  /**
   * Unsubscribe from a topic.
   */
  unsubscribe(topic: string): boolean {
    if (this._state !== 'READY') return false;

    return this.send({
      v: PROTOCOL_VERSION,
      type: 'UNSUBSCRIBE',
      id: uuid(),
      ts: Date.now(),
      topic,
      payload: {},
    });
  }

  /**
   * Bind this agent as a shadow to a primary agent.
   * As a shadow, this agent will receive copies of messages to/from the primary.
   * @param primaryAgent - The agent to shadow
   * @param options - Shadow configuration options
   */
  bindAsShadow(
    primaryAgent: string,
    options: {
      /** When this shadow should speak (default: ['EXPLICIT_ASK']) */
      speakOn?: SpeakOnTrigger[];
      /** Receive copies of messages TO the primary (default: true) */
      receiveIncoming?: boolean;
      /** Receive copies of messages FROM the primary (default: true) */
      receiveOutgoing?: boolean;
    } = {}
  ): boolean {
    if (this._state !== 'READY') return false;

    return this.send({
      v: PROTOCOL_VERSION,
      type: 'SHADOW_BIND',
      id: uuid(),
      ts: Date.now(),
      payload: {
        primaryAgent,
        speakOn: options.speakOn,
        receiveIncoming: options.receiveIncoming,
        receiveOutgoing: options.receiveOutgoing,
      },
    });
  }

  /**
   * Unbind this agent from a primary agent (stop shadowing).
   * @param primaryAgent - The agent to stop shadowing
   */
  unbindAsShadow(primaryAgent: string): boolean {
    if (this._state !== 'READY') return false;

    return this.send({
      v: PROTOCOL_VERSION,
      type: 'SHADOW_UNBIND',
      id: uuid(),
      ts: Date.now(),
      payload: {
        primaryAgent,
      },
    });
  }


  /**
   * Send log/output data to the daemon for dashboard streaming.
   * Used by daemon-connected agents (not spawned workers) to stream their output.
   * @param data - The log/output data to send
   * @returns true if sent successfully, false otherwise
   */
  sendLog(data: string): boolean {
    if (this._state !== 'READY') {
      return false;
    }

    const envelope: Envelope<LogPayload> = {
      v: PROTOCOL_VERSION,
      type: 'LOG',
      id: uuid(),
      ts: Date.now(),
      payload: {
        data,
        timestamp: Date.now(),
      },
    };

    return this.send(envelope);
  }
  private setState(state: ClientState): void {
    this._state = state;
    if (this.onStateChange) {
      this.onStateChange(state);
    }
  }

  private sendHello(): void {
    const hello: Envelope<HelloPayload> = {
      v: PROTOCOL_VERSION,
      type: 'HELLO',
      id: uuid(),
      ts: Date.now(),
      payload: {
        agent: this.config.agentName,
        cli: this.config.cli,
        program: this.config.program,
        model: this.config.model,
        task: this.config.task,
        workingDirectory: this.config.workingDirectory,
        capabilities: {
          ack: true,
          resume: true,
          max_inflight: 256,
          supports_topics: true,
        },
        session: this.resumeToken ? { resume_token: this.resumeToken } : undefined,
      },
    };

    this.send(hello);
  }

  private send(envelope: Envelope): boolean {
    if (!this.socket) return false;

    try {
      const frame = encodeFrame(envelope);
      this.socket.write(frame);
      return true;
    } catch (err) {
      this.handleError(err as Error);
      return false;
    }
  }

  private handleData(data: Buffer): void {
    try {
      const frames = this.parser.push(data);
      for (const frame of frames) {
        this.processFrame(frame);
      }
    } catch (err) {
      this.handleError(err as Error);
    }
  }

  private processFrame(envelope: Envelope): void {
    switch (envelope.type) {
      case 'WELCOME':
        this.handleWelcome(envelope as Envelope<WelcomePayload>);
        break;

      case 'DELIVER':
        this.handleDeliver(envelope as DeliverEnvelope);
        break;

      case 'PING':
        this.handlePing(envelope);
        break;

      case 'ERROR':
        this.handleErrorFrame(envelope as Envelope<ErrorPayload>);
        break;

      case 'BUSY':
        console.warn('[client] Server busy, backing off');
        break;
    }
  }

  private handleWelcome(envelope: Envelope<WelcomePayload>): void {
    this.sessionId = envelope.payload.session_id;
    this.resumeToken = envelope.payload.resume_token;
    this.reconnectAttempts = 0;
    this.reconnectDelay = this.config.reconnectDelayMs;
    this.setState('READY');
    if (!this.config.quiet) {
      console.log(`[client] Connected as ${this.config.agentName} (session: ${this.sessionId})`);
    }
  }

  private handleDeliver(envelope: DeliverEnvelope): void {
    // Send ACK
    this.send({
      v: PROTOCOL_VERSION,
      type: 'ACK',
      id: uuid(),
      ts: Date.now(),
      payload: {
        ack_id: envelope.id,
        seq: envelope.delivery.seq,
      },
    });

    const duplicate = this.markDelivered(envelope.id);
    if (duplicate) {
      return;
    }

    // Notify handler
    // Pass originalTo from delivery info so handlers know if this was a broadcast
    if (this.onMessage && envelope.from) {
      this.onMessage(envelope.from, envelope.payload, envelope.id, envelope.payload_meta, envelope.delivery.originalTo);
    }
  }

  private handlePing(envelope: Envelope): void {
    this.send({
      v: PROTOCOL_VERSION,
      type: 'PONG',
      id: uuid(),
      ts: Date.now(),
      payload: (envelope.payload as { nonce?: string }) ?? {},
    });
  }

  private handleErrorFrame(envelope: Envelope<ErrorPayload>): void {
    console.error('[client] Server error:', envelope.payload);

    if (envelope.payload.code === 'RESUME_TOO_OLD') {
      if (this.resumeToken) {
        console.warn('[client] Resume token rejected, clearing and requesting new session');
      }
      // Clear resume token so next HELLO starts a fresh session instead of looping on an invalid token
      this.resumeToken = undefined;
      this.sessionId = undefined;
    }
  }

  private handleDisconnect(): void {
    this.parser.reset();
    this.socket = undefined;

    // Don't reconnect if permanently destroyed
    if (this._destroyed) {
      this.setState('DISCONNECTED');
      return;
    }

    if (this.config.reconnect && this.reconnectAttempts < this.config.maxReconnectAttempts) {
      this.scheduleReconnect();
    } else {
      this.setState('DISCONNECTED');
      if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
        console.error(
          `[client] Max reconnect attempts reached (${this.config.maxReconnectAttempts}), giving up`
        );
      }
    }
  }

  private handleError(error: Error): void {
    console.error('[client] Error:', error.message);
    if (this.onError) {
      this.onError(error);
    }
  }

  private scheduleReconnect(): void {
    this.setState('BACKOFF');
    this.reconnectAttempts++;

    // Exponential backoff with jitter
    const jitter = Math.random() * 0.3 + 0.85; // 0.85 - 1.15
    const delay = Math.min(this.reconnectDelay * jitter, this.config.reconnectMaxDelayMs);
    this.reconnectDelay *= 2;

    if (!this.config.quiet) {
      console.log(`[client] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);
    }

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {
        // Will trigger another reconnect
      });
    }, delay);
  }

  /**
   * Track delivered message IDs to provide deterministic deduplication when messages are replayed.
   * @returns true if the message has already been seen.
   */
  private markDelivered(id: string): boolean {
    if (this.deliveredIds.has(id)) {
      return true;
    }

    this.deliveredIds.add(id);
    this.deliveredOrder.push(id);

    // Simple FIFO eviction to keep memory bounded
    if (this.deliveredOrder.length > this.deliveredCacheLimit) {
      const oldest = this.deliveredOrder.shift();
      if (oldest) {
        this.deliveredIds.delete(oldest);
      }
    }

    return false;
  }
}
