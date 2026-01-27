/**
 * RelayClient - Agent Relay SDK Client
 * @agent-relay/sdk
 *
 * Lightweight client for agent-to-agent communication via Agent Relay daemon.
 */

import net from 'node:net';
import { randomUUID } from 'node:crypto';
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
  type SpawnPayload,
  type SpawnResultPayload,
  type ReleasePayload,
  type ReleaseResultPayload,
  type SpawnEnvelope,
  type ReleaseEnvelope,
  type StatusResponsePayload,
  type InboxPayload,
  type InboxMessage,
  type InboxResponsePayload,
  type ListAgentsPayload,
  type AgentInfo,
  type ListAgentsResponsePayload,
  type ListConnectedAgentsPayload,
  type ListConnectedAgentsResponsePayload,
  type RemoveAgentPayload,
  type RemoveAgentResponsePayload,
  type HealthPayload,
  type HealthResponsePayload,
  type MetricsPayload,
  type MetricsResponsePayload,
  type ConsensusType,
  type VoteValue,
  type CreateProposalOptions,
  type VoteOptions,
  PROTOCOL_VERSION,
} from './protocol/types.js';
import { encodeFrameLegacy, FrameParser } from './protocol/framing.js';

export type ClientState = 'DISCONNECTED' | 'CONNECTING' | 'HANDSHAKING' | 'READY' | 'BACKOFF';

export interface SyncOptions {
  timeoutMs?: number;
  kind?: PayloadKind;
  data?: Record<string, unknown>;
  thread?: string;
}

export interface ClientConfig {
  /** Daemon socket path (default: /tmp/agent-relay.sock) */
  socketPath: string;
  /** Agent name */
  agentName: string;
  /** Entity type: 'agent' (default) or 'user' */
  entityType?: EntityType;
  /** CLI identifier (claude, codex, gemini, etc.) */
  cli?: string;
  /** Program identifier */
  program?: string;
  /** Model identifier */
  model?: string;
  /** Task description */
  task?: string;
  /** Working directory */
  workingDirectory?: string;
  /** Display name for human users */
  displayName?: string;
  /** Avatar URL for human users */
  avatarUrl?: string;
  /** Suppress console logging */
  quiet?: boolean;
  /** Auto-reconnect on disconnect */
  reconnect: boolean;
  /** Max reconnect attempts */
  maxReconnectAttempts: number;
  /** Initial reconnect delay (ms) */
  reconnectDelayMs: number;
  /** Max reconnect delay (ms) */
  reconnectMaxDelayMs: number;
}

const DEFAULT_SOCKET_PATH = '/tmp/agent-relay.sock';

const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  socketPath: DEFAULT_SOCKET_PATH,
  agentName: 'agent',
  cli: undefined,
  quiet: false,
  reconnect: true,
  maxReconnectAttempts: 10,
  reconnectDelayMs: 1000, // Increased from 100ms to prevent reconnect storms
  reconnectMaxDelayMs: 30000,
};

