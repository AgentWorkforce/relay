/**
 * Connection state machine for agent connections.
 *
 * States:
 *   CONNECTING -> HANDSHAKING -> ACTIVE -> CLOSING -> CLOSED
 *                     |            |
 *                     v            v
 *                   ERROR -------> CLOSED
 */

import net from 'node:net';
import { generateId } from '../utils/id-generator.js';
import {
  type Envelope,
  type HelloPayload,
  type WelcomePayload,
  type SendPayload,
  type PongPayload,
  type ErrorPayload,
  type AckPayload,
  type EntityType,
  PROTOCOL_VERSION,
} from '../protocol/types.js';
import { encodeFrameLegacy as encodeFrame, FrameParser } from '../protocol/framing.js';
import { DEFAULT_CONNECTION_CONFIG } from '../config/relay-config.js';

export type ConnectionState = 'CONNECTING' | 'HANDSHAKING' | 'ACTIVE' | 'CLOSING' | 'CLOSED' | 'ERROR';

export interface ConnectionConfig {
  maxFrameBytes: number;
  heartbeatMs: number;
  /** Multiplier for heartbeat timeout (timeout = heartbeatMs * multiplier). Default: 6 (30s with 5s heartbeat) */
  heartbeatTimeoutMultiplier: number;
  /** Optional handler to validate resume tokens and provide session state */
  resumeHandler?: (params: { agent: string; resumeToken: string }) => Promise<{
    sessionId: string;
    resumeToken?: string;
    seedSequences?: Array<{ topic?: string; peer: string; seq: number }>;
  } | null>;
  /** Optional callback to check if agent is currently processing (exempts from heartbeat timeout) */
  isProcessing?: (agentName: string) => boolean;

  // Write queue configuration
  /** Maximum messages in write queue before dropping (default: 2000) */
  maxWriteQueueSize?: number;
  /** High water mark - emit backpressure signal when queue exceeds this (default: 1500) */
  writeQueueHighWaterMark?: number;
  /** Low water mark - release backpressure when queue drops below this (default: 500) */
  writeQueueLowWaterMark?: number;
}

export const DEFAULT_CONFIG: ConnectionConfig = {
  ...DEFAULT_CONNECTION_CONFIG,
};

export class Connection {
  readonly id: string;
  private socket: net.Socket;
  private parser: FrameParser;
  private config: ConnectionConfig;

  private _state: ConnectionState = 'CONNECTING';
  private _agentName?: string;
  private _entityType?: EntityType;
  private _cli?: string;
  private _program?: string;
  private _model?: string;
  private _task?: string;
  private _workingDirectory?: string;
  private _displayName?: string;
  private _avatarUrl?: string;
  private _sessionId: string;
  private _resumeToken: string;
  private _isResumed = false;

  private heartbeatTimer?: NodeJS.Timeout;
  private lastPongReceived?: number;

  // Sequence numbers per (topic, peer) stream
  private sequences: Map<string, number> = new Map();

  // Write queue for backpressure handling
  private writeQueue: Buffer[] = [];
  private draining = false;
  private _backpressured = false;
  private socketDrainHandler?: () => void;

  // Event handlers
  onMessage?: (envelope: Envelope) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
  onActive?: () => void; // Fires when connection transitions to ACTIVE state
  onAck?: (envelope: Envelope<AckPayload>) => void;
  onPong?: () => void; // Fires on successful heartbeat response
  /** Fires when write queue crosses high/low water marks */
  onBackpressure?: (backpressured: boolean) => void;

  constructor(socket: net.Socket, config: Partial<ConnectionConfig> = {}) {
    this.id = generateId();
    this.socket = socket;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.parser = new FrameParser(this.config.maxFrameBytes);
    this.parser.setLegacyMode(true); // Use 4-byte header for backwards compatibility
    this._sessionId = generateId();
    this._resumeToken = generateId();

    this.setupSocketHandlers();
    this._state = 'HANDSHAKING';
  }

  get state(): ConnectionState {
    return this._state;
  }

  get agentName(): string | undefined {
    return this._agentName;
  }

  get entityType(): EntityType | undefined {
    return this._entityType;
  }

  get cli(): string | undefined {
    return this._cli;
  }

  get program(): string | undefined {
    return this._program;
  }

  get model(): string | undefined {
    return this._model;
  }

  get task(): string | undefined {
    return this._task;
  }

  get workingDirectory(): string | undefined {
    return this._workingDirectory;
  }

  get displayName(): string | undefined {
    return this._displayName;
  }

