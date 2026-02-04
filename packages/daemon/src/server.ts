/**
 * Agent Relay Daemon Server
 * Main entry point for the relay daemon.
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { Connection, type ConnectionConfig, DEFAULT_CONFIG } from './connection.js';
import { Router } from './router.js';
import {
  PROTOCOL_VERSION,
  type Envelope,
  type ShadowBindPayload,
  type ShadowUnbindPayload,
  type LogPayload,
  type SendEnvelope,
  type AckPayload,
  type ErrorPayload,
  type SpawnPayload,
  type ReleasePayload,
  type StatusResponsePayload,
  type InboxPayload,
  type InboxResponsePayload,
  type MessagesQueryPayload,
  type MessagesResponsePayload,
  type ListAgentsPayload,
  type ListAgentsResponsePayload,
  type ListConnectedAgentsPayload,
  type ListConnectedAgentsResponsePayload,
  type RemoveAgentPayload,
  type RemoveAgentResponsePayload,
  type HealthPayload,
  type HealthResponsePayload,
  type MetricsPayload,
  type MetricsResponsePayload,
  type AgentReadyPayload,
} from '@agent-relay/protocol/types';
import type { ChannelJoinPayload, ChannelLeavePayload, ChannelMessagePayload } from '@agent-relay/protocol/channels';
import { SpawnManager, type SpawnManagerConfig } from './spawn-manager.js';
import { createStorageAdapter, type StorageAdapter, type StorageConfig, type StorageHealth } from '@agent-relay/storage/adapter';
import { getProjectPaths, saveRuntimeConfig, clearRuntimeConfig } from '@agent-relay/config';
import { AgentRegistry } from './agent-registry.js';
import { daemonLog as log } from '@agent-relay/utils/logger';
import { getCloudSync, type CloudSyncService, type RemoteAgent, type CrossMachineMessage, type AgentMetricsProvider } from './cloud-sync.js';
import { getMemoryMonitor } from '@agent-relay/resiliency';
import { generateId } from '@agent-relay/wrapper';
import {
  ConsensusIntegration,
  createConsensusIntegration,
  type ConsensusIntegrationConfig,
} from './consensus-integration.js';
import type { ChannelMembershipStore } from './channel-membership-store.js';
import {
  initTelemetry,
  track,
  shutdown as shutdownTelemetry,
} from '@agent-relay/telemetry';

// Get version: prefer build-time injected version (for standalone binaries), fall back to package.json
const DAEMON_VERSION: string = (() => {
  const envVersion = process.env.AGENT_RELAY_VERSION;
  if (envVersion) return envVersion;
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require('../package.json');
    return packageJson.version as string;
  } catch {
    return 'unknown';
  }
})();

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
  /** Cloud API URL (defaults to https://agent-relay.com) */
  cloudUrl?: string;
  /** Consensus mechanism for multi-agent decisions (enabled by default, set to false to disable) */
  consensus?: boolean | Partial<ConsensusIntegrationConfig>;
  /** Enable protocol-based spawning via SPAWN/RELEASE messages */
  spawnManager?: boolean | Partial<SpawnManagerConfig>;
}

export const DEFAULT_SOCKET_PATH = '/tmp/agent-relay.sock';

export const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
  ...DEFAULT_CONFIG,
  socketPath: DEFAULT_SOCKET_PATH,
  pidFilePath: `${DEFAULT_SOCKET_PATH}.pid`,
};

interface PendingAck {
  correlationId: string;
  connectionId: string;
  connection: Connection;
  timeoutHandle: NodeJS.Timeout;
}

export class Daemon {
  private server: net.Server;
  private router!: Router;
  private config: DaemonConfig;
  private running = false;
  private connections: Set<Connection> = new Set();
  private pendingAcks: Map<string, PendingAck> = new Map();
  private storage?: StorageAdapter;
  private storageInitialized = false;
  private registry?: AgentRegistry;
  private processingStateInterval?: NodeJS.Timeout;
  private cloudSync?: CloudSyncService;
  private remoteAgents: RemoteAgent[] = [];
  private remoteUsers: RemoteAgent[] = [];
  private consensus?: ConsensusIntegration;
  private cloudSyncDebounceTimer?: NodeJS.Timeout;
  private spawnManager?: SpawnManager;
  private shuttingDown = false;
  private storageHealth?: StorageHealth;

  /** Telemetry tracking */
  private startTime?: number;
  private agentSpawnCount = 0;

  /** Callback for log output from agents (used by dashboard for streaming) */
  onLogOutput?: (agentName: string, data: string, timestamp: number) => void;

  /** Interval for writing processing state file (500ms for responsive UI) */
  private static readonly PROCESSING_STATE_INTERVAL_MS = 500;
  private static readonly DEFAULT_SYNC_TIMEOUT_MS = 30000;

  constructor(config: Partial<DaemonConfig> = {}) {
    this.config = { ...DEFAULT_DAEMON_CONFIG, ...config };
    if (config.socketPath && !config.pidFilePath) {
      this.config.pidFilePath = `${config.socketPath}.pid`;
    }
    // Default teamDir to same directory as socket, but avoid /tmp directly
    // because macOS can clean temp files causing atomic write failures
    if (!this.config.teamDir) {
      const socketDir = path.dirname(this.config.socketPath);
      // If socket is in /tmp or /private/tmp, use a subdirectory
      if (socketDir === '/tmp' || socketDir === '/private/tmp') {
        this.config.teamDir = path.join(socketDir, 'agent-relay-state');
      } else {
        this.config.teamDir = socketDir;
      }
    }
    if (this.config.teamDir) {
      this.registry = new AgentRegistry(this.config.teamDir);
    }
    // SpawnManager is initialized in start() after router is created
    // so we can wire up onMarkSpawning/onClearSpawning callbacks
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
      const targetDir = this.config.teamDir ?? path.dirname(this.config.socketPath);
      const targetPath = path.join(targetDir, 'agents.json');
      // Ensure directory exists (defensive - may have been deleted)
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
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
    // Skip writes during shutdown to avoid race conditions with directory cleanup
    if (this.shuttingDown) return;

    try {
      const processingAgents = this.router.getProcessingAgents();
      const targetDir = this.config.teamDir ?? path.dirname(this.config.socketPath);
      const targetPath = path.join(targetDir, 'processing-state.json');
      // Ensure directory exists (defensive - may have been deleted)
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      const data = JSON.stringify({ processingAgents, updatedAt: Date.now() }, null, 2);
      const tempPath = `${targetPath}.tmp`;
      fs.writeFileSync(tempPath, data, 'utf-8');
      fs.renameSync(tempPath, targetPath);
    } catch (err) {
      // Suppress ENOENT errors during shutdown race conditions
      if (!this.shuttingDown) {
        log.error('Failed to write processing-state.json', { error: String(err) });
      }
    }
  }

