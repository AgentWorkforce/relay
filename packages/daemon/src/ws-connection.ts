/**
 * WebSocket Connection adapter for the hosted daemon.
 *
 * Implements the same connection state machine as Connection (net.Socket)
 * but operates over WebSocket. Each WebSocket message is a complete
 * JSON-encoded protocol envelope — no binary framing needed since
 * WebSocket handles message boundaries natively.
 *
 * States:
 *   CONNECTING -> HANDSHAKING -> ACTIVE -> CLOSING -> CLOSED
 *                     |            |
 *                     v            v
 *                   ERROR -------> CLOSED
 */

import { generateId } from '@agent-relay/wrapper';
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
} from '@agent-relay/protocol/types';
import { DEFAULT_CONNECTION_CONFIG } from '@agent-relay/config/relay-config';
import type { RoutableConnection } from './router.js';

export type WsConnectionState = 'CONNECTING' | 'HANDSHAKING' | 'ACTIVE' | 'CLOSING' | 'CLOSED' | 'ERROR';

/** Reserved agent names (mirrors connection.ts) */
export const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set([
  'Dashboard', 'cli', 'system', '_router',
]);

export interface WsConnectionConfig {
  heartbeatMs: number;
  heartbeatTimeoutMultiplier: number;
  /** Optional handler to validate resume tokens and provide session state */
  resumeHandler?: (params: { agent: string; resumeToken: string }) => Promise<{
    sessionId: string;
    resumeToken?: string;
    seedSequences?: Array<{ topic?: string; peer: string; seq: number }>;
  } | null>;
  /** Optional callback to check if agent is currently processing */
  isProcessing?: (agentName: string) => boolean;
}

const DEFAULT_WS_CONFIG: WsConnectionConfig = {
  heartbeatMs: DEFAULT_CONNECTION_CONFIG.heartbeatMs,
  heartbeatTimeoutMultiplier: DEFAULT_CONNECTION_CONFIG.heartbeatTimeoutMultiplier,
};

/**
 * WebSocket handle interface — works with both 'ws' (Node.js) and
 * browser-native WebSocket (abstracted).
 */
export interface WebSocketHandle {
  send(data: string): void;
  close(): void;
  readyState: number;
  OPEN: number;
}

/**
 * WebSocket-based connection for the hosted daemon.
 *
 * Accepts incoming JSON messages on `handleMessage()`, processes the relay
 * protocol handshake (HELLO/WELCOME) and heartbeat (PING/PONG), and
 * delivers envelopes to the router via callbacks.
 *
 * Implements RoutableConnection so the Router can treat it identically
 * to a Unix-socket Connection.
 */
export class WsConnection implements RoutableConnection {
  readonly id: string;
  private ws: WebSocketHandle;
  private config: WsConnectionConfig;

  private _state: WsConnectionState = 'CONNECTING';
  private _agentName?: string;
  private _entityType?: EntityType;
  private _cli?: string;
  private _program?: string;
  private _model?: string;
  private _task?: string;
  private _workingDirectory?: string;
  private _team?: string;
  private _displayName?: string;
  private _avatarUrl?: string;
  private _sessionId: string;
  private _resumeToken: string;
  private _isResumed = false;

  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private lastPongReceived?: number;

  /** Sequence numbers per (topic, peer) stream */
  private sequences: Map<string, number> = new Map();

  // Event handlers — wired by HostedDaemon
  onMessage?: (envelope: Envelope) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
  onActive?: () => void;
  onAck?: (envelope: Envelope<AckPayload>) => void;
  onPong?: () => void;

  constructor(ws: WebSocketHandle, config: Partial<WsConnectionConfig> = {}) {
    this.id = generateId();
    this.ws = ws;
    this.config = { ...DEFAULT_WS_CONFIG, ...config };
    this._sessionId = generateId();
    this._resumeToken = generateId();
    this._state = 'HANDSHAKING';
  }

  // RoutableConnection interface
  get state(): WsConnectionState { return this._state; }
  get agentName(): string | undefined { return this._agentName; }
  get entityType(): EntityType | undefined { return this._entityType; }
  get cli(): string | undefined { return this._cli; }
  get program(): string | undefined { return this._program; }
  get model(): string | undefined { return this._model; }
  get task(): string | undefined { return this._task; }
  get workingDirectory(): string | undefined { return this._workingDirectory; }
  get team(): string | undefined { return this._team; }
  get displayName(): string | undefined { return this._displayName; }
  get avatarUrl(): string | undefined { return this._avatarUrl; }
  get sessionId(): string { return this._sessionId; }
  get resumeToken(): string { return this._resumeToken; }
  get isResumed(): boolean { return this._isResumed; }

  // ─── Inbound ──────────────────────────────────────────────────────

  /**
   * Called by the HostedDaemon when a WebSocket message arrives.
   * Each message is expected to be a JSON-encoded Envelope.
   */
  handleMessage(raw: string): void {
    if (this._state === 'CLOSED' || this._state === 'ERROR') return;

    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch {
      this.sendError('BAD_REQUEST', 'Invalid JSON', true);
      this.close();
      return;
    }

    this.processEnvelope(envelope).catch((err) => {
      this.sendError('BAD_REQUEST', `Protocol error: ${err}`, true);
      this.close();
    });
  }

  /**
   * Called by the HostedDaemon when the WebSocket closes.
   */
  handleWsClose(): void {
    if (this._state === 'CLOSED') return;
    this._state = 'CLOSED';
    this.stopHeartbeat();
    this.onClose?.();
  }

  /**
   * Called by the HostedDaemon when a WebSocket error occurs.
   */
  handleWsError(err: Error): void {
    if (this._state === 'ERROR' || this._state === 'CLOSED') return;
    this._state = 'ERROR';
    this.stopHeartbeat();
    this.onError?.(err);
  }

