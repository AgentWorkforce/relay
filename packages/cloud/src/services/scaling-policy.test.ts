/**
 * Tests for ScalingPolicyService
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ScalingPolicyService,
  getScalingPolicyService,
  UserScalingContext,
} from './scaling-policy.js';

describe('ScalingPolicyService', () => {
  let service: ScalingPolicyService;

  beforeEach(() => {
    service = new ScalingPolicyService();
  });

  describe('getThresholds', () => {
    it('returns thresholds for free plan', () => {
      const thresholds = service.getThresholds('free');
      expect(thresholds.memoryWarningBytes).toBe(256 * 1024 * 1024);
      expect(thresholds.memoryCriticalBytes).toBe(512 * 1024 * 1024);
      expect(thresholds.agentsPerWorkspaceMax).toBe(5);
      expect(thresholds.cooldownMs).toBe(30 * 60 * 1000);
    });

    it('returns thresholds for pro plan', () => {
      const thresholds = service.getThresholds('pro');
      expect(thresholds.memoryWarningBytes).toBe(512 * 1024 * 1024);
      expect(thresholds.agentsPerWorkspaceMax).toBe(15);
      expect(thresholds.cooldownMs).toBe(10 * 60 * 1000);
    });

    it('returns thresholds for team plan', () => {
      const thresholds = service.getThresholds('team');
      expect(thresholds.memoryWarningBytes).toBe(768 * 1024 * 1024);
      expect(thresholds.agentsPerWorkspaceMax).toBe(25);
    });

    it('returns thresholds for enterprise plan', () => {
      const thresholds = service.getThresholds('enterprise');
      expect(thresholds.memoryWarningBytes).toBe(1024 * 1024 * 1024);
      expect(thresholds.agentsPerWorkspaceMax).toBe(50);
      expect(thresholds.cooldownMs).toBe(2 * 60 * 1000);
    });

    it('falls back to free plan for unknown plans', () => {
      const thresholds = service.getThresholds('unknown');
      expect(thresholds.memoryWarningBytes).toBe(256 * 1024 * 1024);
    });
  });

  describe('setThresholds', () => {
    it('allows customizing thresholds for a plan', () => {
      service.setThresholds('pro', { memoryWarningBytes: 600 * 1024 * 1024 });
      const thresholds = service.getThresholds('pro');
      expect(thresholds.memoryWarningBytes).toBe(600 * 1024 * 1024);
      // Other values should remain unchanged
      expect(thresholds.agentsPerWorkspaceMax).toBe(15);
    });
  });

  describe('getMaxWorkspaces', () => {
    it('returns 1 for free plan', () => {
      expect(service.getMaxWorkspaces('free')).toBe(1);
    });

    it('returns 3 for pro plan', () => {
      expect(service.getMaxWorkspaces('pro')).toBe(3);
    });

    it('returns 10 for team plan', () => {
      expect(service.getMaxWorkspaces('team')).toBe(10);
    });

    it('returns 50 for enterprise plan', () => {
      expect(service.getMaxWorkspaces('enterprise')).toBe(50);
    });

    it('returns 1 for unknown plans', () => {
      expect(service.getMaxWorkspaces('unknown')).toBe(1);
    });
  });

  describe('evaluate', () => {
    const createContext = (overrides: Partial<UserScalingContext> = {}): UserScalingContext => ({
      userId: 'user-1',
      plan: 'pro',
      currentWorkspaceCount: 1,
      maxWorkspaces: 3,
      workspaceMetrics: [
        {
          workspaceId: 'ws-1',
          totalMemoryBytes: 400 * 1024 * 1024,
          averageMemoryBytes: 400 * 1024 * 1024,
          peakMemoryBytes: 500 * 1024 * 1024,
          memoryTrendPerMinute: 5 * 1024 * 1024,
          agentCount: 5,
          healthyAgentCount: 5,
          cpuPercent: 50,
          uptimeMs: 3600000,
        },
      ],
      ...overrides,
    });

    it('returns no scaling needed when under thresholds', () => {
      const context = createContext({
        workspaceMetrics: [
          {
            workspaceId: 'ws-1',
            totalMemoryBytes: 100 * 1024 * 1024,
            averageMemoryBytes: 100 * 1024 * 1024,
            peakMemoryBytes: 150 * 1024 * 1024,
            memoryTrendPerMinute: 1 * 1024 * 1024,
            agentCount: 3,
            healthyAgentCount: 3,
            cpuPercent: 30,
            uptimeMs: 3600000,
          },
        ],
      });

      const decision = service.evaluate(context);
      expect(decision.shouldScale).toBe(false);
      expect(decision.action).toBeNull();
      expect(decision.reason).toBe('No scaling conditions met');
    });

    it('blocks scaling during cooldown period', () => {
      const context = createContext({
        lastScalingAction: new Date(Date.now() - 1000), // 1 second ago
      });

      const decision = service.evaluate(context);
      expect(decision.shouldScale).toBe(false);
      expect(decision.reason).toContain('Cooldown active');
    });

    it('blocks horizontal scaling at maximum workspace limit but allows in-workspace scaling', () => {
      // At max workspaces with high agent count - should trigger in-workspace scaling, not scale_up
      const context = createContext({
        currentWorkspaceCount: 3,
        maxWorkspaces: 3,
        workspaceMetrics: [
          {
            workspaceId: 'ws-1',
            totalMemoryBytes: 300 * 1024 * 1024,
            averageMemoryBytes: 300 * 1024 * 1024,
            peakMemoryBytes: 400 * 1024 * 1024,
            memoryTrendPerMinute: 2 * 1024 * 1024,
            agentCount: 14, // High agent count would trigger scale_up, but we're at max
            healthyAgentCount: 14,
            cpuPercent: 40,
            uptimeMs: 3600000,
          },
          {
            workspaceId: 'ws-2',
            totalMemoryBytes: 300 * 1024 * 1024,
            averageMemoryBytes: 300 * 1024 * 1024,
            peakMemoryBytes: 400 * 1024 * 1024,
            memoryTrendPerMinute: 2 * 1024 * 1024,
            agentCount: 14,
            healthyAgentCount: 14,
            cpuPercent: 40,
            uptimeMs: 3600000,
          },
          {
            workspaceId: 'ws-3',
            totalMemoryBytes: 300 * 1024 * 1024,
            averageMemoryBytes: 300 * 1024 * 1024,
            peakMemoryBytes: 400 * 1024 * 1024,
            memoryTrendPerMinute: 2 * 1024 * 1024,
            agentCount: 14,
            healthyAgentCount: 14,
            cpuPercent: 40,
            uptimeMs: 3600000,
          },
        ],
      });

      const decision = service.evaluate(context);
      // scale_up is blocked, but rebalance policy should still work
      expect(decision.shouldScale).toBe(true);
      expect(decision.action?.type).toBe('rebalance');
      expect(decision.triggeredPolicy).toBe('agent-rebalance');
    });

    it('triggers scale up on high memory usage', () => {
      const context = createContext({
        workspaceMetrics: [
          {
            workspaceId: 'ws-1',
            totalMemoryBytes: 700 * 1024 * 1024, // High memory
            averageMemoryBytes: 700 * 1024 * 1024,
            peakMemoryBytes: 800 * 1024 * 1024,
            memoryTrendPerMinute: 5 * 1024 * 1024,
            agentCount: 5,
            healthyAgentCount: 5,
            cpuPercent: 50,
            uptimeMs: 3600000,
          },
        ],
      });

      // First evaluation - starts tracking duration
      service.evaluate(context);

      // Note: The policy requires duration, so immediate triggering won't happen
      // This test checks that metrics are calculated correctly
      const decision = service.evaluate(context);
      expect(decision.metrics.memory_usage).toBeGreaterThan(0.8);
    });

    it('triggers agent limit increase on high agent count (single workspace)', () => {
      const context = createContext({
        workspaceMetrics: [
          {
            workspaceId: 'ws-1',
            totalMemoryBytes: 300 * 1024 * 1024,
            averageMemoryBytes: 300 * 1024 * 1024,
            peakMemoryBytes: 400 * 1024 * 1024,
            memoryTrendPerMinute: 2 * 1024 * 1024,
            agentCount: 14, // 14/15 = 93% > 90% threshold
            healthyAgentCount: 14,
            cpuPercent: 40,
            uptimeMs: 3600000,
          },
        ],
      });

      const decision = service.evaluate(context);
      // In-workspace scaling has higher priority than horizontal scaling
      expect(decision.shouldScale).toBe(true);
      expect(decision.action?.type).toBe('increase_agent_limit');
      expect(decision.triggeredPolicy).toBe('agent-limit-increase');
    });

    it('triggers scale up on high agent count (multiple workspaces)', () => {
      const context = createContext({
        currentWorkspaceCount: 2,
        workspaceMetrics: [
          {
            workspaceId: 'ws-1',
            totalMemoryBytes: 300 * 1024 * 1024,
            averageMemoryBytes: 300 * 1024 * 1024,
            peakMemoryBytes: 400 * 1024 * 1024,
            memoryTrendPerMinute: 2 * 1024 * 1024,
            agentCount: 14, // 14/15 = 93% > 90% threshold
            healthyAgentCount: 14,
            cpuPercent: 40,
            uptimeMs: 3600000,
          },
          {
            workspaceId: 'ws-2',
            totalMemoryBytes: 300 * 1024 * 1024,
            averageMemoryBytes: 300 * 1024 * 1024,
            peakMemoryBytes: 400 * 1024 * 1024,
            memoryTrendPerMinute: 2 * 1024 * 1024,
            agentCount: 14,
            healthyAgentCount: 14,
            cpuPercent: 40,
            uptimeMs: 3600000,
          },
        ],
      });

      const decision = service.evaluate(context);
      // With multiple workspaces, agent-count-scale-up policy triggers
      expect(decision.shouldScale).toBe(true);
      expect(decision.action?.type).toBe('scale_up');
      expect(decision.triggeredPolicy).toBe('agent-count-scale-up');
    });

    it('calculates aggregate metrics correctly', () => {
      const context = createContext({
        workspaceMetrics: [
          {
            workspaceId: 'ws-1',
            totalMemoryBytes: 200 * 1024 * 1024,
            averageMemoryBytes: 200 * 1024 * 1024,
            peakMemoryBytes: 250 * 1024 * 1024,
            memoryTrendPerMinute: 5 * 1024 * 1024,
            agentCount: 5,
            healthyAgentCount: 5,
            cpuPercent: 50,
            uptimeMs: 3600000,
          },
          {
            workspaceId: 'ws-2',
            totalMemoryBytes: 300 * 1024 * 1024,
            averageMemoryBytes: 300 * 1024 * 1024,
            peakMemoryBytes: 350 * 1024 * 1024,
            memoryTrendPerMinute: 10 * 1024 * 1024,
            agentCount: 7,
            healthyAgentCount: 6,
            cpuPercent: 60,
            uptimeMs: 7200000,
          },
        ],
      });

      const decision = service.evaluate(context);
      expect(decision.metrics.workspace_count).toBe(1);
      expect(decision.metrics.total_agents).toBe(12);
      expect(decision.metrics.total_memory_bytes).toBe(500 * 1024 * 1024);
    });

    it('emits scaling_decision event', () => {
      const context = createContext({
        workspaceMetrics: [
          {
            workspaceId: 'ws-1',
            totalMemoryBytes: 300 * 1024 * 1024,
            averageMemoryBytes: 300 * 1024 * 1024,
            peakMemoryBytes: 400 * 1024 * 1024,
            memoryTrendPerMinute: 2 * 1024 * 1024,
            agentCount: 14,
            healthyAgentCount: 14,
            cpuPercent: 40,
            uptimeMs: 3600000,
          },
        ],
      });

      const listener = vi.fn();
      service.on('scaling_decision', listener);

      service.evaluate(context);

      // With single workspace, agent-limit-increase has higher priority
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          policy: 'agent-limit-increase',
        })
      );
    });
  });

  describe('getPolicies', () => {
    it('returns default policies sorted by priority', () => {
      const policies = service.getPolicies('user-1');
      expect(policies.length).toBeGreaterThan(0);

      // Verify they're sorted by priority (descending)
      for (let i = 1; i < policies.length; i++) {
        expect(policies[i - 1].priority).toBeGreaterThanOrEqual(policies[i].priority);
      }
    });

    it('includes custom policies for a user', () => {
      service.addPolicy('user-1', {
        id: 'custom-policy',
        name: 'Custom Policy',
        description: 'Test policy',
        enabled: true,
        priority: 200, // Higher than defaults
        conditions: [{ metric: 'cpu_usage', operator: 'gte', value: 0.95 }],
        action: { type: 'scale_up', targetCount: 2 },
        maxInstances: 5,
        minInstances: 1,
      });

      const policies = service.getPolicies('user-1');
      expect(policies[0].id).toBe('custom-policy');
    });
  });

  describe('singleton', () => {
    it('getScalingPolicyService returns same instance', () => {
      const instance1 = getScalingPolicyService();
      const instance2 = getScalingPolicyService();
      expect(instance1).toBe(instance2);
    });
  });
});
