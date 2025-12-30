/**
 * Usage API Routes
 *
 * Track and report user resource usage against plan limits.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from './auth.js';
import { getRemainingQuota, getUserUsage, getPlanLimits } from '../services/planLimits.js';
import { db, PlanType } from '../db/index.js';

export const usageRouter = Router();

// All routes require authentication
usageRouter.use(requireAuth);

/**
 * GET /api/usage
 * Get current usage vs limits for the authenticated user
 */
usageRouter.get('/', async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  try {
    const user = await db.users.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const plan = (user.plan as PlanType) || 'free';
    const quota = await getRemainingQuota(userId);

    const calcPercent = (current: number, limit: number) =>
      limit === Infinity ? 0 : Math.round((current / limit) * 100);

    res.json({
      plan,
      limits: {
        workspaces: quota.limits.maxWorkspaces,
        repos: quota.limits.maxRepos,
        concurrentAgents: quota.limits.maxConcurrentAgents,
        computeHoursPerMonth: quota.limits.maxComputeHoursPerMonth,
        coordinatorsEnabled: quota.limits.coordinatorsEnabled,
      },
      usage: {
        workspaces: quota.usage.workspaceCount,
        repos: quota.usage.repoCount,
        concurrentAgents: quota.usage.concurrentAgents,
        computeHoursThisMonth: quota.usage.computeHoursThisMonth,
      },
      remaining: {
        workspaces: quota.remaining.workspaces,
        repos: quota.remaining.repos,
        concurrentAgents: quota.remaining.concurrentAgents,
        computeHours: quota.remaining.computeHours,
      },
      percentUsed: {
        workspaces: calcPercent(quota.usage.workspaceCount, quota.limits.maxWorkspaces),
        repos: calcPercent(quota.usage.repoCount, quota.limits.maxRepos),
        concurrentAgents: calcPercent(quota.usage.concurrentAgents, quota.limits.maxConcurrentAgents),
        computeHours: calcPercent(quota.usage.computeHoursThisMonth, quota.limits.maxComputeHoursPerMonth),
      },
    });
  } catch (error) {
    console.error('Error getting usage:', error);
    res.status(500).json({ error: 'Failed to get usage' });
  }
});

/**
 * GET /api/usage/summary
 * Get a quick summary of plan and usage status
 */
usageRouter.get('/summary', async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  try {
    const user = await db.users.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const plan = (user.plan as PlanType) || 'free';
    const limits = getPlanLimits(plan);
    const usage = await getUserUsage(userId);

    // Calculate warnings (when at 80%+ of limit)
    const warnings = [];

    const checkLimit = (
      resource: string,
      message: string,
      current: number,
      limit: number
    ) => {
      if (limit !== Infinity && current >= limit * 0.8) {
        warnings.push({ resource, message, current, limit });
      }
    };

    checkLimit('workspaces', 'Approaching workspace limit', usage.workspaceCount, limits.maxWorkspaces);
    checkLimit('repos', 'Approaching repository limit', usage.repoCount, limits.maxRepos);
    checkLimit('concurrentAgents', 'Approaching concurrent agent limit', usage.concurrentAgents, limits.maxConcurrentAgents);
    checkLimit('computeHours', 'Approaching compute hours limit', usage.computeHoursThisMonth, limits.maxComputeHoursPerMonth);

    res.json({
      plan,
      coordinatorsEnabled: limits.coordinatorsEnabled,
      status: warnings.length > 0 ? 'warning' : 'healthy',
      warnings,
    });
  } catch (error) {
    console.error('Error getting usage summary:', error);
    res.status(500).json({ error: 'Failed to get usage summary' });
  }
});