  /**
   * Write currently connected agents to connected-agents.json for CLI consumption.
   * This file contains agents with active socket connections (vs agents.json which is historical).
   */
  private writeConnectedAgentsFile(): void {
    try {
      const connectedAgents = this.router.getAgents();
      const connectedUsers = this.router.getUsers();
      const targetDir = this.config.teamDir ?? path.dirname(this.config.socketPath);
      const targetPath = path.join(targetDir, 'connected-agents.json');

      // Debug: log what we're writing
      log.info('Writing connected-agents.json', {
        agents: connectedAgents.join(','),
        path: targetPath,
        teamDir: this.config.teamDir,
      });

      // Ensure directory exists (defensive - may have been deleted)
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      const data = JSON.stringify({
        agents: connectedAgents,
        users: connectedUsers,
        updatedAt: Date.now(),
      }, null, 2);
      const tempPath = `${targetPath}.tmp`;
      fs.writeFileSync(tempPath, data, 'utf-8');
      fs.renameSync(tempPath, targetPath);
    } catch (err) {
      log.error('Failed to write connected-agents.json', { error: String(err) });
    }
  }

  /**
   * Mark an agent as spawning (before HELLO completes).
   * Messages sent to this agent will be queued for delivery after registration.
   * Call this before starting the agent's PTY process.
   */
  markSpawning(agentName: string): void {
    this.router.markSpawning(agentName);
  }

  /**
   * Clear the spawning flag for an agent.
   * Called when spawn fails or is cancelled (successful registration clears automatically).
   */
  clearSpawning(agentName: string): void {
    this.router.clearSpawning(agentName);
  }

  /**
   * Remove a stale agent from the router (used when process dies without clean disconnect).
   * This is called by the orchestrator's health monitoring when a PID is detected as dead.
   */
  removeStaleAgent(agentName: string): boolean {
    const removed = this.router.forceRemoveAgent(agentName);
    if (removed) {
      // Notify cloud sync about agent removal
      this.notifyCloudSync();
      // Update connected-agents.json to reflect the removal
      this.writeConnectedAgentsFile();
      log.info('Removed stale agent from router', { agentName });
    }
    return removed;
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

    let channelMembershipStore: ChannelMembershipStore | undefined;
    const workspaceId = process.env.RELAY_WORKSPACE_ID
      || process.env.AGENT_RELAY_WORKSPACE_ID
      || process.env.WORKSPACE_ID;
    const databaseUrl = process.env.CLOUD_DATABASE_URL
      || process.env.DATABASE_URL
      || process.env.AGENT_RELAY_STORAGE_URL;
    const isPostgresUrl = databaseUrl?.startsWith('postgres://') || databaseUrl?.startsWith('postgresql://');

    if (workspaceId && isPostgresUrl && databaseUrl) {
      try {
        const { CloudChannelMembershipStore } = await import('./channel-membership-store.js');
        channelMembershipStore = new CloudChannelMembershipStore({ workspaceId, databaseUrl });
        log.info('Channel membership store enabled (cloud DB)', { workspaceId });
      } catch (err) {
        log.error('Failed to initialize channel membership store', { error: String(err) });
      }
    } else {
      log.debug('Channel membership store disabled (missing workspaceId or Postgres database URL)');
    }

    this.router = new Router({
      storage: this.storage,
      registry: this.registry,
      onProcessingStateChange: () => this.writeProcessingStateFile(),
      crossMachineHandler: {
        sendCrossMachineMessage: this.sendCrossMachineMessage.bind(this),
        isRemoteAgent: this.isRemoteAgent.bind(this),
        isRemoteUser: this.isRemoteUser.bind(this),
      },
      channelMembershipStore,
    });

    // Initialize SpawnManager if enabled (after router, so we can wire callbacks)
    if (this.config.spawnManager) {
      const spawnConfig = typeof this.config.spawnManager === 'object'
        ? this.config.spawnManager
        : {};
      // Derive projectRoot from teamDir (teamDir is typically {projectRoot}/.agent-relay/)
      const projectRoot = spawnConfig.projectRoot || path.dirname(this.config.teamDir || this.config.socketPath);
      this.spawnManager = new SpawnManager({
        projectRoot,
        socketPath: this.config.socketPath,
        ...spawnConfig,
        // Track spawn count for telemetry
        onAgentSpawn: () => {
          this.agentSpawnCount++;
        },
        // Wire spawn tracking to router so messages are queued during spawn
        onMarkSpawning: (name: string) => this.router.markSpawning(name),
        onClearSpawning: (name: string) => this.router.clearSpawning(name),
        // Fallback for releasing agents not spawned by this instance
        onReleaseFallback: async (agentName: string, _reason?: string): Promise<boolean> => {
          // Check if agent is connected to the router
          if (this.router.forceRemoveAgent(agentName)) {
            log.info(`Release fallback: force-disconnected agent ${agentName}`);
            // Also clean up from storage if available
            if (this.storage?.removeAgent) {
              try {
                await this.storage.removeAgent(agentName);
              } catch (err) {
                log.warn(`Failed to remove agent ${agentName} from storage:`, { error: String(err) });
              }
            }
            return true;
          }
          return false;
        },
      });
      log.info('SpawnManager initialized with spawn tracking callbacks');
    }

    // Initialize consensus (enabled by default, can be disabled with consensus: false)
    if (this.config.consensus !== false) {
      const consensusConfig = typeof this.config.consensus === 'object'
        ? this.config.consensus
        : {};

      this.consensus = createConsensusIntegration(this.router, consensusConfig);
      log.info('Consensus mechanism enabled');
    }

    this.storageInitialized = true;
  }

