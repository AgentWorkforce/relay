/**
 * Agent Relay Daemon Server
 * Main entry point for the relay daemon.
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Connection, type ConnectionConfig, DEFAULT_CONFIG } from './connection.js';
import { Router } from './router.js';
import type { Envelope, SendPayload, ShadowBindPayload, ShadowUnbindPayload, LogPayload } from '../protocol/types.js';
import { createStorageAdapter, type StorageAdapter, type StorageConfig } from '../storage/adapter.js';
import { SqliteStorageAdapter } from '../storage/sqlite-adapter.js';
import { getProjectPaths } from '../utils/project-namespace.js';
import { AgentRegistry } from './agent-registry.js';
import { daemonLog as log } from '../utils/logger.js';
import { getCloudSync, type CloudSyncService, type RemoteAgent, type CrossMachineMessage } from './cloud-sync.js';

export interface DaemonConfig extends ConnectionConfig {
  socketPath: string;
  pidFilePath: string;
  storagePath?: string;
  storageAdapter?: StorageAdapter;
  /** Storage configuration (type, path, url) */
  storageConfig?: StorageConfig;
  /** Directory for team data (agents.json, etc.) */
  teamDir?: string;
  /** Enable cloud sync for cross-machine agent communication */
  cloudSync?: boolean;
  /** Cloud API URL (defaults to https://api.agent-relay.com) */
  cloudUrl?: string;
}

export const DEFAULT_SOCKET_PATH = '/tmp/agent-relay.sock';

export const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
  ...DEFAULT_CONFIG,
  socketPath: DEFAULT_SOCKET_PATH,
  pidFilePath: `${DEFAULT_SOCKET_PATH}.pid`,
};

export class Daemon {
  private server: net.Server;
  private router!: Router;
  private config: DaemonConfig;
  private running = false;
  private connections: Set<Connection> = new Set();
  private storage?: StorageAdapter;
  private storageInitialized = false;
  private registry?: AgentRegistry;
  private processingStateInterval?: NodeJS.Timeout;
  private cloudSync?: CloudSyncService;
  private remoteAgents: RemoteAgent[] = [];

  /** Callback for log output from agents (used by dashboard for streaming) */
  onLogOutput?: (agentName: string, data: string, timestamp: number) => void;

  /** Interval for writing processing state file (500ms for responsive UI) */
  private static readonly PROCESSING_STATE_INTERVAL_MS = 500;

  constructor(config: Partial<DaemonConfig> = {}) {
    this.config = { ...DEFAULT_DAEMON_CONFIG, ...config };
    if (config.socketPath && !config.pidFilePath) {
      this.config.pidFilePath = `${config.socketPath}.pid`;
    }
    // Default teamDir to same directory as socket
    if (!this.config.teamDir) {
      this.config.teamDir = path.dirname(this.config.socketPath);
    }
    if (this.config.teamDir) {
      this.registry = new AgentRegistry(this.config.teamDir);
    }
    // Storage is initialized lazily in start() to support async createStorageAdapter
    this.server = net.createServer(this.handleConnection.bind(this));
  }

  /**
   * Write current agents to agents.json for dashboard consumption.
   */
  private writeAgentsFile(): void {
    if (!this.registry) return;
    // The registry persists on every update; this is a no-op helper for symmetry.
    const agents = this.registry.getAgents();
    try {
      const targetPath = path.join(this.config.teamDir ?? path.dirname(this.config.socketPath), 'agents.json');
      const data = JSON.stringify({ agents }, null, 2);
      // Write atomically: write to temp file first, then rename
      // This prevents race conditions where readers see partial/empty data
      const tempPath = `${targetPath}.tmp`;
      fs.writeFileSync(tempPath, data, 'utf-8');
      fs.renameSync(tempPath, targetPath);
    } catch (err) {
      log.error('Failed to write agents.json', { error: String(err) });
    }
  }

  /**
   * Write processing state to processing-state.json for dashboard consumption.
   * This file contains agents currently processing/thinking after receiving a message.
   */
  private writeProcessingStateFile(): void {
    try {
      const processingAgents = this.router.getProcessingAgents();
      const targetPath = path.join(this.config.teamDir ?? path.dirname(this.config.socketPath), 'processing-state.json');
      const data = JSON.stringify({ processingAgents, updatedAt: Date.now() }, null, 2);
      const tempPath = `${targetPath}.tmp`;
      fs.writeFileSync(tempPath, data, 'utf-8');
      fs.renameSync(tempPath, targetPath);
    } catch (err) {
      log.error('Failed to write processing-state.json', { error: String(err) });
    }
  }