  get avatarUrl(): string | undefined {
    return this._avatarUrl;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get resumeToken(): string {
    return this._resumeToken;
  }

  get isResumed(): boolean {
    return this._isResumed;
  }

  /** Whether this connection is currently backpressured (write queue above high water mark) */
  get backpressured(): boolean {
    return this._backpressured;
  }

  /** Current number of messages queued for writing */
  get writeQueueLength(): number {
    return this.writeQueue.length;
  }

  private setupSocketHandlers(): void {
    this.socket.on('data', (data) => this.handleData(data));
    this.socket.on('close', () => this.handleClose());
    this.socket.on('error', (err) => this.handleError(err));
  }

  private handleData(data: Buffer): void {
    try {
      const frames = this.parser.push(data);
      for (const frame of frames) {
        this.processFrame(frame).catch((err) => {
          this.sendError('BAD_REQUEST', `Frame error: ${err}`, true);
          this.close();
        });
      }
    } catch (err) {
      this.sendError('BAD_REQUEST', `Frame error: ${err}`, true);
      this.close();
    }
  }

  private async processFrame(envelope: Envelope): Promise<void> {
    switch (envelope.type) {
      case 'HELLO':
        await this.handleHello(envelope as Envelope<HelloPayload>);
        break;
      case 'SEND':
        this.handleSend(envelope as Envelope<SendPayload>);
        break;
      case 'ACK':
        if (this.onAck) {
          this.onAck(envelope as Envelope<AckPayload>);
        }
        break;
      case 'PONG':
        this.handlePong(envelope as Envelope<PongPayload>);
        break;
      case 'BYE':
        this.close();
        break;
      default:
        if (this.onMessage) {
          this.onMessage(envelope);
        }
    }
  }

  private async handleHello(envelope: Envelope<HelloPayload>): Promise<void> {
    if (this._state !== 'HANDSHAKING') {
      this.sendError('BAD_REQUEST', 'Unexpected HELLO', false);
      return;
    }

    this._agentName = envelope.payload.agent;
    this._entityType = envelope.payload.entityType;
    this._cli = envelope.payload.cli;
    this._program = envelope.payload.program;
    this._model = envelope.payload.model;
    this._task = envelope.payload.task;
    this._workingDirectory = envelope.payload.workingDirectory;
    this._displayName = envelope.payload.displayName;
    this._avatarUrl = envelope.payload.avatarUrl;

    // Check for session resume
    const resumeToken = envelope.payload.session?.resume_token;
    if (resumeToken) {
      if (this.config.resumeHandler) {
        try {
          const resumeState = await this.config.resumeHandler({
            agent: this._agentName,
            resumeToken,
          });

          if (resumeState) {
            this._sessionId = resumeState.sessionId;
            this._resumeToken = resumeState.resumeToken ?? resumeToken;
            this._isResumed = true;

            // Seed sequence counters so new deliveries continue from last known seq per stream
            for (const seed of resumeState.seedSequences ?? []) {
              this.seedSequence(seed.topic ?? 'default', seed.peer, seed.seq);
            }
          } else {
            this.sendError('RESUME_TOO_OLD', 'Resume token rejected; starting new session', false);
          }
        } catch (err: any) {
          this.sendError('RESUME_TOO_OLD', `Resume validation failed: ${err?.message ?? err}`, false);
        }
      } else {
        this.sendError('RESUME_TOO_OLD', 'Session resume not configured; starting new session', false);
      }
    }

    // Send WELCOME
    const welcome: Envelope<WelcomePayload> = {
      v: PROTOCOL_VERSION,
      type: 'WELCOME',
      id: generateId(),
      ts: Date.now(),
      payload: {
        session_id: this._sessionId,
        resume_token: this._resumeToken,
        server: {
          max_frame_bytes: this.config.maxFrameBytes,
          heartbeat_ms: this.config.heartbeatMs,
        },
      },
    };

    this.send(welcome);
    this._state = 'ACTIVE';
    this.lastPongReceived = Date.now();
    this.startHeartbeat();

    // Notify that connection is now active (for registration)
    if (this.onActive) {
      this.onActive();
    }
  }

  private handleSend(envelope: Envelope<SendPayload>): void {
    if (this._state !== 'ACTIVE') {
      this.sendError('BAD_REQUEST', 'Not in ACTIVE state', false);
      return;
    }

    // Forward to router via callback
    if (this.onMessage) {
      this.onMessage(envelope);
    }
  }

  private handlePong(_envelope: Envelope<PongPayload>): void {
    // Note: envelope.payload.nonce could be used for RTT calculation in the future
    this.lastPongReceived = Date.now();
    if (this.onPong) {
      this.onPong();
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this._state !== 'ACTIVE') return;

      const now = Date.now();

      // Check for missed pong - use configurable timeout multiplier
      const timeoutMs = this.config.heartbeatMs * this.config.heartbeatTimeoutMultiplier;
      if (this.lastPongReceived && now - this.lastPongReceived > timeoutMs) {
        // Exempt agents that are actively processing (long tool calls, thinking, etc.)
        if (this._agentName && this.config.isProcessing?.(this._agentName)) {
          // Agent is processing - reset the pong timer to avoid timeout
          // but don't kill the connection
          console.log(`[connection] Heartbeat timeout exemption for ${this._agentName} (processing)`);
        } else {
          this.handleError(new Error(`Heartbeat timeout (no pong in ${timeoutMs}ms)`));
          return;
        }
      }

      // Send ping
      const nonce = generateId();
      this.send({
        v: PROTOCOL_VERSION,
        type: 'PING',
        id: generateId(),
        ts: now,
        payload: { nonce },
      });
    }, this.config.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /**
   * Seed a sequence counter for a stream so that the next value continues from the provided seq.
   */
  seedSequence(topic: string | undefined, peer: string, seq: number): void {
    const key = `${topic ?? 'default'}:${peer}`;
    const current = this.sequences.get(key) ?? 0;
    if (seq > current) {
      this.sequences.set(key, seq);
    }
  }

  /**
   * Get next sequence number for a stream.
   */
  getNextSeq(topic: string, peer: string): number {
    const key = `${topic}:${peer}`;
    const seq = (this.sequences.get(key) ?? 0) + 1;
    this.sequences.set(key, seq);
    return seq;
  }

  /**
   * Send an envelope to this connection.
   *
   * Uses a write queue to prevent blocking on slow consumers.
   * Returns false if the connection is closed or the queue is full.
   */
  send(envelope: Envelope): boolean {
    if (this._state === 'CLOSED' || this._state === 'ERROR') {
      return false;
    }

    const maxQueueSize = this.config.maxWriteQueueSize ?? 2000;
    const highWaterMark = this.config.writeQueueHighWaterMark ?? 1500;

    // Check queue capacity
    if (this.writeQueue.length >= maxQueueSize) {
      // Queue full - this is a serious condition, log it
      console.warn(`[connection] Write queue full for ${this._agentName ?? this.id}, dropping message`);
      return false;
    }

    try {
      const frame = encodeFrame(envelope);
      this.writeQueue.push(frame);

      // Check if we should signal backpressure
      if (!this._backpressured && this.writeQueue.length >= highWaterMark) {
        this._backpressured = true;
        this.onBackpressure?.(true);
      }

      // Schedule drain if not already draining
      this.scheduleDrain();
      return true;
    } catch (err) {
      this.handleError(err as Error);
      return false;
    }
  }

  /**
   * Schedule the drain loop to run on next tick if not already running.
   */
  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = true;
    setImmediate(() => this.drain());
  }

