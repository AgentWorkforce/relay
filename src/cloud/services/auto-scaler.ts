/**
 * Auto-Scaler Service
 *
 * Monitors workspace metrics and automatically scales instances based on
 * defined policies. Uses Redis pub/sub for cross-server coordination to
 * ensure only one scaling operation happens at a time.
 *
 * Key responsibilities:
 * - Subscribe to metrics updates from monitoring service
 * - Evaluate scaling policies periodically
 * - Coordinate scaling decisions across multiple cloud servers
 * - Execute scaling actions via workspace provisioner
 * - Track scaling history and pending operations
 */

import { EventEmitter } from 'events';
import { createClient, RedisClientType } from 'redis';
import {
  ScalingPolicyService,
  ScalingDecision,
  UserScalingContext,
  WorkspaceMetrics,
  getScalingPolicyService,
} from './scaling-policy.js';

export interface ScalingOperation {
  id: string;
  userId: string;
  action:
    | 'scale_up' // Horizontal: add new workspace
    | 'scale_down' // Horizontal: remove workspace
    | 'resize_up' // Vertical: increase workspace resources (CPU/memory)
    | 'resize_down' // Vertical: decrease workspace resources
    | 'increase_agent_limit' // Increase max agents in workspace
    | 'migrate_agents' // Move agents between workspaces
    | 'rebalance'; // Redistribute agents across workspaces
  targetWorkspaceId?: string;
  targetResourceTier?: 'small' | 'medium' | 'large' | 'xlarge';
  targetAgentLimit?: number;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  startedAt: Date;
  completedAt?: Date;
  error?: string;
  triggeredBy: string; // policy ID or manual
  metrics: Record<string, number>;
}

export interface AutoScalerConfig {
  enabled: boolean;
  evaluationIntervalMs: number; // How often to check metrics
  lockTimeoutMs: number; // Distributed lock timeout
  maxConcurrentOperations: number;
  redisKeyPrefix: string;
}

export interface MetricsSnapshot {
  userId: string;
  workspaces: WorkspaceMetrics[];
  timestamp: Date;
}

const DEFAULT_CONFIG: AutoScalerConfig = {
  enabled: true,
  evaluationIntervalMs: 30000, // 30 seconds
  lockTimeoutMs: 60000, // 1 minute
  maxConcurrentOperations: 5,
  redisKeyPrefix: 'autoscaler:',
};

// Redis pub/sub channels
const CHANNELS = {
  METRICS_UPDATE: 'autoscaler:metrics',
  SCALING_REQUEST: 'autoscaler:scale',
  SCALING_COMPLETE: 'autoscaler:complete',
  LOCK_ACQUIRED: 'autoscaler:lock',
};

export class AutoScaler extends EventEmitter {
  private config: AutoScalerConfig;
  private policyService: ScalingPolicyService;
  private redis: RedisClientType | null = null;
  private subscriber: RedisClientType | null = null;
  private evaluationTimer: ReturnType<typeof setInterval> | null = null;
  private pendingOperations: Map<string, ScalingOperation> = new Map();
  private metricsCache: Map<string, MetricsSnapshot> = new Map();
  private isLeader: boolean = false;
  private serverId: string;
  private lastScalingActions: Map<string, Date> = new Map(); // userId -> lastAction

  constructor(config: Partial<AutoScalerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.policyService = getScalingPolicyService();
    this.serverId = `server-${process.pid}-${Date.now()}`;
  }

