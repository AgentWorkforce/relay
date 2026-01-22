/**
 * Scaling Policy Service
 *
 * Defines rules and policies for auto-scaling workspaces based on:
 * - Memory pressure
 * - Agent count
 * - CPU usage
 * - Trend analysis
 *
 * Policies are configurable per user/plan tier.
 */

import { EventEmitter } from 'events';

export interface ScalingThresholds {
  // Memory thresholds (bytes)
  memoryWarningBytes: number;
  memoryCriticalBytes: number;
  memoryScaleUpBytes: number;

  // Memory trend thresholds (bytes per minute)
  memoryGrowthRateWarning: number;
  memoryGrowthRateScaleUp: number;

  // Agent count thresholds
  agentsPerWorkspaceWarning: number;
  agentsPerWorkspaceMax: number;

  // CPU thresholds (percent)
  cpuWarningPercent: number;
  cpuScaleUpPercent: number;

  // Time windows
  evaluationWindowMs: number; // How long to observe before scaling
  cooldownMs: number; // Minimum time between scaling actions
}

export interface ScalingPolicy {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  priority: number; // Higher = evaluated first

  // Conditions (all must be true to trigger)
  conditions: ScalingCondition[];

  // Action to take
  action: ScalingAction;

  // Limits
  maxInstances: number;
  minInstances: number;
}

export interface ScalingCondition {
  metric: 'memory_usage' | 'memory_trend' | 'agent_count' | 'cpu_usage' | 'workspace_count';
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
  value: number;
  duration?: number; // How long condition must be true (ms)
}

export interface ScalingAction {
  type:
    | 'scale_up' // Add new workspace
    | 'scale_down' // Remove workspace
    | 'resize_up' // Vertical scale: increase workspace resources (memory/CPU)
    | 'resize_down' // Vertical scale: decrease workspace resources
    | 'increase_agent_limit' // Increase max agents in workspace
    | 'migrate_agents' // Move agents between workspaces
    | 'rebalance' // Redistribute agents across workspaces
    | 'alert_only'; // Just notify, don't take action
  targetCount?: number; // For scale_up/down: how many instances
  percentage?: number; // For scale_up/down or resize: percentage increase
  targetWorkspaceId?: string; // For in-workspace scaling
  resourceTier?: 'small' | 'medium' | 'large' | 'xlarge'; // For resize actions
  newAgentLimit?: number; // For increase_agent_limit
}

export interface ScalingDecision {
  shouldScale: boolean;
  action: ScalingAction | null;
  reason: string;
  triggeredPolicy: string | null;
  metrics: Record<string, number>;
  timestamp: Date;
}

export interface WorkspaceMetrics {
  workspaceId: string;
  totalMemoryBytes: number;
  averageMemoryBytes: number;
  peakMemoryBytes: number;
  memoryTrendPerMinute: number;
  agentCount: number;
  healthyAgentCount: number;
  cpuPercent: number;
  uptimeMs: number;
}

export interface UserScalingContext {
  userId: string;
  plan: 'free' | 'pro' | 'team' | 'enterprise';
  currentWorkspaceCount: number;
  maxWorkspaces: number;
  workspaceMetrics: WorkspaceMetrics[];
  lastScalingAction?: Date;
}