  /**
   * Drain the write queue to the socket.
   * Respects socket backpressure by waiting for 'drain' events.
   */
  private drain(): void {
    while (this.writeQueue.length > 0) {
      if (this._state === 'CLOSED' || this._state === 'ERROR') {
        this.draining = false;
        return;
      }

      const frame = this.writeQueue[0];
      const canWrite = this.socket.write(frame);
      this.writeQueue.shift();

      if (!canWrite) {
        // Socket buffer full - wait for drain event
        if (!this.socketDrainHandler) {
          this.socketDrainHandler = () => {
            this.socketDrainHandler = undefined;
            this.drain();
          };
          this.socket.once('drain', this.socketDrainHandler);
        }
        return;
      }
    }

    this.draining = false;

    // Check if we should release backpressure
    const lowWaterMark = this.config.writeQueueLowWaterMark ?? 500;
    if (this._backpressured && this.writeQueue.length <= lowWaterMark) {
      this._backpressured = false;
      this.onBackpressure?.(false);
    }
  }

  private sendError(code: string, message: string, fatal: boolean): void {
    const error: Envelope<ErrorPayload> = {
      v: PROTOCOL_VERSION,
      type: 'ERROR',
      id: generateId(),
      ts: Date.now(),
      payload: {
        code: code as ErrorPayload['code'],
        message,
        fatal,
      },
    };
    this.send(error);
  }


  private handleClose(): void {
    this._state = 'CLOSED';
    this.stopHeartbeat();
    this.cleanup();
    if (this.onClose) {
      this.onClose();
    }
  }

  private handleError(err: Error): void {
    this._state = 'ERROR';
    this.stopHeartbeat();
    this.cleanup();
    if (this.onError) {
      this.onError(err);
    }
    this.socket.destroy();
  }

  private cleanup(): void {
    this.parser.reset();
    // Clear write queue
    this.writeQueue = [];
    this.draining = false;
    this._backpressured = false;
    // Remove drain handler if registered
    if (this.socketDrainHandler) {
      this.socket.removeListener('drain', this.socketDrainHandler);
      this.socketDrainHandler = undefined;
    }
  }

  close(): void {
    if (this._state === 'CLOSED' || this._state === 'CLOSING') return;

    this._state = 'CLOSING';
    this.send({
      v: PROTOCOL_VERSION,
      type: 'BYE',
      id: generateId(),
      ts: Date.now(),
      payload: {},
    });
    this.socket.end();
  }
}
