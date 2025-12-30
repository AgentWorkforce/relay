/**
 * Plan Limits Service
 *
 * Defines resource limits for each plan tier and provides
 * functions to check if users are within their limits.
 */

import { db, PlanType, usageRecordsTable } from '../db/index.js';
import { eq, and, gte, sql } from 'drizzle-orm';
import { getDb } from '../db/drizzle.js';

/**
 * Resource limits for each plan tier
 */
export interface PlanLimits {
  maxWorkspaces: number;
  maxRepos: number;
  maxConcurrentAgents: number;
  maxComputeHoursPerMonth: number;
  coordinatorsEnabled: boolean;
}

/**
 * Plan limits configuration
 *
 * Free: Try it out on a side project
 * Pro: Professional developers, coordinators enabled
 * Team: Growing teams with advanced needs
 * Enterprise: Unlimited everything
 */
export const PLAN_LIMITS: Record<PlanType, PlanLimits> = {
  free: {
    maxWorkspaces: 1,
    maxRepos: 3,
    maxConcurrentAgents: 2,
    maxComputeHoursPerMonth: 10,
    coordinatorsEnabled: false,
  },
  pro: {
    maxWorkspaces: 5,
    maxRepos: 20,
    maxConcurrentAgents: 10,
    maxComputeHoursPerMonth: 100,
    coordinatorsEnabled: true,
  },
  team: {
    maxWorkspaces: 20,
    maxRepos: 100,
    maxConcurrentAgents: 50,
    maxComputeHoursPerMonth: 500,
    coordinatorsEnabled: true,
  },
  enterprise: {
    maxWorkspaces: Infinity,
    maxRepos: Infinity,
    maxConcurrentAgents: Infinity,
    maxComputeHoursPerMonth: Infinity,
    coordinatorsEnabled: true,
  },
};

/**
 * Get plan limits for a given plan type
 */
export function getPlanLimits(plan: PlanType): PlanLimits {
  return PLAN_LIMITS[plan];
}

/**
 * Current usage for a user
 */
export interface UserUsage {
  workspaceCount: number;
  repoCount: number;
  concurrentAgents: number;
  computeHoursThisMonth: number;
}

/**
 * Get current usage for a user
 */
export async function getUserUsage(userId: string): Promise<UserUsage> {
  // Get workspace count
  const workspaces = await db.workspaces.findByUserId(userId);
  const workspaceCount = workspaces.length;

  // Get repo count across all workspaces
  let repoCount = 0;
  for (const workspace of workspaces) {
    const repos = await db.repositories.findByWorkspaceId(workspace.id);
    repoCount += repos.length;
  }

  // Get concurrent agents (currently running)
  // For now, we'll track this via usage_records with metric 'active_agents'
  // In production, this would query the actual running agent count
  const drizzleDb = getDb();
  const activeAgentsResult = await drizzleDb
    .select({ total: sql<number>`COALESCE(MAX(${usageRecordsTable.value}), 0)` })
    .from(usageRecordsTable)
    .where(
      and(
        eq(usageRecordsTable.userId, userId),
        eq(usageRecordsTable.metric, 'active_agents')
      )
    );
  const concurrentAgents = Number(activeAgentsResult[0]?.total || 0);

  // Get compute hours this month
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const computeHoursResult = await drizzleDb
    .select({ total: sql<number>`COALESCE(SUM(${usageRecordsTable.value}), 0)` })
    .from(usageRecordsTable)
    .where(
      and(
        eq(usageRecordsTable.userId, userId),
        eq(usageRecordsTable.metric, 'compute_hours'),
        gte(usageRecordsTable.recordedAt, startOfMonth)
      )
    );

  const computeHoursThisMonth = Number(computeHoursResult[0]?.total || 0);

  return {
    workspaceCount,
    repoCount,
    concurrentAgents,
    computeHoursThisMonth,
  };
}

/**
 * Check if user can create a new workspace
 */
export async function canCreateWorkspace(userId: string): Promise<{
  allowed: boolean;
  reason?: string;
  limit?: number;
  current?: number;
}> {
  const user = await db.users.findById(userId);
  if (!user) {
    return { allowed: false, reason: 'User not found' };
  }

  const plan = (user.plan as PlanType) || 'free';
  const limits = getPlanLimits(plan);
  const usage = await getUserUsage(userId);

  if (usage.workspaceCount >= limits.maxWorkspaces) {
    return {
      allowed: false,
      reason: `Workspace limit reached for ${plan} plan`,
      limit: limits.maxWorkspaces,
      current: usage.workspaceCount,
    };
  }

  return { allowed: true };
}

/**
 * Check if user can add a new repo
 */
