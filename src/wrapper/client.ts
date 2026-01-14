/**
 * Relay Client
 * Connects to the daemon and handles message sending/receiving.
 *
 * Optimizations:
 * - Monotonic ID generation (faster than UUID)
 * - Write coalescing (batch socket writes)
 * - Circular dedup cache (O(1) eviction)
 */

import net from 'node:net';
import { generateId } from '../utils/id-generator.js';
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
  type EntityType,
  type SpawnPayload,
  type SpawnResultPayload,
  type ReleasePayload,
  type ReleaseResultPayload,
  PROTOCOL_VERSION,
} from '../protocol/types.js';
import { encodeFrameLegacy, FrameParser } from '../protocol/framing.js';
import { DEFAULT_SOCKET_PATH } from '../daemon/server.js';

/**
 * Debug logging helper for client events.
 * Format: [RELAY:client:timestamp] event_name | details
 */
function clientLog(agentName: string, event: string, details?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const detailStr = details ? ` | ${JSON.stringify(details)}` : '';
  console.log(`[RELAY:client:${ts}] ${event} | agent=${agentName}${detailStr}`);
}

export type ClientState = 'DISCONNECTED' | 'CONNECTING' | 'HANDSHAKING' | 'READY' | 'BACKOFF';

export interface ClientConfig {
  socketPath: string;
  agentName: string;
  /** Entity type: 'agent' (default) or 'user' for human users */
  entityType?: EntityType;
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
  /** Display name for human users */
  displayName?: string;
  /** Avatar URL for human users */
  avatarUrl?: string;
  /** Suppress client-side console logging */
  quiet?: boolean;
  reconnect: boolean;
  maxReconnectAttempts: number;
  reconnectDelayMs: number;
  reconnectMaxDelayMs: number;
}

/** Request to spawn an agent via daemon */
export interface SpawnRequest {
  name: string;
  cli: string;
  task: string;
  team?: string;
  cwd?: string;
  socketPath?: string;
  spawnerName?: string;
  interactive?: boolean;
  shadowOf?: string;
  shadowSpeakOn?: SpeakOnTrigger[];
  userId?: string;
}

/** Result of a spawn request */
export interface SpawnResult {
  success: boolean;
  name: string;
  pid?: number;
  error?: string;
  policyDecision?: {
    allowed: boolean;
    reason: string;
    policySource: 'repo' | 'local' | 'workspace' | 'default';
  };
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