  /**
   * Start the daemon.
   */
  async start(): Promise<void> {
    if (this.running) return;

    // Initialize telemetry (don't show notice - CLI handles that)
    initTelemetry({ showNotice: false });
    this.startTime = Date.now();
    this.agentSpawnCount = 0;

    // Initialize storage
    await this.initStorage();

    // Storage health check: warn if non-persistent (e.g., in-memory fallback)
    try {
      if (this.storage?.healthCheck) {
        this.storageHealth = await this.storage.healthCheck();
        if (!this.storageHealth.persistent) {
          console.warn('[daemon] ⚠️  Running in non-persistent mode!');
          console.warn('[daemon] Messages will be lost on restart.');
        }
      }
    } catch (err) {
      log.warn('Storage health check failed', { error: String(err) });
    }

    // Save runtime config so CLI commands can use the same storage type
    try {
      saveRuntimeConfig({
        storageType: this.storageHealth?.driver ?? this.config.storageConfig?.type ?? 'jsonl',
        daemonPid: process.pid,
        startedAt: new Date().toISOString(),
        version: DAEMON_VERSION,
      });
    } catch (err) {
      log.warn('Failed to save runtime config', { error: String(err) });
    }

    // Restore channel memberships from persisted storage (cloud DB or SQLite)
    await this.router.restoreChannelMemberships();

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

    // Clean up stale mcp-identity-* files from previous runs
    // These are left behind when agents crash or aren't cleaned up properly
    const dataDir = path.dirname(this.config.socketPath);
    try {
      const files = fs.readdirSync(dataDir);
      for (const file of files) {
        if (file.startsWith('mcp-identity-')) {
          const match = file.match(/mcp-identity-(\d+)/);
          if (match) {
            const identityPid = parseInt(match[1], 10);
            // Check if process is still running
            let isRunning = false;
            try {
              process.kill(identityPid, 0);
              isRunning = true;
            } catch {
              // Process not running
            }
            if (!isRunning) {
              const identityPath = path.join(dataDir, file);
              fs.unlinkSync(identityPath);
              log.info('Cleaned up stale identity file', { file });
            }
          }
        }
      }
    } catch (err) {
      log.warn('Failed to clean up stale identity files', { error: String(err) });
    }

    // Ensure socket directory exists
    const socketDir = path.dirname(this.config.socketPath);
    if (!fs.existsSync(socketDir)) {
      fs.mkdirSync(socketDir, { recursive: true });
    }

    // Ensure team directory exists for state files (agents.json, processing-state.json, etc.)
    // Always check and create, even if same as socketDir, to handle edge cases
    const teamDir = this.config.teamDir ?? socketDir;
    if (!fs.existsSync(teamDir)) {
      fs.mkdirSync(teamDir, { recursive: true });
    }

    // Set up inbox symlink for workspace namespacing
    // Daemon delivers to legacy path (/tmp/relay-inbox), symlink points to workspace path
    // This allows agents to use simple instructions while maintaining workspace isolation
    const workspaceId = process.env.RELAY_WORKSPACE_ID
      || process.env.AGENT_RELAY_WORKSPACE_ID
      || process.env.WORKSPACE_ID;

    const legacyInboxPath = '/tmp/relay-inbox';
    let inboxPath = legacyInboxPath;

    if (workspaceId) {
      // Workspace-namespaced inbox directory
      inboxPath = `/tmp/relay/${workspaceId}/inbox`;

      try {
        // Ensure workspace inbox directory exists
        const inboxDir = path.dirname(inboxPath);
        if (!fs.existsSync(inboxDir)) {
          fs.mkdirSync(inboxDir, { recursive: true });
        }
        if (!fs.existsSync(inboxPath)) {
          fs.mkdirSync(inboxPath, { recursive: true });
        }

        // Ensure legacy inbox parent directory exists
        const legacyInboxParent = path.dirname(legacyInboxPath);
        if (!fs.existsSync(legacyInboxParent)) {
          fs.mkdirSync(legacyInboxParent, { recursive: true });
        }

        // Create symlink from legacy path to workspace path
        // If legacy path exists as a regular directory, remove it first
        if (fs.existsSync(legacyInboxPath)) {
          try {
            const stats = fs.lstatSync(legacyInboxPath);
            if (stats.isSymbolicLink()) {
              // Already a symlink - remove and recreate to ensure correct target
              fs.unlinkSync(legacyInboxPath);
            } else if (stats.isDirectory()) {
              // Regular directory - remove it (may have stale files from previous run)
              fs.rmSync(legacyInboxPath, { recursive: true, force: true });
            }
          } catch {
            // Ignore errors during cleanup
          }
        }

        // Create the symlink: legacy path -> workspace path
        fs.symlinkSync(inboxPath, legacyInboxPath);
        log.info('Created inbox symlink', { from: legacyInboxPath, to: inboxPath });
      } catch (err: any) {
        log.error('Failed to set up inbox symlink', { error: err.message });
        // Fall back to creating legacy directory directly
        try {
          if (!fs.existsSync(legacyInboxPath)) {
            fs.mkdirSync(legacyInboxPath, { recursive: true });
          }
        } catch {
          // Ignore
        }
      }
    } else {
      // No workspace ID - just ensure legacy inbox directory exists
      try {
        if (!fs.existsSync(legacyInboxPath)) {
          fs.mkdirSync(legacyInboxPath, { recursive: true });
        }
      } catch (err: any) {
        log.error('Failed to create inbox directory', { error: err.message });
      }
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

        // Track daemon start
        track('daemon_start', {});

        log.info('Listening', { socketPath: this.config.socketPath });
        resolve();
      });
    });
  }

  /**
   * Initialize cloud sync service for cross-machine agent communication.
   */
  private async initCloudSync(): Promise<void> {
    // Check for cloud config file OR environment variables
    const dataDir = process.env.AGENT_RELAY_DATA_DIR ||
      path.join(os.homedir(), '.local', 'share', 'agent-relay');
    const configPath = path.join(dataDir, 'cloud-config.json');

    const hasConfigFile = fs.existsSync(configPath);
    const hasEnvApiKey = !!process.env.AGENT_RELAY_API_KEY;

    // Allow cloud sync if config file exists OR API key is set via env var
    // This enables cloud-hosted workspaces (Fly.io) to sync messages without a config file
    if (!hasConfigFile && !hasEnvApiKey) {
      log.info('Cloud sync disabled (not linked to cloud)');
      return;
    }

    try {
      let apiKey: string | undefined;
      let cloudUrl: string | undefined;

      if (hasConfigFile) {
        // Use config file (local daemons linked via CLI)
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        apiKey = config.apiKey;
        cloudUrl = config.cloudUrl;
      } else {
        // Use env vars (cloud-hosted workspaces like Fly.io)
        apiKey = process.env.AGENT_RELAY_API_KEY;
        // CLOUD_API_URL is set by Fly.io provisioner, AGENT_RELAY_CLOUD_URL is the standard
        cloudUrl = process.env.AGENT_RELAY_CLOUD_URL || process.env.CLOUD_API_URL;
        log.info('Using environment variables for cloud sync', { hasApiKey: !!apiKey, hasCloudUrl: !!cloudUrl });
      }

      // Get project root for workspace detection via git remote
      const projectPaths = getProjectPaths();

      this.cloudSync = getCloudSync({
        apiKey,
        cloudUrl: cloudUrl || this.config.cloudUrl,
        enabled: this.config.cloudSync !== false,
        projectDirectory: projectPaths.projectRoot,
      });

      // Listen for remote agent updates
      this.cloudSync.on('remote-agents-updated', (agents: RemoteAgent[]) => {
        this.remoteAgents = agents;
        log.info('Remote agents updated', { count: agents.length });
        this.writeRemoteAgentsFile();
      });

      // Listen for remote user updates (humans connected via cloud dashboard)
      this.cloudSync.on('remote-users-updated', (users: RemoteAgent[]) => {
        this.remoteUsers = users;
        log.info('Remote users updated', { count: users.length });
        this.writeRemoteUsersFile();
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

      // Set storage adapter for message sync to cloud
      if (this.storage) {
        this.cloudSync.setStorage(this.storage);
      }

      // Set metrics provider for agent metrics sync to cloud
      // Uses the singleton memory monitor from @agent-relay/resiliency
      const memoryMonitor = getMemoryMonitor();
      const metricsProvider: AgentMetricsProvider = {
        getAll: () => {
          return memoryMonitor.getAll().map(m => ({
            name: m.name,
            pid: m.pid,
            status: m.alertLevel === 'normal' ? 'running' : m.alertLevel,
            rssBytes: m.current.rssBytes,
            heapUsedBytes: m.current.heapUsedBytes,
            heapTotalBytes: m.current.heapTotalBytes,
            cpuPercent: m.current.cpuPercent,
            trend: m.trend,
            trendRatePerMinute: m.trendRatePerMinute,
            alertLevel: m.alertLevel,
            highWatermark: m.highWatermark,
            averageRss: m.averageRss,
            uptimeMs: m.uptimeMs,
            startedAt: m.startedAt,
          }));
        },
      };
      this.cloudSync.setMetricsProvider(metricsProvider);

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
   * Write remote users to file for dashboard consumption.
   * Remote users are humans connected via the cloud dashboard.
   */
  private writeRemoteUsersFile(): void {
    try {
      const targetPath = path.join(
        this.config.teamDir ?? path.dirname(this.config.socketPath),
        'remote-users.json'
      );
      const data = JSON.stringify({
        users: this.remoteUsers,
        updatedAt: Date.now(),
      }, null, 2);
      const tempPath = `${targetPath}.tmp`;
      fs.writeFileSync(tempPath, data, 'utf-8');
      fs.renameSync(tempPath, targetPath);
    } catch (err) {
      log.error('Failed to write remote-users.json', { error: String(err) });
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
    const envelope: SendEnvelope = {
      v: 1,
      type: 'SEND',
      id: generateId(),
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

    this.router.route(targetConnection, envelope);
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
   * Check if a user is on a remote machine (connected via cloud dashboard).
   */
  isRemoteUser(userName: string): RemoteAgent | undefined {
    return this.remoteUsers.find(u => u.name === userName);
  }

  /**
   * Notify cloud sync about local agent changes.
   * Debounced to prevent flooding the cloud API with rapid connect/disconnect events.
   */
  private notifyCloudSync(): void {
    if (!this.cloudSync?.isConnected()) return;

    // Debounce: clear any pending sync and schedule a new one
    if (this.cloudSyncDebounceTimer) {
      clearTimeout(this.cloudSyncDebounceTimer);
    }

    this.cloudSyncDebounceTimer = setTimeout(() => {
      this.cloudSyncDebounceTimer = undefined;
      this.doCloudSync();
    }, 1000); // 1 second debounce
  }

  /**
   * Actually perform the cloud sync (called after debounce).
   */
  private doCloudSync(): void {
    if (!this.cloudSync?.isConnected()) return;

    // Get AI agents (exclude internal ones like Dashboard)
    const aiAgents = Array.from(this.connections)
      .filter(c => {
        if (!c.agentName) return false;
        if (c.entityType === 'user') return false;
        if (this.isInternalAgent(c.agentName)) return false;
        return true;
      })
      .map(c => ({
        name: c.agentName!,
        status: 'online',
        isHuman: false,
      }));

    // Get human users (entityType === 'user', exclude Dashboard)
    const humanUsers = Array.from(this.connections)
      .filter(c => {
        if (!c.agentName) return false;
        if (c.entityType !== 'user') return false;
        if (this.isInternalAgent(c.agentName)) return false;
        return true;
      })
      .map(c => ({
        name: c.agentName!,
        status: 'online',
        isHuman: true,
        avatarUrl: c.avatarUrl,
      }));

    this.cloudSync.updateAgents([...aiAgents, ...humanUsers]);
  }

  /**
   * Check if an agent is internal (should be hidden from cloud sync and listings).
   */
  private isInternalAgent(name: string): boolean {
    if (name.startsWith('__')) return true;
    // Dashboard and cli are internal system agents
    return name === 'Dashboard' || name === 'cli';
  }

  /**
   * Stop the daemon.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    // Mark as shutting down to prevent race conditions with state file writes
    this.shuttingDown = true;

    // Track daemon stop
    const uptimeSeconds = this.startTime
      ? Math.floor((Date.now() - this.startTime) / 1000)
      : 0;
    track('daemon_stop', {
      uptime_seconds: uptimeSeconds,
      agent_spawn_count: this.agentSpawnCount,
    });

    // Shutdown telemetry (flush pending events)
    await shutdownTelemetry();

    // Stop cloud sync
    if (this.cloudSync) {
      this.cloudSync.stop();
      this.cloudSync = undefined;
    }

    // Clear cloud sync debounce timer
    if (this.cloudSyncDebounceTimer) {
      clearTimeout(this.cloudSyncDebounceTimer);
      this.cloudSyncDebounceTimer = undefined;
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
        // Clear runtime config
        try {
          clearRuntimeConfig();
        } catch {
          // Ignore errors during shutdown
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
      this.handleAck(connection, envelope);
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
          team: connection.team,
        });

        // Auto-join all agents to #general channel
        this.router.autoJoinChannel(connection.agentName, '#general');

        // Record session start
        if (this.storage?.startSession) {
          const projectPaths = getProjectPaths();
          const storage = this.storage;
          const persistSession = async (): Promise<void> => {
            let startedAt = Date.now();
            if (connection.isResumed && storage.getSessionByResumeToken) {
              const existing = await storage.getSessionByResumeToken(connection.resumeToken);
              if (existing?.startedAt) {
                startedAt = existing.startedAt;
              }
            }

            await storage.startSession!({
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

      // Replay pending deliveries for resumed sessions (unacked messages from previous session)
      if (connection.isResumed) {
        this.router.replayPending(connection).catch(err => {
          log.error('Failed to replay pending messages', { error: String(err) });
        });
      }

      // Deliver any messages that were sent while this agent was offline
      // This handles messages sent during spawn timing gaps or brief disconnections
      this.router.deliverPendingMessages(connection).catch(err => {
        log.error('Failed to deliver pending messages', { error: String(err) });
      });

      // Auto-rejoin channels that the agent was a member of before daemon restart
      // This restores channel memberships from persisted storage (cloud DB or SQLite)
      if (connection.agentName) {
        this.router.autoRejoinChannelsForAgent(connection.agentName).catch(err => {
          log.error('Failed to auto-rejoin channels', { error: String(err) });
        });
      }

      // Notify cloud sync about agent changes
      this.notifyCloudSync();

      // Update connected agents file for CLI
      this.writeConnectedAgentsFile();

      // Broadcast AGENT_READY event to all connected clients
      // This allows spawning clients to know when their spawned agent is ready
      if (connection.agentName) {
        this.broadcastAgentReady(connection);
      }
    };

    connection.onClose = () => {
      log.debug('Connection closed', { agent: connection.agentName ?? connection.id });
      this.connections.delete(connection);
      this.clearPendingAcksForConnection(connection.id);
      this.router.unregister(connection);
      // Registry handles persistence internally via touch() -> save()
      if (connection.agentName) {
        this.registry?.touch(connection.agentName);
      }

      // Record session end (disconnect - agent may still mark it closed explicitly)
      if (this.storage?.endSession) {
        this.storage.endSession(connection.sessionId, { closedBy: 'disconnect' })
          .catch(err => log.error('Failed to record session end', { error: String(err) }));
      }

      // Notify cloud sync about agent changes
      this.notifyCloudSync();

      // Update connected agents file for CLI
      this.writeConnectedAgentsFile();
    };

    connection.onError = (error: Error) => {
      log.error('Connection error', { error: error.message });
      this.connections.delete(connection);
      this.clearPendingAcksForConnection(connection.id);
      this.router.unregister(connection);
      // Registry handles persistence internally via touch() -> save()
      if (connection.agentName) {
        this.registry?.touch(connection.agentName);
      }

      // Record session end on error
      if (this.storage?.endSession) {
        this.storage.endSession(connection.sessionId, { closedBy: 'error' })
          .catch(err => log.error('Failed to record session end', { error: String(err) }));
      }

      // Update connected agents file for CLI
      this.writeConnectedAgentsFile();
    };
  }

  /**
   * Handle incoming message from a connection.
   */
  private handleMessage(connection: Connection, envelope: Envelope): void {
    switch (envelope.type) {
      case 'SEND': {
        const sendEnvelope = envelope as SendEnvelope;

        const membershipUpdate = (sendEnvelope.payload.data as { _channelMembershipUpdate?: { channel?: string; member?: string; action?: 'join' | 'leave' | 'invite' } })?._channelMembershipUpdate;
        if (membershipUpdate && sendEnvelope.to === '_router') {
          this.router.handleMembershipUpdate({
            channel: membershipUpdate.channel ?? '',
            member: membershipUpdate.member ?? '',
            action: membershipUpdate.action ?? 'join',
          });
          return;
        }

        // Check for consensus commands (messages to _consensus)
        if (this.consensus?.enabled && sendEnvelope.to === '_consensus') {
          const from = connection.agentName ?? 'unknown';
          const result = this.consensus.processIncomingMessage(from, sendEnvelope.payload.body);

          if (result.isConsensusCommand) {
            log.info(`Consensus ${result.type} from ${from}`, {
              success: result.result?.success,
              proposalId: result.result?.proposal?.id,
            });
            // Don't route consensus commands to the router
            return;
          }
        }

        const syncMeta = sendEnvelope.payload_meta?.sync;
        if (syncMeta?.blocking) {
          if (!syncMeta.correlationId) {
            this.sendErrorEnvelope(connection, 'Missing sync correlationId for blocking SEND');
            return;
          }
          const registered = this.registerPendingAck(connection, syncMeta.correlationId, syncMeta.timeoutMs);
          if (!registered) {
            return;
          }
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

      // Channel messaging handlers
      case 'CHANNEL_JOIN': {
        const channelEnvelope = envelope as Envelope<ChannelJoinPayload>;
        log.info(`Channel join: ${connection.agentName} -> ${channelEnvelope.payload.channel}`);
        this.router.handleChannelJoin(connection, channelEnvelope);
        break;
      }

      case 'CHANNEL_LEAVE': {
        const channelEnvelope = envelope as Envelope<ChannelLeavePayload>;
        log.info(`Channel leave: ${connection.agentName} <- ${channelEnvelope.payload.channel}`);
        this.router.handleChannelLeave(connection, channelEnvelope);
        break;
      }

      case 'CHANNEL_MESSAGE': {
        const channelEnvelope = envelope as Envelope<ChannelMessagePayload>;
        log.info(`CHANNEL_MESSAGE received: from=${connection.agentName} channel=${channelEnvelope.payload.channel}`);
        this.router.routeChannelMessage(connection, channelEnvelope);
        break;
      }

      // Spawn/release handlers (protocol-based agent spawning)
      case 'SPAWN': {
        if (!this.spawnManager) {
          this.sendErrorEnvelope(connection, 'SpawnManager not enabled. Configure spawnManager: true in daemon config.');
          break;
        }
        const spawnEnvelope = envelope as Envelope<SpawnPayload>;
        log.info(`SPAWN request: from=${connection.agentName} agent=${spawnEnvelope.payload.name} cli=${spawnEnvelope.payload.cli}`);
        this.spawnManager.handleSpawn(connection, spawnEnvelope);
        break;
      }

      case 'RELEASE': {
        if (!this.spawnManager) {
          this.sendErrorEnvelope(connection, 'SpawnManager not enabled. Configure spawnManager: true in daemon config.');
          break;
        }
        const releaseEnvelope = envelope as Envelope<ReleasePayload>;
        log.info(`RELEASE request: from=${connection.agentName} agent=${releaseEnvelope.payload.name}`);
        this.spawnManager.handleRelease(connection, releaseEnvelope);
        break;
      }

      // Query handlers (MCP/client requests)
      case 'STATUS': {
        const uptimeMs = this.startTime ? Date.now() - this.startTime : 0;
        const sendStatus = async (): Promise<void> => {
          let storageHealth: StorageHealth | undefined;
          if (this.storage?.healthCheck) {
            try {
              storageHealth = await this.storage.healthCheck();
              this.storageHealth = storageHealth;
            } catch (err) {
              log.warn('STATUS: storage health check failed', { error: String(err) });
              storageHealth = this.storageHealth;
            }
          }

          const response: Envelope<StatusResponsePayload> = {
            v: PROTOCOL_VERSION,
            type: 'STATUS_RESPONSE',
            id: envelope.id,
            ts: Date.now(),
            payload: {
              version: DAEMON_VERSION,
              uptime: uptimeMs,
              cloudConnected: this.cloudSync?.isConnected() ?? false,
              agentCount: this.router.connectionCount,
              storage: storageHealth,
            },
          };
          connection.send(response);
        };

        sendStatus().catch(err => {
          log.error('Failed to send STATUS response', { error: String(err) });
        });
        break;
      }

      case 'INBOX': {
        const inboxPayload = envelope.payload as InboxPayload;
        const agentName = inboxPayload.agent || connection.agentName;

        // Get messages from storage
        const getInboxMessages = async () => {
          if (!this.storage?.getMessages) {
            return [];
          }
          try {
            // If channel is specified, get channel messages; otherwise get DMs to agent
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
          } catch {
            return [];
          }
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
          this.sendErrorEnvelope(connection, `Failed to get inbox: ${err.message}`);
        });
        break;
      }

      case 'MESSAGES_QUERY': {
        // Query all messages (used by dashboard) - not filtered by recipient
        const queryPayload = envelope.payload as MessagesQueryPayload;

        const getMessages = async () => {
          if (!this.storage?.getMessages) {
            return [];
          }
          try {
            const messages = await this.storage.getMessages({
              limit: queryPayload.limit || 100,
              sinceTs: queryPayload.sinceTs,
              from: queryPayload.from,
              to: queryPayload.to,
              thread: queryPayload.thread,
              order: queryPayload.order || 'desc',
            });
            return messages.map(m => ({
              id: m.id,
              from: m.from,
              to: m.to,
              body: m.body,
              channel: (m.data as { channel?: string })?.channel,
              thread: m.thread,
              timestamp: m.ts,
              status: m.status,
              isBroadcast: m.is_broadcast,
              replyCount: m.replyCount,
              data: m.data,
            }));
          } catch {
            return [];
          }
        };

        getMessages().then(messages => {
          const response: Envelope<MessagesResponsePayload> = {
            v: PROTOCOL_VERSION,
            type: 'MESSAGES_RESPONSE',
            id: envelope.id,
            ts: Date.now(),
            payload: { messages },
          };
          connection.send(response);
        }).catch(err => {
          this.sendErrorEnvelope(connection, `Failed to get messages: ${err.message}`);
        });
        break;
      }

      case 'LIST_AGENTS': {
        const listPayload = envelope.payload as ListAgentsPayload;

        // Get connected agents from router
        const connectedAgents = this.router.getAgents();

        // Get all agents from registry for metadata lookup
        const registryAgents = this.registry?.getAgents() ?? [];
        const registryMap = new Map(registryAgents.map(a => [a.name, a]));

        // Get active workers from spawn manager for PID lookup
        const activeWorkers = this.spawnManager?.getActiveWorkers() ?? [];
        const workerMap = new Map(activeWorkers.map(w => [w.name, w]));

        // Build agent list from connected agents
        const agents = connectedAgents
          .filter(name => !this.isInternalAgent(name))
          .map(name => {
            const registryAgent = registryMap.get(name);
            const conn = this.router.getConnection(name);
            const worker = workerMap.get(name);
            return {
              name,
              cli: conn?.cli ?? registryAgent?.cli,
              idle: false, // Connected agents are not idle
              parent: worker?.spawnerName,
              team: conn?.team ?? worker?.team,
              pid: worker?.pid,
            };
          });

        // Optionally include idle agents from registry
        if (listPayload.includeIdle && this.registry) {
          for (const agent of registryAgents) {
            if (!connectedAgents.includes(agent.name) && !this.isInternalAgent(agent.name)) {
              agents.push({
                name: agent.name,
                cli: agent.cli,
                idle: true,
                parent: undefined,
                team: agent.team,
                pid: undefined,
              });
            }
          }
        }

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
        // Returns only currently connected agents (not historical/registered agents)
        const connectedAgentNames = this.router.getAgents();
        const registryAgents = this.registry?.getAgents() ?? [];
        const registryMap = new Map(registryAgents.map(a => [a.name, a]));

        // Get active workers from spawn manager for PID lookup
        const workers = this.spawnManager?.getActiveWorkers() ?? [];
        const workersByName = new Map(workers.map(w => [w.name, w]));

        const agents = connectedAgentNames
          .filter(name => !this.isInternalAgent(name))
          .map(name => {
            const registryAgent = registryMap.get(name);
            const conn = this.router.getConnection(name);
            const worker = workersByName.get(name);
            return {
              name,
              cli: conn?.cli ?? registryAgent?.cli,
              idle: false,
              parent: worker?.spawnerName,
              team: conn?.team ?? worker?.team,
              pid: worker?.pid,
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

      case 'REMOVE_AGENT': {
        const removePayload = envelope.payload as RemoveAgentPayload;
        const agentName = removePayload.name;

        // Validate agent name
        if (!agentName || typeof agentName !== 'string' || agentName.length === 0) {
          const errorResponse: Envelope<RemoveAgentResponsePayload> = {
            v: PROTOCOL_VERSION,
            type: 'REMOVE_AGENT_RESPONSE',
            id: envelope.id,
            ts: Date.now(),
            payload: { success: false, removed: false, message: 'Invalid agent name: name is required' },
          };
          connection.send(errorResponse);
          break;
        }

        if (agentName.length > 128) {
          const errorResponse: Envelope<RemoveAgentResponsePayload> = {
            v: PROTOCOL_VERSION,
            type: 'REMOVE_AGENT_RESPONSE',
            id: envelope.id,
            ts: Date.now(),
            payload: { success: false, removed: false, message: 'Invalid agent name: exceeds 128 characters' },
          };
          connection.send(errorResponse);
          break;
        }

        const doRemove = async (): Promise<{ removed: boolean; message: string }> => {
          let removed = false;
          let message = '';

          // Remove from registry (agents.json)
          if (this.registry) {
            const wasInRegistry = this.registry.getAgents().some(a => a.name === agentName);
            if (wasInRegistry) {
              this.registry.remove(agentName);
              removed = true;
              message = `Removed ${agentName} from registry`;
            }
          }

          // Remove from storage (sessions table) if storage is available
          if (this.storage?.removeAgent) {
            await this.storage.removeAgent(agentName);
            if (!removed) {
              removed = true;
              message = `Removed ${agentName} from storage`;
            } else {
              message += ' and storage';
            }
          }

          // Optionally remove messages
          if (removePayload.removeMessages && this.storage?.removeMessagesForAgent) {
            await this.storage.removeMessagesForAgent(agentName);
            message += ' (including messages)';
          }

          // Force remove from router if still connected (shouldn't be, but just in case)
          if (this.router.forceRemoveAgent(agentName)) {
            message += ', disconnected from router';
            // Notify cloud sync and update connected-agents.json
            this.notifyCloudSync();
            this.writeConnectedAgentsFile();
          }

          if (!removed) {
            message = `Agent ${agentName} not found in registry or storage`;
          }

          return { removed, message };
        };

        doRemove().then(({ removed, message }) => {
          const removeResponse: Envelope<RemoveAgentResponsePayload> = {
            v: PROTOCOL_VERSION,
            type: 'REMOVE_AGENT_RESPONSE',
            id: envelope.id,
            ts: Date.now(),
            payload: { success: removed, removed, message },
          };
          connection.send(removeResponse);
        }).catch(err => {
          const removeResponse: Envelope<RemoveAgentResponsePayload> = {
            v: PROTOCOL_VERSION,
            type: 'REMOVE_AGENT_RESPONSE',
            id: envelope.id,
            ts: Date.now(),
            payload: { success: false, removed: false, message: `Error: ${(err as Error).message}` },
          };
          connection.send(removeResponse);
        });
        break;
      }

      case 'HEALTH': {
        const healthPayload = envelope.payload as HealthPayload;

        // Compute health based on available data
        const connectedAgents = this.router.getAgents();
        const registryAgents = this.registry?.getAgents() ?? [];
        const agentCount = connectedAgents.filter(n => !this.isInternalAgent(n)).length;

        // Basic health computation
        const issues: Array<{ severity: string; message: string }> = [];
        const recommendations: string[] = [];
        let healthScore = 100;

        // Check for memory issues via memory monitor
        const memoryMonitor = getMemoryMonitor();
        const memoryMetrics = memoryMonitor.getAll();
        const criticalAgents = memoryMetrics.filter(m => m.alertLevel === 'critical');
        const warningAgents = memoryMetrics.filter(m => m.alertLevel === 'warning');

        if (criticalAgents.length > 0) {
          healthScore -= 30;
          for (const agent of criticalAgents) {
            issues.push({ severity: 'critical', message: `${agent.name} has critical memory usage` });
          }
          recommendations.push('Consider releasing some agents to free memory');
        }

        if (warningAgents.length > 0) {
          healthScore -= 10;
          for (const agent of warningAgents) {
            issues.push({ severity: 'warning', message: `${agent.name} has high memory usage` });
          }
        }

        // Check cloud sync status
        if (!this.cloudSync?.isConnected()) {
          issues.push({ severity: 'info', message: 'Cloud sync not connected' });
        }

        const summary = healthScore >= 80 ? 'System is healthy' :
                        healthScore >= 50 ? 'System has some issues' :
                        'System needs attention';

        const healthResponse: Envelope<HealthResponsePayload> = {
          v: PROTOCOL_VERSION,
          type: 'HEALTH_RESPONSE',
          id: envelope.id,
          ts: Date.now(),
          payload: {
            healthScore: Math.max(0, healthScore),
            summary,
            issues,
            recommendations,
            crashes: [], // Would need crash tracking implementation
            alerts: [], // Would need alert tracking implementation
            stats: {
              totalCrashes24h: 0,
              totalAlerts24h: 0,
              agentCount,
            },
          },
        };
        connection.send(healthResponse);
        break;
      }

      case 'METRICS': {
        const metricsPayload = envelope.payload as MetricsPayload;

        // Get metrics from memory monitor
        const memoryMonitor = getMemoryMonitor();
        let metrics = memoryMonitor.getAll();

        // Filter to specific agent if requested
        if (metricsPayload.agent) {
          metrics = metrics.filter(m => m.name === metricsPayload.agent);
        }

        // Convert to response format
        const agents = metrics.map(m => ({
          name: m.name,
          pid: m.pid,
          status: m.alertLevel === 'normal' ? 'running' : m.alertLevel,
          rssBytes: m.current.rssBytes,
          cpuPercent: m.current.cpuPercent,
          trend: m.trend,
          alertLevel: m.alertLevel,
          highWatermark: m.highWatermark,
          uptimeMs: m.uptimeMs,
        }));

        // System metrics
        const system = {
          totalMemory: os.totalmem(),
          freeMemory: os.freemem(),
          heapUsed: process.memoryUsage().heapUsed,
        };

        const metricsResponse: Envelope<MetricsResponsePayload> = {
          v: PROTOCOL_VERSION,
          type: 'METRICS_RESPONSE',
          id: envelope.id,
          ts: Date.now(),
          payload: { agents, system },
        };
        connection.send(metricsResponse);
        break;
      }
    }
  }

  private handleAck(connection: Connection, envelope: Envelope<AckPayload>): void {
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

  private registerPendingAck(connection: Connection, correlationId: string, timeoutMs?: number): boolean {
    if (this.pendingAcks.has(correlationId)) {
      this.sendErrorEnvelope(connection, `Duplicate correlationId: ${correlationId}`);
      return false;
    }

    const timeout = timeoutMs ?? Daemon.DEFAULT_SYNC_TIMEOUT_MS;
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

  private sendErrorEnvelope(connection: Connection, message: string): void {
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

  /**
   * Get list of connected agents.
   */
  getAgents(): string[] {
    return this.router.getAgents();
  }

  /**
   * Broadcast a system message to all connected agents.
   * Used for system notifications like agent death announcements.
   */
  broadcastSystemMessage(message: string, data?: Record<string, unknown>): void {
    this.router.broadcastSystemMessage(message, data);
  }

  /**
   * Broadcast AGENT_READY event when an agent completes connection.
   * This allows spawning clients to know when their spawned agent is ready to receive messages.
   */
  private broadcastAgentReady(connection: Connection): void {
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

    // Broadcast to all connections except the one that just connected
    for (const conn of this.connections) {
      if (conn.id !== connection.id && conn.state === 'ACTIVE') {
        conn.send(envelope);
      }
    }

    log.info('Broadcast AGENT_READY', { agent: connection.agentName });
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

  /**
   * Check if consensus is enabled.
   */
  get consensusEnabled(): boolean {
    return this.consensus?.enabled ?? false;
  }

  /**
   * Get the consensus integration (for API access).
   */
  getConsensus(): ConsensusIntegration | undefined {
    return this.consensus;
  }
}

// Run as standalone if executed directly (not in bundled CLI)
// In bundled builds, AGENT_RELAY_VERSION is defined, so we skip auto-start
// The CLI handles daemon startup via the 'up' command
const isMainModule = import.meta.url === `file://${process.argv[1]}` &&
  !process.env.AGENT_RELAY_VERSION;
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
