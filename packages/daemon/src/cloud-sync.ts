/**
 * Cloud Sync Service
 *
 * Handles automatic bridging between local daemons via the cloud:
 * - Heartbeat to report status
 * - Agent discovery across machines
 * - Cross-machine message relay
 * - Credential sync from cloud
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomBytes } from 'crypto';
import { createLogger } from '@agent-relay/utils/logger';
import type { StorageAdapter, StoredMessage } from '@agent-relay/storage/adapter';
import { SyncQueue, type SyncQueueConfig, type SyncQueueStats } from './sync-queue.js';
import { getRepoFullNameFromPath } from '@agent-relay/utils/git-remote';

const log = createLogger('cloud-sync');

export interface CloudSyncConfig {
  apiKey?: string;
  cloudUrl: string;
  heartbeatInterval: number; // ms
  enabled: boolean;
  /** Enable message sync to cloud (default: true if connected) */
  messageSyncEnabled?: boolean;
  /** Batch size for message sync (default: 100) */
  messageSyncBatchSize?: number;

  // Optimized sync queue options
  /** Use optimized sync queue with compression and spillover (default: true) */
  useOptimizedSync?: boolean;
  /** Sync queue configuration */
  syncQueue?: Partial<SyncQueueConfig>;

  // Project context for workspace resolution
  /** Project directory for git remote detection (defaults to cwd) */
  projectDirectory?: string;

  /** Enable agent metrics sync to cloud (default: true if connected) */
  metricsSyncEnabled?: boolean;
}

/**
 * Agent metrics data for cloud sync
 */
export interface AgentMetricsPayload {
  name: string;
  pid?: number;
  status: string;
  rssBytes?: number;
  heapUsedBytes?: number;
  heapTotalBytes?: number;
  cpuPercent?: number;
  trend?: string;
  trendRatePerMinute?: number;
  alertLevel?: string;
  highWatermark?: number;
  averageRss?: number;
  uptimeMs?: number;
  startedAt?: Date;
}

/**
 * Provider interface for getting agent metrics
 */
export interface AgentMetricsProvider {
  getAll(): AgentMetricsPayload[];
}

export interface RemoteAgent {
  name: string;
  status: string;
  daemonId: string;
  daemonName: string;
  machineId: string;
}

