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
import { createLogger } from '../utils/logger.js';
import type { StorageAdapter, StoredMessage } from '../storage/adapter.js';

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
  private localAgents: Map<string, { name: string; status: string }> = new Map();
  private remoteAgents: RemoteAgent[] = [];
  private connected = false;
  private storage: StorageAdapter | null = null;
  private lastMessageSyncTs: number = 0;
  private messageSyncInProgress = false;

  constructor(config: Partial<CloudSyncConfig> = {}) {
    super();

    this.config = {
      apiKey: config.apiKey || process.env.AGENT_RELAY_API_KEY,
      cloudUrl: config.cloudUrl || process.env.AGENT_RELAY_CLOUD_URL || 'https://agent-relay.com',
      heartbeatInterval: config.heartbeatInterval || 30000, // 30 seconds
      enabled: config.enabled ?? true,
    };

    // Generate or load machine ID for consistent identification
    this.machineId = this.getMachineId();
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
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.connected = false;
    this.emit('disconnected');
  }

  /**
   * Update local agent list (called by daemon when agents change)
   */
  updateAgents(agents: Array<{ name: string; status: string }>): void {
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
   * Send heartbeat to cloud
   */
  private async sendHeartbeat(): Promise<void> {
    try {
      const agents = Array.from(this.localAgents.entries()).map(([name, info]) => ({
        name,
        status: info.status,
      }));

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
      });

      if (!response.ok) {
        if (response.status === 401) {
          log.error('Invalid API key. Run `agent-relay cloud link` to re-authenticate.');
          this.stop();
          return;
        }
        throw new Error(`Heartbeat failed: ${response.status}`);
      }

      const data = await response.json() as { commands?: Array<{ type: string; payload: unknown }> };

      // Process any pending commands from cloud
      if (data.commands && data.commands.length > 0) {
        for (const cmd of data.commands) {
          this.emit('command', cmd);
        }
      }

      // Fetch messages, sync agents, and sync local messages to cloud
      await Promise.all([
        this.fetchMessages(),
        this.syncAgents(),
        this.syncMessagesToCloud(),
      ]);
    } catch (error) {
      log.error('Heartbeat error', { error: String(error) });
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

    const data = await response.json() as { allAgents: RemoteAgent[] };

    // Filter out our own agents
    this.remoteAgents = data.allAgents.filter(
      (a) => !this.localAgents.has(a.name)
    );

    if (this.remoteAgents.length > 0) {
      this.emit('remote-agents-updated', this.remoteAgents);
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

      // Post to cloud
      const response = await fetch(`${this.config.cloudUrl}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messages: syncPayload }),
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
