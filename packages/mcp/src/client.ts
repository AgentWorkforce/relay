/**
 * RelayClient - Client for connecting to the Agent Relay daemon
 *
 * This module uses @agent-relay/protocol for wire format handling
 * to avoid code duplication with the SDK.
 */

import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { discoverSocket } from './cloud.js';
import { DaemonNotRunningError } from './errors.js';

// Import shared protocol types and framing utilities
import {
  type Envelope,
  type MessageType,
  type SendPayload,
  type AckPayload,
  type SpawnPayload,
  type SpawnResultPayload,
  type ReleasePayload,
  type ReleaseResultPayload,
  type InboxPayload,
  type ListAgentsPayload,
  type HealthPayload,
  type MetricsPayload,
  type HealthResponsePayload,
  type MetricsResponsePayload,
  encodeFrameLegacy,
  PROTOCOL_VERSION,
} from '@agent-relay/protocol';

// Import shared client helpers for consistency
import {
  createRequestEnvelope,
  createRequestHandler,
  generateRequestId,
  toSpawnResult,
  toReleaseResult,
  type SpawnResult,
  type ReleaseResult,
  type RequestOptions,
} from '@agent-relay/utils/client-helpers';

// Re-export response types for consumers
export type HealthResponse = HealthResponsePayload;
export type MetricsResponse = MetricsResponsePayload;

export interface RelayClient {
  // Basic messaging
  send(to: string, message: string, options?: { thread?: string; kind?: string; data?: Record<string, unknown> }): Promise<void>;
  sendAndWait(to: string, message: string, options?: { thread?: string; timeoutMs?: number; kind?: string; data?: Record<string, unknown> }): Promise<AckPayload>;
  broadcast(message: string, options?: { kind?: string }): Promise<void>;

  // Spawn/Release
  spawn(options: { name: string; cli: string; task: string; model?: string; cwd?: string }): Promise<SpawnResult>;
  release(name: string, reason?: string): Promise<ReleaseResult>;

  // Pub/Sub
  subscribe(topic: string): Promise<{ success: boolean; error?: string }>;
  unsubscribe(topic: string): Promise<{ success: boolean; error?: string }>;

  // Channel operations
  joinChannel(channel: string, displayName?: string): Promise<{ success: boolean; error?: string }>;
  leaveChannel(channel: string, reason?: string): Promise<{ success: boolean; error?: string }>;
  sendChannelMessage(channel: string, message: string, options?: { thread?: string }): Promise<void>;

  // Shadow agent operations
  bindAsShadow(primaryAgent: string, options?: { speakOn?: string[] }): Promise<{ success: boolean; error?: string }>;
  unbindAsShadow(primaryAgent: string): Promise<{ success: boolean; error?: string }>;

  // Consensus operations
  createProposal(options: { id: string; description: string; options: string[]; votingMethod?: string; deadline?: number }): Promise<{ success: boolean; error?: string }>;
  vote(options: { proposalId: string; vote: string; reason?: string }): Promise<{ success: boolean; error?: string }>;

  // Query operations
  getStatus(): Promise<{ connected: boolean; agentName: string; project: string; socketPath: string; daemonVersion?: string; uptime?: string }>;
  getInbox(options?: { limit?: number; unread_only?: boolean; from?: string; channel?: string }): Promise<Array<{ id: string; from: string; content: string; channel?: string; thread?: string }>>;
  listAgents(options?: { include_idle?: boolean; project?: string }): Promise<Array<{ name: string; cli?: string; idle?: boolean; parent?: string }>>;
  listConnectedAgents(options?: { project?: string }): Promise<Array<{ name: string; cli?: string; idle?: boolean; parent?: string }>>;
  removeAgent(name: string, options?: { removeMessages?: boolean }): Promise<{ success: boolean; removed: boolean; message?: string }>;
  getHealth(options?: { include_crashes?: boolean; include_alerts?: boolean }): Promise<HealthResponse>;
  getMetrics(options?: { agent?: string }): Promise<MetricsResponse>;
}

export interface RelayClientOptions {
  agentName: string;
  socketPath?: string;
  project?: string;
  timeout?: number;
}

