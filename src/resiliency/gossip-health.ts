/**
 * Gossip-Based Health Broadcast
 *
 * Implements P4: Agents broadcast heartbeats via relay.
 * Collective failure detection without central monitor.
 *
 * Each agent:
 * - Periodically broadcasts HEARTBEAT message to all agents
 * - Tracks health of all known peers
 * - Detects failures when peer heartbeats go stale
 * - Emits events for peer health changes
 */

import { EventEmitter } from 'events';

/**
 * Peer health state
 */
export interface PeerHealth {
  name: string;
  lastHeartbeat: number;
  load: number;
  healthy: boolean;
  isLeader: boolean;
  taskCount: number;
}

/**
 * Heartbeat payload (broadcast via relay)
 */
export interface GossipHeartbeat {
  type: 'HEARTBEAT';
  agent: string;
  agentId: string;
  timestamp: number;
  load: number;
  healthy: boolean;
  isLeader: boolean;
  taskCount: number;
}

/**
 * Gossip health configuration
 */
export interface GossipHealthConfig {
  /** This agent's name */
  agentName: string;
  /** This agent's unique ID */
  agentId: string;
  /** How often to broadcast heartbeat (ms) */
  broadcastIntervalMs: number;
  /** Peer considered stale after this duration (ms) */
  staleThresholdMs: number;
  /** How often to check for stale peers (ms) */
  checkIntervalMs: number;
  /** Callback to broadcast message to all agents */
  broadcast: (message: string) => Promise<void>;
  /** Callback to get current load (0-1) */
  getLoad?: () => number;
  /** Callback to get current task count */
  getTaskCount?: () => number;
  /** Callback to check if this agent is leader */
  isLeader?: () => boolean;
}

const DEFAULT_CONFIG: Partial<GossipHealthConfig> = {
  broadcastIntervalMs: 10000,
  staleThresholdMs: 30000,
  checkIntervalMs: 5000,
};

/**
 * Gossip Health Monitor
 *
 * Broadcasts heartbeats and tracks peer health via gossip protocol.
 */
export class GossipHealthMonitor extends EventEmitter {
  private config: GossipHealthConfig;
  private peers = new Map<string, PeerHealth>();
  private broadcastInterval?: ReturnType<typeof setInterval>;
  private checkInterval?: ReturnType<typeof setInterval>;
  private isRunning = false;
  private healthy = true;

