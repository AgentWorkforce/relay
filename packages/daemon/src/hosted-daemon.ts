/**
 * Hosted Daemon — a deployable WebSocket server for agent relay.
 *
 * Replaces the local Unix-socket daemon with a hosted service that agents
 * connect to over WebSocket. This eliminates the need for:
 *   - Local relay-pty Rust binary
 *   - Local daemon process
 *   - Unix sockets
 *   - PTY wrapping
 *
 * Agents connect directly via `wss://your-host/ws` using the same relay
 * protocol (HELLO/WELCOME/SEND/DELIVER/PING/PONG).
 *
 * Usage:
 *   const hosted = new HostedDaemon({ port: 4080 });
 *   await hosted.start();
 *
 * Deploy to any cloud provider (Fly.io, Railway, Render, etc.) or run
 * locally with `relay serve`.
 */

import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Router, type RoutableConnection } from './router.js';
import { WsConnection } from './ws-connection.js';
import { AgentRegistry } from './agent-registry.js';
// SpawnManager is not used in hosted mode — spawning is a local operation
// import { SpawnManager, type SpawnManagerConfig } from './spawn-manager.js';
import { createStorageAdapter, type StorageAdapter, type StorageConfig, type StorageHealth } from '@agent-relay/storage/adapter';
import { randomUUID } from 'node:crypto';

/** Generate a short unique ID */
function generateId(): string {
  return randomUUID().replace(/-/g, '').substring(0, 16);
}
import {
  PROTOCOL_VERSION,
  type Envelope,
  type SendEnvelope,
  type AckPayload,
  type ErrorPayload,
  type StatusResponsePayload,
  type InboxPayload,
  type InboxResponsePayload,
  type ListAgentsPayload,
  type ListAgentsResponsePayload,
  type ListConnectedAgentsPayload,
  type ListConnectedAgentsResponsePayload,
  type HealthPayload,
  type HealthResponsePayload,
  type MetricsPayload,
  type MetricsResponsePayload,
  type AgentReadyPayload,
  type SendInputPayload,
  type ListWorkersPayload,
  type LogPayload,
} from '@agent-relay/protocol/types';
import type {
  ChannelJoinPayload,
  ChannelLeavePayload,
  ChannelMessagePayload,
} from '@agent-relay/protocol/channels';

export interface HostedDaemonConfig {
  /** Port for HTTP + WebSocket server (default: 4080) */
  port: number;
  /** Host to bind to (default: '::' for dual-stack) */
  host: string;
  /** Optional workspace token for auth — if set, clients must provide it */
  workspaceToken?: string;
  /** Storage configuration */
  storageConfig?: StorageConfig;
  /** Storage adapter (overrides storageConfig) */
  storageAdapter?: StorageAdapter;
  /** Team directory for agents.json, etc. */
  teamDir?: string;
  /** Heartbeat interval in ms (default: 5000) */
  heartbeatMs?: number;
  /** Heartbeat timeout multiplier (default: 6) */
  heartbeatTimeoutMultiplier?: number;
  /** Allowed origins for CORS (default: all) */
  allowedOrigins?: string[];
  /** Enable consensus mechanism (default: true) */
  consensus?: boolean;
}

const DEFAULT_HOSTED_CONFIG: HostedDaemonConfig = {
  port: 4080,
  host: '::',
};

