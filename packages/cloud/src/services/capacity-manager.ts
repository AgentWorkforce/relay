/**
 * Capacity Manager
 *
 * Tracks workspace capacity across the fleet and provides:
 * - Real-time capacity metrics
 * - Optimal agent placement recommendations
 * - Load balancing decisions
 * - Capacity forecasting based on trends
 *
 * Works with AutoScaler to determine when to provision new instances
 * and with Coordinator to place agents optimally.
 */

import { EventEmitter } from 'events';
import { createClient, RedisClientType } from 'redis';
import { WorkspaceMetrics } from './scaling-policy.js';

export interface WorkspaceCapacity {
  workspaceId: string;
  userId: string;
  provider: string;
  region: string;

  // Current state
  currentAgents: number;
  maxAgents: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
  cpuPercent: number;

  // Derived metrics
  agentCapacityPercent: number; // currentAgents / maxAgents * 100
  memoryCapacityPercent: number; // memoryUsed / memoryLimit * 100
  overallHealthScore: number; // 0-100, lower is better for placement

  // Timestamps
  lastHeartbeat: Date;
  lastMetricsUpdate: Date;
}

export interface PlacementRecommendation {
  workspaceId: string;
  score: number; // Lower is better
  reason: string;
  estimatedCapacityAfter: number; // Percent capacity after placement
}

export interface CapacitySnapshot {
  userId: string;
  totalWorkspaces: number;
  totalAgents: number;
  totalMaxAgents: number;
  totalMemoryBytes: number;
  totalMemoryLimitBytes: number;
  averageHealthScore: number;
  workspaces: WorkspaceCapacity[];
  timestamp: Date;
}

export interface CapacityForecast {
  userId: string;
  currentAgents: number;
  projectedAgents15Min: number;
  projectedAgents60Min: number;
  memoryTrendPerMinute: number;
  willExceedCapacity: boolean;
  timeToCapacityExhaustion?: number; // Minutes
  recommendation: 'none' | 'scale_soon' | 'scale_now' | 'critical';
}

export interface CapacityManagerConfig {
  healthCheckIntervalMs: number;
  staleThresholdMs: number; // Consider workspace stale after this
  memoryWeightFactor: number; // Weight for memory in health score
  agentWeightFactor: number; // Weight for agent count in health score
  cpuWeightFactor: number; // Weight for CPU in health score
  redisKeyPrefix: string;
}

const DEFAULT_CONFIG: CapacityManagerConfig = {
  healthCheckIntervalMs: 15000, // 15 seconds
  staleThresholdMs: 60000, // 1 minute
  memoryWeightFactor: 0.4,
  agentWeightFactor: 0.4,
  cpuWeightFactor: 0.2,
  redisKeyPrefix: 'capacity:',
};

// Redis channels
const CHANNELS = {
  CAPACITY_UPDATE: 'capacity:update',
  PLACEMENT_REQUEST: 'capacity:placement',
};

