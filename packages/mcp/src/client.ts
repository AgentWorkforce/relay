/**
 * RelayClient - Client for connecting to the Agent Relay daemon
 */

import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { discoverSocket } from './cloud.js';
import { DaemonNotRunningError } from './errors.js';

// ============================================================================
// Protocol Types - These MUST match @agent-relay/protocol types
// Keeping them local avoids circular dependencies but requires sync
// ============================================================================

/**
 * SendPayload for SEND messages.
 * IMPORTANT: `from` and `to` go at envelope level, NOT in payload!
 */
interface SendPayload {
  kind: 'message' | 'action' | 'state' | 'thinking';
  body: string;
  data?: Record<string, unknown>;
  thread?: string;
}

/**
 * Envelope routing properties - go at top level, NOT in payload.
 */
interface EnvelopeRouting {
  from?: string;
  to?: string;
}

/**
 * SpawnPayload for SPAWN messages.
 */
interface SpawnPayload {
  name: string;
  cli: string;
  task: string;
  team?: string;
  cwd?: string;
  model?: string;
  socketPath?: string;
  spawnerName?: string;  // Parent agent name
  interactive?: boolean;
}

/**
 * ReleasePayload for RELEASE messages.
 */
interface ReleasePayload {
  name: string;
  reason?: string;
}

/**
 * InboxPayload for INBOX queries.
 */
interface InboxPayload {
  agent: string;
  limit?: number;
  unreadOnly?: boolean;
  from?: string;
  channel?: string;
}

/**
 * ListAgentsPayload for LIST_AGENTS queries.
 */
interface ListAgentsPayload {
  includeIdle?: boolean;
  project?: string;
}

/**
 * HealthPayload for HEALTH queries.
 */
interface HealthPayload {
  includeCrashes?: boolean;
  includeAlerts?: boolean;
}

/**
 * MetricsPayload for METRICS queries.
 */
interface MetricsPayload {
  agent?: string;
}

export interface HealthResponse {
  healthScore: number;
  summary: string;
  issues: Array<{ severity: string; message: string }>;
  recommendations: string[];
  crashes: Array<{ id: string; agentName: string; crashedAt: string; likelyCause: string; summary?: string }>;
  alerts: Array<{ id: string; agentName: string; alertType: string; message: string; createdAt: string }>;
  stats: { totalCrashes24h: number; totalAlerts24h: number; agentCount: number };
}

export interface MetricsResponse {
  agents: Array<{
    name: string;
    pid?: number;
    status: string;
    rssBytes?: number;
    cpuPercent?: number;
    trend?: string;
    alertLevel?: string;
    highWatermark?: number;
    uptimeMs?: number;
  }>;
  system: { totalMemory: number; freeMemory: number; heapUsed: number };
}

export interface RelayClient {
  send(to: string, message: string, options?: { thread?: string }): Promise<void>;
  sendAndWait(to: string, message: string, options?: { thread?: string; timeoutMs?: number }): Promise<{ from: string; content: string; thread?: string }>;
  spawn(options: { name: string; cli: string; task: string; model?: string; cwd?: string }): Promise<{ success: boolean; error?: string }>;
  release(name: string, reason?: string): Promise<{ success: boolean; error?: string }>;
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

// Protocol version
const PROTOCOL_VERSION = 1;

/**
 * Encode a message envelope into a length-prefixed frame (legacy format).
 * Format: 4-byte big-endian length + JSON payload
 */
function encodeFrame(envelope: Record<string, unknown>): Buffer {
  const json = JSON.stringify(envelope);
  const data = Buffer.from(json, 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 0);
  return Buffer.concat([header, data]);
}

/**
 * Frame parser for length-prefixed messages.
 */
class FrameParser {
  private buffer = Buffer.alloc(0);