interface PendingAck {
  correlationId: string;
  connectionId: string;
  connection: WsConnection;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export class HostedDaemon {
  private config: HostedDaemonConfig;
  private server?: http.Server;
  private wss?: WebSocketServer;
  private router!: Router;
  private storage?: StorageAdapter;
  private registry?: AgentRegistry;
  private connections: Set<WsConnection> = new Set();
  private pendingAcks: Map<string, PendingAck> = new Map();
  private running = false;
  private startTime?: number;
  private storageHealth?: StorageHealth;

  /** Callback for log output (used by dashboard) */
  onLogOutput?: (agentName: string, data: string, timestamp: number) => void;

  private static readonly DEFAULT_SYNC_TIMEOUT_MS = 30000;

  constructor(config: Partial<HostedDaemonConfig> = {}) {
    this.config = { ...DEFAULT_HOSTED_CONFIG, ...config };
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    this.startTime = Date.now();

    // Initialize storage
    await this.initStorage();

    // Create HTTP server with health endpoints
    this.server = http.createServer((req, res) => this.handleHttpRequest(req, res));

    // Create WebSocket server attached to the HTTP server
    this.wss = new WebSocketServer({
      server: this.server,
      path: '/ws',
      // Disable per-message-deflate to avoid "RSV1 must be clear" errors
      // when multiple WebSocket servers are in the process
      perMessageDeflate: false,
    });

    this.wss.on('connection', (ws, req) => this.handleWsConnection(ws, req));

    return new Promise((resolve, reject) => {
      this.server!.on('error', reject);
      this.server!.listen(this.config.port, this.config.host, () => {
        this.running = true;
        const addr = this.server!.address();
        const portStr = typeof addr === 'object' && addr ? addr.port : this.config.port;
        console.log(`[hosted-daemon] Listening on ws://${this.config.host}:${portStr}/ws`);
        if (this.config.workspaceToken) {
          console.log('[hosted-daemon] Workspace token auth enabled');
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    // Close all WebSocket connections
    for (const conn of this.connections) {
      conn.close();
    }
    this.connections.clear();

    // Clear pending ACKs
    for (const [, pending] of this.pendingAcks) {
      clearTimeout(pending.timeoutHandle);
    }
    this.pendingAcks.clear();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = undefined;
    }

    // Close HTTP server
    return new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.running = false;
          if (this.storage?.close) {
            this.storage.close().catch(() => {});
          }
          console.log('[hosted-daemon] Stopped');
          resolve();
        });
      } else {
        this.running = false;
        resolve();
      }
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  getAgents(): string[] {
    return this.router?.getAgents() ?? [];
  }

  // ─── Storage Init ─────────────────────────────────────────────────

  private async initStorage(): Promise<void> {
    if (this.config.storageAdapter) {
      this.storage = this.config.storageAdapter;
    } else {
      // Default to in-memory (JSONL) storage for hosted mode
      this.storage = await createStorageAdapter(':memory:', this.config.storageConfig);
    }

    if (this.config.teamDir) {
      this.registry = new AgentRegistry(this.config.teamDir);
    }

    this.router = new Router({
      storage: this.storage,
      registry: this.registry,
    });

    // Restore persisted channel memberships
    await this.router.restoreChannelMemberships();
  }

  // ─── HTTP Handler ─────────────────────────────────────────────────

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS headers
    const origin = req.headers.origin;
    if (this.config.allowedOrigins?.length) {
      if (origin && this.config.allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    switch (url.pathname) {
      case '/health':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          uptime: this.startTime ? Date.now() - this.startTime : 0,
          agents: this.router.getAgents().length,
          connections: this.connections.size,
        }));
        break;

      case '/api/agents':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          agents: this.router.getAgents().map(name => ({
            name,
            connected: true,
          })),
        }));
        break;

      default:
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  // ─── WebSocket Handler ────────────────────────────────────────────