  /** Returns true if duplicate (already seen) */
  check(id: string): boolean {
    if (this.ids.has(id)) return true;

    // Evict oldest if at capacity
    if (this.ids.size >= this.capacity) {
      const oldest = this.ring[this.head];
      if (oldest) this.ids.delete(oldest);
    }

    // Add new ID
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

  // Circular dedup cache (O(1) eviction vs O(n) array shift)
  private dedupeCache = new CircularDedupeCache(2000);

  // Write coalescing: batch multiple writes into single syscall
  private writeQueue: Buffer[] = [];
  private writeScheduled = false;

  // Pending spawn/release requests (correlation ID -> resolver)
  private pendingSpawns = new Map<string, {
    resolve: (result: SpawnResult) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private pendingReleases = new Map<string, {
    resolve: (success: boolean) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();

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
    this.parser.setLegacyMode(true); // Use 4-byte header for backwards compatibility
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
    clientLog(this.config.agentName, 'CONNECT_START', {
      currentState: this._state,
      socketPath: this.config.socketPath,
    });

    if (this._state !== 'DISCONNECTED' && this._state !== 'BACKOFF') {
      clientLog(this.config.agentName, 'CONNECT_SKIP', {
        reason: 'Already connecting or connected',
        currentState: this._state,
      });
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const settleResolve = (): void => {
        if (settled) return;
        settled = true;
        clientLog(this.config.agentName, 'CONNECT_RESOLVED', {
          state: this._state,
          sessionId: this.sessionId?.substring(0, 8),
        });
        resolve();
      };
      const settleReject = (err: Error): void => {
        if (settled) return;
        settled = true;
        clientLog(this.config.agentName, 'CONNECT_REJECTED', {
          error: err.message,
          state: this._state,
        });
        reject(err);
      };

      this.setState('CONNECTING');
      clientLog(this.config.agentName, 'SOCKET_CONNECTING', {
        socketPath: this.config.socketPath,
      });

      this.socket = net.createConnection(this.config.socketPath, () => {
        clientLog(this.config.agentName, 'SOCKET_CONNECTED', {
          localAddress: this.socket?.localAddress,
        });
        this.setState('HANDSHAKING');
        this.sendHello();
      });

      this.socket.on('data', (data) => this.handleData(data));

      this.socket.on('close', () => {
        clientLog(this.config.agentName, 'SOCKET_CLOSED');
        this.handleDisconnect();
      });

      this.socket.on('error', (err) => {
        clientLog(this.config.agentName, 'SOCKET_ERROR', {
          error: err.message,
          state: this._state,
        });
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
          clientLog(this.config.agentName, 'CONNECT_TIMEOUT', {
            state: this._state,
            timeoutMs: 5000,
          });
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

    // Clean up pending spawn/release requests
    for (const [id, pending] of this.pendingSpawns) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Client disconnected'));
    }
    this.pendingSpawns.clear();

    for (const [id, pending] of this.pendingReleases) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Client disconnected'));
    }
    this.pendingReleases.clear();

    if (this.socket) {
      this.send({
        v: PROTOCOL_VERSION,
        type: 'BYE',
        id: generateId(),
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
    const messageId = generateId();

    clientLog(this.config.agentName, 'SEND_MESSAGE_START', {
      to,
      kind,
      messageId: messageId.substring(0, 8),
      bodyPreview: body.substring(0, 50),
      state: this._state,
      thread,
    });

    if (this._state !== 'READY') {
      clientLog(this.config.agentName, 'SEND_MESSAGE_BLOCKED', {
        reason: 'Client not ready',
        state: this._state,
        to,
        messageId: messageId.substring(0, 8),
      });
      return false;
    }

    const envelope: SendEnvelope = {
      v: PROTOCOL_VERSION,
      type: 'SEND',
      id: messageId,
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

    const sent = this.send(envelope);
    clientLog(this.config.agentName, 'SEND_MESSAGE_RESULT', {
      to,
      messageId: messageId.substring(0, 8),
      sent,
    });
    return sent;
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
      id: generateId(),
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
      id: generateId(),
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
   * Unbind this agent from a primary agent (stop shadowing).
   * @param primaryAgent - The agent to stop shadowing
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
      id: generateId(),
      ts: Date.now(),
      payload: {
        data,
        timestamp: Date.now(),
      },
    };

    return this.send(envelope);
  }

  /**
   * Spawn an agent via the daemon.
   * @param request - Spawn request parameters
   * @param timeoutMs - Timeout in milliseconds (default: 60000)
   * @returns Promise that resolves with spawn result
   */
  spawn(request: SpawnRequest, timeoutMs = 60000): Promise<SpawnResult> {
    return new Promise((resolve, reject) => {
      if (this._state !== 'READY') {
        reject(new Error(`Client not ready (state: ${this._state})`));
        return;
      }

      const messageId = generateId();
      const payload: SpawnPayload = {
        name: request.name,
        cli: request.cli,
        task: request.task,
        team: request.team,
        cwd: request.cwd,
        socketPath: request.socketPath,
        spawnerName: request.spawnerName ?? this.config.agentName,
        interactive: request.interactive,
        shadowOf: request.shadowOf,
        shadowSpeakOn: request.shadowSpeakOn,
        userId: request.userId,
      };

      const timeout = setTimeout(() => {
        this.pendingSpawns.delete(messageId);
        reject(new Error(`Spawn timeout for ${request.name}`));
      }, timeoutMs);

      this.pendingSpawns.set(messageId, { resolve, reject, timeout });

      const sent = this.send({
        v: PROTOCOL_VERSION,
        type: 'SPAWN',
        id: messageId,
        ts: Date.now(),
        payload,
      });

      if (!sent) {
        clearTimeout(timeout);
        this.pendingSpawns.delete(messageId);
        reject(new Error('Failed to send SPAWN message'));
      }
    });
  }

  /**
   * Release (terminate) an agent via the daemon.
   * @param name - Agent name to release
   * @param timeoutMs - Timeout in milliseconds (default: 30000)
   * @returns Promise that resolves with success boolean
   */
  release(name: string, timeoutMs = 30000): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (this._state !== 'READY') {
        reject(new Error(`Client not ready (state: ${this._state})`));
        return;
      }

      const messageId = generateId();
      const payload: ReleasePayload = { name };

      const timeout = setTimeout(() => {
        this.pendingReleases.delete(messageId);
        reject(new Error(`Release timeout for ${name}`));
      }, timeoutMs);

      this.pendingReleases.set(messageId, { resolve, reject, timeout });

      const sent = this.send({
        v: PROTOCOL_VERSION,
        type: 'RELEASE',
        id: messageId,
        ts: Date.now(),
        payload,
      });

      if (!sent) {
        clearTimeout(timeout);
        this.pendingReleases.delete(messageId);
        reject(new Error('Failed to send RELEASE message'));
      }
    });
  }

  private setState(state: ClientState): void {
    this._state = state;
    if (this.onStateChange) {
      this.onStateChange(state);
    }
  }

  private sendHello(): void {
    const helloId = generateId();
    clientLog(this.config.agentName, 'HELLO_SENDING', {
      helloId: helloId.substring(0, 8),
      cli: this.config.cli,
      entityType: this.config.entityType,
      hasResumeToken: !!this.resumeToken,
    });

    const hello: Envelope<HelloPayload> = {
      v: PROTOCOL_VERSION,
      type: 'HELLO',
      id: helloId,
      ts: Date.now(),
      payload: {
        agent: this.config.agentName,
        entityType: this.config.entityType,
        cli: this.config.cli,
        program: this.config.program,
        model: this.config.model,
        task: this.config.task,
        workingDirectory: this.config.workingDirectory,
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

    const sent = this.send(hello);
    clientLog(this.config.agentName, 'HELLO_SENT', {
      helloId: helloId.substring(0, 8),
      sent,
    });
  }

  private send(envelope: Envelope): boolean {
    if (!this.socket) return false;

    try {
      const frame = encodeFrameLegacy(envelope);
      this.writeQueue.push(frame);

      // Coalesce writes: schedule flush on next tick if not already scheduled
      if (!this.writeScheduled) {
        this.writeScheduled = true;
        setImmediate(() => this.flushWrites());
      }
      return true;
    } catch (err) {
      this.handleError(err as Error);
      return false;
    }
  }

  /**
   * Flush all queued writes in a single syscall.
   */
  private flushWrites(): void {
    this.writeScheduled = false;
    if (this.writeQueue.length === 0 || !this.socket) return;

    if (this.writeQueue.length === 1) {
      // Single frame - write directly (no concat needed)
      this.socket.write(this.writeQueue[0]);
    } else {
      // Multiple frames - batch into single write
      this.socket.write(Buffer.concat(this.writeQueue));
    }
    this.writeQueue = [];
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

      case 'SPAWN_RESULT': {
        const payload = envelope.payload as SpawnResultPayload;
        const pending = this.pendingSpawns.get(payload.replyTo);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingSpawns.delete(payload.replyTo);
          pending.resolve({
            success: payload.success,
            name: payload.name,
            pid: payload.pid,
            error: payload.error,
            policyDecision: payload.policyDecision,
          });
        }
        break;
      }

      case 'RELEASE_RESULT': {
        const payload = envelope.payload as ReleaseResultPayload;
        const pending = this.pendingReleases.get(payload.replyTo);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingReleases.delete(payload.replyTo);
          pending.resolve(payload.success);
        }
        break;
      }
    }
  }

  private handleWelcome(envelope: Envelope<WelcomePayload>): void {
    clientLog(this.config.agentName, 'WELCOME_RECEIVED', {
      sessionId: envelope.payload.session_id?.substring(0, 8),
      hasResumeToken: !!envelope.payload.resume_token,
      heartbeatMs: envelope.payload.server?.heartbeat_ms,
    });

    this.sessionId = envelope.payload.session_id;
    this.resumeToken = envelope.payload.resume_token;
    this.reconnectAttempts = 0;
    this.reconnectDelay = this.config.reconnectDelayMs;
    this.setState('READY');

    clientLog(this.config.agentName, 'CLIENT_NOW_READY', {
      sessionId: this.sessionId?.substring(0, 8),
      readyToSendAndReceive: true,
    });

    if (!this.config.quiet) {
      console.log(`[client] Connected as ${this.config.agentName} (session: ${this.sessionId})`);
    }
  }

  private handleDeliver(envelope: DeliverEnvelope): void {
    clientLog(this.config.agentName, 'DELIVER_RECEIVED', {
      messageId: envelope.id.substring(0, 8),
      from: envelope.from,
      kind: envelope.payload.kind,
      seq: envelope.delivery.seq,
      originalTo: envelope.delivery.originalTo,
      bodyPreview: envelope.payload.body?.substring(0, 50),
    });

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

    const duplicate = this.markDelivered(envelope.id);
    if (duplicate) {
      clientLog(this.config.agentName, 'DELIVER_DUPLICATE', {
        messageId: envelope.id.substring(0, 8),
        from: envelope.from,
      });
      return;
    }

    // Notify handler
    // Pass originalTo from delivery info so handlers know if this was a broadcast
    if (this.onMessage && envelope.from) {
      clientLog(this.config.agentName, 'DELIVER_INVOKING_HANDLER', {
        messageId: envelope.id.substring(0, 8),
        from: envelope.from,
        hasHandler: true,
      });
      this.onMessage(envelope.from, envelope.payload, envelope.id, envelope.payload_meta, envelope.delivery.originalTo);
    } else {
      clientLog(this.config.agentName, 'DELIVER_NO_HANDLER', {
        messageId: envelope.id.substring(0, 8),
        from: envelope.from,
        hasOnMessage: !!this.onMessage,
        hasFrom: !!envelope.from,
      });
    }
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
   * Check if message was already delivered (deduplication).
   * Uses circular buffer for O(1) eviction.
   * @returns true if the message has already been seen.
   */
  private markDelivered(id: string): boolean {
    return this.dedupeCache.check(id);
  }
}