// Default thresholds by plan
const DEFAULT_THRESHOLDS: Record<string, ScalingThresholds> = {
  free: {
    memoryWarningBytes: 256 * 1024 * 1024, // 256MB
    memoryCriticalBytes: 512 * 1024 * 1024, // 512MB
    memoryScaleUpBytes: 400 * 1024 * 1024, // 400MB (no auto-scale for free)
    memoryGrowthRateWarning: 5 * 1024 * 1024, // 5MB/min
    memoryGrowthRateScaleUp: 10 * 1024 * 1024, // 10MB/min
    agentsPerWorkspaceWarning: 3,
    agentsPerWorkspaceMax: 5,
    cpuWarningPercent: 70,
    cpuScaleUpPercent: 85,
    evaluationWindowMs: 5 * 60 * 1000, // 5 minutes
    cooldownMs: 30 * 60 * 1000, // 30 minutes (free tier)
  },
  pro: {
    memoryWarningBytes: 512 * 1024 * 1024, // 512MB
    memoryCriticalBytes: 1024 * 1024 * 1024, // 1GB
    memoryScaleUpBytes: 768 * 1024 * 1024, // 768MB
    memoryGrowthRateWarning: 10 * 1024 * 1024, // 10MB/min
    memoryGrowthRateScaleUp: 20 * 1024 * 1024, // 20MB/min
    agentsPerWorkspaceWarning: 8,
    agentsPerWorkspaceMax: 15,
    cpuWarningPercent: 75,
    cpuScaleUpPercent: 90,
    evaluationWindowMs: 3 * 60 * 1000, // 3 minutes
    cooldownMs: 10 * 60 * 1000, // 10 minutes
  },
  team: {
    memoryWarningBytes: 768 * 1024 * 1024, // 768MB
    memoryCriticalBytes: 1.5 * 1024 * 1024 * 1024, // 1.5GB
    memoryScaleUpBytes: 1024 * 1024 * 1024, // 1GB
    memoryGrowthRateWarning: 15 * 1024 * 1024, // 15MB/min
    memoryGrowthRateScaleUp: 30 * 1024 * 1024, // 30MB/min
    agentsPerWorkspaceWarning: 15,
    agentsPerWorkspaceMax: 25,
    cpuWarningPercent: 80,
    cpuScaleUpPercent: 92,
    evaluationWindowMs: 2 * 60 * 1000, // 2 minutes
    cooldownMs: 5 * 60 * 1000, // 5 minutes
  },
  enterprise: {
    memoryWarningBytes: 1024 * 1024 * 1024, // 1GB
    memoryCriticalBytes: 2 * 1024 * 1024 * 1024, // 2GB
    memoryScaleUpBytes: 1.5 * 1024 * 1024 * 1024, // 1.5GB
    memoryGrowthRateWarning: 20 * 1024 * 1024, // 20MB/min
    memoryGrowthRateScaleUp: 50 * 1024 * 1024, // 50MB/min
    agentsPerWorkspaceWarning: 25,
    agentsPerWorkspaceMax: 50,
    cpuWarningPercent: 85,
    cpuScaleUpPercent: 95,
    evaluationWindowMs: 1 * 60 * 1000, // 1 minute
    cooldownMs: 2 * 60 * 1000, // 2 minutes
  },
};

// Default policies - ordered by priority (higher = evaluated first)
// In-workspace scaling is preferred over adding new workspaces (more efficient)
const DEFAULT_POLICIES: ScalingPolicy[] = [
  // === In-Workspace Scaling (Higher Priority) ===
  {
    id: 'agent-limit-increase',
    name: 'Increase Agent Limit',
    description: 'Increase max agents when approaching limit within single workspace',
    enabled: true,
    priority: 150, // Higher priority - try this before adding workspaces
    conditions: [
      { metric: 'agent_count', operator: 'gte', value: 0.85 }, // 85% of max agents
      { metric: 'workspace_count', operator: 'eq', value: 1 }, // Only 1 workspace
    ],
    action: { type: 'increase_agent_limit', percentage: 50 }, // Increase limit by 50%
    maxInstances: 10,
    minInstances: 1,
  },
  {
    id: 'workspace-resize-up',
    name: 'Resize Workspace Up',
    description: 'Vertically scale workspace when memory is high',
    enabled: true,
    priority: 140, // Higher priority than horizontal scaling
    conditions: [
      { metric: 'memory_usage', operator: 'gte', value: 0.75, duration: 120000 }, // 75% for 2min
      { metric: 'workspace_count', operator: 'eq', value: 1 }, // Only 1 workspace
    ],
    action: { type: 'resize_up', percentage: 100 }, // Double resources
    maxInstances: 10,
    minInstances: 1,
  },
  {
    id: 'cpu-pressure-resize',
    name: 'CPU Pressure Resize',
    description: 'Resize workspace when CPU is consistently high',
    enabled: true,
    priority: 135,
    conditions: [
      { metric: 'cpu_usage', operator: 'gte', value: 0.85, duration: 180000 }, // 85% for 3min
    ],
    action: { type: 'resize_up', percentage: 50 }, // 50% more resources
    maxInstances: 10,
    minInstances: 1,
  },
  {
    id: 'workspace-resize-down',
    name: 'Resize Workspace Down',
    description: 'Reduce workspace resources when underutilized',
    enabled: true,
    priority: 45, // Lower priority
    conditions: [
      { metric: 'memory_usage', operator: 'lt', value: 0.15, duration: 900000 }, // Under 15% for 15min
      { metric: 'cpu_usage', operator: 'lt', value: 0.1, duration: 900000 }, // Under 10% CPU
    ],
    action: { type: 'resize_down', percentage: 50 }, // Halve resources
    maxInstances: 10,
    minInstances: 1,
  },

  // === Horizontal Scaling (Add/Remove Workspaces) ===
  {
    id: 'memory-pressure-scale-up',
    name: 'Memory Pressure Scale Up',
    description: 'Add workspace when memory exceeds threshold across all workspaces',
    enabled: true,
    priority: 100,
    conditions: [
      { metric: 'memory_usage', operator: 'gte', value: 0.8, duration: 60000 }, // 80% for 1min
    ],
    action: { type: 'scale_up', targetCount: 1 },
    maxInstances: 10,
    minInstances: 1,
  },
  {
    id: 'memory-trend-scale-up',
    name: 'Memory Trend Scale Up',
    description: 'Add workspace when memory growth rate is high',
    enabled: true,
    priority: 90,
    conditions: [
      { metric: 'memory_trend', operator: 'gte', value: 1.0, duration: 180000 }, // At threshold for 3min
    ],
    action: { type: 'scale_up', targetCount: 1 },
    maxInstances: 10,
    minInstances: 1,
  },
  {
    id: 'agent-count-scale-up',
    name: 'Agent Count Scale Up',
    description: 'Add workspace when agent count is high across all workspaces',
    enabled: true,
    priority: 80,
    conditions: [
      { metric: 'agent_count', operator: 'gte', value: 0.9 }, // 90% of max agents
      { metric: 'workspace_count', operator: 'gte', value: 1 }, // Already tried in-workspace scaling
    ],
    action: { type: 'scale_up', targetCount: 1 },
    maxInstances: 10,
    minInstances: 1,
  },

  // === Rebalancing ===
  {
    id: 'agent-rebalance',
    name: 'Agent Rebalance',
    description: 'Redistribute agents when load is uneven across workspaces',
    enabled: true,
    priority: 60,
    conditions: [
      { metric: 'workspace_count', operator: 'gte', value: 2 }, // Multiple workspaces
    ],
    action: { type: 'rebalance' },
    maxInstances: 10,
    minInstances: 1,
  },

  // === Scale Down ===
  {
    id: 'low-usage-scale-down',
    name: 'Low Usage Scale Down',
    description: 'Remove workspace when usage is low',
    enabled: true,
    priority: 50,
    conditions: [
      { metric: 'memory_usage', operator: 'lt', value: 0.2, duration: 600000 }, // Under 20% for 10min
      { metric: 'workspace_count', operator: 'gt', value: 1 }, // More than 1 workspace
    ],
    action: { type: 'scale_down', targetCount: 1 },
    maxInstances: 10,
    minInstances: 1,
  },
];