  private handleWsConnection(ws: WebSocket, req: http.IncomingMessage): void {
    // Auth check: if workspace token is configured, validate it
    if (this.config.workspaceToken) {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const token = url.searchParams.get('token')
        || req.headers.authorization?.replace('Bearer ', '');

      if (token !== this.config.workspaceToken) {
        ws.close(4001, 'Unauthorized: invalid workspace token');
        return;
      }
    }

    const conn = new WsConnection(ws as unknown as import('./ws-connection.js').WebSocketHandle, {
      heartbeatMs: this.config.heartbeatMs ?? 5000,
      heartbeatTimeoutMultiplier: this.config.heartbeatTimeoutMultiplier ?? 6,
      resumeHandler: this.storage?.getSessionByResumeToken
        ? async ({ agent, resumeToken }) => {
            const session = await this.storage!.getSessionByResumeToken!(resumeToken);
            if (!session || session.agentName !== agent) return null;
            return {
              sessionId: session.id,
              resumeToken: session.resumeToken ?? resumeToken,
            };
          }
        : undefined,
      isProcessing: (agentName: string) => this.router.isAgentProcessing(agentName),
    });

    this.connections.add(conn);

    // Wire up event handlers (mirrors Daemon.handleConnection)
    conn.onMessage = (envelope: Envelope) => {
      this.handleMessage(conn, envelope);
    };

    conn.onAck = (envelope) => {
      this.handleAck(conn, envelope);
    };

    conn.onPong = () => {
      if (conn.agentName) {
        this.registry?.touch(conn.agentName);
      }
    };

    conn.onActive = () => {
      if (conn.agentName) {
        this.router.register(conn);
        console.log(`[hosted-daemon] Agent registered: ${conn.agentName}`);

        this.registry?.registerOrUpdate({
          name: conn.agentName,
          cli: conn.cli,
          program: conn.program,
          model: conn.model,
          task: conn.task,
          workingDirectory: conn.workingDirectory,
          team: conn.team,
        });

        // Auto-join #general
        this.router.autoJoinChannel(conn.agentName, '#general');

        // Record session start
        if (this.storage?.startSession) {
          this.storage.startSession({
            id: conn.sessionId,
            agentName: conn.agentName,
            cli: conn.cli,
            startedAt: Date.now(),
            resumeToken: conn.resumeToken,
          }).catch(() => {});
        }
      }

      // Deliver pending messages
      this.router.deliverPendingMessages(conn).catch(() => {});

      // Auto-rejoin channels
      if (conn.agentName) {
        this.router.autoRejoinChannelsForAgent(conn.agentName).catch(() => {});
      }

      // Broadcast AGENT_READY
      if (conn.agentName) {
        this.broadcastAgentReady(conn);
      }
    };

    conn.onClose = () => {
      this.connections.delete(conn);
      this.clearPendingAcksForConnection(conn.id);
      this.router.unregister(conn);
      if (conn.agentName) {
        console.log(`[hosted-daemon] Agent disconnected: ${conn.agentName}`);
        this.registry?.touch(conn.agentName);
      }
      if (this.storage?.endSession) {
        this.storage.endSession(conn.sessionId, { closedBy: 'disconnect' }).catch(() => {});
      }
    };

    conn.onError = (error: Error) => {
      console.error(`[hosted-daemon] Connection error: ${error.message}`);
      this.connections.delete(conn);
      this.clearPendingAcksForConnection(conn.id);
      this.router.unregister(conn);
      if (conn.agentName) {
        this.registry?.touch(conn.agentName);
      }
    };

    // Wire up WebSocket events to the WsConnection
    ws.on('message', (data) => {
      const msg = typeof data === 'string' ? data : data.toString('utf-8');
      conn.handleMessage(msg);
    });

    ws.on('close', () => conn.handleWsClose());
    ws.on('error', (err) => conn.handleWsError(err));
  }

  // ─── Message Handling (mirrors Daemon.handleMessage) ──────────────