// Simple ID generator
let idCounter = 0;
function generateId(): string {
  return `${Date.now().toString(36)}-${(++idCounter).toString(36)}`;
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
 * RelayClient for agent-to-agent communication.
 */
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

  private dedupeCache = new CircularDedupeCache(2000);
  private writeQueue: Buffer[] = [];
  private writeScheduled = false;

  private pendingSyncAcks: Map<string, {
    resolve: (ack: AckPayload) => void;
    reject: (err: Error) => void;
    timeoutHandle: NodeJS.Timeout;
  }> = new Map();

  private pendingSpawns: Map<string, {
    resolve: (result: SpawnResultPayload) => void;
    reject: (err: Error) => void;
    timeoutHandle: NodeJS.Timeout;
  }> = new Map();

  private pendingReleases: Map<string, {
    resolve: (result: ReleaseResultPayload) => void;
    reject: (err: Error) => void;
    timeoutHandle: NodeJS.Timeout;
  }> = new Map();

  private pendingQueries: Map<string, {
    resolve: (payload: unknown) => void;
    reject: (err: Error) => void;
    timeoutHandle: NodeJS.Timeout;
  }> = new Map();

  // Event handlers
  onMessage?: (from: string, payload: SendPayload, messageId: string, meta?: SendMeta, originalTo?: string) => void;
  /**
   * Callback for channel messages.
   */
  onChannelMessage?: (from: string, channel: string, body: string, envelope: Envelope<ChannelMessagePayload>) => void;
  onStateChange?: (state: ClientState) => void;
  onError?: (error: Error) => void;

  constructor(config: Partial<ClientConfig> = {}) {
    this.config = { ...DEFAULT_CLIENT_CONFIG, ...config };
    this.parser = new FrameParser();
    this.parser.setLegacyMode(true);
    this.reconnectDelay = this.config.reconnectDelayMs;
  }

  get state(): ClientState {
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

      const checkReady = setInterval(() => {
        if (this._state === 'READY') {
          clearInterval(checkReady);
          clearTimeout(timeout);
          settleResolve();
        }
      }, 10);

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
   * Send a message and wait for ACK response.
   */
  async sendAndWait(to: string, body: string, options: SyncOptions = {}): Promise<AckPayload> {
    if (this._state !== 'READY') {
      throw new Error('Client not ready');
    }

    const correlationId = randomUUID();
    const timeoutMs = options.timeoutMs ?? 30000;
    const kind = options.kind ?? 'message';

    return new Promise<AckPayload>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingSyncAcks.delete(correlationId);
        reject(new Error(`ACK timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingSyncAcks.set(correlationId, { resolve, reject, timeoutHandle });

      const envelope: SendEnvelope = {
        v: PROTOCOL_VERSION,
        type: 'SEND',
        id: generateId(),
        ts: Date.now(),
        to,
        payload: {
          kind,
          body,
          data: options.data,
          thread: options.thread,
        },
        payload_meta: {
          sync: {
            correlationId,
            timeoutMs,
            blocking: true,
          },
        },
      };

      const sent = this.send(envelope);
      if (!sent) {
        clearTimeout(timeoutHandle);
        this.pendingSyncAcks.delete(correlationId);
        reject(new Error('Failed to send message'));
      }
    });
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
   * Send log output to the daemon for dashboard streaming.
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
  // Spawn/Release Operations
  // =============================================================================

  /**
   * Spawn a new agent via the relay daemon.
   * @param options - Spawn options
   * @param options.name - Name for the new agent
   * @param options.cli - CLI to use (claude, codex, gemini, etc.)
   * @param options.task - Task description
   * @param options.cwd - Working directory
   * @param options.team - Team name
   * @param options.interactive - Interactive mode
   * @param options.shadowOf - Spawn as shadow of this agent
   * @param options.shadowSpeakOn - Shadow speak-on triggers
   * @param timeoutMs - Timeout for spawn operation (default: 30000ms)
   */
  async spawn(
    options: {
      name: string;
      cli: string;
      task?: string;
      cwd?: string;
      team?: string;
      interactive?: boolean;
      shadowOf?: string;
      shadowSpeakOn?: SpeakOnTrigger[];
    },
    timeoutMs = 30000
  ): Promise<SpawnResultPayload> {
    if (this._state !== 'READY') {
      throw new Error('Client not ready');
    }

    const envelopeId = generateId();

    return new Promise<SpawnResultPayload>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingSpawns.delete(envelopeId);
        reject(new Error(`Spawn timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingSpawns.set(envelopeId, { resolve, reject, timeoutHandle });

      const envelope: SpawnEnvelope = {
        v: PROTOCOL_VERSION,
        type: 'SPAWN',
        id: envelopeId,
        ts: Date.now(),
        payload: {
          name: options.name,
          cli: options.cli,
          task: options.task || '',
          cwd: options.cwd,
          team: options.team,
          interactive: options.interactive,
          shadowOf: options.shadowOf,
          shadowSpeakOn: options.shadowSpeakOn,
          spawnerName: this.config.agentName,
        },
      };

      const sent = this.send(envelope);
      if (!sent) {
        clearTimeout(timeoutHandle);
        this.pendingSpawns.delete(envelopeId);
        reject(new Error('Failed to send spawn message'));
      }
    });
  }

  /**
   * Release (terminate) an agent via the relay daemon.
   * @param name - Agent name to release
   * @param timeoutMs - Timeout for release operation (default: 10000ms)
   */
  async release(name: string, timeoutMs = 10000): Promise<ReleaseResultPayload> {
    if (this._state !== 'READY') {
      throw new Error('Client not ready');
    }

    const envelopeId = generateId();

    return new Promise<ReleaseResultPayload>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingReleases.delete(envelopeId);
        reject(new Error(`Release timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingReleases.set(envelopeId, { resolve, reject, timeoutHandle });

      const envelope: ReleaseEnvelope = {
        v: PROTOCOL_VERSION,
        type: 'RELEASE',
        id: envelopeId,
        ts: Date.now(),
        payload: {
          name,
        },
      };

      const sent = this.send(envelope);
      if (!sent) {
        clearTimeout(timeoutHandle);
        this.pendingReleases.delete(envelopeId);
        reject(new Error('Failed to send release message'));
      }
    });
  }

  // =============================================================================
  // Channel Operations
  // =============================================================================

  /**
   * Join a channel.
   * @param channel - Channel name (e.g., '#general', 'dm:alice:bob')
   * @param displayName - Optional display name for this member
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
   * Admin join: Add any member to a channel (does not require member to be connected).
   * @param channel - Channel name
   * @param member - Name of the member to add
   */
  adminJoinChannel(channel: string, member: string): boolean {
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
        member,
      },
    };

    return this.send(envelope);
  }

  /**
   * Leave a channel.
   * @param channel - Channel name to leave
   * @param reason - Optional reason for leaving
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
   * Admin remove: Remove any member from a channel.
   * @param channel - Channel name
   * @param member - Name of the member to remove
   */
  adminRemoveMember(channel: string, member: string): boolean {
    if (this._state !== 'READY') {
      return false;
    }

    const envelope: ChannelLeaveEnvelope = {
      v: PROTOCOL_VERSION,
      type: 'CHANNEL_LEAVE',
      id: generateId(),
      ts: Date.now(),
      payload: {
        channel,
        member,
      },
    };

    return this.send(envelope);
  }

  /**
   * Send a message to a channel.
   * @param channel - Channel name
   * @param body - Message content
   * @param options - Optional thread, mentions, attachments
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
  // Consensus Operations
  // =============================================================================

  /**
   * Create a consensus proposal.
   *
   * The proposal will be broadcast to all participants. They can vote using
   * the `vote()` method. Results are delivered via `onMessage` callback.
   *
   * @example
   * ```typescript
   * client.createProposal({
   *   title: 'Approve API design',
   *   description: 'Should we proceed with the REST API design?',
   *   participants: ['Developer', 'Reviewer', 'Lead'],
   *   consensusType: 'majority',
   * });
   * ```
   *
   * @param options - Proposal options
   * @returns true if the message was sent
   */
  createProposal(options: CreateProposalOptions): boolean {
    if (this._state !== 'READY') {
      return false;
    }

    // Build the PROPOSE command message
    const lines: string[] = [
      `PROPOSE: ${options.title}`,
      `TYPE: ${options.consensusType ?? 'majority'}`,
      `PARTICIPANTS: ${options.participants.join(', ')}`,
      `DESCRIPTION: ${options.description}`,
    ];

    if (options.timeoutMs !== undefined) {
      lines.push(`TIMEOUT: ${options.timeoutMs}`);
    }
    if (options.quorum !== undefined) {
      lines.push(`QUORUM: ${options.quorum}`);
    }
    if (options.threshold !== undefined) {
      lines.push(`THRESHOLD: ${options.threshold}`);
    }

    const body = lines.join('\n');

    // Send to the special _consensus recipient
    return this.sendMessage('_consensus', body, 'action');
  }

  /**
   * Vote on a consensus proposal.
   *
   * @example
   * ```typescript
   * // Approve with a reason
   * client.vote({
   *   proposalId: 'prop_123',
   *   value: 'approve',
   *   reason: 'Looks good to me',
   * });
   *
   * // Reject without reason
   * client.vote({ proposalId: 'prop_123', value: 'reject' });
   * ```
   *
   * @param options - Vote options
   * @returns true if the message was sent
   */
  vote(options: VoteOptions): boolean {
    if (this._state !== 'READY') {
      return false;
    }

    // Build the VOTE command
    let body = `VOTE ${options.proposalId} ${options.value}`;
    if (options.reason) {
      body += ` ${options.reason}`;
    }

    // Send to the special _consensus recipient
    return this.sendMessage('_consensus', body, 'action');
  }

  // =============================================================================
  // Query Operations
  // =============================================================================

  /**
   * Send a query to the daemon and wait for a response.
   * @internal
   */
  private async query<T>(type: string, payload: unknown, timeoutMs = 5000): Promise<T> {
    if (this._state !== 'READY') {
      throw new Error('Client not ready');
    }

    const envelopeId = generateId();

    return new Promise<T>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingQueries.delete(envelopeId);
        reject(new Error(`Query timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingQueries.set(envelopeId, {
        resolve: resolve as (p: unknown) => void,
        reject,
        timeoutHandle,
      });

      const envelope: Envelope = {
        v: PROTOCOL_VERSION,
        type: type as Envelope['type'],
        id: envelopeId,
        ts: Date.now(),
        payload,
      };

      const sent = this.send(envelope);
      if (!sent) {
        clearTimeout(timeoutHandle);
        this.pendingQueries.delete(envelopeId);
        reject(new Error(`Failed to send ${type} query`));
      }
    });
  }

  /**
   * Get daemon status information.
   * @returns Daemon status including version, uptime, and counts
   */
  async getStatus(): Promise<StatusResponsePayload> {
    return this.query<StatusResponsePayload>('STATUS', {});
  }

  /**
   * Get messages from the inbox.
   * @param options - Filter options
   * @param options.limit - Maximum number of messages to return
   * @param options.unreadOnly - Only return unread messages
   * @param options.from - Filter by sender
   * @param options.channel - Filter by channel
   * @returns Array of inbox messages
   */
  async getInbox(options: {
    limit?: number;
    unreadOnly?: boolean;
    from?: string;
    channel?: string;
  } = {}): Promise<InboxMessage[]> {
    const payload: InboxPayload = {
      agent: this.config.agentName,
      limit: options.limit,
      unreadOnly: options.unreadOnly,
      from: options.from,
      channel: options.channel,
    };
    const response = await this.query<InboxResponsePayload>('INBOX', payload);
    return response.messages || [];
  }

  /**
   * List online agents.
   * @param options - Filter options
   * @param options.includeIdle - Include idle agents (default: true)
   * @param options.project - Filter by project
   * @returns Array of agent info
   */
  async listAgents(options: {
    includeIdle?: boolean;
    project?: string;
  } = {}): Promise<AgentInfo[]> {
    const payload: ListAgentsPayload = {
      includeIdle: options.includeIdle ?? true,
      project: options.project,
    };
    const response = await this.query<ListAgentsResponsePayload>('LIST_AGENTS', payload);
    return response.agents || [];
  }

  /**
   * Get system health information.
   * @param options - Include options
   * @param options.includeCrashes - Include crash history (default: true)
   * @param options.includeAlerts - Include alerts (default: true)
   * @returns Health information including score, issues, and recommendations
   */
  async getHealth(options: {
    includeCrashes?: boolean;
    includeAlerts?: boolean;
  } = {}): Promise<HealthResponsePayload> {
    const payload: HealthPayload = {
      includeCrashes: options.includeCrashes ?? true,
      includeAlerts: options.includeAlerts ?? true,
    };
    return this.query<HealthResponsePayload>('HEALTH', payload);
  }

  /**
   * Get resource metrics for agents.
   * @param options - Filter options
   * @param options.agent - Filter to a specific agent
   * @returns Metrics including memory, CPU, and system info
   */
  async getMetrics(options: {
    agent?: string;
  } = {}): Promise<MetricsResponsePayload> {
    const payload: MetricsPayload = {
      agent: options.agent,
    };
    return this.query<MetricsResponsePayload>('METRICS', payload);
  }

  /**
   * List only currently connected agents (not historical/registered agents).
   * Use this instead of listAgents() when you need accurate liveness information.
   * @param options - Filter options
   * @param options.project - Filter by project
   * @returns Array of currently connected agent info
   */
  async listConnectedAgents(options: {
    project?: string;
  } = {}): Promise<AgentInfo[]> {
    const payload: ListConnectedAgentsPayload = {
      project: options.project,
    };
    const response = await this.query<ListConnectedAgentsResponsePayload>('LIST_CONNECTED_AGENTS', payload);
    return response.agents || [];
  }

  /**
   * Remove an agent from the registry (sessions, agents.json).
   * Use this to clean up stale agents that are no longer needed.
   * @param name - Agent name to remove
   * @param options - Removal options
   * @param options.removeMessages - Also remove all messages from/to this agent (default: false)
   * @returns Result indicating if the agent was removed
   */
  async removeAgent(name: string, options: {
    removeMessages?: boolean;
  } = {}): Promise<RemoveAgentResponsePayload> {
    const payload: RemoveAgentPayload = {
      name,
      removeMessages: options.removeMessages,
    };
    return this.query<RemoveAgentResponsePayload>('REMOVE_AGENT', payload);
  }

  // Private methods

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
      id: generateId(),
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

    this.send(hello);
  }

  private send(envelope: Envelope): boolean {
    if (!this.socket) return false;

    try {
      const frame = encodeFrameLegacy(envelope);
      this.writeQueue.push(frame);

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

  private flushWrites(): void {
    this.writeScheduled = false;
    if (this.writeQueue.length === 0 || !this.socket) return;

    if (this.writeQueue.length === 1) {
      this.socket.write(this.writeQueue[0]);
    } else {
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

      case 'CHANNEL_MESSAGE':
        this.handleChannelMessage(envelope as Envelope<ChannelMessagePayload> & { from?: string });
        break;

      case 'PING':
        this.handlePing(envelope);
        break;

      case 'ACK':
        this.handleAck(envelope as Envelope<AckPayload>);
        break;

      case 'SPAWN_RESULT':
        this.handleSpawnResult(envelope as Envelope<SpawnResultPayload>);
        break;

      case 'RELEASE_RESULT':
        this.handleReleaseResult(envelope as Envelope<ReleaseResultPayload>);
        break;

      case 'ERROR':
        this.handleErrorFrame(envelope as Envelope<ErrorPayload>);
        break;

      case 'BUSY':
        if (!this.config.quiet) {
          console.warn('[sdk] Server busy, backing off');
        }
        break;

      case 'STATUS_RESPONSE':
      case 'INBOX_RESPONSE':
      case 'LIST_AGENTS_RESPONSE':
      case 'LIST_CONNECTED_AGENTS_RESPONSE':
      case 'REMOVE_AGENT_RESPONSE':
      case 'HEALTH_RESPONSE':
      case 'METRICS_RESPONSE':
        this.handleQueryResponse(envelope);
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

  private handleChannelMessage(envelope: Envelope<ChannelMessagePayload> & { from?: string }): void {
    const duplicate = this.dedupeCache.check(envelope.id);
    if (duplicate) {
      return;
    }

    // Notify channel message handler
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

  private handleSpawnResult(envelope: Envelope<SpawnResultPayload>): void {
    const replyTo = envelope.payload.replyTo;
    if (!replyTo) return;

    const pending = this.pendingSpawns.get(replyTo);
    if (!pending) return;

    clearTimeout(pending.timeoutHandle);
    this.pendingSpawns.delete(replyTo);
    pending.resolve(envelope.payload);
  }

  private handleReleaseResult(envelope: Envelope<ReleaseResultPayload>): void {
    const replyTo = envelope.payload.replyTo;
    if (!replyTo) return;

    const pending = this.pendingReleases.get(replyTo);
    if (!pending) return;

    clearTimeout(pending.timeoutHandle);
    this.pendingReleases.delete(replyTo);
    pending.resolve(envelope.payload);
  }

  private handleQueryResponse(envelope: Envelope): void {
    // Query responses use the envelope id to match requests
    const pending = this.pendingQueries.get(envelope.id);
    if (!pending) return;

    clearTimeout(pending.timeoutHandle);
    this.pendingQueries.delete(envelope.id);
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

    // Fatal errors (like DUPLICATE_CONNECTION) should prevent reconnection
    if (envelope.payload.fatal) {
      if (!this.config.quiet) {
        console.error('[sdk] Fatal error received, will not reconnect:', envelope.payload.message);
      }
      this._destroyed = true;
    }
  }

  private handleDisconnect(): void {
    this.parser.reset();
    this.socket = undefined;
    this.rejectPendingSyncAcks(new Error('Disconnected while awaiting ACK'));
    this.rejectPendingSpawns(new Error('Disconnected while awaiting spawn result'));
    this.rejectPendingReleases(new Error('Disconnected while awaiting release result'));
    this.rejectPendingQueries(new Error('Disconnected while awaiting query response'));

    if (this._destroyed) {
      this.setState('DISCONNECTED');
      return;
    }

    if (this.config.reconnect && this.reconnectAttempts < this.config.maxReconnectAttempts) {
      this.scheduleReconnect();
    } else {
      this.setState('DISCONNECTED');
      if (this.reconnectAttempts >= this.config.maxReconnectAttempts && !this.config.quiet) {
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

  private rejectPendingSpawns(error: Error): void {
    for (const [id, pending] of this.pendingSpawns.entries()) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(error);
      this.pendingSpawns.delete(id);
    }
  }

  private rejectPendingReleases(error: Error): void {
    for (const [id, pending] of this.pendingReleases.entries()) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(error);
      this.pendingReleases.delete(id);
    }
  }

  private rejectPendingQueries(error: Error): void {
    for (const [id, pending] of this.pendingQueries.entries()) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(error);
      this.pendingQueries.delete(id);
    }
  }

  private scheduleReconnect(): void {
    this.setState('BACKOFF');
    this.reconnectAttempts++;

    const jitter = Math.random() * 0.3 + 0.85;
    const delay = Math.min(this.reconnectDelay * jitter, this.config.reconnectMaxDelayMs);
    this.reconnectDelay *= 2;

    if (!this.config.quiet) {
      console.log(`[sdk] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);
    }

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {});
    }, delay);
  }
}