export interface CrossMachineMessage {
  from: {
    daemonId: string;
    daemonName: string;
    agent: string;
  };
  to: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export class CloudSyncService extends EventEmitter {
  private config: CloudSyncConfig;
  private heartbeatTimer?: NodeJS.Timeout;
  private machineId: string;
  private localAgents: Map<string, { name: string; status: string; isHuman?: boolean; avatarUrl?: string }> = new Map();
  private remoteAgents: RemoteAgent[] = [];
  private remoteUsers: RemoteAgent[] = [];
  private connected = false;
  private useLegacyHeartbeat = false;
  private storage: StorageAdapter | null = null;
  private lastMessageSyncTs: number = 0;
  private messageSyncInProgress = false;

  // Project context for workspace resolution
  private projectDirectory: string;
  private repoFullName: string | null = null;

  // Optimized sync queue
  private syncQueue: SyncQueue | null = null;

  // Agent metrics provider (e.g., AgentMemoryMonitor)
  private metricsProvider: AgentMetricsProvider | null = null;

  constructor(config: Partial<CloudSyncConfig> = {}) {
    super();

    this.config = {
      apiKey: config.apiKey || process.env.AGENT_RELAY_API_KEY,
      cloudUrl: config.cloudUrl || process.env.AGENT_RELAY_CLOUD_URL || 'https://agent-relay.com',
      heartbeatInterval: config.heartbeatInterval
        || (process.env.AGENT_RELAY_HEARTBEAT_INTERVAL ? parseInt(process.env.AGENT_RELAY_HEARTBEAT_INTERVAL, 10) : 0)
        || 60000, // 60 seconds default; override via AGENT_RELAY_HEARTBEAT_INTERVAL env var
      enabled: config.enabled ?? true,
      useOptimizedSync: config.useOptimizedSync ?? true,
      syncQueue: config.syncQueue,
      projectDirectory: config.projectDirectory,
    };

    // Generate or load machine ID for consistent identification
    this.machineId = this.getMachineId();

    // Initialize project context for workspace resolution
    this.projectDirectory = this.config.projectDirectory || process.cwd();
    this.repoFullName = getRepoFullNameFromPath(this.projectDirectory);
    if (this.repoFullName) {
      log.info('Detected git repository', { repoFullName: this.repoFullName });
    }

    // Initialize optimized sync queue if enabled and API key is available
    if (this.config.useOptimizedSync && this.config.apiKey) {
      this.syncQueue = new SyncQueue({
        cloudUrl: this.config.cloudUrl,
        apiKey: this.config.apiKey,
        ...this.config.syncQueue,
      });
    }
  }

  /**
   * Get or create a persistent machine ID
   */
  private getMachineId(): string {
    const dataDir = process.env.AGENT_RELAY_DATA_DIR ||
      path.join(os.homedir(), '.local', 'share', 'agent-relay');

    const machineIdPath = path.join(dataDir, 'machine-id');

    try {
      if (fs.existsSync(machineIdPath)) {
        return fs.readFileSync(machineIdPath, 'utf-8').trim();
      }

      // Generate new machine ID
      const machineId = `${os.hostname()}-${randomBytes(8).toString('hex')}`;

      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(machineIdPath, machineId);

      return machineId;
    } catch {
      // Fallback: generate ephemeral ID
      return `${os.hostname()}-${Date.now().toString(36)}`;
    }
  }

  /**
   * Start the cloud sync service
   */
  async start(): Promise<void> {
    if (!this.config.enabled || !this.config.apiKey) {
      log.info('Disabled (no API key configured)');
      log.info('Run `agent-relay cloud link` to connect to cloud');
      return;
    }

    log.info('Starting cloud sync', { url: this.config.cloudUrl });

    // Recover any spilled messages from previous runs
    if (this.syncQueue) {
      const { recovered, failed } = await this.syncQueue.recoverSpilledMessages();
      if (recovered > 0 || failed > 0) {
        log.info('Recovered spilled messages', { recovered, failed });
      }
    }

    // Initial heartbeat
    await this.sendHeartbeat();

    // Start periodic heartbeat
    this.heartbeatTimer = setInterval(
      () => this.sendHeartbeat().catch((err) => log.error('Heartbeat failed', { error: String(err) })),
      this.config.heartbeatInterval
    );

    this.connected = true;
    this.emit('connected');
  }

  /**
   * Stop the cloud sync service
   */
  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    // Gracefully close sync queue (flushes pending messages)
    if (this.syncQueue) {
      await this.syncQueue.close();
    }

    this.connected = false;
    this.emit('disconnected');
  }

  /**
   * Update local agent list (called by daemon when agents change)
   */
  updateAgents(agents: Array<{ name: string; status: string; isHuman?: boolean; avatarUrl?: string }>): void {
    this.localAgents.clear();
    for (const agent of agents) {
      this.localAgents.set(agent.name, agent);
    }

    // Trigger immediate sync if connected
    if (this.connected) {
      this.syncAgents().catch((err) => log.error('Agent sync failed', { error: String(err) }));
    }
  }

  /**
   * Get all remote agents (from other machines)
   */
  getRemoteAgents(): RemoteAgent[] {
    return this.remoteAgents;
  }