  private handleMessage(connection: WsConnection, envelope: Envelope): void {
    switch (envelope.type) {
      case 'SEND': {
        const sendEnvelope = envelope as SendEnvelope;

        // Handle sync/blocking sends
        const syncMeta = sendEnvelope.payload_meta?.sync;
        if (syncMeta?.blocking) {
          if (!syncMeta.correlationId) {
            this.sendErrorEnvelope(connection, 'Missing sync correlationId for blocking SEND');
            return;
          }
          const registered = this.registerPendingAck(connection, syncMeta.correlationId, syncMeta.timeoutMs);
          if (!registered) return;
        }

        this.router.route(connection, sendEnvelope);
        break;
      }

      case 'SUBSCRIBE':
        if (connection.agentName && envelope.topic) {
          this.router.subscribe(connection.agentName, envelope.topic);
        }
        break;

      case 'UNSUBSCRIBE':
        if (connection.agentName && envelope.topic) {
          this.router.unsubscribe(connection.agentName, envelope.topic);
        }
        break;

      case 'LOG':
        if (connection.agentName) {
          const payload = envelope.payload as LogPayload;
          const timestamp = payload.timestamp ?? envelope.ts;
          this.onLogOutput?.(connection.agentName, payload.data, timestamp);
        }
        break;

      // Channel messaging
      case 'CHANNEL_JOIN': {
        const channelEnvelope = envelope as Envelope<ChannelJoinPayload>;
        this.router.handleChannelJoin(connection, channelEnvelope);
        break;
      }
      case 'CHANNEL_LEAVE': {
        const channelEnvelope = envelope as Envelope<ChannelLeavePayload>;
        this.router.handleChannelLeave(connection, channelEnvelope);
        break;
      }
      case 'CHANNEL_MESSAGE': {
        const channelEnvelope = envelope as Envelope<ChannelMessagePayload>;
        this.router.routeChannelMessage(connection, channelEnvelope);
        break;
      }

      // Spawn/Release — forward as messages in hosted mode since spawning
      // is a local operation. The connector handles spawn locally.
      case 'SPAWN':
      case 'RELEASE': {
        // In hosted mode, spawn/release requests are forwarded to the
        // target agent's connector which handles them locally.
        // For now, send an error — full hosted spawning is future work.
        this.sendErrorEnvelope(
          connection,
          'Spawn/release not supported in hosted mode. Use a local connector.'
        );
        break;
      }

      // Query handlers
      case 'STATUS': {
        const uptimeMs = this.startTime ? Date.now() - this.startTime : 0;
        const response: Envelope<StatusResponsePayload> = {
          v: PROTOCOL_VERSION,
          type: 'STATUS_RESPONSE',
          id: envelope.id,
          ts: Date.now(),
          payload: {
            version: 'hosted',
            uptime: uptimeMs,
            cloudConnected: false,
            agentCount: this.router.connectionCount,
            storage: this.storageHealth,
          },
        };
        connection.send(response);
        break;
      }

      case 'INBOX': {
        const inboxPayload = envelope.payload as InboxPayload;
        const agentName = inboxPayload.agent || connection.agentName;

        const getInboxMessages = async () => {
          if (!this.storage?.getMessages) return [];
          const toFilter = inboxPayload.channel || agentName;
          const messages = await this.storage.getMessages({
            to: toFilter,
            from: inboxPayload.from,
            limit: inboxPayload.limit || 50,
            unreadOnly: inboxPayload.unreadOnly,
          });
          return messages.map(m => ({
            id: m.id,
            from: m.from,
            body: m.body,
            channel: (m.data as { channel?: string })?.channel,
            thread: m.thread,
            timestamp: m.ts,
          }));
        };

        getInboxMessages().then(messages => {
          const response: Envelope<InboxResponsePayload> = {
            v: PROTOCOL_VERSION,
            type: 'INBOX_RESPONSE',
            id: envelope.id,
            ts: Date.now(),
            payload: { messages },
          };
          connection.send(response);
        }).catch(err => {
          this.sendErrorEnvelope(connection, `Failed to get inbox: ${(err as Error).message}`);
        });
        break;
      }

      case 'LIST_AGENTS': {
        const connectedAgents = this.router.getAgents();
        const agents = connectedAgents
          .filter(name => !name.startsWith('__') && name !== 'Dashboard' && name !== 'cli')
          .map(name => {
            const conn = this.router.getConnection(name);
            return {
              name,
              cli: conn?.cli,
              idle: false,
            };
          });

        const response: Envelope<ListAgentsResponsePayload> = {
          v: PROTOCOL_VERSION,
          type: 'LIST_AGENTS_RESPONSE',
          id: envelope.id,
          ts: Date.now(),
          payload: { agents },
        };
        connection.send(response);
        break;
      }

      case 'LIST_CONNECTED_AGENTS': {
        const connectedAgentNames = this.router.getAgents();
        const agents = connectedAgentNames
          .filter(name => !name.startsWith('__') && name !== 'Dashboard' && name !== 'cli')
          .map(name => {
            const conn = this.router.getConnection(name);
            return {
              name,
              cli: conn?.cli,
              idle: false,
            };
          });

        const connectedResponse: Envelope<ListConnectedAgentsResponsePayload> = {
          v: PROTOCOL_VERSION,
          type: 'LIST_CONNECTED_AGENTS_RESPONSE',
          id: envelope.id,
          ts: Date.now(),
          payload: { agents },
        };
        connection.send(connectedResponse);
        break;
      }

      case 'HEALTH': {
        const agentCount = this.router.getAgents().length;
        const response: Envelope<HealthResponsePayload> = {
          v: PROTOCOL_VERSION,
          type: 'HEALTH_RESPONSE',
          id: envelope.id,
          ts: Date.now(),
          payload: {
            healthScore: 100,
            summary: 'Hosted daemon is healthy',
            issues: [],
            recommendations: [],
            crashes: [],
            alerts: [],
            stats: {
              totalCrashes24h: 0,
              totalAlerts24h: 0,
              agentCount,
            },
          },
        };
        connection.send(response);
        break;
      }

      case 'METRICS': {
        const response: Envelope<MetricsResponsePayload> = {
          v: PROTOCOL_VERSION,
          type: 'METRICS_RESPONSE',
          id: envelope.id,
          ts: Date.now(),
          payload: {
            agents: [],
            system: {
              totalMemory: 0,
              freeMemory: 0,
              heapUsed: process.memoryUsage().heapUsed,
            },
          },
        };
        connection.send(response);
        break;
      }
    }
  }

