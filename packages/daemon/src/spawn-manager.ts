/**
 * Spawn Manager
 * Daemon component that manages agent spawning via protocol messages.
 * Owns the AgentSpawner instance and handles SPAWN/RELEASE protocol messages.
 */

import { generateId } from '@agent-relay/wrapper';
import {
  type Envelope,
  type SpawnPayload,
  type SpawnResultPayload,
  type ReleasePayload,
  type ReleaseResultPayload,
  type MessageType,
  PROTOCOL_VERSION,
} from '@agent-relay/protocol/types';
import { AgentSpawner, type CloudPersistenceHandler, type OnAgentDeathCallback } from '@agent-relay/bridge';
import type { CloudPolicyFetcher } from '@agent-relay/policy';
import type { Connection } from './connection.js';
import { track, type ActionSource } from '@agent-relay/telemetry';

export interface SpawnManagerConfig {
  /** Project root directory */
  projectRoot: string;
  /** Socket path for spawned agents to connect to */
  socketPath?: string;
  /** Cloud persistence handler for agent events */
  cloudPersistence?: CloudPersistenceHandler;
  /** Cloud policy fetcher for workspace-level policies */
  policyFetcher?: CloudPolicyFetcher;
  /** Callback when an agent dies unexpectedly */
  onAgentDeath?: OnAgentDeathCallback;
  /** Callback when an agent is spawned (for telemetry tracking) */
  onAgentSpawn?: () => void;
}

/**
 * SpawnManager handles agent lifecycle via protocol messages.
 * The daemon creates this instance and forwards SPAWN/RELEASE messages to it.
 */
export class SpawnManager {
  private spawner: AgentSpawner;
  private spawnTimes: Map<string, number> = new Map();
  private agentClis: Map<string, string> = new Map();
  private onAgentSpawn?: () => void;

  constructor(config: SpawnManagerConfig) {
    this.spawner = new AgentSpawner(config.projectRoot);
    this.onAgentSpawn = config.onAgentSpawn;

    if (config.cloudPersistence) {
      this.spawner.setCloudPersistence(config.cloudPersistence);
    }

    if (config.policyFetcher) {
      this.spawner.setCloudPolicyFetcher(config.policyFetcher);
    }

    if (config.onAgentDeath) {
      this.spawner.setOnAgentDeath(config.onAgentDeath);
    }

    console.log('[spawn-manager] Initialized');
  }

  /**
   * Handle a SPAWN message from a connection.
   * Spawns the requested agent and sends SPAWN_RESULT back.
   */
  async handleSpawn(connection: Connection, envelope: Envelope<SpawnPayload>): Promise<void> {
    const payload = envelope.payload;
    const spawnerName = connection.agentName;

    console.log(`[spawn-manager] SPAWN request from ${spawnerName ?? 'unknown'}: ${payload.name} (${payload.cli})`);

    try {
      const result = await this.spawner.spawn({
        name: payload.name,
        cli: payload.cli,
        task: payload.task,
        team: payload.team,
        cwd: payload.cwd,
        spawnerName: payload.spawnerName ?? spawnerName,
        interactive: payload.interactive,
        shadowOf: payload.shadowOf,
        shadowSpeakOn: payload.shadowSpeakOn,
        userId: payload.userId,
      });

      this.sendResult(connection, 'SPAWN_RESULT', envelope.id, {
        replyTo: envelope.id,
        success: result.success,
        name: result.name,
        pid: result.pid,
        error: result.error,
        policyDecision: result.policyDecision,
      });

      // Track successful spawn
      if (result.success) {
        this.spawnTimes.set(payload.name, Date.now());
        this.agentClis.set(payload.name, payload.cli);

        // Determine spawn source
        const spawnSource: ActionSource = spawnerName ? 'agent' : 'protocol';

        track('agent_spawn', {
          cli: payload.cli,
          spawn_source: spawnSource,
          has_task: !!payload.task,
          is_shadow: !!payload.shadowOf,
        });

        // Notify daemon to increment spawn count
        this.onAgentSpawn?.();
      }

      console.log(`[spawn-manager] SPAWN ${result.success ? 'succeeded' : 'failed'}: ${payload.name}`, {
        pid: result.pid,
        error: result.error,
      });
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      this.sendResult(connection, 'SPAWN_RESULT', envelope.id, {
        replyTo: envelope.id,
        success: false,
        name: payload.name,
        error,
      });
      console.error(`[spawn-manager] SPAWN error for ${payload.name}:`, error);
    }
  }