export function createRelayClient(options: RelayClientOptions): RelayClient {
  const { agentName, project = 'default', timeout = 5000 } = options;
  // Prefer explicit socketPath option over discovery to avoid finding wrong daemon
  const socketPath = options.socketPath || discoverSocket()?.socketPath || '/tmp/agent-relay.sock';

  // Generate unique IDs with MCP prefix
  const generateId = () => generateRequestId('mcp-');

  // Timeouts for different operations
  const RELEASE_TIMEOUT = 10000; // 10 seconds for release operations
  const SPAWN_TIMEOUT = 30000; // 30 seconds for spawn operations

  /**
   * Fire-and-forget: Send a message without waiting for any response.
   * Used for SEND and SPAWN where we don't expect daemon to reply.
   */
  function fireAndForget(type: MessageType, payload: Record<string, unknown>, envelopeProps?: { from?: string; to?: string }): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = generateId();
      const envelope: Envelope = {
        v: PROTOCOL_VERSION,
        type,
        id,
        ts: Date.now(),
        payload,
        from: envelopeProps?.from,
        to: envelopeProps?.to,
      };

      const socket: Socket = createConnection(socketPath);

      socket.on('connect', () => {
        socket.write(encodeFrameLegacy(envelope));
        socket.end();
        resolve();
      });

      socket.on('error', (err) => {
        const errno = (err as NodeJS.ErrnoException).code;
        if (errno === 'ECONNREFUSED' || errno === 'ENOENT') {
          reject(new DaemonNotRunningError(`Cannot connect to daemon at ${socketPath}`));
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Request-response: Send a message and wait for daemon to respond.
   * Used for queries (STATUS, INBOX, etc.) and blocking sends (waits for ACK).
   */
  async function request<T>(
    type: MessageType,
    payload: Record<string, unknown>,
    customTimeout?: number,
    payloadMeta?: RequestOptions['payloadMeta'],
    envelopeProps?: RequestOptions['envelopeProps']
  ): Promise<T> {
    const id = generateId();
    const envelope = createRequestEnvelope(type, payload, id, {
      payloadMeta,
      envelopeProps,
    });

    try {
      return await createRequestHandler<T>(socketPath, envelope, {
        timeout: customTimeout ?? timeout,
        payloadMeta,
        envelopeProps,
      });
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code;
      if (errno === 'ECONNREFUSED' || errno === 'ENOENT') {
        throw new DaemonNotRunningError(`Cannot connect to daemon at ${socketPath}`);
      }
      throw err;
    }
  }

  return {
    async send(to, message, opts = {}) {
      const payload: SendPayload = {
        kind: (opts.kind as SendPayload['kind']) || 'message',
        body: message,
        thread: opts.thread,
        data: opts.data,
      };
      await fireAndForget('SEND', payload as unknown as Record<string, unknown>, { from: agentName, to });
    },

    async sendAndWait(to, message, opts = {}) {
      const waitTimeout = opts.timeoutMs || 30000;
      const correlationId = randomUUID();
      const payload: SendPayload = {
        kind: (opts.kind as SendPayload['kind']) || 'message',
        body: message,
        thread: opts.thread,
        data: opts.data,
      };

      const ack = await request<AckPayload>(
        'SEND',
        payload as unknown as Record<string, unknown>,
        waitTimeout + 5000,
        { sync: { blocking: true, correlationId, timeoutMs: waitTimeout } },
        { from: agentName, to }
      );
      return ack;
    },

    async broadcast(message, opts = {}) {
      const payload: SendPayload = { kind: (opts.kind as SendPayload['kind']) || 'message', body: message };
      await fireAndForget('SEND', payload as unknown as Record<string, unknown>, { from: agentName, to: '*' });
    },

    async subscribe(topic) {
      try {
        await fireAndForget('SUBSCRIBE', { topic }, { from: agentName });
        return { success: true };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async unsubscribe(topic) {
      try {
        await fireAndForget('UNSUBSCRIBE', { topic }, { from: agentName });
        return { success: true };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async joinChannel(channel, displayName) {
      try {
        await fireAndForget('CHANNEL_JOIN', { channel, displayName }, { from: agentName });
        return { success: true };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async leaveChannel(channel, reason) {
      try {
        await fireAndForget('CHANNEL_LEAVE', { channel, reason }, { from: agentName });
        return { success: true };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async sendChannelMessage(channel, message, opts = {}) {
      await fireAndForget('CHANNEL_MESSAGE', { channel, body: message, thread: opts.thread }, { from: agentName });
    },

    async bindAsShadow(primaryAgent, opts = {}) {
      try {
        await fireAndForget('SHADOW_BIND', { primaryAgent, speakOn: opts.speakOn }, { from: agentName });
        return { success: true };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async unbindAsShadow(primaryAgent) {
      try {
        await fireAndForget('SHADOW_UNBIND', { primaryAgent }, { from: agentName });
        return { success: true };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async createProposal(opts) {
      try {
        await fireAndForget('PROPOSAL_CREATE', {
          id: opts.id,
          description: opts.description,
          options: opts.options,
          votingMethod: opts.votingMethod || 'majority',
          deadline: opts.deadline,
        }, { from: agentName });
        return { success: true };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async vote(opts) {
      try {
        await fireAndForget('VOTE', {
          proposalId: opts.proposalId,
          vote: opts.vote,
          reason: opts.reason,
        }, { from: agentName });
        return { success: true };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async spawn(opts) {
      try {
        const payload: SpawnPayload = {
          name: opts.name,
          cli: opts.cli,
          task: opts.task,
          model: opts.model,
          cwd: opts.cwd,
          spawnerName: agentName,
        };
        const result = await request<SpawnResultPayload>(
          'SPAWN',
          payload as unknown as Record<string, unknown>,
          SPAWN_TIMEOUT,
          undefined,
          { from: agentName }
        );
        return toSpawnResult(result);
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async release(name, reason) {
      try {
        const payload: ReleasePayload = { name, reason };
        const result = await request<ReleaseResultPayload>(
          'RELEASE',
          payload as unknown as Record<string, unknown>,
          RELEASE_TIMEOUT,
          undefined,
          { from: agentName }
        );
        return toReleaseResult(result);
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async getStatus() {
      try {
        const s = await request<{ version?: string; uptime?: number }>('STATUS', {});
        return { connected: true, agentName, project, socketPath, daemonVersion: s.version, uptime: s.uptime ? Math.floor(s.uptime/1000)+'s' : undefined };
      } catch {
        return { connected: false, agentName, project, socketPath };
      }
    },

    async getInbox(opts = {}) {
      const payload: InboxPayload = {
        agent: agentName,
        limit: opts.limit,
        unreadOnly: opts.unread_only,
        from: opts.from,
        channel: opts.channel,
      };
      const response = await request<{ messages: Array<{ id: string; from: string; body: string; channel?: string; thread?: string; timestamp: number }> }>(
        'INBOX',
        payload as unknown as Record<string, unknown>
      );
      const msgs = response.messages || [];
      return msgs.map(m => ({ id: m.id, from: m.from, content: m.body, channel: m.channel, thread: m.thread }));
    },

    async listAgents(opts: { include_idle?: boolean; project?: string } = {}) {
      const payload: ListAgentsPayload = {
        includeIdle: opts.include_idle,
        project: opts.project,
      };
      const response = await request<{ agents: Array<{ name: string; cli?: string; idle?: boolean; parent?: string }> }>(
        'LIST_AGENTS',
        payload as unknown as Record<string, unknown>
      );
      return response.agents || [];
    },

    async listConnectedAgents(opts: { project?: string } = {}) {
      const payload = { project: opts.project };
      const response = await request<{ agents: Array<{ name: string; cli?: string; idle?: boolean; parent?: string }> }>(
        'LIST_CONNECTED_AGENTS',
        payload
      );
      return response.agents || [];
    },

    async removeAgent(name: string, opts: { removeMessages?: boolean } = {}) {
      const payload = { name, removeMessages: opts.removeMessages };
      return request<{ success: boolean; removed: boolean; message?: string }>('REMOVE_AGENT', payload);
    },

    async getHealth(opts: { include_crashes?: boolean; include_alerts?: boolean } = {}) {
      const payload: HealthPayload = {
        includeCrashes: opts.include_crashes,
        includeAlerts: opts.include_alerts,
      };
      return request<HealthResponse>('HEALTH', payload as unknown as Record<string, unknown>);
    },

    async getMetrics(opts: { agent?: string } = {}) {
      const payload: MetricsPayload = { agent: opts.agent };
      return request<MetricsResponse>('METRICS', payload as unknown as Record<string, unknown>);
    },
  };
}

export default createRelayClient;
