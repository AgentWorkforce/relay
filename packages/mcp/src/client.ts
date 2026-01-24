/**
 * RelayClient - Client for connecting to the Agent Relay daemon
 */

import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { discoverSocket } from './cloud.js';
import { DaemonNotRunningError } from './errors.js';

export interface RelayClient {
  send(to: string, message: string, options?: { thread?: string }): Promise<void>;
  sendAndWait(to: string, message: string, options?: { thread?: string; timeoutMs?: number }): Promise<{ from: string; content: string; thread?: string }>;
  spawn(options: { name: string; cli: string; task: string; model?: string; cwd?: string }): Promise<{ success: boolean; error?: string }>;
  release(name: string, reason?: string): Promise<{ success: boolean; error?: string }>;
  getStatus(): Promise<{ connected: boolean; agentName: string; project: string; socketPath: string; daemonVersion?: string; uptime?: string }>;
  getInbox(options?: { limit?: number; unread_only?: boolean; from?: string; channel?: string }): Promise<Array<{ id: string; from: string; content: string; channel?: string; thread?: string }>>;
  listAgents(options?: { include_idle?: boolean; project?: string }): Promise<Array<{ name: string; cli: string; idle?: boolean; parent?: string }>>;
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
  const discovery = discoverSocket({ socketPath: options.socketPath });
  const socketPath = discovery?.socketPath || options.socketPath || '/tmp/agent-relay.sock';

  // Generate unique IDs
  let idCounter = 0;
  const generateId = () => `mcp-${Date.now().toString(36)}-${(++idCounter).toString(36)}`;

  async function request<T>(type: string, payload: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = generateId();
      // Build a proper protocol envelope
      const envelope = {
        v: PROTOCOL_VERSION,
        type,
        id,
        ts: Date.now(),
        payload,
      };
      let timedOut = false;
      const parser = new FrameParser();

      const socket: Socket = createConnection(socketPath);

      const timeoutId = setTimeout(() => {
        timedOut = true;
        socket.destroy();
        reject(new Error(`Request timeout after ${timeout}ms`));
      }, timeout);

      socket.on('connect', () => socket.write(encodeFrame(envelope)));

      socket.on('data', (data) => {
        // Ignore data if we've already timed out
        if (timedOut) return;

        const frames = parser.push(data);
        for (const response of frames) {
          // Check if this is a response to our request
          if (response.id === id || (response as { payload?: { replyTo?: string } }).payload?.replyTo === id) {
            clearTimeout(timeoutId);
            socket.end();
            // Handle error responses
            if (response.type === 'ERROR') {
              const errorPayload = response.payload as { message?: string; code?: string };
              reject(new Error(errorPayload?.message || errorPayload?.code || 'Unknown error'));
            } else if ((response.payload as { error?: string })?.error) {
              reject(new Error((response.payload as { error: string }).error));
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
      await request('SEND', { from: agentName, to, body: message, thread: opts.thread });
    },
    async sendAndWait(to, message, opts = {}) {
      const r = await request<{ from: string; body: string; thread?: string }>('SEND_AND_WAIT', { from: agentName, to, body: message, thread: opts.thread, timeoutMs: opts.timeoutMs || 30000 });
      return { from: r.from, content: r.body, thread: r.thread };
    },
    async spawn(opts) {
      try { await request('SPAWN', { ...opts, parent: agentName }); return { success: true }; }
      catch (e) { return { success: false, error: e instanceof Error ? e.message : String(e) }; }
    },
    async release(name, reason) {
      try { await request('RELEASE', { name, reason }); return { success: true }; }
      catch (e) { return { success: false, error: e instanceof Error ? e.message : String(e) }; }
    },
    async getStatus() {
      try {
        const s = await request<{ version?: string; uptime?: number }>('STATUS', {});
        return { connected: true, agentName, project, socketPath, daemonVersion: s.version, uptime: s.uptime ? Math.floor(s.uptime/1000)+'s' : undefined };
      } catch { return { connected: false, agentName, project, socketPath }; }
    },
    async getInbox(opts = {}) {
      const msgs = await request<Array<{ id: string; from: string; body: string; channel?: string; thread?: string }>>('INBOX', { agent: agentName, limit: opts.limit, unreadOnly: opts.unread_only, from: opts.from, channel: opts.channel });
      return msgs.map(m => ({ id: m.id, from: m.from, content: m.body, channel: m.channel, thread: m.thread }));
    },
    async listAgents(opts = {}) {
      return request<Array<{ name: string; cli: string; idle?: boolean; parent?: string }>>('LIST_AGENTS', { includeIdle: opts.include_idle, project: opts.project });
    },
  };
}

export default createRelayClient;