export class ScalingPolicyService extends EventEmitter {
  private thresholds: Map<string, ScalingThresholds> = new Map();
  private policies: Map<string, ScalingPolicy[]> = new Map();
  private conditionHistory: Map<string, { timestamp: Date; value: number }[]> = new Map();

  constructor() {
    super();
    // Initialize with defaults
    for (const [plan, thresholds] of Object.entries(DEFAULT_THRESHOLDS)) {
      this.thresholds.set(plan, thresholds);
    }
  }

  /**
   * Get thresholds for a plan tier
   */
  getThresholds(plan: string): ScalingThresholds {
    return this.thresholds.get(plan) || this.thresholds.get('free')!;
  }

  /**
   * Set custom thresholds for a plan
   */
  setThresholds(plan: string, thresholds: Partial<ScalingThresholds>): void {
    const current = this.getThresholds(plan);
    this.thresholds.set(plan, { ...current, ...thresholds });
  }

  /**
   * Get policies for a user (default + custom)
   */
  getPolicies(userId: string): ScalingPolicy[] {
    const userPolicies = this.policies.get(userId) || [];
    return [...DEFAULT_POLICIES, ...userPolicies].sort((a, b) => b.priority - a.priority);
  }

  /**
   * Add custom policy for a user
   */
  addPolicy(userId: string, policy: ScalingPolicy): void {
    const existing = this.policies.get(userId) || [];
    existing.push(policy);
    this.policies.set(userId, existing);
  }

  /**
   * Evaluate scaling decision based on current context
   */
  evaluate(context: UserScalingContext): ScalingDecision {
    const thresholds = this.getThresholds(context.plan);
    const policies = this.getPolicies(context.userId);

    // Calculate aggregate metrics
    const metrics = this.calculateAggregateMetrics(context, thresholds);

    // Check cooldown
    if (context.lastScalingAction) {
      const timeSinceLastScale = Date.now() - context.lastScalingAction.getTime();
      if (timeSinceLastScale < thresholds.cooldownMs) {
        return {
          shouldScale: false,
          action: null,
          reason: `Cooldown active (${Math.round((thresholds.cooldownMs - timeSinceLastScale) / 1000)}s remaining)`,
          triggeredPolicy: null,
          metrics,
          timestamp: new Date(),
        };
      }
    }

    // Evaluate policies in priority order
    for (const policy of policies) {
      if (!policy.enabled) continue;

      const conditionsMet = this.evaluateConditions(policy.conditions, metrics, thresholds, context.userId);

      if (conditionsMet) {
        // Check instance limits for horizontal scaling only
        if (policy.action.type === 'scale_up') {
          // Block if at workspace limit (for adding new workspaces)
          if (context.currentWorkspaceCount >= context.maxWorkspaces) {
            continue; // Try next policy (could be in-workspace scaling)
          }
          if (context.currentWorkspaceCount >= policy.maxInstances) {
            continue;
          }
        }
        if (policy.action.type === 'scale_down' && context.currentWorkspaceCount <= policy.minInstances) {
          continue;
        }

        this.emit('scaling_decision', {
          userId: context.userId,
          policy: policy.id,
          action: policy.action,
          metrics,
        });

        return {
          shouldScale: true,
          action: policy.action,
          reason: policy.description,
          triggeredPolicy: policy.id,
          metrics,
          timestamp: new Date(),
        };
      }
    }

    return {
      shouldScale: false,
      action: null,
      reason: 'No scaling conditions met',
      triggeredPolicy: null,
      metrics,
      timestamp: new Date(),
    };
  }

