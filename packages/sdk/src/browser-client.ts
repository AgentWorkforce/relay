/**
 * BrowserRelayClient - Browser-compatible Agent Relay SDK Client
 * @agent-relay/sdk
 *
 * A client designed for browser environments using WebSocket transport.
 * Can also be used in Node.js with the WebSocket transport.
 *
 * Key differences from RelayClient:
 * - Uses transport abstraction instead of direct socket access
 * - No Node.js-specific dependencies (node:net, node:crypto)
 * - Uses browser-compatible APIs (crypto.randomUUID, etc.)
 */

import type { Transport } from './transports/types.js';
import {
  createAutoTransport,
  type AutoTransportOptions,
} from './transports/index.js';
import {
  type Envelope,
  type HelloPayload,
  type WelcomePayload,
  type SendPayload,
  type SendMeta,
  type SendEnvelope,
  type DeliverEnvelope,
  type AckPayload,
  type ErrorPayload,
  type PayloadKind,
  type LogPayload,
  type SpeakOnTrigger,
  type EntityType,
  type ChannelMessagePayload,
  type ChannelJoinEnvelope,
  type ChannelLeaveEnvelope,
  type ChannelMessageEnvelope,
  type MessageAttachment,
  PROTOCOL_VERSION,
  encodeFrameLegacy,
  FrameParser,
} from '@agent-relay/protocol';

export type BrowserClientState = 'DISCONNECTED' | 'CONNECTING' | 'HANDSHAKING' | 'READY' | 'BACKOFF';

export interface BrowserClientConfig {
  /** Agent name */
  agentName: string;
  /** Entity type: 'agent' (default) or 'user' */
  entityType?: EntityType;
  /** CLI identifier (claude, codex, gemini, etc.) */
  cli?: string;
  /** Display name for human users */
  displayName?: string;
  /** Avatar URL for human users */
  avatarUrl?: string;
  /** Suppress console logging */
  quiet?: boolean;
  /** Auto-reconnect on disconnect */
  reconnect?: boolean;
  /** Max reconnect attempts */
  maxReconnectAttempts?: number;
  /** Initial reconnect delay (ms) */
  reconnectDelayMs?: number;
  /** Max reconnect delay (ms) */
  reconnectMaxDelayMs?: number;
  /** Transport options (WebSocket URL, socket path, etc.) */
  transport?: AutoTransportOptions;
  /**
   * Pre-configured transport instance (alternative to transport options).
   * NOTE: Auto-reconnection is NOT supported when using transportInstance.
   * If reconnection is needed, use `transport` options instead, or handle
   * reconnection manually by listening for state changes.
   */
  transportInstance?: Transport;
}

const DEFAULT_CONFIG: Required<Omit<BrowserClientConfig, 'entityType' | 'cli' | 'displayName' | 'avatarUrl' | 'transport' | 'transportInstance'>> = {
  agentName: 'agent',
  quiet: false,
  reconnect: true,
  maxReconnectAttempts: 10,
  reconnectDelayMs: 1000,
  reconnectMaxDelayMs: 30000,
};

// Simple ID generator (browser-compatible)
let idCounter = 0;
function generateId(): string {
  return `${Date.now().toString(36)}-${(++idCounter).toString(36)}`;
}