  // ─── Protocol Processing ──────────────────────────────────────────

  private async processEnvelope(envelope: Envelope): Promise<void> {
    switch (envelope.type) {
      case 'HELLO':
        await this.handleHello(envelope as Envelope<HelloPayload>);
        break;
      case 'SEND':
        this.handleSend(envelope as Envelope<SendPayload>);
        break;
      case 'ACK':
        this.onAck?.(envelope as Envelope<AckPayload>);
        break;
      case 'PONG':
        this.handlePong();
        break;
      case 'BYE':
        this.close();
        break;
      default:
        // Forward all other envelope types (SPAWN, RELEASE, STATUS, etc.)
        this.onMessage?.(envelope);
    }
  }

  private async handleHello(envelope: Envelope<HelloPayload>): Promise<void> {
    if (this._state !== 'HANDSHAKING') {
      this.sendError('BAD_REQUEST', 'Unexpected HELLO', false);
      return;
    }

    const agentName = envelope.payload.agent;

    // Validate reserved names
    if (RESERVED_AGENT_NAMES.has(agentName) && !envelope.payload._isSystemComponent) {
      this.sendError('BAD_REQUEST', `Agent name "${agentName}" is reserved for system use`, true);
      return;
    }

    this._agentName = agentName;
    this._entityType = envelope.payload.entityType;
    this._cli = envelope.payload.cli;
    this._program = envelope.payload.program;
    this._model = envelope.payload.model;
    this._task = envelope.payload.task;
    this._workingDirectory = envelope.payload.workingDirectory;
    this._team = envelope.payload.team;
    this._displayName = envelope.payload.displayName;
    this._avatarUrl = envelope.payload.avatarUrl;

    // Session resume
    const resumeToken = envelope.payload.session?.resume_token;
    if (resumeToken && this.config.resumeHandler) {
      try {
        const resumeState = await this.config.resumeHandler({
          agent: this._agentName,
          resumeToken,
        });
        if (resumeState) {
          this._sessionId = resumeState.sessionId;
          this._resumeToken = resumeState.resumeToken ?? resumeToken;
          this._isResumed = true;
          for (const seed of resumeState.seedSequences ?? []) {
            this.seedSequence(seed.topic ?? 'default', seed.peer, seed.seq);
          }
        } else {
          this.sendError('RESUME_TOO_OLD', 'Resume token rejected; starting new session', false);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.sendError('RESUME_TOO_OLD', `Resume validation failed: ${msg}`, false);
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
          max_frame_bytes: 1024 * 1024,
          heartbeat_ms: this.config.heartbeatMs,
        },
      },
    };

    this.send(welcome);
    this._state = 'ACTIVE';
    this.lastPongReceived = Date.now();
    this.startHeartbeat();

    this.onActive?.();
  }

  private handleSend(envelope: Envelope<SendPayload>): void {
    const hasMcpSender = !!envelope.from && !!envelope.to;
    if (this._state !== 'ACTIVE' && !hasMcpSender) {
      this.sendError('BAD_REQUEST', 'Not in ACTIVE state', false);
      return;
    }
    this.onMessage?.(envelope);
  }

  private handlePong(): void {
    this.lastPongReceived = Date.now();
    this.onPong?.();
  }

  // ─── Heartbeat ────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this._state !== 'ACTIVE') return;

      const now = Date.now();
      const timeoutMs = this.config.heartbeatMs * this.config.heartbeatTimeoutMultiplier;

      if (this.lastPongReceived && now - this.lastPongReceived > timeoutMs) {
        if (this._agentName && this.config.isProcessing?.(this._agentName)) {
          // Exempt processing agents from heartbeat timeout
        } else {
          this.handleWsError(new Error(`Heartbeat timeout (no pong in ${timeoutMs}ms)`));
          return;
        }
      }

      // Send PING
      this.send({
        v: PROTOCOL_VERSION,
        type: 'PING',
        id: generateId(),
        ts: now,
        payload: { nonce: generateId() },
      });
    }, this.config.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  // ─── Sequence Tracking ────────────────────────────────────────────

  seedSequence(topic: string | undefined, peer: string, seq: number): void {
    const key = `${topic ?? 'default'}:${peer}`;
    const current = this.sequences.get(key) ?? 0;
    if (seq > current) {
      this.sequences.set(key, seq);
    }
  }

  getNextSeq(topic: string, peer: string): number {
    const key = `${topic}:${peer}`;
    const seq = (this.sequences.get(key) ?? 0) + 1;
    this.sequences.set(key, seq);
    return seq;
  }

  // ─── Outbound ─────────────────────────────────────────────────────

  /**
   * Send an envelope to this connection over WebSocket.
   * Returns false if the connection is closed.
   */
  send(envelope: Envelope): boolean {
    if (this._state === 'CLOSED' || this._state === 'ERROR' || this._state === 'CLOSING') {
      return false;
    }

    if (this.ws.readyState !== this.ws.OPEN) {
      return false;
    }

    try {
      this.ws.send(JSON.stringify(envelope));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send a protocol error envelope.
   */
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

  /**
   * Gracefully close the connection.
   */
  close(): void {
    if (this._state === 'CLOSED' || this._state === 'CLOSING') return;
    this._state = 'CLOSING';

    try {
      this.send({
        v: PROTOCOL_VERSION,
        type: 'BYE',
        id: generateId(),
        ts: Date.now(),
        payload: {},
      });
    } catch {
      // Ignore write errors during close
    }

    this.stopHeartbeat();
    this.ws.close();
    this._state = 'CLOSED';
  }
}