  /**
   * Handle a RELEASE message from a connection.
   * Releases the requested agent and sends RELEASE_RESULT back.
   */
  async handleRelease(connection: Connection, envelope: Envelope<ReleasePayload>): Promise<void> {
    const payload = envelope.payload;
    const requester = connection.agentName;

    console.log(`[spawn-manager] RELEASE request from ${requester ?? 'unknown'}: ${payload.name}`);

    try {
      const success = await this.spawner.release(payload.name);

      this.sendResult(connection, 'RELEASE_RESULT', envelope.id, {
        replyTo: envelope.id,
        success,
        name: payload.name,
        error: success ? undefined : `Worker ${payload.name} not found`,
      });

      // Track successful release
      if (success) {
        const spawnTime = this.spawnTimes.get(payload.name);
        const cli = this.agentClis.get(payload.name) || 'unknown';
        const lifetimeSeconds = spawnTime
          ? Math.floor((Date.now() - spawnTime) / 1000)
          : 0;

        // Determine release source
        const releaseSource: ActionSource = requester ? 'agent' : 'protocol';

        track('agent_release', {
          cli,
          release_reason: 'explicit',
          lifetime_seconds: lifetimeSeconds,
          release_source: releaseSource,
        });

        // Clean up tracking data
        this.spawnTimes.delete(payload.name);
        this.agentClis.delete(payload.name);
      }

      console.log(`[spawn-manager] RELEASE ${success ? 'succeeded' : 'failed'}: ${payload.name}`);
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      this.sendResult(connection, 'RELEASE_RESULT', envelope.id, {
        replyTo: envelope.id,
        success: false,
        name: payload.name,
        error,
      });
      console.error(`[spawn-manager] RELEASE error for ${payload.name}:`, error);
    }
  }

  /**
   * Send a result envelope back to the requesting connection.
   */
  private sendResult(
    connection: Connection,
    type: MessageType,
    _replyTo: string,
    payload: SpawnResultPayload | ReleaseResultPayload
  ): void {
    connection.send({
      v: PROTOCOL_VERSION,
      type,
      id: generateId(),
      ts: Date.now(),
      payload,
    });
  }

  /**
   * Get the underlying spawner instance.
   * Useful for direct access to spawner methods (getActiveWorkers, etc.)
   */
  getSpawner(): AgentSpawner {
    return this.spawner;
  }

  /**
   * Release all active workers.
   * Called during daemon shutdown.
   */
  async releaseAll(): Promise<void> {
    await this.spawner.releaseAll();
  }

  /**
   * Check if a worker exists.
   */
  hasWorker(name: string): boolean {
    return this.spawner.hasWorker(name);
  }

  /**
   * Get info about a worker.
   */
  getWorker(name: string) {
    return this.spawner.getWorker(name);
  }

  /**
   * Get all active workers.
   */
  getActiveWorkers() {
    return this.spawner.getActiveWorkers();
  }

  /**
   * Get output from a worker.
   */
  getWorkerOutput(name: string, limit?: number) {
    return this.spawner.getWorkerOutput(name, limit);
  }

  /**
   * Get raw output from a worker.
   */
  getWorkerRawOutput(name: string) {
    return this.spawner.getWorkerRawOutput(name);
  }

  /**
   * Send input to a worker's PTY.
   */
  sendWorkerInput(name: string, data: string): boolean {
    return this.spawner.sendWorkerInput(name, data);
  }
}