  constructor(config: GossipHealthConfig) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config } as GossipHealthConfig;
  }

  /**
   * Start gossip health monitoring
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log(`[gossip] Started health broadcast for ${this.config.agentName}`);

    // Start broadcasting heartbeats
    this.broadcastInterval = setInterval(async () => {
      try {
        await this.broadcastHeartbeat();
      } catch (err) {
        console.error('[gossip] Broadcast error:', err);
      }
    }, this.config.broadcastIntervalMs);

    // Start checking for stale peers
    this.checkInterval = setInterval(() => {
      this.checkStalePeers();
    }, this.config.checkIntervalMs);

    // Initial broadcast
    this.broadcastHeartbeat().catch((err) => {
      console.error('[gossip] Initial broadcast error:', err);
    });

    this.emit('started');
  }

  /**
   * Stop gossip health monitoring
   */
  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = undefined;
    }

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
    }

    console.log(`[gossip] Stopped health broadcast for ${this.config.agentName}`);
    this.emit('stopped');
  }

  /**
   * Broadcast heartbeat to all agents
   */
  private async broadcastHeartbeat(): Promise<void> {
    const heartbeat: GossipHeartbeat = {
      type: 'HEARTBEAT',
      agent: this.config.agentName,
      agentId: this.config.agentId,
      timestamp: Date.now(),
      load: this.config.getLoad?.() ?? 0,
      healthy: this.healthy,
      isLeader: this.config.isLeader?.() ?? false,
      taskCount: this.config.getTaskCount?.() ?? 0,
    };

    const message = `HEARTBEAT: ${JSON.stringify(heartbeat)}`;
    await this.config.broadcast(message);
  }

  /**
   * Process incoming heartbeat from another agent
   */
  processHeartbeat(heartbeat: GossipHeartbeat): void {
    // Ignore our own heartbeats
    if (heartbeat.agentId === this.config.agentId) return;

    const existing = this.peers.get(heartbeat.agent);
    const wasHealthy = existing?.healthy ?? true;
    const wasLeader = existing?.isLeader ?? false;

    // Update peer state
    const peer: PeerHealth = {
      name: heartbeat.agent,
      lastHeartbeat: heartbeat.timestamp,
      load: heartbeat.load,
      healthy: heartbeat.healthy,
      isLeader: heartbeat.isLeader,
      taskCount: heartbeat.taskCount,
    };

    this.peers.set(heartbeat.agent, peer);

    // Emit events for state changes
    if (!existing) {
      this.emit('peerDiscovered', peer);
    } else {
      if (!wasHealthy && heartbeat.healthy) {
        this.emit('peerRecovered', peer);
      }
      if (wasHealthy && !heartbeat.healthy) {
        this.emit('peerUnhealthy', peer);
      }
      if (!wasLeader && heartbeat.isLeader) {
        this.emit('newLeader', peer);
      }
    }
  }

  /**
   * Parse heartbeat from relay message
   */
  static parseHeartbeat(message: string): GossipHeartbeat | null {
    const match = message.match(/^HEARTBEAT:\s*(.+)$/);
    if (!match) return null;

    try {
      const data = JSON.parse(match[1]);
      if (data.type === 'HEARTBEAT') {
        return data as GossipHeartbeat;
      }
    } catch {
      // Invalid JSON
    }

    return null;
  }

  /**
   * Check for stale peers
   */
  private checkStalePeers(): void {
    const now = Date.now();

    for (const [name, peer] of this.peers) {
      const age = now - peer.lastHeartbeat;

      if (age > this.config.staleThresholdMs) {
        if (peer.healthy) {
          // Mark as unhealthy
          peer.healthy = false;
          console.log(`[gossip] Peer ${name} is stale (${Math.round(age / 1000)}s since last heartbeat)`);
          this.emit('peerStale', { peer, age });

          // If the stale peer was leader, emit leader lost
          if (peer.isLeader) {
            this.emit('leaderLost', peer);
          }
        }
      }
    }
  }

  /**
   * Set this agent's health status
   */
  setHealthy(healthy: boolean): void {
    if (this.healthy !== healthy) {
      this.healthy = healthy;
      // Broadcast immediately on health change
      this.broadcastHeartbeat().catch((err) => {
        console.error('[gossip] Immediate broadcast error:', err);
      });
    }
  }

  /**
   * Get all known peers
   */
  getPeers(): PeerHealth[] {
    return Array.from(this.peers.values());
  }

  /**
   * Get healthy peers
   */
  getHealthyPeers(): PeerHealth[] {
    return this.getPeers().filter((p) => p.healthy);
  }

  /**
   * Get current leader from gossip
   */
  getLeader(): PeerHealth | null {
    for (const peer of this.peers.values()) {
      if (peer.isLeader && peer.healthy) {
        return peer;
      }
    }
    return null;
  }

  /**
   * Get peer by name
   */
  getPeer(name: string): PeerHealth | undefined {
    return this.peers.get(name);
  }

  /**
   * Get status
   */
  getStatus(): {
    isRunning: boolean;
    agentName: string;
    peerCount: number;
    healthyPeerCount: number;
    leader: string | null;
  } {
    const leader = this.getLeader();
    return {
      isRunning: this.isRunning,
      agentName: this.config.agentName,
      peerCount: this.peers.size,
      healthyPeerCount: this.getHealthyPeers().length,
      leader: leader?.name ?? null,
    };
  }
}

/**
 * Create gossip health monitor with defaults
 */
export function createGossipHealth(
  agentName: string,
  agentId: string,
  broadcast: (message: string) => Promise<void>,
  options?: {
    getLoad?: () => number;
    getTaskCount?: () => number;
    isLeader?: () => boolean;
  }
): GossipHealthMonitor {
  return new GossipHealthMonitor({
    agentName,
    agentId,
    broadcast,
    broadcastIntervalMs: 10000,
    staleThresholdMs: 30000,
    checkIntervalMs: 5000,
    ...options,
  });
}