  /**
   * Calculate aggregate metrics from workspace metrics
   */
  private calculateAggregateMetrics(
    context: UserScalingContext,
    thresholds: ScalingThresholds
  ): Record<string, number> {
    const workspaces = context.workspaceMetrics;

    if (workspaces.length === 0) {
      return {
        memory_usage: 0,
        memory_trend: 0,
        agent_count: 0,
        cpu_usage: 0,
        workspace_count: 0,
        total_memory_bytes: 0,
        total_agents: 0,
      };
    }

    const totalMemory = workspaces.reduce((sum, w) => sum + w.totalMemoryBytes, 0);
    const avgTrend = workspaces.reduce((sum, w) => sum + w.memoryTrendPerMinute, 0) / workspaces.length;
    const totalAgents = workspaces.reduce((sum, w) => sum + w.agentCount, 0);
    const avgCpu = workspaces.reduce((sum, w) => sum + w.cpuPercent, 0) / workspaces.length;

    // Normalized metrics (0-1 scale relative to thresholds)
    return {
      memory_usage: totalMemory / (thresholds.memoryScaleUpBytes * workspaces.length),
      memory_trend: avgTrend / thresholds.memoryGrowthRateScaleUp,
      agent_count: totalAgents / (thresholds.agentsPerWorkspaceMax * workspaces.length),
      cpu_usage: avgCpu / thresholds.cpuScaleUpPercent,
      workspace_count: context.currentWorkspaceCount,
      total_memory_bytes: totalMemory,
      total_agents: totalAgents,
    };
  }

  /**
   * Evaluate conditions with duration support
   */
  private evaluateConditions(
    conditions: ScalingCondition[],
    metrics: Record<string, number>,
    thresholds: ScalingThresholds,
    userId: string
  ): boolean {
    for (const condition of conditions) {
      const metricValue = metrics[condition.metric];
      if (metricValue === undefined) continue;

      const conditionMet = this.compareValues(metricValue, condition.operator, condition.value);

      if (condition.duration) {
        // Track condition history for duration-based evaluation
        const historyKey = `${userId}:${condition.metric}`;
        const history = this.conditionHistory.get(historyKey) || [];

        // Add current value
        history.push({ timestamp: new Date(), value: metricValue });

        // Clean old entries
        const cutoff = Date.now() - condition.duration;
        const recentHistory = history.filter((h) => h.timestamp.getTime() > cutoff);
        this.conditionHistory.set(historyKey, recentHistory);

        // Check if condition has been met for the full duration
        if (recentHistory.length === 0) return false;

        const allMet = recentHistory.every((h) =>
          this.compareValues(h.value, condition.operator, condition.value)
        );

        // Also check if we have enough history
        const oldestEntry = recentHistory[0].timestamp.getTime();
        const hasEnoughHistory = Date.now() - oldestEntry >= condition.duration * 0.8; // 80% of duration

        if (!allMet || !hasEnoughHistory) return false;
      } else {
        if (!conditionMet) return false;
      }
    }

    return true;
  }

  /**
   * Compare values based on operator
   */
  private compareValues(actual: number, operator: string, target: number): boolean {
    switch (operator) {
      case 'gt':
        return actual > target;
      case 'gte':
        return actual >= target;
      case 'lt':
        return actual < target;
      case 'lte':
        return actual <= target;
      case 'eq':
        return actual === target;
      default:
        return false;
    }
  }

  /**
   * Get max workspaces for a plan
   */
  getMaxWorkspaces(plan: string): number {
    switch (plan) {
      case 'free':
        return 1;
      case 'pro':
        return 3;
      case 'team':
        return 10;
      case 'enterprise':
        return 50;
      default:
        return 1;
    }
  }
}

// Singleton instance
let _scalingPolicyService: ScalingPolicyService | null = null;

export function getScalingPolicyService(): ScalingPolicyService {
  if (!_scalingPolicyService) {
    _scalingPolicyService = new ScalingPolicyService();
  }
  return _scalingPolicyService;
}