// Browser-compatible UUID generator
function generateUUID(): string {
  // Use crypto.randomUUID if available (modern browsers)
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback: simple UUID v4 implementation
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Circular buffer for O(1) deduplication with bounded memory.
 */
class CircularDedupeCache {
  private ids: Set<string> = new Set();
  private ring: string[];
  private head = 0;
  private readonly capacity: number;

  constructor(capacity = 2000) {
    this.capacity = capacity;
    this.ring = new Array(capacity);
  }

  check(id: string): boolean {
    if (this.ids.has(id)) return true;

    if (this.ids.size >= this.capacity) {
      const oldest = this.ring[this.head];
      if (oldest) this.ids.delete(oldest);
    }

    this.ring[this.head] = id;
    this.ids.add(id);
    this.head = (this.head + 1) % this.capacity;

    return false;
  }

  clear(): void {
    this.ids.clear();
    this.ring = new Array(this.capacity);
    this.head = 0;
  }
}

/**
 * Browser-compatible request options.
 */
export interface BrowserRequestOptions {
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Optional structured data to include with the request */
  data?: Record<string, unknown>;
  /** Optional thread identifier */
  thread?: string;
  /** Message kind (default: 'message') */
  kind?: PayloadKind;
}

/**
 * Response from the request() method.
 */
export interface BrowserRequestResponse {
  /** Sender of the response */
  from: string;
  /** Response body text */
  body: string;
  /** Optional structured data from the response */
  data?: Record<string, unknown>;
  /** The correlation ID used for this request/response */
  correlationId: string;
  /** Thread identifier if set */
  thread?: string;
  /** The full payload for advanced use cases */
  payload: SendPayload;
}

/**
 * BrowserRelayClient - A browser-compatible relay client.
 *
 * Uses WebSocket transport by default, making it compatible with browsers.
 * Can also be used in Node.js for WebSocket-based connections.
 *
 * @example Browser usage
 * ```typescript
 * import { BrowserRelayClient } from '@agent-relay/sdk/browser';
 *
 * const client = new BrowserRelayClient({
 *   agentName: 'MyAgent',
 *   transport: {
 *     wsUrl: 'wss://relay.example.com/ws',
 *   },
 * });
 *
 * await client.connect();
 *
 * client.onMessage = (from, payload) => {
 *   console.log(`Message from ${from}: ${payload.body}`);
 * };
 *
 * client.sendMessage('OtherAgent', 'Hello!');
 * ```
 */
export class BrowserRelayClient {
  private config: BrowserClientConfig;
  private transport?: Transport;
  private parser: FrameParser;

  private _state: BrowserClientState = 'DISCONNECTED';
  private sessionId?: string;
  private resumeToken?: string;
  private reconnectAttempts = 0;
  private reconnectDelay: number;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private _destroyed = false;

  private dedupeCache = new CircularDedupeCache(2000);
  private writeQueue: Uint8Array[] = [];
  private writeScheduled = false;

  private pendingSyncAcks: Map<string, {
    resolve: (ack: AckPayload) => void;
    reject: (err: Error) => void;
    timeoutHandle: ReturnType<typeof setTimeout>;
  }> = new Map();

  private pendingRequests: Map<string, {
    resolve: (response: BrowserRequestResponse) => void;
    reject: (err: Error) => void;
    timeoutHandle: ReturnType<typeof setTimeout>;
    targetAgent: string;
  }> = new Map();

  // Event handlers
  onMessage?: (from: string, payload: SendPayload, messageId: string, meta?: SendMeta, originalTo?: string) => void;
  onChannelMessage?: (from: string, channel: string, body: string, envelope: Envelope<ChannelMessagePayload>) => void;
  onStateChange?: (state: BrowserClientState) => void;
  onError?: (error: Error) => void;

  constructor(config: BrowserClientConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.parser = new FrameParser();
    this.parser.setLegacyMode(true);
    this.reconnectDelay = this.config.reconnectDelayMs ?? DEFAULT_CONFIG.reconnectDelayMs;
  }

  get state(): BrowserClientState {
    return this._state;
  }

  get agentName(): string {
    return this.config.agentName;
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Connect to the relay daemon.
   */
  async connect(): Promise<void> {
    if (this._state !== 'DISCONNECTED' && this._state !== 'BACKOFF') {
      return;
    }

    this.setState('CONNECTING');

    // Create transport if not provided
    if (!this.transport) {
      if (this.config.transportInstance) {
        this.transport = this.config.transportInstance;
      } else if (this.config.transport) {
        this.transport = createAutoTransport(this.config.transport);
      } else {
        throw new Error(
          'Transport configuration required. Provide either transport options or transportInstance.'
        );
      }
    }

    // Set up transport events
    this.transport.setEvents({
      onConnect: () => {
        this.setState('HANDSHAKING');
        this.sendHello();
      },
      onData: (data) => this.handleData(data),
      onClose: () => this.handleDisconnect(),
      onError: (err) => this.handleError(err),
    });

    try {
      await this.transport.connect();

      // Wait for READY state
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection handshake timeout'));
        }, 5000);

        const checkReady = setInterval(() => {
          if (this._state === 'READY') {
            clearInterval(checkReady);
            clearTimeout(timeout);
            resolve();
          } else if (this._state === 'DISCONNECTED') {
            clearInterval(checkReady);
            clearTimeout(timeout);
            reject(new Error('Connection failed'));
          }
        }, 10);
      });
    } catch (err) {
      this.setState('DISCONNECTED');
      throw err;
    }
  }

  /**
   * Disconnect from the relay daemon.
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.transport) {
      // Send BYE message
      this.send({
        v: PROTOCOL_VERSION,
        type: 'BYE',
        id: generateId(),
        ts: Date.now(),
        payload: {},
      });
      this.transport.disconnect();
      this.transport = undefined;
    }

    this.setState('DISCONNECTED');
  }

  /**
   * Permanently destroy the client.
   */
  destroy(): void {
    this._destroyed = true;
    this.disconnect();
  }

  /**
   * Send a message to another agent.
   */
  sendMessage(
    to: string,
    body: string,
    kind: PayloadKind = 'message',
    data?: Record<string, unknown>,
    thread?: string,
    meta?: SendMeta
  ): boolean {
    if (this._state !== 'READY') {
      return false;
    }

    const envelope: SendEnvelope = {
      v: PROTOCOL_VERSION,
      type: 'SEND',
      id: generateId(),
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
   * Send an ACK for a delivered message.
   */
  sendAck(payload: AckPayload): boolean {
    if (this._state !== 'READY') {
      return false;
    }

    const envelope: Envelope<AckPayload> = {
      v: PROTOCOL_VERSION,
      type: 'ACK',
      id: generateId(),
      ts: Date.now(),
      payload,
    };

    return this.send(envelope);
  }

  /**
   * Send a request to another agent and wait for their response.
   */
  async request(to: string, body: string, options: BrowserRequestOptions = {}): Promise<BrowserRequestResponse> {
    if (this._state !== 'READY') {
      throw new Error('Client not ready');
    }

    const correlationId = generateUUID();
    const timeoutMs = options.timeout ?? 30000;
    const kind = options.kind ?? 'message';

    return new Promise<BrowserRequestResponse>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        reject(new Error(`Request timeout after ${timeoutMs}ms waiting for response from ${to}`));
      }, timeoutMs);

      this.pendingRequests.set(correlationId, {
        resolve,
        reject,
        timeoutHandle,
        targetAgent: to,
      });

      const envelope: SendEnvelope = {
        v: PROTOCOL_VERSION,
        type: 'SEND',
        id: generateId(),
        ts: Date.now(),
        to,
        payload: {
          kind,
          body,
          data: {
            ...options.data,
            _correlationId: correlationId,
          },
          thread: options.thread,
        },
        payload_meta: {
          replyTo: correlationId,
        },
      };

      const sent = this.send(envelope);
      if (!sent) {
        clearTimeout(timeoutHandle);
        this.pendingRequests.delete(correlationId);
        reject(new Error('Failed to send request'));
      }
    });
  }

  /**
   * Respond to a request from another agent.
   */
  respond(correlationId: string, to: string, body: string, data?: Record<string, unknown>): boolean {
    if (this._state !== 'READY') {
      return false;
    }

    const envelope: SendEnvelope = {
      v: PROTOCOL_VERSION,
      type: 'SEND',
      id: generateId(),
      ts: Date.now(),
      to,
      payload: {
        kind: 'message',
        body,
        data: {
          ...data,
          _correlationId: correlationId,
          _isResponse: true,
        },
      },
      payload_meta: {
        replyTo: correlationId,
      },
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
   * Bind as a shadow to a primary agent.
   */
  bindAsShadow(
    primaryAgent: string,
    options: {
      speakOn?: SpeakOnTrigger[];
      receiveIncoming?: boolean;
      receiveOutgoing?: boolean;
    } = {}
  ): boolean {
    if (this._state !== 'READY') return false;

    return this.send({
      v: PROTOCOL_VERSION,
      type: 'SHADOW_BIND',
      id: generateId(),
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
   * Unbind from a primary agent.
   */
  unbindAsShadow(primaryAgent: string): boolean {
    if (this._state !== 'READY') return false;

    return this.send({
      v: PROTOCOL_VERSION,
      type: 'SHADOW_UNBIND',
      id: generateId(),
      ts: Date.now(),
      payload: {
        primaryAgent,
      },
    });
  }

  /**
   * Send log output to the daemon.
   */
  sendLog(data: string): boolean {
    if (this._state !== 'READY') {
      return false;
    }

    const envelope: Envelope<LogPayload> = {
      v: PROTOCOL_VERSION,
      type: 'LOG',
      id: generateId(),
      ts: Date.now(),
      payload: {
        data,
        timestamp: Date.now(),
      },
    };

    return this.send(envelope);
  }

  // =============================================================================
  // Channel Operations
  // =============================================================================

  /**
   * Join a channel.
   */
  joinChannel(channel: string, displayName?: string): boolean {
    if (this._state !== 'READY') {
      return false;
    }

    const envelope: ChannelJoinEnvelope = {
      v: PROTOCOL_VERSION,
      type: 'CHANNEL_JOIN',
      id: generateId(),
      ts: Date.now(),
      payload: {
        channel,
        displayName,
      },
    };

    return this.send(envelope);
  }

  /**
   * Leave a channel.
   */
  leaveChannel(channel: string, reason?: string): boolean {
    if (this._state !== 'READY') return false;

    const envelope: ChannelLeaveEnvelope = {
      v: PROTOCOL_VERSION,
      type: 'CHANNEL_LEAVE',
      id: generateId(),
      ts: Date.now(),
      payload: {
        channel,
        reason,
      },
    };

    return this.send(envelope);
  }

  /**
   * Send a message to a channel.
   */
  sendChannelMessage(
    channel: string,
    body: string,
    options?: {
      thread?: string;
      mentions?: string[];
      attachments?: MessageAttachment[];
      data?: Record<string, unknown>;
    }
  ): boolean {
    if (this._state !== 'READY') {
      return false;
    }

    const envelope: ChannelMessageEnvelope = {
      v: PROTOCOL_VERSION,
      type: 'CHANNEL_MESSAGE',
      id: generateId(),
      ts: Date.now(),
      payload: {
        channel,
        body,
        thread: options?.thread,
        mentions: options?.mentions,
        attachments: options?.attachments,
        data: options?.data,
      },
    };

    return this.send(envelope);
  }

  // =============================================================================
  // Private Methods
  // =============================================================================

  private setState(state: BrowserClientState): void {
    this._state = state;
    if (this.onStateChange) {
      this.onStateChange(state);
    }
  }

  private sendHello(): void {
    const hello: Envelope<HelloPayload> = {
      v: PROTOCOL_VERSION,
      type: 'HELLO',
      id: generateId(),
      ts: Date.now(),
      payload: {
        agent: this.config.agentName,
        entityType: this.config.entityType,
        cli: this.config.cli,
        displayName: this.config.displayName,
        avatarUrl: this.config.avatarUrl,
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
    if (!this.transport || this.transport.state !== 'connected') {
      return false;
    }

    try {
      const frame = encodeFrameLegacy(envelope);
      this.writeQueue.push(frame);

      if (!this.writeScheduled) {
        this.writeScheduled = true;
        // Use setTimeout(0) for browser compatibility (instead of setImmediate)
        setTimeout(() => this.flushWrites(), 0);
      }
      return true;
    } catch (err) {
      this.handleError(err as Error);
      return false;
    }
  }

  private flushWrites(): void {
    this.writeScheduled = false;
    if (this.writeQueue.length === 0 || !this.transport) return;

    // Concatenate all buffers
    const totalLength = this.writeQueue.reduce((sum, buf) => sum + buf.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const buf of this.writeQueue) {
      combined.set(buf, offset);
      offset += buf.length;
    }

    this.transport.send(combined);
    this.writeQueue = [];
  }

  private handleData(data: Uint8Array): void {
    try {
      // Convert Uint8Array to Buffer for FrameParser
      const buffer = Buffer.from(data);
      const frames = this.parser.push(buffer);
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

      case 'CHANNEL_MESSAGE':
        this.handleChannelMessage(envelope as Envelope<ChannelMessagePayload> & { from?: string });
        break;

      case 'PING':
        this.handlePing(envelope);
        break;

      case 'ACK':
        this.handleAck(envelope as Envelope<AckPayload>);
        break;

      case 'ERROR':
        this.handleErrorFrame(envelope as Envelope<ErrorPayload>);
        break;

      case 'BUSY':
        if (!this.config.quiet) {
          console.warn('[sdk] Server busy, backing off');
        }
        break;
    }
  }

  private handleWelcome(envelope: Envelope<WelcomePayload>): void {
    this.sessionId = envelope.payload.session_id;
    this.resumeToken = envelope.payload.resume_token;
    this.reconnectAttempts = 0;
    this.reconnectDelay = this.config.reconnectDelayMs ?? DEFAULT_CONFIG.reconnectDelayMs;
    this.setState('READY');
    if (!this.config.quiet) {
      console.log(`[sdk] Connected as ${this.config.agentName} (session: ${this.sessionId})`);
    }
  }

  private handleDeliver(envelope: DeliverEnvelope): void {
    // Send ACK
    this.send({
      v: PROTOCOL_VERSION,
      type: 'ACK',
      id: generateId(),
      ts: Date.now(),
      payload: {
        ack_id: envelope.id,
        seq: envelope.delivery.seq,
      },
    });

    const duplicate = this.dedupeCache.check(envelope.id);
    if (duplicate) {
      return;
    }

    // Check if this is a response to a pending request
    const correlationId = this.extractCorrelationId(envelope);
    if (correlationId && envelope.from) {
      const pending = this.pendingRequests.get(correlationId);
      if (pending) {
        clearTimeout(pending.timeoutHandle);
        this.pendingRequests.delete(correlationId);
        pending.resolve({
          from: envelope.from,
          body: envelope.payload.body,
          data: envelope.payload.data,
          correlationId,
          thread: envelope.payload.thread,
          payload: envelope.payload,
        });
      }
    }

    if (this.onMessage && envelope.from) {
      this.onMessage(
        envelope.from,
        envelope.payload,
        envelope.id,
        envelope.payload_meta,
        envelope.delivery.originalTo
      );
    }
  }

  private extractCorrelationId(envelope: DeliverEnvelope): string | undefined {
    if (envelope.payload_meta?.replyTo) {
      return envelope.payload_meta.replyTo;
    }
    if (envelope.payload.data && typeof envelope.payload.data._correlationId === 'string') {
      return envelope.payload.data._correlationId;
    }
    return undefined;
  }

  private handleChannelMessage(envelope: Envelope<ChannelMessagePayload> & { from?: string }): void {
    const duplicate = this.dedupeCache.check(envelope.id);
    if (duplicate) {
      return;
    }

    if (this.onChannelMessage && envelope.from) {
      this.onChannelMessage(
        envelope.from,
        envelope.payload.channel,
        envelope.payload.body,
        envelope as Envelope<ChannelMessagePayload>
      );
    }

    // Also call onMessage for backwards compatibility
    if (this.onMessage && envelope.from) {
      const sendPayload: SendPayload = {
        kind: 'message',
        body: envelope.payload.body,
        data: {
          _isChannelMessage: true,
          _channel: envelope.payload.channel,
          _mentions: envelope.payload.mentions,
        },
        thread: envelope.payload.thread,
      };
      this.onMessage(envelope.from, sendPayload, envelope.id, undefined, envelope.payload.channel);
    }
  }

  private handleAck(envelope: Envelope<AckPayload>): void {
    const correlationId = envelope.payload.correlationId;
    if (!correlationId) return;

    const pending = this.pendingSyncAcks.get(correlationId);
    if (!pending) return;

    clearTimeout(pending.timeoutHandle);
    this.pendingSyncAcks.delete(correlationId);
    pending.resolve(envelope.payload);
  }

  private handlePing(envelope: Envelope): void {
    this.send({
      v: PROTOCOL_VERSION,
      type: 'PONG',
      id: generateId(),
      ts: Date.now(),
      payload: (envelope.payload as { nonce?: string }) ?? {},
    });
  }

  private handleErrorFrame(envelope: Envelope<ErrorPayload>): void {
    if (!this.config.quiet) {
      console.error('[sdk] Server error:', envelope.payload);
    }

    if (envelope.payload.code === 'RESUME_TOO_OLD') {
      this.resumeToken = undefined;
      this.sessionId = undefined;
    }

    if (envelope.payload.fatal) {
      if (!this.config.quiet) {
        console.error('[sdk] Fatal error received, will not reconnect:', envelope.payload.message);
      }
      this._destroyed = true;
    }
  }

  private handleDisconnect(): void {
    this.parser.reset();
    this.transport = undefined;
    this.rejectPendingSyncAcks(new Error('Disconnected while awaiting ACK'));
    this.rejectPendingRequests(new Error('Disconnected while awaiting request response'));

    if (this._destroyed) {
      this.setState('DISCONNECTED');
      return;
    }

    if (this.config.reconnect && this.reconnectAttempts < (this.config.maxReconnectAttempts ?? DEFAULT_CONFIG.maxReconnectAttempts)) {
      this.scheduleReconnect();
    } else {
      this.setState('DISCONNECTED');
      if (this.reconnectAttempts >= (this.config.maxReconnectAttempts ?? DEFAULT_CONFIG.maxReconnectAttempts) && !this.config.quiet) {
        console.error(
          `[sdk] Max reconnect attempts reached (${this.config.maxReconnectAttempts}), giving up`
        );
      }
    }
  }

  private handleError(error: Error): void {
    if (!this.config.quiet) {
      console.error('[sdk] Error:', error.message);
    }
    if (this.onError) {
      this.onError(error);
    }
  }

  private rejectPendingSyncAcks(error: Error): void {
    for (const [correlationId, pending] of this.pendingSyncAcks.entries()) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(error);
      this.pendingSyncAcks.delete(correlationId);
    }
  }

  private rejectPendingRequests(error: Error): void {
    for (const [correlationId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(error);
      this.pendingRequests.delete(correlationId);
    }
  }

  private scheduleReconnect(): void {
    // Cannot reconnect when using transportInstance - we can't recreate an
    // externally-provided transport. Users must handle reconnection themselves
    // or use transport options instead.
    if (!this.config.transport && this.config.transportInstance) {
      if (!this.config.quiet) {
        console.warn(
          '[sdk] Cannot auto-reconnect with transportInstance. ' +
          'Use transport options instead, or handle reconnection manually.'
        );
      }
      this.setState('DISCONNECTED');
      return;
    }

    this.setState('BACKOFF');
    this.reconnectAttempts++;

    const jitter = Math.random() * 0.3 + 0.85;
    const maxDelay = this.config.reconnectMaxDelayMs ?? DEFAULT_CONFIG.reconnectMaxDelayMs;
    const delay = Math.min(this.reconnectDelay * jitter, maxDelay);
    this.reconnectDelay *= 2;

    if (!this.config.quiet) {
      console.log(`[sdk] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);
    }

    this.reconnectTimer = setTimeout(() => {
      // Re-create transport for reconnection
      if (this.config.transport) {
        this.transport = createAutoTransport(this.config.transport);
      }
      this.connect().catch(() => {});
    }, delay);
  }
}