  /**
   * Send a message to an agent on another machine
   */
  async sendCrossMachineMessage(
    targetDaemonId: string,
    targetAgent: string,
    fromAgent: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    if (!this.connected) {
      throw new Error('Not connected to cloud');
    }

    const response = await fetch(`${this.config.cloudUrl}/api/daemons/message`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetDaemonId,
        targetAgent,
        message: {
          from: fromAgent,
          content,
          metadata,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to send cross-machine message: ${error}`);
    }
  }

  /**
   * Send heartbeat to cloud using the batched poll endpoint.
   * Combines heartbeat, messages, agents, and message sync into a single request.
   * Falls back to legacy individual endpoints if poll endpoint is not available.
   */
  private async sendHeartbeat(): Promise<void> {
    // Skip batched poll if server doesn't support it (cached 404)
    if (this.useLegacyHeartbeat) {
      return this.sendHeartbeatLegacy();
    }

    try {
      const agents = Array.from(this.localAgents.entries()).map(([name, info]) => ({
        name,
        status: info.status,
        isHuman: info.isHuman,
        avatarUrl: info.avatarUrl,
      }));

      // Prepare sync messages payload (if any)
      const syncMessages = await this.getSyncMessagesPayload();

      // Use AbortController for timeout (15 second timeout for batched poll)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(`${this.config.cloudUrl}/api/daemons/poll`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agents,
          metrics: {
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage(),
          },
          ...(syncMessages ? { syncMessages, repoFullName: this.repoFullName } : {}),
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));

      if (!response.ok) {
        if (response.status === 401) {
          log.error('Invalid API key. Run `agent-relay cloud link` to re-authenticate.');
          this.stop();
          return;
        }
        // If poll endpoint doesn't exist (404), cache and fall back to legacy
        if (response.status === 404) {
          log.info('Poll endpoint not available, switching to legacy endpoints permanently');
          this.useLegacyHeartbeat = true;
          return this.sendHeartbeatLegacy();
        }
        throw new Error(`Poll failed: ${response.status}`);
      }

      const data = await response.json() as {
        commands?: Array<{ type: string; payload: unknown }>;
        messages?: CrossMachineMessage[];
        allAgents?: RemoteAgent[];
        allUsers?: RemoteAgent[];
        sync?: { synced: number; duplicates: number };
        pollIntervalMs?: number;
      };

      // Process pending commands
      if (data.commands && data.commands.length > 0) {
        for (const cmd of data.commands) {
          this.emit('command', cmd);
        }
      }

      // Process queued cross-machine messages
      if (data.messages) {
        for (const msg of data.messages) {
          this.emit('cross-machine-message', msg);
        }
      }

      // Process agent discovery
      if (data.allAgents) {
        this.remoteAgents = data.allAgents.filter(
          (a) => !this.localAgents.has(a.name)
        );
        if (this.remoteAgents.length > 0) {
          this.emit('remote-agents-updated', this.remoteAgents);
        }
      }

      // Process remote users
      if (data.allUsers) {
        this.remoteUsers = data.allUsers.filter(
          (u) => !this.localAgents.has(u.name)
        );
        if (this.remoteUsers.length > 0) {
          this.emit('remote-users-updated', this.remoteUsers);
        }
      }

      // Process sync result
      if (data.sync && data.sync.synced > 0) {
        log.info(`Synced ${data.sync.synced} messages to cloud`, { duplicates: data.sync.duplicates });
      }

      // Update sync watermark if we synced messages
      if (syncMessages && syncMessages.length > 0 && data.sync && data.sync.synced >= 0) {
        this.lastMessageSyncTs = Math.max(...syncMessages.map((m) => m.ts));
      }

      // Respect server-recommended polling interval
      if (data.pollIntervalMs && data.pollIntervalMs !== this.config.heartbeatInterval) {
        const newInterval = Math.max(5000, data.pollIntervalMs); // Floor at 5s
        if (newInterval !== this.config.heartbeatInterval) {
          log.info(`Adjusting poll interval from ${this.config.heartbeatInterval}ms to ${newInterval}ms (server hint)`);
          this.config.heartbeatInterval = newInterval;
          // Restart the timer with new interval
          if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = setInterval(
              () => this.sendHeartbeat().catch((err) => log.error('Heartbeat failed', { error: String(err) })),
              this.config.heartbeatInterval
            );
          }
        }
      }

      // Push agent metrics separately (not part of poll)
      await this.pushAgentMetrics();
    } catch (error) {
      const errorMessage = String(error);
      if (error instanceof Error && error.name === 'AbortError') {
        log.error('Poll timeout (15s)', { url: this.config.cloudUrl });
      } else if (errorMessage.includes('fetch failed') || errorMessage.includes('ECONNREFUSED')) {
        log.error('Poll network error - cloud server unreachable', {
          url: this.config.cloudUrl,
          error: errorMessage,
        });
      } else if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo')) {
        log.error('Poll DNS error - cannot resolve cloud server', {
          url: this.config.cloudUrl,
        });
      } else {
        log.error('Poll error', { error: errorMessage });
      }
      this.emit('error', error);
    }
  }

  /**
   * Get messages ready for sync, or null if none available.
   */
  private async getSyncMessagesPayload(): Promise<Array<{
    id: string; ts: number; from: string; to: string; body: string;
    kind?: string; topic?: string; thread?: string;
    is_broadcast?: boolean; is_urgent?: boolean;
    data?: Record<string, unknown>; payload_meta?: unknown;
  }> | null> {
    if (!this.storage || this.messageSyncInProgress || this.config.messageSyncEnabled === false) {
      return null;
    }

    this.messageSyncInProgress = true;
    try {
      const batchSize = this.config.messageSyncBatchSize || 100;
      const messages = await this.storage.getMessages({
        sinceTs: this.lastMessageSyncTs > 0 ? this.lastMessageSyncTs : undefined,
        limit: batchSize,
        order: 'asc',
      });

      if (messages.length === 0) {
        return null;
      }

      return messages.map((msg: StoredMessage) => ({
        id: msg.id,
        ts: msg.ts,
        from: msg.from,
        to: msg.to,
        body: msg.body,
        kind: msg.kind,
        topic: msg.topic,
        thread: msg.thread,
        is_broadcast: msg.is_broadcast,
        is_urgent: msg.is_urgent,
        data: msg.data,
        payload_meta: msg.payloadMeta,
      }));
    } catch (error) {
      log.error('Failed to prepare sync messages', { error: String(error) });
      return null;
    } finally {
      this.messageSyncInProgress = false;
    }
  }

  /**
   * Legacy heartbeat: individual endpoint calls.
   * Used as fallback when the batched /api/daemons/poll endpoint is not available.
   */
  private async sendHeartbeatLegacy(): Promise<void> {
    try {
      const agents = Array.from(this.localAgents.entries()).map(([name, info]) => ({
        name,
        status: info.status,
        isHuman: info.isHuman,
        avatarUrl: info.avatarUrl,
      }));

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${this.config.cloudUrl}/api/daemons/heartbeat`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agents,
          metrics: {
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage(),
          },
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));

      if (!response.ok) {
        if (response.status === 401) {
          log.error('Invalid API key. Run `agent-relay cloud link` to re-authenticate.');
          this.stop();
          return;
        }
        throw new Error(`Heartbeat failed: ${response.status}`);
      }

      const data = await response.json() as { commands?: Array<{ type: string; payload: unknown }> };

      if (data.commands && data.commands.length > 0) {
        for (const cmd of data.commands) {
          this.emit('command', cmd);
        }
      }

      await Promise.all([
        this.fetchMessages(),
        this.syncAgents(),
        this.syncMessagesToCloud(),
        this.pushAgentMetrics(),
      ]);
    } catch (error) {
      const errorMessage = String(error);
      if (error instanceof Error && error.name === 'AbortError') {
        log.error('Heartbeat timeout (10s)', { url: this.config.cloudUrl });
      } else if (errorMessage.includes('fetch failed') || errorMessage.includes('ECONNREFUSED')) {
        log.error('Heartbeat network error - cloud server unreachable', {
          url: this.config.cloudUrl,
          error: errorMessage,
        });
      } else if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo')) {
        log.error('Heartbeat DNS error - cannot resolve cloud server', {
          url: this.config.cloudUrl,
        });
      } else {
        log.error('Heartbeat error', { error: errorMessage });
      }
      this.emit('error', error);
    }
  }

  /**
   * Sync agents with cloud and get remote agents
   */
  private async syncAgents(): Promise<void> {
    const agents = Array.from(this.localAgents.entries()).map(([name, info]) => ({
      name,
      status: info.status,
      isHuman: info.isHuman,
      avatarUrl: info.avatarUrl,
    }));

    const response = await fetch(`${this.config.cloudUrl}/api/daemons/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agents }),
    });

    if (!response.ok) {
      throw new Error(`Agent sync failed: ${response.status}`);
    }

    const data = await response.json() as { allAgents: RemoteAgent[]; allUsers?: RemoteAgent[] };

    // Filter out our own agents
    this.remoteAgents = data.allAgents.filter(
      (a) => !this.localAgents.has(a.name)
    );

    if (this.remoteAgents.length > 0) {
      this.emit('remote-agents-updated', this.remoteAgents);
    }

    // Handle remote users (humans connected via cloud dashboard)
    if (data.allUsers) {
      this.remoteUsers = data.allUsers.filter(
        (u) => !this.localAgents.has(u.name)
      );

      if (this.remoteUsers.length > 0) {
        this.emit('remote-users-updated', this.remoteUsers);
      }
    }
  }

  /**
   * Fetch queued messages from cloud
   */
  private async fetchMessages(): Promise<void> {
    const response = await fetch(`${this.config.cloudUrl}/api/daemons/messages`, {
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Message fetch failed: ${response.status}`);
    }

    const data = await response.json() as { messages: CrossMachineMessage[] };

    for (const msg of data.messages) {
      this.emit('cross-machine-message', msg);
    }
  }

  /**
   * Sync credentials from cloud (pull latest tokens)
   */
  async syncCredentials(): Promise<Array<{
    provider: string;
    accessToken: string;
    tokenType?: string;
    expiresAt?: string;
  }>> {
    if (!this.connected) {
      throw new Error('Not connected to cloud');
    }

    const response = await fetch(`${this.config.cloudUrl}/api/daemons/credentials`, {
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Credential sync failed: ${response.status}`);
    }

    const data = await response.json() as {
      credentials: Array<{
        provider: string;
        accessToken: string;
        tokenType?: string;
        expiresAt?: string;
      }>;
    };

    return data.credentials;
  }

  /**
   * Check if connected to cloud
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get machine ID
   */
  getMachineIdentifier(): string {
    return this.machineId;
  }

  /**
   * Set the storage adapter for message sync
   */
  setStorage(storage: StorageAdapter): void {
    this.storage = storage;
    log.info('Storage adapter configured for message sync');
  }

  /**
   * Set the metrics provider for agent metrics sync
   */
  setMetricsProvider(provider: AgentMetricsProvider): void {
    this.metricsProvider = provider;
    log.info('Metrics provider configured for agent metrics sync');
  }

  /**
   * Push agent metrics to cloud monitoring API.
   * Called during heartbeat if a metrics provider is configured.
   */
  async pushAgentMetrics(): Promise<{ recorded: number } | null> {
    if (!this.connected || this.config.metricsSyncEnabled === false) {
      return null;
    }

    if (!this.metricsProvider) {
      return null;
    }

    try {
      const agents = this.metricsProvider.getAll();
      if (agents.length === 0) {
        return { recorded: 0 };
      }

      // Transform to API format
      const payload = agents.map(agent => ({
        name: agent.name,
        pid: agent.pid,
        status: agent.status,
        rssBytes: agent.rssBytes,
        heapUsedBytes: agent.heapUsedBytes,
        heapTotalBytes: agent.heapTotalBytes,
        cpuPercent: agent.cpuPercent,
        trend: agent.trend,
        trendRatePerMinute: agent.trendRatePerMinute,
        alertLevel: agent.alertLevel,
        highWatermark: agent.highWatermark,
        averageRss: agent.averageRss,
        uptimeMs: agent.uptimeMs,
        startedAt: agent.startedAt?.toISOString(),
      }));

      const response = await fetch(`${this.config.cloudUrl}/api/monitoring/metrics`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ agents: payload }),
      });

      if (!response.ok) {
        throw new Error(`Metrics push failed: ${response.status}`);
      }

      const result = await response.json() as { success: boolean; recorded: number };

      if (result.recorded > 0) {
        log.info(`Pushed ${result.recorded} agent metrics to cloud`);
      }

      return { recorded: result.recorded };
    } catch (error) {
      log.error('Failed to push agent metrics', { error: String(error) });
      return null;
    }
  }

  // ============================================================================
  // Session Persistence API (for linked daemons)
  // ============================================================================

  /**
   * Create a new agent session in cloud.
   * Returns the session ID for tracking summaries and end markers.
   */
  async createSession(agentName: string, workspaceId?: string): Promise<string | null> {
    if (!this.connected) {
      return null;
    }

    try {
      const response = await fetch(`${this.config.cloudUrl}/api/monitoring/session/create`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agentName,
          workspaceId,
        }),
      });

      if (!response.ok) {
        throw new Error(`Session create failed: ${response.status}`);
      }

      const result = await response.json() as { success: boolean; sessionId: string };
      log.info(`Created session ${result.sessionId.substring(0, 8)} for ${agentName}`);
      return result.sessionId;
    } catch (error) {
      log.error('Failed to create session', { agentName, error: String(error) });
      return null;
    }
  }

  /**
   * Add a summary to an existing session.
   */
  async addSummary(
    sessionId: string,
    agentName: string,
    summary: {
      currentTask?: string;
      completedTasks?: string[];
      decisions?: string[];
      context?: string;
      files?: string[];
    }
  ): Promise<string | null> {
    if (!this.connected) {
      return null;
    }

    try {
      const response = await fetch(`${this.config.cloudUrl}/api/monitoring/session/summary`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId,
          agentName,
          summary,
        }),
      });

      if (!response.ok) {
        throw new Error(`Summary add failed: ${response.status}`);
      }

      const result = await response.json() as { success: boolean; summaryId: string };
      log.info(`Added summary for ${agentName}: ${summary.currentTask || 'no task'}`);
      return result.summaryId;
    } catch (error) {
      log.error('Failed to add summary', { sessionId, agentName, error: String(error) });
      return null;
    }
  }

  /**
   * End a session with an optional end marker.
   */
  async endSession(
    sessionId: string,
    endMarker?: {
      summary?: string;
      completedTasks?: string[];
    }
  ): Promise<boolean> {
    if (!this.connected) {
      return false;
    }

    try {
      const response = await fetch(`${this.config.cloudUrl}/api/monitoring/session/end`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId,
          endMarker,
        }),
      });

      if (!response.ok) {
        throw new Error(`Session end failed: ${response.status}`);
      }

      log.info(`Ended session ${sessionId.substring(0, 8)}: ${endMarker?.summary || 'no summary'}`);
      return true;
    } catch (error) {
      log.error('Failed to end session', { sessionId, error: String(error) });
      return false;
    }
  }

  /**
   * Queue a single message for sync to cloud.
   * Use this for real-time sync as messages are created.
   * Falls back to batch sync if optimized queue is not enabled.
   */
  async queueMessageForSync(message: StoredMessage): Promise<void> {
    if (!this.connected || this.config.messageSyncEnabled === false) {
      return;
    }

    if (this.syncQueue) {
      await this.syncQueue.enqueue(message);
    }
    // If no sync queue, messages will be synced on next heartbeat via syncMessagesToCloud
  }

  /**
   * Get sync queue statistics (if optimized sync is enabled).
   */
  getSyncQueueStats(): SyncQueueStats | null {
    return this.syncQueue?.getStats() ?? null;
  }

  /**
   * Force flush the sync queue.
   */
  async flushSyncQueue(): Promise<void> {
    if (this.syncQueue) {
      await this.syncQueue.flush();
    }
  }

  /**
   * Sync local messages to cloud storage
   *
   * Reads messages from local SQLite since last sync and posts them
   * to the cloud API for centralized storage and search.
   */
  async syncMessagesToCloud(): Promise<{ synced: number; duplicates: number }> {
    // Skip if disabled, not connected, no storage, or sync in progress
    if (!this.connected || !this.storage || this.messageSyncInProgress) {
      return { synced: 0, duplicates: 0 };
    }

    if (this.config.messageSyncEnabled === false) {
      return { synced: 0, duplicates: 0 };
    }

    this.messageSyncInProgress = true;

    try {
      const batchSize = this.config.messageSyncBatchSize || 100;

      // Get messages since last sync
      const messages = await this.storage.getMessages({
        sinceTs: this.lastMessageSyncTs > 0 ? this.lastMessageSyncTs : undefined,
        limit: batchSize,
        order: 'asc',
      });

      if (messages.length === 0) {
        return { synced: 0, duplicates: 0 };
      }

      // Transform to API format
      const syncPayload = messages.map((msg: StoredMessage) => ({
        id: msg.id,
        ts: msg.ts,
        from: msg.from,
        to: msg.to,
        body: msg.body,
        kind: msg.kind,
        topic: msg.topic,
        thread: msg.thread,
        is_broadcast: msg.is_broadcast,
        is_urgent: msg.is_urgent,
        data: msg.data,
        payload_meta: msg.payloadMeta,
      }));

      // Post to cloud with repo context for workspace resolution
      const response = await fetch(`${this.config.cloudUrl}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: syncPayload,
          repoFullName: this.repoFullName,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Message sync failed: ${response.status} - ${errorText}`);
      }

      const result = await response.json() as { synced: number; duplicates: number };

      // Update last sync timestamp to the newest message we synced
      if (messages.length > 0) {
        this.lastMessageSyncTs = Math.max(...messages.map((m: StoredMessage) => m.ts));
      }

      if (result.synced > 0) {
        log.info(`Synced ${result.synced} messages to cloud`, { duplicates: result.duplicates });
      }

      return result;
    } catch (error) {
      log.error('Message sync error', { error: String(error) });
      return { synced: 0, duplicates: 0 };
    } finally {
      this.messageSyncInProgress = false;
    }
  }
}

// Singleton instance
let _cloudSync: CloudSyncService | null = null;

export function getCloudSync(config?: Partial<CloudSyncConfig>): CloudSyncService {
  if (!_cloudSync) {
    _cloudSync = new CloudSyncService(config);
  }
  return _cloudSync;
}

// ============================================================================
// Cloud Persistence Handler Factory
// ============================================================================

/**
 * Summary event from wrapper
 */
export interface SummaryEvent {
  agentName: string;
  summary: {
    currentTask?: string;
    completedTasks?: string[];
    decisions?: string[];
    context?: string;
    files?: string[];
  };
}

/**
 * Session end event from wrapper
 */
export interface SessionEndEvent {
  agentName: string;
  marker: {
    summary?: string;
    completedTasks?: string[];
  };
}

/**
 * Cloud persistence handler interface (matches @agent-relay/bridge)
 */
export interface CloudPersistenceHandler {
  onSummary: (agentName: string, event: SummaryEvent) => Promise<void>;
  onSessionEnd: (agentName: string, event: SessionEndEvent) => Promise<void>;
  destroy?: () => void;
}

/**
 * Create a cloud persistence handler that uses CloudSyncService.
 * Tracks session IDs per agent and creates sessions lazily on first summary.
 *
 * @param cloudSync The CloudSyncService instance to use
 * @param workspaceId Optional workspace ID for session scoping
 * @returns CloudPersistenceHandler for use with AgentSpawner
 */
export function createCloudPersistenceHandler(
  cloudSync: CloudSyncService,
  workspaceId?: string
): CloudPersistenceHandler {
  // Track session IDs per agent name
  const agentSessions = new Map<string, string>();

  return {
    async onSummary(agentName: string, event: SummaryEvent): Promise<void> {
      // Get or create session for this agent
      let sessionId = agentSessions.get(agentName);

      if (!sessionId) {
        // Create session on first summary
        const newSessionId = await cloudSync.createSession(agentName, workspaceId);
        if (newSessionId) {
          sessionId = newSessionId;
          agentSessions.set(agentName, sessionId);
        } else {
          log.warn(`Failed to create session for ${agentName}, skipping summary`);
          return;
        }
      }

      // Add summary to session
      await cloudSync.addSummary(sessionId, agentName, event.summary);
    },

    async onSessionEnd(agentName: string, event: SessionEndEvent): Promise<void> {
      const sessionId = agentSessions.get(agentName);

      if (sessionId) {
        // End the session
        await cloudSync.endSession(sessionId, event.marker);
        agentSessions.delete(agentName);
      } else {
        log.warn(`No session found for ${agentName} on session-end`);
      }
    },

    destroy(): void {
      agentSessions.clear();
    },
  };
}