  /**
   * Initialize storage adapter (called during start).
   */
  private async initStorage(): Promise<void> {
    if (this.storageInitialized) return;

    if (this.config.storageAdapter) {
      // Use explicitly provided adapter
      this.storage = this.config.storageAdapter;
    } else {
      // Create adapter based on config/env
      const storagePath = this.config.storagePath ??
        path.join(path.dirname(this.config.socketPath), 'agent-relay.sqlite');
      this.storage = await createStorageAdapter(storagePath, this.config.storageConfig);
    }

    this.router = new Router({
      storage: this.storage,
      registry: this.registry,
      onProcessingStateChange: () => this.writeProcessingStateFile(),
      crossMachineHandler: {
        sendCrossMachineMessage: this.sendCrossMachineMessage.bind(this),
        isRemoteAgent: this.isRemoteAgent.bind(this),
      },
    });
    this.storageInitialized = true;
  }

  /**
   * Start the daemon.
   */
  async start(): Promise<void> {
    if (this.running) return;

    // Initialize storage
    await this.initStorage();

    // Initialize cloud sync if configured
    await this.initCloudSync();

    // Clean up stale socket (only if it's actually a socket)
    if (fs.existsSync(this.config.socketPath)) {
      const stat = fs.lstatSync(this.config.socketPath);
      if (!stat.isSocket()) {
        throw new Error(
          `Refusing to unlink non-socket at ${this.config.socketPath}`
        );
      }
      fs.unlinkSync(this.config.socketPath);
    }

    // Ensure directory exists
    const socketDir = path.dirname(this.config.socketPath);
    if (!fs.existsSync(socketDir)) {
      fs.mkdirSync(socketDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      this.server.on('error', reject);
      this.server.listen(this.config.socketPath, () => {
        this.running = true;
        // Set restrictive permissions
        fs.chmodSync(this.config.socketPath, 0o600);
        fs.writeFileSync(this.config.pidFilePath, `${process.pid}\n`, 'utf-8');

        // Start periodic processing state updates for dashboard
        this.processingStateInterval = setInterval(() => {
          this.writeProcessingStateFile();
        }, Daemon.PROCESSING_STATE_INTERVAL_MS);

        log.info('Listening', { socketPath: this.config.socketPath });
        resolve();
      });
    });
  }

