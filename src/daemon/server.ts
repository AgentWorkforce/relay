/**
 * Agent Relay Daemon Server
 * Main entry point for the relay daemon.
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { Connection, type ConnectionConfig, DEFAULT_CONFIG } from './connection.js';
import { Router } from './router.js';
import type { Envelope, SendPayload } from '../protocol/types.js';
import { createStorageAdapter, type StorageAdapter, type StorageConfig } from '../storage/adapter.js';
import { SqliteStorageAdapter } from '../storage/sqlite-adapter.js';
import { getProjectPaths } from '../utils/project-namespace.js';
import { AgentRegistry } from './agent-registry.js';

export interface DaemonConfig extends ConnectionConfig {
  socketPath: string;
  pidFilePath: string;
  storagePath?: string;
  storageAdapter?: StorageAdapter;
  /** Storage configuration (type, path, url) */
  storageConfig?: StorageConfig;
  /** Directory for team data (agents.json, etc.) */
  teamDir?: string;
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
      console.error('[daemon] Failed to write agents.json:', err);
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

    this.router = new Router({ storage: this.storage, registry: this.registry });
    this.storageInitialized = true;
  }

  /**
   * Start the daemon.
   */
  async start(): Promise<void> {
    if (this.running) return;

    // Initialize storage
    await this.initStorage();

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
        console.log(`[daemon] Listening on ${this.config.socketPath}`);
        resolve();
      });
    });
  }

  /**
   * Stop the daemon.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

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
            console.error('[daemon] Failed to close storage', err);
          });
        }
        console.log('[daemon] Stopped');
        resolve();
      });
    });
  }

  /**
   * Handle new connection.
   */
  private handleConnection(socket: net.Socket): void {
    console.log('[daemon] New connection');

    const connection = new Connection(socket, this.config);
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
          console.log(`[daemon] Agent registered: ${connection.agentName}`);
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
          this.storage.startSession({
            id: connection.sessionId,
            agentName: connection.agentName,
            cli: connection.cli,
            projectId: projectPaths.projectId,
            projectRoot: projectPaths.projectRoot,
            startedAt: Date.now(),
          }).catch(err => console.error('[daemon] Failed to record session start:', err));
        }
      }
    };

    connection.onClose = () => {
      console.log(`[daemon] Connection closed: ${connection.agentName ?? connection.id}`);
      this.connections.delete(connection);
      this.router.unregister(connection);
      // Registry handles persistence internally via touch() -> save()
      if (connection.agentName) {
        this.registry?.touch(connection.agentName);
      }

      // Record session end (disconnect - agent may still mark it closed explicitly)
      if (this.storage instanceof SqliteStorageAdapter) {
        this.storage.endSession(connection.sessionId, { closedBy: 'disconnect' })
          .catch(err => console.error('[daemon] Failed to record session end:', err));
      }
    };

    connection.onError = (error: Error) => {
      console.error(`[daemon] Connection error: ${error.message}`);
      this.connections.delete(connection);
      this.router.unregister(connection);
      // Registry handles persistence internally via touch() -> save()
      if (connection.agentName) {
        this.registry?.touch(connection.agentName);
      }

      // Record session end on error
      if (this.storage instanceof SqliteStorageAdapter) {
        this.storage.endSession(connection.sessionId, { closedBy: 'error' })
          .catch(err => console.error('[daemon] Failed to record session end:', err));
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
    console.log('\n[daemon] Shutting down...');
    await daemon.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await daemon.stop();
    process.exit(0);
  });

  daemon.start().catch((err) => {
    console.error('[daemon] Failed to start:', err);
    process.exit(1);
  });
}