  /**
   * Initialize with Redis connection for cross-server coordination
   */
  async initialize(redisUrl: string): Promise<void> {
    if (!this.config.enabled) {
      this.emit('disabled');
      return;
    }

    try {
      // Main Redis client for commands
      this.redis = createClient({ url: redisUrl });
      this.redis.on('error', (err) => this.emit('error', { context: 'redis', error: err }));

      // Separate client for subscriptions
      this.subscriber = createClient({ url: redisUrl });
      this.subscriber.on('error', (err) => this.emit('error', { context: 'subscriber', error: err }));

      await Promise.all([this.redis.connect(), this.subscriber.connect()]);

      // Set up pub/sub subscriptions
      await this.setupSubscriptions();

      // Start evaluation loop
      this.startEvaluationLoop();

      // Attempt to become leader
      await this.attemptLeadership();

      this.emit('initialized', { serverId: this.serverId, isLeader: this.isLeader });
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Set up Redis pub/sub subscriptions
   */
  private async setupSubscriptions(): Promise<void> {
    if (!this.subscriber) return;

    // Subscribe to all channels
    await this.subscriber.subscribe(CHANNELS.METRICS_UPDATE, (message: string) => {
      this.handleChannelMessage(CHANNELS.METRICS_UPDATE, message);
    });

    await this.subscriber.subscribe(CHANNELS.SCALING_REQUEST, (message: string) => {
      this.handleChannelMessage(CHANNELS.SCALING_REQUEST, message);
    });

    await this.subscriber.subscribe(CHANNELS.SCALING_COMPLETE, (message: string) => {
      this.handleChannelMessage(CHANNELS.SCALING_COMPLETE, message);
    });

    await this.subscriber.subscribe(CHANNELS.LOCK_ACQUIRED, (message: string) => {
      this.handleChannelMessage(CHANNELS.LOCK_ACQUIRED, message);
    });
  }

  /**
   * Handle channel message
   */
  private handleChannelMessage(channel: string, message: string): void {
    try {
      const data = JSON.parse(message);
      this.handlePubSubMessage(channel, data).catch((err) => {
        this.emit('error', { context: 'message_handler', error: err });
      });
    } catch (error) {
      this.emit('error', { context: 'pubsub_parse', error });
    }
  }

  /**
   * Handle incoming pub/sub messages
   */
  private async handlePubSubMessage(channel: string, data: unknown): Promise<void> {
    switch (channel) {
      case CHANNELS.METRICS_UPDATE:
        await this.handleMetricsUpdate(data as MetricsSnapshot);
        break;
      case CHANNELS.SCALING_REQUEST:
        await this.handleScalingRequest(data as ScalingOperation);
        break;
      case CHANNELS.SCALING_COMPLETE:
        await this.handleScalingComplete(data as ScalingOperation);
        break;
      case CHANNELS.LOCK_ACQUIRED:
        this.handleLeadershipChange(data as { serverId: string });
        break;
    }
  }

  /**
   * Handle metrics update from monitoring service
   */
  private async handleMetricsUpdate(snapshot: MetricsSnapshot): Promise<void> {
    this.metricsCache.set(snapshot.userId, snapshot);
    this.emit('metrics_received', snapshot);

    // If we're the leader, evaluate immediately for this user
    if (this.isLeader) {
      await this.evaluateUserScaling(snapshot.userId);
    }
  }

  /**
   * Handle scaling request (from any server)
   */
  private async handleScalingRequest(operation: ScalingOperation): Promise<void> {
    // Track the operation
    this.pendingOperations.set(operation.id, operation);
    this.emit('scaling_started', operation);
  }

  /**
   * Handle scaling completion
   */
  private async handleScalingComplete(operation: ScalingOperation): Promise<void> {
    const pending = this.pendingOperations.get(operation.id);
    if (pending) {
      this.pendingOperations.delete(operation.id);
      this.lastScalingActions.set(operation.userId, new Date());
    }
    this.emit('scaling_completed', operation);
  }

  /**
   * Handle leadership change
   */
  private handleLeadershipChange(data: { serverId: string }): void {
    if (data.serverId !== this.serverId) {
      this.isLeader = false;
      this.emit('leadership_lost');
    }
  }

  /**
   * Attempt to become the leader (only leader evaluates scaling)
   */
  private async attemptLeadership(): Promise<boolean> {
    if (!this.redis) return false;

    const lockKey = `${this.config.redisKeyPrefix}leader`;
    const result = await this.redis.set(lockKey, this.serverId, {
      PX: this.config.lockTimeoutMs,
      NX: true,
    });

    if (result === 'OK') {
      this.isLeader = true;
      await this.redis.publish(CHANNELS.LOCK_ACQUIRED, JSON.stringify({ serverId: this.serverId }));
      this.emit('became_leader');

      // Renew leadership periodically
      this.scheduleLeadershipRenewal();
      return true;
    }

    return false;
  }

  /**
   * Schedule leadership lock renewal
   */
  private scheduleLeadershipRenewal(): void {
    const renewInterval = this.config.lockTimeoutMs / 2;
    setInterval(async () => {
      if (this.isLeader && this.redis) {
        const lockKey = `${this.config.redisKeyPrefix}leader`;
        const currentHolder = await this.redis.get(lockKey);
        if (currentHolder === this.serverId) {
          await this.redis.pExpire(lockKey, this.config.lockTimeoutMs);
        } else {
          this.isLeader = false;
          this.emit('leadership_lost');
        }
      }
    }, renewInterval);
  }

  /**
   * Start the periodic evaluation loop
   */
  private startEvaluationLoop(): void {
    if (this.evaluationTimer) {
      clearInterval(this.evaluationTimer);
    }

    this.evaluationTimer = setInterval(async () => {
      if (this.isLeader) {
        await this.evaluateAllUsers();
      } else {
        // Try to become leader if current leader is gone
        await this.attemptLeadership();
      }
    }, this.config.evaluationIntervalMs);
  }

  /**
   * Evaluate scaling for all cached users
   */
  private async evaluateAllUsers(): Promise<void> {
    const evaluations: Promise<void>[] = [];

    for (const userId of this.metricsCache.keys()) {
      evaluations.push(this.evaluateUserScaling(userId));
    }

    await Promise.allSettled(evaluations);
  }

  /**
   * Evaluate scaling for a specific user
   */
  private async evaluateUserScaling(userId: string): Promise<void> {
    const snapshot = this.metricsCache.get(userId);
    if (!snapshot) return;

    // Check if we have too many pending operations
    const userPendingOps = Array.from(this.pendingOperations.values()).filter(
      (op) => op.userId === userId && op.status === 'in_progress'
    ).length;

    if (userPendingOps >= this.config.maxConcurrentOperations) {
      return;
    }

    // Build context for policy evaluation
    const context = await this.buildUserContext(userId, snapshot);
    if (!context) return;

    // Evaluate policies
    const decision = this.policyService.evaluate(context);

    if (decision.shouldScale && decision.action) {
      await this.requestScaling(userId, decision);
    }

    this.emit('evaluation_complete', { userId, decision });
  }

  /**
   * Build user context for policy evaluation
   */
  private async buildUserContext(
    userId: string,
    snapshot: MetricsSnapshot
  ): Promise<UserScalingContext | null> {
    if (!this.redis) return null;

    // Get user plan from Redis cache or database
    const userPlanKey = `${this.config.redisKeyPrefix}user:${userId}:plan`;
    let plan = (await this.redis.get(userPlanKey)) as UserScalingContext['plan'] | null;
    if (!plan) {
      plan = 'free'; // Default, should be fetched from database
    }

    const maxWorkspaces = this.policyService.getMaxWorkspaces(plan);
    const lastScalingAction = this.lastScalingActions.get(userId);

    return {
      userId,
      plan,
      currentWorkspaceCount: snapshot.workspaces.length,
      maxWorkspaces,
      workspaceMetrics: snapshot.workspaces,
      lastScalingAction,
    };
  }

  /**
   * Request a scaling operation
   */
  private async requestScaling(userId: string, decision: ScalingDecision): Promise<void> {
    if (!this.redis || !decision.action) return;

    const operation: ScalingOperation = {
      id: `scale-${userId}-${Date.now()}`,
      userId,
      action: decision.action.type as ScalingOperation['action'],
      targetWorkspaceId: decision.action.targetWorkspaceId,
      targetResourceTier: decision.action.resourceTier,
      targetAgentLimit: decision.action.newAgentLimit,
      status: 'pending',
      startedAt: new Date(),
      triggeredBy: decision.triggeredPolicy || 'manual',
      metrics: decision.metrics,
    };

    // Acquire distributed lock for this user's scaling
    const lockKey = `${this.config.redisKeyPrefix}scaling:${userId}`;
    const lockAcquired = await this.redis.set(lockKey, operation.id, {
      PX: 60000,
      NX: true,
    });

    if (lockAcquired !== 'OK') {
      // Another scaling operation is in progress
      this.emit('scaling_skipped', { reason: 'lock_held', userId });
      return;
    }

    try {
      // Publish scaling request
      await this.redis.publish(CHANNELS.SCALING_REQUEST, JSON.stringify(operation));

      // Execute the scaling operation
      operation.status = 'in_progress';
      await this.executeScaling(operation, decision);
    } catch (error) {
      operation.status = 'failed';
      operation.error = error instanceof Error ? error.message : 'Unknown error';
      this.emit('scaling_error', { operation, error });
    } finally {
      // Release lock
      await this.redis.del(lockKey);

      // Publish completion
      operation.completedAt = new Date();
      await this.redis.publish(CHANNELS.SCALING_COMPLETE, JSON.stringify(operation));
    }
  }

  /**
   * Execute the actual scaling operation
   */
  private async executeScaling(
    operation: ScalingOperation,
    decision: ScalingDecision
  ): Promise<void> {
    // This will be integrated with the workspace provisioner
    // For now, emit event for external handling
    this.emit('execute_scaling', { operation, decision });

    // The actual implementation would:
    // 1. Call workspaceProvisioner.provisionWorkspace() for scale_up
    // 2. Call workspaceProvisioner.terminateWorkspace() for scale_down
    // 3. Call coordinator.rebalanceAgents() for rebalance

    operation.status = 'completed';
    this.emit('scaling_executed', operation);
  }

  /**
   * Report metrics from monitoring service
   */
  async reportMetrics(userId: string, workspaces: WorkspaceMetrics[]): Promise<void> {
    if (!this.redis) return;

    const snapshot: MetricsSnapshot = {
      userId,
      workspaces,
      timestamp: new Date(),
    };

    // Cache locally
    this.metricsCache.set(userId, snapshot);

    // Publish to all servers
    await this.redis.publish(CHANNELS.METRICS_UPDATE, JSON.stringify(snapshot));
  }

  /**
   * Manually trigger scaling evaluation for a user
   */
  async triggerEvaluation(userId: string): Promise<ScalingDecision | null> {
    const snapshot = this.metricsCache.get(userId);
    if (!snapshot) return null;

    const context = await this.buildUserContext(userId, snapshot);
    if (!context) return null;

    return this.policyService.evaluate(context);
  }

  /**
   * Get current scaling status
   */
  getStatus(): {
    enabled: boolean;
    isLeader: boolean;
    serverId: string;
    pendingOperations: number;
    cachedUsers: number;
  } {
    return {
      enabled: this.config.enabled,
      isLeader: this.isLeader,
      serverId: this.serverId,
      pendingOperations: this.pendingOperations.size,
      cachedUsers: this.metricsCache.size,
    };
  }

  /**
   * Get pending operations for a user
   */
  getPendingOperations(userId?: string): ScalingOperation[] {
    const ops = Array.from(this.pendingOperations.values());
    return userId ? ops.filter((op) => op.userId === userId) : ops;
  }

  /**
   * Update user plan in cache
   */
  async setUserPlan(userId: string, plan: UserScalingContext['plan']): Promise<void> {
    if (!this.redis) return;
    const key = `${this.config.redisKeyPrefix}user:${userId}:plan`;
    await this.redis.set(key, plan, { EX: 3600 }); // 1 hour TTL
  }

  /**
   * Clean shutdown
   */
  async shutdown(): Promise<void> {
    if (this.evaluationTimer) {
      clearInterval(this.evaluationTimer);
      this.evaluationTimer = null;
    }

    if (this.subscriber) {
      await this.subscriber.unsubscribe();
      await this.subscriber.quit();
      this.subscriber = null;
    }

    if (this.redis) {
      // Release leadership if we have it
      if (this.isLeader) {
        const lockKey = `${this.config.redisKeyPrefix}leader`;
        await this.redis.del(lockKey);
      }
      await this.redis.quit();
      this.redis = null;
    }

    this.emit('shutdown');
  }
}

// Singleton instance
let _autoScaler: AutoScaler | null = null;

export function getAutoScaler(): AutoScaler {
  if (!_autoScaler) {
    _autoScaler = new AutoScaler();
  }
  return _autoScaler;
}

export function createAutoScaler(config: Partial<AutoScalerConfig> = {}): AutoScaler {
  _autoScaler = new AutoScaler(config);
  return _autoScaler;
}