  /**
   * Initialize cloud sync service for cross-machine agent communication.
   */
  private async initCloudSync(): Promise<void> {
    // Check for cloud config file
    const dataDir = process.env.AGENT_RELAY_DATA_DIR ||
      path.join(os.homedir(), '.local', 'share', 'agent-relay');
    const configPath = path.join(dataDir, 'cloud-config.json');

    if (!fs.existsSync(configPath)) {
      log.info('Cloud sync disabled (not linked to cloud)');
      return;
    }

    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      this.cloudSync = getCloudSync({
        apiKey: config.apiKey,
        cloudUrl: config.cloudUrl || this.config.cloudUrl,
        enabled: this.config.cloudSync !== false,
      });

      // Listen for remote agent updates
      this.cloudSync.on('remote-agents-updated', (agents: RemoteAgent[]) => {
        this.remoteAgents = agents;
        log.info('Remote agents updated', { count: agents.length });
        this.writeRemoteAgentsFile();
      });

      // Listen for cross-machine messages
      this.cloudSync.on('cross-machine-message', (msg: CrossMachineMessage) => {
        this.handleCrossMachineMessage(msg);
      });

      // Listen for cloud commands (e.g., credential refresh)
      this.cloudSync.on('command', (cmd: { type: string; payload: unknown }) => {
        log.info('Cloud command received', { type: cmd.type });
        // Handle commands like credential updates, config changes, etc.
      });

      await this.cloudSync.start();
      log.info('Cloud sync enabled');
    } catch (err) {
      log.error('Failed to initialize cloud sync', { error: String(err) });
    }
  }

  /**
   * Write remote agents to file for dashboard consumption.
   */
  private writeRemoteAgentsFile(): void {
    try {
      const targetPath = path.join(
        this.config.teamDir ?? path.dirname(this.config.socketPath),
        'remote-agents.json'
      );
      const data = JSON.stringify({
        agents: this.remoteAgents,
        updatedAt: Date.now(),
      }, null, 2);
      const tempPath = `${targetPath}.tmp`;
      fs.writeFileSync(tempPath, data, 'utf-8');
      fs.renameSync(tempPath, targetPath);
    } catch (err) {
      log.error('Failed to write remote-agents.json', { error: String(err) });
    }
  }

  /**
   * Handle incoming message from another machine via cloud.
   */
  private handleCrossMachineMessage(msg: CrossMachineMessage): void {
    log.info('Cross-machine message received', {
      from: `${msg.from.daemonName}:${msg.from.agent}`,
      to: msg.to,
    });

    // Find local agent
    const targetConnection = Array.from(this.connections).find(
      c => c.agentName === msg.to
    );

    if (!targetConnection) {
      log.warn('Target agent not found locally', { agent: msg.to });
      return;
    }

    // Inject message to local agent
    const envelope: Envelope<SendPayload> = {
      v: 1,
      type: 'SEND',
      id: `cross-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ts: Date.now(),
      from: `${msg.from.daemonName}:${msg.from.agent}`,
      to: msg.to,
      payload: {
        kind: 'message',
        body: msg.content,
        data: {
          _crossMachine: true,
          _fromDaemon: msg.from.daemonId,
          _fromDaemonName: msg.from.daemonName,
          ...msg.metadata,
        },
      },
    };

    this.router.route(targetConnection as any, envelope as any);
  }

  /**
   * Send message to agent on another machine via cloud.
   */
  async sendCrossMachineMessage(
    targetDaemonId: string,
    targetAgent: string,
    fromAgent: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<boolean> {
    if (!this.cloudSync?.isConnected()) {
      log.warn('Cannot send cross-machine message: not connected to cloud');
      return false;
    }

    try {
      await this.cloudSync.sendCrossMachineMessage(
        targetDaemonId,
        targetAgent,
        fromAgent,
        content,
        metadata
      );
      return true;
    } catch (err) {
      log.error('Failed to send cross-machine message', { error: String(err) });
      return false;
    }
  }

  /**
   * Get list of remote agents (from other machines).
   */
  getRemoteAgents(): RemoteAgent[] {
    return this.remoteAgents;
  }

  /**
   * Check if an agent is on a remote machine.
   */
  isRemoteAgent(agentName: string): RemoteAgent | undefined {
    return this.remoteAgents.find(a => a.name === agentName);
  }

  /**
   * Notify cloud sync about local agent changes.
   */
  private notifyCloudSync(): void {
    if (!this.cloudSync?.isConnected()) return;

    const agents = Array.from(this.connections)
      .filter(c => c.agentName)
      .map(c => ({
        name: c.agentName!,
        status: 'online',
      }));

    this.cloudSync.updateAgents(agents);
  }

  /**
   * Stop the daemon.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    // Stop cloud sync
    if (this.cloudSync) {
      this.cloudSync.stop();
      this.cloudSync = undefined;
    }

    // Stop processing state updates
    if (this.processingStateInterval) {
      clearInterval(this.processingStateInterval);
      this.processingStateInterval = undefined;
    }

    // Close all active connections
    for (const connection of this.connections) {
      connection.close();
    }
    this.connections.clear();

    return new Promise((resolve) => {
      this.server.close(() => {
        this.running = false;
        // Clean up socket file
        if (fs.existsSync(this.config.socketPath)) {
          fs.unlinkSync(this.config.socketPath);
        }
        // Clean up pid file
        if (fs.existsSync(this.config.pidFilePath)) {
          fs.unlinkSync(this.config.pidFilePath);
        }
        if (this.storage?.close) {
          this.storage.close().catch((err) => {
            log.error('Failed to close storage', { error: String(err) });
          });
        }
        log.info('Stopped');
        resolve();
      });
    });
  }

  /**
   * Handle new connection.
   */
  private handleConnection(socket: net.Socket): void {
    log.debug('New connection');

    const resumeHandler = this.storage?.getSessionByResumeToken
      ? async ({ agent, resumeToken }: { agent: string; resumeToken: string }) => {
          const session = await this.storage!.getSessionByResumeToken!(resumeToken);
          if (!session || session.agentName !== agent) return null;

          let seedSequences: Array<{ topic?: string; peer: string; seq: number }> | undefined;
          if (this.storage?.getMaxSeqByStream) {
            const streams = await this.storage.getMaxSeqByStream(agent, session.id);
            seedSequences = streams.map(s => ({
              topic: s.topic ?? 'default',
              peer: s.peer,
              seq: s.maxSeq,
            }));
          }

          return {
            sessionId: session.id,
            resumeToken: session.resumeToken ?? resumeToken,
            seedSequences,
          };
        }
      : undefined;

    // Provide processing state callback for heartbeat exemption
    const isProcessing = (agentName: string) => this.router.isAgentProcessing(agentName);

    const connection = new Connection(socket, { ...this.config, resumeHandler, isProcessing });
    this.connections.add(connection);

    connection.onMessage = (envelope: Envelope) => {
      this.handleMessage(connection, envelope);
    };

    connection.onAck = (envelope) => {
      this.router.handleAck(connection, envelope);
    };

    // Update lastSeen on successful heartbeat to keep agent status fresh
    connection.onPong = () => {
      if (connection.agentName) {
        this.registry?.touch(connection.agentName);
      }
    };

    // Register agent when connection becomes active (after successful handshake)
    connection.onActive = () => {
      if (connection.agentName) {
        this.router.register(connection);
        log.info('Agent registered', { agent: connection.agentName });
        // Registry handles persistence internally via save()
        this.registry?.registerOrUpdate({
          name: connection.agentName,
          cli: connection.cli,
          program: connection.program,
          model: connection.model,
          task: connection.task,
          workingDirectory: connection.workingDirectory,
        });

        // Record session start
        if (this.storage instanceof SqliteStorageAdapter) {
          const projectPaths = getProjectPaths();
          const storage = this.storage as SqliteStorageAdapter;
          const persistSession = async (): Promise<void> => {
            let startedAt = Date.now();
            if (connection.isResumed && storage.getSessionByResumeToken) {
              const existing = await storage.getSessionByResumeToken(connection.resumeToken);
              if (existing?.startedAt) {
                startedAt = existing.startedAt;
              }
            }

            await storage.startSession({
              id: connection.sessionId,
              agentName: connection.agentName!,
              cli: connection.cli,
              projectId: projectPaths.projectId,
              projectRoot: projectPaths.projectRoot,
              startedAt,
              resumeToken: connection.resumeToken,
            });
          };

          persistSession().catch(err => log.error('Failed to record session start', { error: String(err) }));
        }
      }

      // Replay pending deliveries for resumed sessions
      if (connection.isResumed) {
        this.router.replayPending(connection).catch(err => {
          log.error('Failed to replay pending messages', { error: String(err) });
        });
      }

      // Notify cloud sync about agent changes
      this.notifyCloudSync();
    };

    connection.onClose = () => {
      log.debug('Connection closed', { agent: connection.agentName ?? connection.id });
      this.connections.delete(connection);
      this.router.unregister(connection);
      // Registry handles persistence internally via touch() -> save()
      if (connection.agentName) {
        this.registry?.touch(connection.agentName);
      }

      // Record session end (disconnect - agent may still mark it closed explicitly)
      if (this.storage instanceof SqliteStorageAdapter) {
        this.storage.endSession(connection.sessionId, { closedBy: 'disconnect' })
          .catch(err => log.error('Failed to record session end', { error: String(err) }));
      }

      // Notify cloud sync about agent changes
      this.notifyCloudSync();
    };

    connection.onError = (error: Error) => {
      log.error('Connection error', { error: error.message });
      this.connections.delete(connection);
      this.router.unregister(connection);
      // Registry handles persistence internally via touch() -> save()
      if (connection.agentName) {
        this.registry?.touch(connection.agentName);
      }

      // Record session end on error
      if (this.storage instanceof SqliteStorageAdapter) {
        this.storage.endSession(connection.sessionId, { closedBy: 'error' })
          .catch(err => log.error('Failed to record session end', { error: String(err) }));
      }
    };
  }

  /**
   * Handle incoming message from a connection.
   */
  private handleMessage(connection: Connection, envelope: Envelope): void {
    switch (envelope.type) {
      case 'SEND':
        this.router.route(connection, envelope as Envelope<SendPayload>);
        break;

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

      case 'SHADOW_BIND':
        if (connection.agentName) {
          const payload = envelope.payload as ShadowBindPayload;
          this.router.bindShadow(connection.agentName, payload.primaryAgent, {
            speakOn: payload.speakOn,
            receiveIncoming: payload.receiveIncoming,
            receiveOutgoing: payload.receiveOutgoing,
          });
        }
        break;

      case 'SHADOW_UNBIND':
        if (connection.agentName) {
          const payload = envelope.payload as ShadowUnbindPayload;
          // Verify the shadow is actually bound to the specified primary
          const currentPrimary = this.router.getPrimaryForShadow(connection.agentName);
          if (currentPrimary === payload.primaryAgent) {
            this.router.unbindShadow(connection.agentName);
          }
        }
        break;

      case 'LOG':
        // Handle log output from daemon-connected agents
        if (connection.agentName) {
          const payload = envelope.payload as LogPayload;
          const timestamp = payload.timestamp ?? envelope.ts;
          // Forward to dashboard via callback
          if (this.onLogOutput) {
            this.onLogOutput(connection.agentName, payload.data, timestamp);
          }
        }
        break;
    }
  }

  /**
   * Get list of connected agents.
   */
  getAgents(): string[] {
    return this.router.getAgents();
  }

  /**
   * Get connection count.
   */
  get connectionCount(): number {
    return this.router.connectionCount;
  }

  /**
   * Check if daemon is running.
   */
  get isRunning(): boolean {
    return this.running;
  }
}

// Run as standalone if executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const daemon = new Daemon();

  process.on('SIGINT', async () => {
    log.info('Shutting down (SIGINT)');
    await daemon.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    log.info('Shutting down (SIGTERM)');
    await daemon.stop();
    process.exit(0);
  });

  daemon.start().catch((err) => {
    log.error('Failed to start', { error: String(err) });
    process.exit(1);
  });
}