  push(data: Buffer): Array<Record<string, unknown>> {
    this.buffer = Buffer.concat([this.buffer, data]);
    const frames: Array<Record<string, unknown>> = [];

    while (this.buffer.length >= 4) {
      const frameLength = this.buffer.readUInt32BE(0);
      const totalLength = 4 + frameLength;

      if (this.buffer.length < totalLength) break;

      const payload = this.buffer.subarray(4, totalLength);
      this.buffer = this.buffer.subarray(totalLength);

      try {
        frames.push(JSON.parse(payload.toString('utf-8')));
      } catch {
        // Skip malformed frames
      }
    }

    return frames;
  }
}

export function createRelayClient(options: RelayClientOptions): RelayClient {
  const { agentName, project = 'default', timeout = 5000 } = options;
  // Prefer explicit socketPath option over discovery to avoid finding wrong daemon
  const socketPath = options.socketPath || discoverSocket()?.socketPath || '/tmp/agent-relay.sock';

  // Generate unique IDs
  let idCounter = 0;
  const generateId = () => `mcp-${Date.now().toString(36)}-${(++idCounter).toString(36)}`;

  // Timeouts for different operations
  const RELEASE_TIMEOUT = 10000; // 10 seconds for release operations

  /** Union of all payload types for type safety */
  type AnyPayload = SendPayload | SpawnPayload | ReleasePayload | InboxPayload | ListAgentsPayload | HealthPayload | MetricsPayload | Record<string, unknown>;

  /**
   * Fire-and-forget: Send a message without waiting for any response.
   * Used for SEND and SPAWN where we don't expect daemon to reply.
   * @param type Message type
   * @param payload Message payload (for SEND: must be SendPayload with kind, body, etc.)
   * @param envelopeProps Envelope-level routing (from, to) - NOT in payload!
   */
  function fireAndForget(type: string, payload: AnyPayload, envelopeProps?: EnvelopeRouting): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = generateId();
      const envelope: Record<string, unknown> = {
        v: PROTOCOL_VERSION,
        type,
        id,
        ts: Date.now(),
        payload,
      };
      // Add from/to at envelope level (required for SEND messages)
      if (envelopeProps?.from) envelope.from = envelopeProps.from;
      if (envelopeProps?.to) envelope.to = envelopeProps.to;

      const socket: Socket = createConnection(socketPath);

      socket.on('connect', () => {
        socket.write(encodeFrame(envelope));
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
   * @param type Message type
   * @param payload Message payload (for SEND: must be SendPayload with kind, body, etc.)
   * @param customTimeout Optional timeout override
   * @param payloadMeta Optional sync metadata for blocking sends
   * @param envelopeProps Envelope-level routing (from, to) - NOT in payload!
   */
  async function request<T>(type: string, payload: AnyPayload, customTimeout?: number, payloadMeta?: { sync?: { blocking?: boolean; correlationId?: string; timeoutMs?: number } }, envelopeProps?: EnvelopeRouting): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = generateId();
      const correlationId = payloadMeta?.sync?.correlationId;
      // Build a proper protocol envelope
      const envelope: Record<string, unknown> = {
        v: PROTOCOL_VERSION,
        type,
        id,
        ts: Date.now(),
        payload,
      };
      // Add from/to at envelope level (required for SEND messages)
      if (envelopeProps?.from) envelope.from = envelopeProps.from;
      if (envelopeProps?.to) envelope.to = envelopeProps.to;
      if (payloadMeta) {
        envelope.payload_meta = payloadMeta;
      }
      let timedOut = false;
      const parser = new FrameParser();

      const socket: Socket = createConnection(socketPath);

      const effectiveTimeout = customTimeout ?? timeout;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        socket.destroy();
        reject(new Error(`Request timeout after ${effectiveTimeout}ms`));
      }, effectiveTimeout);

      socket.on('connect', () => socket.write(encodeFrame(envelope)));

      socket.on('data', (data) => {
        // Ignore data if we've already timed out
        if (timedOut) return;

        const frames = parser.push(data);
        for (const response of frames) {
          const responsePayload = response.payload as { replyTo?: string; correlationId?: string; error?: string; message?: string; code?: string };
          // Check if this is a response to our request (by id, replyTo, or correlationId for blocking sends)
          const isMatchingResponse = response.id === id ||
            responsePayload?.replyTo === id ||
            (correlationId && responsePayload?.correlationId === correlationId);

          if (isMatchingResponse) {
            clearTimeout(timeoutId);
            socket.end();
            // Handle error responses
            if (response.type === 'ERROR') {
              reject(new Error(responsePayload?.message || responsePayload?.code || 'Unknown error'));
            } else if (responsePayload?.error) {
              reject(new Error(responsePayload.error));
            } else {
              resolve(response.payload as T);
            }
            return;
          }
        }
      });

      socket.on('error', (err) => {
        clearTimeout(timeoutId);
        // Provide user-friendly error for common connection failures
        const errno = (err as NodeJS.ErrnoException).code;
        if (errno === 'ECONNREFUSED' || errno === 'ENOENT') {
          reject(new DaemonNotRunningError(`Cannot connect to daemon at ${socketPath}`));
        } else {
          reject(err);
        }
      });
    });
  }

  return {
    async send(to, message, opts = {}) {
      // Fire-and-forget: daemon doesn't respond to non-blocking SEND
      // from/to must be at envelope level, kind/body/thread in payload
      await fireAndForget('SEND', { kind: 'message', body: message, thread: opts.thread }, { from: agentName, to });
    },
    async sendAndWait(to, message, opts = {}) {
      // Use proper SEND with sync.blocking - daemon handles the wait and returns ACK
      // from/to must be at envelope level, kind/body/thread in payload
      const waitTimeout = opts.timeoutMs || 30000;
      const correlationId = randomUUID();
      const r = await request<{ correlationId?: string; response?: string; from?: string }>('SEND', {
        kind: 'message',
        body: message,
        thread: opts.thread,
      }, waitTimeout + 5000, {
        sync: {
          blocking: true,
          correlationId,
          timeoutMs: waitTimeout,
        },
      }, { from: agentName, to });
      return { from: r.from ?? to, content: r.response ?? '', thread: opts.thread };
    },
    async spawn(opts) {
      // Fire-and-forget: daemon handles spawning, agent will message when ready
      try {
        const payload: SpawnPayload = {
          name: opts.name,
          cli: opts.cli,
          task: opts.task,
          model: opts.model,
          cwd: opts.cwd,
          spawnerName: agentName,  // Parent agent making the spawn request
        };
        await fireAndForget('SPAWN', payload);
        return { success: true };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    async release(name, reason) {
      try {
        const payload: ReleasePayload = { name, reason };
        await request('RELEASE', payload, RELEASE_TIMEOUT);
        return { success: true };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    async getStatus() {
      try {
        const s = await request<{ version?: string; uptime?: number }>('STATUS', {});
        return { connected: true, agentName, project, socketPath, daemonVersion: s.version, uptime: s.uptime ? Math.floor(s.uptime/1000)+'s' : undefined };
      } catch { return { connected: false, agentName, project, socketPath }; }
    },
    async getInbox(opts = {}) {
      const payload: InboxPayload = {
        agent: agentName,
        limit: opts.limit,
        unreadOnly: opts.unread_only,
        from: opts.from,
        channel: opts.channel,
      };
      const response = await request<{ messages: Array<{ id: string; from: string; body: string; channel?: string; thread?: string; timestamp: number }> }>('INBOX', payload);
      const msgs = response.messages || [];
      return msgs.map(m => ({ id: m.id, from: m.from, content: m.body, channel: m.channel, thread: m.thread }));
    },
    async listAgents(opts: { include_idle?: boolean; project?: string } = {}) {
      const payload: ListAgentsPayload = {
        includeIdle: opts.include_idle,
        project: opts.project,
      };
      const response = await request<{ agents: Array<{ name: string; cli?: string; idle?: boolean; parent?: string }> }>('LIST_AGENTS', payload);
      return response.agents || [];
    },
    async listConnectedAgents(opts: { project?: string } = {}) {
      const payload = { project: opts.project };
      const response = await request<{ agents: Array<{ name: string; cli?: string; idle?: boolean; parent?: string }> }>('LIST_CONNECTED_AGENTS', payload);
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
      return request<HealthResponse>('HEALTH', payload);
    },
    async getMetrics(opts = {}) {
      const payload: MetricsPayload = { agent: opts.agent };
      return request<MetricsResponse>('METRICS', payload);
    },
  };
}

export default createRelayClient;