export async function canAddRepo(userId: string): Promise<{
  allowed: boolean;
  reason?: string;
  limit?: number;
  current?: number;
}> {
  const user = await db.users.findById(userId);
  if (!user) {
    return { allowed: false, reason: 'User not found' };
  }

  const plan = (user.plan as PlanType) || 'free';
  const limits = getPlanLimits(plan);
  const usage = await getUserUsage(userId);

  if (usage.repoCount >= limits.maxRepos) {
    return {
      allowed: false,
      reason: `Repository limit reached for ${plan} plan`,
      limit: limits.maxRepos,
      current: usage.repoCount,
    };
  }

  return { allowed: true };
}

/**
 * Check if user can spawn another agent (concurrent agent limit)
 */
export async function canSpawnAgent(
  userId: string,
  currentRunningAgents?: number
): Promise<{
  allowed: boolean;
  reason?: string;
  limit?: number;
  current?: number;
}> {
  const user = await db.users.findById(userId);
  if (!user) {
    return { allowed: false, reason: 'User not found' };
  }

  const plan = (user.plan as PlanType) || 'free';
  const limits = getPlanLimits(plan);

  // Use provided count or fetch from usage
  let concurrentAgents: number;
  if (currentRunningAgents !== undefined) {
    concurrentAgents = currentRunningAgents;
  } else {
    const usage = await getUserUsage(userId);
    concurrentAgents = usage.concurrentAgents;
  }

  if (concurrentAgents >= limits.maxConcurrentAgents) {
    return {
      allowed: false,
      reason: `Concurrent agent limit reached for ${plan} plan`,
      limit: limits.maxConcurrentAgents,
      current: concurrentAgents,
    };
  }

  return { allowed: true };
}

/**
 * Check if user can use coordinator agents
 */
export async function canUseCoordinator(userId: string): Promise<{
  allowed: boolean;
  reason?: string;
  requiredPlan?: string;
}> {
  const user = await db.users.findById(userId);
  if (!user) {
    return { allowed: false, reason: 'User not found' };
  }

  const plan = (user.plan as PlanType) || 'free';
  const limits = getPlanLimits(plan);

  if (!limits.coordinatorsEnabled) {
    return {
      allowed: false,
      reason: 'Coordinator agents require a Pro plan or higher',
      requiredPlan: 'pro',
    };
  }

  return { allowed: true };
}

/**
 * Check if user has compute hours available
 */
export async function hasComputeHoursAvailable(userId: string): Promise<{
  available: boolean;
  reason?: string;
  limit?: number;
  current?: number;
}> {
  const user = await db.users.findById(userId);
  if (!user) {
    return { available: false, reason: 'User not found' };
  }

  const plan = (user.plan as PlanType) || 'free';
  const limits = getPlanLimits(plan);
  const usage = await getUserUsage(userId);

  // Enterprise has unlimited
  if (limits.maxComputeHoursPerMonth === Infinity) {
    return { available: true };
  }

  if (usage.computeHoursThisMonth >= limits.maxComputeHoursPerMonth) {
    return {
      available: false,
      reason: `Compute hours limit reached for ${plan} plan`,
      limit: limits.maxComputeHoursPerMonth,
      current: usage.computeHoursThisMonth,
    };
  }

  return { available: true };
}

/**
 * Get remaining quota for a user
 */
export async function getRemainingQuota(userId: string): Promise<{
  plan: PlanType;
  limits: PlanLimits;
  usage: UserUsage;
  remaining: {
    workspaces: number;
    repos: number;
    concurrentAgents: number;
    computeHours: number;
  };
}> {
  const user = await db.users.findById(userId);
  const plan = ((user?.plan as PlanType) || 'free') as PlanType;
  const limits = getPlanLimits(plan);
  const usage = await getUserUsage(userId);

  const calcRemaining = (limit: number, current: number) =>
    limit === Infinity ? Infinity : Math.max(0, limit - current);

  return {
    plan,
    limits,
    usage,
    remaining: {
      workspaces: calcRemaining(limits.maxWorkspaces, usage.workspaceCount),
      repos: calcRemaining(limits.maxRepos, usage.repoCount),
      concurrentAgents: calcRemaining(limits.maxConcurrentAgents, usage.concurrentAgents),
      computeHours: calcRemaining(limits.maxComputeHoursPerMonth, usage.computeHoursThisMonth),
    },
  };
}

/**
 * Record compute usage
 */
export async function recordComputeUsage(
  userId: string,
  workspaceId: string,
  hours: number
): Promise<void> {
  const drizzleDb = getDb();
  await drizzleDb.insert(usageRecordsTable).values({
    userId,
    workspaceId,
    metric: 'compute_hours',
    value: Math.round(hours * 100) / 100, // Round to 2 decimal places
    recordedAt: new Date(),
  });
}

/**
 * Update active agent count for a user
 */
export async function updateActiveAgentCount(
  userId: string,
  workspaceId: string,
  count: number
): Promise<void> {
  const drizzleDb = getDb();
  await drizzleDb.insert(usageRecordsTable).values({
    userId,
    workspaceId,
    metric: 'active_agents',
    value: count,
    recordedAt: new Date(),
  });
}
