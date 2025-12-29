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
import { v4 as uuid } from 'uuid';
import {
  type Envelope,
  type HelloPayload,
  type WelcomePayload,
  type SendPayload,
  type PongPayload,
  type ErrorPayload,
  type AckPayload,
  PROTOCOL_VERSION,
} from '../protocol/types.js';
import { encodeFrame, FrameParser } from '../protocol/framing.js';

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
}

export const DEFAULT_CONFIG: ConnectionConfig = {
  maxFrameBytes: 1024 * 1024,
  heartbeatMs: 5000,
  // 6x multiplier = 30 second timeout, more tolerant for AI agents processing long responses
  heartbeatTimeoutMultiplier: 6,
};

export class Connection {
  readonly id: string;
  private socket: net.Socket;
  private parser: FrameParser;
  private config: ConnectionConfig;

  private _state: ConnectionState = 'CONNECTING';
  private _agentName?: string;
  private _cli?: string;
  private _program?: string;
  private _model?: string;
  private _task?: string;
  private _workingDirectory?: string;
  private _sessionId: string;
  private _resumeToken: string;
  private _isResumed = false;

  private heartbeatTimer?: NodeJS.Timeout;
  private lastPongReceived?: number;

  // Sequence numbers per (topic, peer) stream
  private sequences: Map<string, number> = new Map();

  // Event handlers
  onMessage?: (envelope: Envelope) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
  onActive?: () => void; // Fires when connection transitions to ACTIVE state
  onAck?: (envelope: Envelope<AckPayload>) => void;
  onPong?: () => void; // Fires on successful heartbeat response

  constructor(socket: net.Socket, config: Partial<ConnectionConfig> = {}) {
    this.id = uuid();
    this.socket = socket;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.parser = new FrameParser(this.config.maxFrameBytes);
    this._sessionId = uuid();
    this._resumeToken = uuid();

    this.setupSocketHandlers();
    this._state = 'HANDSHAKING';
  }

  get state(): ConnectionState {
    return this._state;
  }

  get agentName(): string | undefined {
    return this._agentName;
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

  get sessionId(): string {
    return this._sessionId;
  }

  get resumeToken(): string {
    return this._resumeToken;
  }

  get isResumed(): boolean {
    return this._isResumed;
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
    this._cli = envelope.payload.cli;
    this._program = envelope.payload.program;
    this._model = envelope.payload.model;
    this._task = envelope.payload.task;
    this._workingDirectory = envelope.payload.workingDirectory;

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
      id: uuid(),
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
      const nonce = uuid();
      this.send({
        v: PROTOCOL_VERSION,
        type: 'PING',
        id: uuid(),
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
   */
  send(envelope: Envelope): boolean {
    if (this._state === 'CLOSED' || this._state === 'ERROR') {
      return false;
    }

    try {
      const frame = encodeFrame(envelope);
      this.socket.write(frame);
      return true;
    } catch (err) {
      this.handleError(err as Error);
      return false;
    }
  }

  private sendError(code: string, message: string, fatal: boolean): void {
    const error: Envelope<ErrorPayload> = {
      v: PROTOCOL_VERSION,
      type: 'ERROR',
      id: uuid(),
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
  }

  close(): void {
    if (this._state === 'CLOSED' || this._state === 'CLOSING') return;

    this._state = 'CLOSING';
    this.send({
      v: PROTOCOL_VERSION,
      type: 'BYE',
      id: uuid(),
      ts: Date.now(),
      payload: {},
    });
    this.socket.end();
  }
}