  private handleAck(connection: WsConnection, envelope: Envelope<AckPayload>): void {
    this.router.handleAck(connection, envelope);

    const correlationId = envelope.payload.correlationId;
    if (!correlationId) return;

    const pending = this.pendingAcks.get(correlationId);
    if (!pending) return;

    clearTimeout(pending.timeoutHandle);
    this.pendingAcks.delete(correlationId);

    const forwardAck: Envelope<AckPayload> = {
      v: envelope.v,
      type: 'ACK',
      id: generateId(),
      ts: Date.now(),
      from: connection.agentName,
      to: pending.connection.agentName,
      payload: envelope.payload,
    };
    pending.connection.send(forwardAck);
  }

  private registerPendingAck(connection: WsConnection, correlationId: string, timeoutMs?: number): boolean {
    if (this.pendingAcks.has(correlationId)) {
      this.sendErrorEnvelope(connection, `Duplicate correlationId: ${correlationId}`);
      return false;
    }

    const timeout = timeoutMs ?? HostedDaemon.DEFAULT_SYNC_TIMEOUT_MS;
    const timeoutHandle = setTimeout(() => {
      this.pendingAcks.delete(correlationId);
      this.sendErrorEnvelope(connection, `ACK timeout after ${timeout}ms`);
    }, timeout);

    this.pendingAcks.set(correlationId, {
      correlationId,
      connectionId: connection.id,
      connection,
      timeoutHandle,
    });
    return true;
  }

  private clearPendingAcksForConnection(connectionId: string): void {
    for (const [correlationId, pending] of this.pendingAcks.entries()) {
      if (pending.connectionId !== connectionId) continue;
      clearTimeout(pending.timeoutHandle);
      this.pendingAcks.delete(correlationId);
    }
  }

  private sendErrorEnvelope(connection: WsConnection, message: string): void {
    const errorEnvelope: Envelope<ErrorPayload> = {
      v: PROTOCOL_VERSION,
      type: 'ERROR',
      id: generateId(),
      ts: Date.now(),
      payload: {
        code: 'INTERNAL',
        message,
        fatal: false,
      },
    };
    connection.send(errorEnvelope);
  }

  private broadcastAgentReady(connection: WsConnection): void {
    const payload: AgentReadyPayload = {
      name: connection.agentName!,
      cli: connection.cli,
      task: connection.task,
      connectedAt: Date.now(),
    };

    const envelope: Envelope<AgentReadyPayload> = {
      v: PROTOCOL_VERSION,
      type: 'AGENT_READY',
      id: generateId(),
      ts: Date.now(),
      payload,
    };

    for (const conn of this.connections) {
      if (conn.id !== connection.id && conn.state === 'ACTIVE') {
        conn.send(envelope);
      }
    }
  }
}