export class CapacityManager extends EventEmitter {
  private config: CapacityManagerConfig;
  private redis: RedisClientType | null = null;
  private subscriber: RedisClientType | null = null;
  private capacityMap: Map<string, WorkspaceCapacity> = new Map();
  private userWorkspaces: Map<string, Set<string>> = new Map(); // userId -> workspaceIds
  private trendHistory: Map<string, { timestamp: Date; agents: number; memory: number }[]> =
    new Map();
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<CapacityManagerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize with Redis for cross-server sync
   */
  async initialize(redisUrl: string): Promise<void> {
    try {
      this.redis = createClient({ url: redisUrl });
      this.redis.on('error', (err) => this.emit('error', { context: 'redis', error: err }));

      this.subscriber = createClient({ url: redisUrl });
      this.subscriber.on('error', (err) => this.emit('error', { context: 'subscriber', error: err }));

      await Promise.all([this.redis.connect(), this.subscriber.connect()]);

      // Subscribe to capacity updates
      await this.subscriber.subscribe(CHANNELS.CAPACITY_UPDATE, (message: string) => {
        try {
          const capacity = JSON.parse(message) as WorkspaceCapacity;
          capacity.lastHeartbeat = new Date(capacity.lastHeartbeat);
          capacity.lastMetricsUpdate = new Date(capacity.lastMetricsUpdate);
          this.updateLocalCapacity(capacity);
        } catch (error) {
          this.emit('error', { context: 'capacity_parse', error });
        }
      });

      // Load existing capacity from Redis
      await this.loadFromRedis();

      // Start health check loop
      this.startHealthCheckLoop();

      this.emit('initialized');
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Load capacity data from Redis
   */
  private async loadFromRedis(): Promise<void> {
    if (!this.redis) return;

    const keys = await this.redis.keys(`${this.config.redisKeyPrefix}workspace:*`);
    for (const key of keys) {
      const data = await this.redis.get(key);
      if (data) {
        try {
          const capacity = JSON.parse(data) as WorkspaceCapacity;
          capacity.lastHeartbeat = new Date(capacity.lastHeartbeat);
          capacity.lastMetricsUpdate = new Date(capacity.lastMetricsUpdate);
          this.updateLocalCapacity(capacity);
        } catch {
          // Skip invalid entries
        }
      }
    }
  }

  /**
   * Update local capacity map
   */
  private updateLocalCapacity(capacity: WorkspaceCapacity): void {
    this.capacityMap.set(capacity.workspaceId, capacity);

    // Track user -> workspace mapping
    let userWorkspaceSet = this.userWorkspaces.get(capacity.userId);
    if (!userWorkspaceSet) {
      userWorkspaceSet = new Set();
      this.userWorkspaces.set(capacity.userId, userWorkspaceSet);
    }
    userWorkspaceSet.add(capacity.workspaceId);

    // Update trend history
    this.updateTrendHistory(capacity);

    this.emit('capacity_updated', capacity);
  }

  /**
   * Update trend history for forecasting
   */
  private updateTrendHistory(capacity: WorkspaceCapacity): void {
    const key = capacity.workspaceId;
    let history = this.trendHistory.get(key) || [];

    history.push({
      timestamp: new Date(),
      agents: capacity.currentAgents,
      memory: capacity.memoryUsedBytes,
    });

    // Keep only last 30 minutes of history
    const cutoff = Date.now() - 30 * 60 * 1000;
    history = history.filter((h) => h.timestamp.getTime() > cutoff);
    this.trendHistory.set(key, history);
  }

  /**
   * Report capacity from a workspace
   */
  async reportCapacity(
    workspaceId: string,
    userId: string,
    metrics: Partial<WorkspaceCapacity>
  ): Promise<void> {
    const existing = this.capacityMap.get(workspaceId);

    const capacity: WorkspaceCapacity = {
      workspaceId,
      userId,
      provider: metrics.provider || existing?.provider || 'unknown',
      region: metrics.region || existing?.region || 'unknown',
      currentAgents: metrics.currentAgents ?? existing?.currentAgents ?? 0,
      maxAgents: metrics.maxAgents ?? existing?.maxAgents ?? 10,
      memoryUsedBytes: metrics.memoryUsedBytes ?? existing?.memoryUsedBytes ?? 0,
      memoryLimitBytes: metrics.memoryLimitBytes ?? existing?.memoryLimitBytes ?? 512 * 1024 * 1024,
      cpuPercent: metrics.cpuPercent ?? existing?.cpuPercent ?? 0,
      agentCapacityPercent: 0,
      memoryCapacityPercent: 0,
      overallHealthScore: 0,
      lastHeartbeat: new Date(),
      lastMetricsUpdate: new Date(),
    };

    // Calculate derived metrics
    capacity.agentCapacityPercent = (capacity.currentAgents / capacity.maxAgents) * 100;
    capacity.memoryCapacityPercent = (capacity.memoryUsedBytes / capacity.memoryLimitBytes) * 100;
    capacity.overallHealthScore = this.calculateHealthScore(capacity);

    // Update local map
    this.updateLocalCapacity(capacity);

    // Persist to Redis and broadcast
    if (this.redis) {
      const key = `${this.config.redisKeyPrefix}workspace:${workspaceId}`;
      await this.redis.set(key, JSON.stringify(capacity), { EX: 300 }); // 5 min TTL
      await this.redis.publish(CHANNELS.CAPACITY_UPDATE, JSON.stringify(capacity));
    }
  }

  /**
   * Calculate health score for a workspace (lower is healthier/better for placement)
   */
  private calculateHealthScore(capacity: WorkspaceCapacity): number {
    const memoryScore = capacity.memoryCapacityPercent * this.config.memoryWeightFactor;
    const agentScore = capacity.agentCapacityPercent * this.config.agentWeightFactor;
    const cpuScore = capacity.cpuPercent * this.config.cpuWeightFactor;

    return memoryScore + agentScore + cpuScore;
  }

  /**
   * Get best workspace for placing a new agent
   */
  recommendPlacement(userId: string, agentCount: number = 1): PlacementRecommendation[] {
    const userWorkspaceIds = this.userWorkspaces.get(userId);
    if (!userWorkspaceIds || userWorkspaceIds.size === 0) {
      return [];
    }

    const recommendations: PlacementRecommendation[] = [];

    for (const workspaceId of userWorkspaceIds) {
      const capacity = this.capacityMap.get(workspaceId);
      if (!capacity) continue;

      // Skip stale workspaces
      if (Date.now() - capacity.lastHeartbeat.getTime() > this.config.staleThresholdMs) {
        continue;
      }

      // Check if workspace can accommodate new agents
      const availableSlots = capacity.maxAgents - capacity.currentAgents;
      if (availableSlots < agentCount) {
        continue;
      }

      // Calculate estimated capacity after placement
      const newAgentCount = capacity.currentAgents + agentCount;
      const estimatedCapacityAfter = (newAgentCount / capacity.maxAgents) * 100;

      // Calculate placement score (lower is better)
      let score = capacity.overallHealthScore;

      // Penalize workspaces that would be over 80% after placement
      if (estimatedCapacityAfter > 80) {
        score += (estimatedCapacityAfter - 80) * 2;
      }

      // Bonus for workspaces with room to grow
      if (estimatedCapacityAfter < 50) {
        score -= (50 - estimatedCapacityAfter) * 0.5;
      }

      const reason = this.getPlacementReason(capacity, estimatedCapacityAfter);

      recommendations.push({
        workspaceId,
        score: Math.max(0, score),
        reason,
        estimatedCapacityAfter,
      });
    }

    // Sort by score (lower is better)
    return recommendations.sort((a, b) => a.score - b.score);
  }

  /**
   * Generate human-readable placement reason
   */
  private getPlacementReason(capacity: WorkspaceCapacity, estimatedAfter: number): string {
    if (capacity.overallHealthScore < 30) {
      return 'Workspace is healthy with low utilization';
    } else if (capacity.overallHealthScore < 50) {
      return 'Workspace has moderate load, good for placement';
    } else if (capacity.overallHealthScore < 70) {
      return 'Workspace under load but can accommodate';
    } else {
      return `Workspace at ${Math.round(estimatedAfter)}% capacity after placement`;
    }
  }

  /**
   * Get capacity snapshot for a user
   */
  getCapacitySnapshot(userId: string): CapacitySnapshot | null {
    const userWorkspaceIds = this.userWorkspaces.get(userId);
    if (!userWorkspaceIds || userWorkspaceIds.size === 0) {
      return null;
    }

    const workspaces: WorkspaceCapacity[] = [];
    let totalAgents = 0;
    let totalMaxAgents = 0;
    let totalMemory = 0;
    let totalMemoryLimit = 0;
    let healthScoreSum = 0;

    for (const workspaceId of userWorkspaceIds) {
      const capacity = this.capacityMap.get(workspaceId);
      if (capacity) {
        workspaces.push(capacity);
        totalAgents += capacity.currentAgents;
        totalMaxAgents += capacity.maxAgents;
        totalMemory += capacity.memoryUsedBytes;
        totalMemoryLimit += capacity.memoryLimitBytes;
        healthScoreSum += capacity.overallHealthScore;
      }
    }

    return {
      userId,
      totalWorkspaces: workspaces.length,
      totalAgents,
      totalMaxAgents,
      totalMemoryBytes: totalMemory,
      totalMemoryLimitBytes: totalMemoryLimit,
      averageHealthScore: workspaces.length > 0 ? healthScoreSum / workspaces.length : 0,
      workspaces,
      timestamp: new Date(),
    };
  }

  /**
   * Forecast capacity needs based on trends
   */
  getCapacityForecast(userId: string): CapacityForecast | null {
    const snapshot = this.getCapacitySnapshot(userId);
    if (!snapshot) return null;

    // Calculate aggregate trends
    let totalAgentTrend = 0;
    let totalMemoryTrend = 0;
    let trendSamples = 0;

    for (const workspace of snapshot.workspaces) {
      const history = this.trendHistory.get(workspace.workspaceId);
      if (!history || history.length < 2) continue;

      const oldest = history[0];
      const newest = history[history.length - 1];
      const timeSpanMinutes =
        (newest.timestamp.getTime() - oldest.timestamp.getTime()) / (1000 * 60);

      if (timeSpanMinutes > 0) {
        totalAgentTrend += (newest.agents - oldest.agents) / timeSpanMinutes;
        totalMemoryTrend += (newest.memory - oldest.memory) / timeSpanMinutes;
        trendSamples++;
      }
    }

    // Average trends
    const avgAgentTrend = trendSamples > 0 ? totalAgentTrend / trendSamples : 0;
    const avgMemoryTrend = trendSamples > 0 ? totalMemoryTrend / trendSamples : 0;

    // Project future state
    const projectedAgents15Min = Math.max(0, snapshot.totalAgents + avgAgentTrend * 15);
    const projectedAgents60Min = Math.max(0, snapshot.totalAgents + avgAgentTrend * 60);

    // Check if we'll exceed capacity
    const willExceedCapacity = projectedAgents60Min >= snapshot.totalMaxAgents * 0.9;

    // Calculate time to capacity exhaustion
    let timeToExhaustion: number | undefined;
    if (avgAgentTrend > 0) {
      const remainingSlots = snapshot.totalMaxAgents - snapshot.totalAgents;
      timeToExhaustion = remainingSlots / avgAgentTrend;
    }

    // Generate recommendation
    let recommendation: CapacityForecast['recommendation'] = 'none';
    if (snapshot.totalAgents >= snapshot.totalMaxAgents * 0.95) {
      recommendation = 'critical';
    } else if (snapshot.totalAgents >= snapshot.totalMaxAgents * 0.85) {
      recommendation = 'scale_now';
    } else if (willExceedCapacity || projectedAgents15Min >= snapshot.totalMaxAgents * 0.8) {
      recommendation = 'scale_soon';
    }

    return {
      userId,
      currentAgents: snapshot.totalAgents,
      projectedAgents15Min: Math.round(projectedAgents15Min),
      projectedAgents60Min: Math.round(projectedAgents60Min),
      memoryTrendPerMinute: avgMemoryTrend,
      willExceedCapacity,
      timeToCapacityExhaustion: timeToExhaustion,
      recommendation,
    };
  }

  /**
   * Convert workspace metrics to capacity format
   */
  fromWorkspaceMetrics(userId: string, metrics: WorkspaceMetrics): Partial<WorkspaceCapacity> {
    return {
      workspaceId: metrics.workspaceId,
      userId,
      currentAgents: metrics.agentCount,
      memoryUsedBytes: metrics.totalMemoryBytes,
      cpuPercent: metrics.cpuPercent,
    };
  }

  /**
   * Health check loop - detect stale workspaces
   */
  private startHealthCheckLoop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    this.healthCheckTimer = setInterval(() => {
      const now = Date.now();

      for (const [workspaceId, capacity] of this.capacityMap) {
        if (now - capacity.lastHeartbeat.getTime() > this.config.staleThresholdMs) {
          this.emit('workspace_stale', { workspaceId, lastHeartbeat: capacity.lastHeartbeat });
        }
      }
    }, this.config.healthCheckIntervalMs);
  }

  /**
   * Remove a workspace from tracking
   */
  async removeWorkspace(workspaceId: string): Promise<void> {
    const capacity = this.capacityMap.get(workspaceId);
    if (capacity) {
      this.capacityMap.delete(workspaceId);
      this.trendHistory.delete(workspaceId);

      const userWorkspaceSet = this.userWorkspaces.get(capacity.userId);
      if (userWorkspaceSet) {
        userWorkspaceSet.delete(workspaceId);
      }

      if (this.redis) {
        await this.redis.del(`${this.config.redisKeyPrefix}workspace:${workspaceId}`);
      }

      this.emit('workspace_removed', workspaceId);
    }
  }

  /**
   * Get all workspaces for a user
   */
  getUserWorkspaces(userId: string): WorkspaceCapacity[] {
    const workspaceIds = this.userWorkspaces.get(userId);
    if (!workspaceIds) return [];

    const workspaces: WorkspaceCapacity[] = [];
    for (const id of workspaceIds) {
      const capacity = this.capacityMap.get(id);
      if (capacity) {
        workspaces.push(capacity);
      }
    }
    return workspaces;
  }

  /**
   * Get global capacity metrics
   */
  getGlobalMetrics(): {
    totalWorkspaces: number;
    totalAgents: number;
    totalMaxAgents: number;
    averageUtilization: number;
    staleWorkspaces: number;
  } {
    let totalAgents = 0;
    let totalMaxAgents = 0;
    let utilizationSum = 0;
    let staleCount = 0;
    const now = Date.now();

    for (const capacity of this.capacityMap.values()) {
      totalAgents += capacity.currentAgents;
      totalMaxAgents += capacity.maxAgents;
      utilizationSum += capacity.overallHealthScore;

      if (now - capacity.lastHeartbeat.getTime() > this.config.staleThresholdMs) {
        staleCount++;
      }
    }

    return {
      totalWorkspaces: this.capacityMap.size,
      totalAgents,
      totalMaxAgents,
      averageUtilization: this.capacityMap.size > 0 ? utilizationSum / this.capacityMap.size : 0,
      staleWorkspaces: staleCount,
    };
  }

  /**
   * Clean shutdown
   */
  async shutdown(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    if (this.subscriber) {
      await this.subscriber.unsubscribe();
      await this.subscriber.quit();
      this.subscriber = null;
    }

    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }

    this.emit('shutdown');
  }
}

// Singleton instance
let _capacityManager: CapacityManager | null = null;

export function getCapacityManager(): CapacityManager {
  if (!_capacityManager) {
    _capacityManager = new CapacityManager();
  }
  return _capacityManager;
}

export function createCapacityManager(config: Partial<CapacityManagerConfig> = {}): CapacityManager {
  _capacityManager = new CapacityManager(config);
  return _capacityManager;
}
