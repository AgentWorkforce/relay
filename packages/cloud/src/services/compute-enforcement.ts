/**
 * Compute Enforcement Service
 *
 * Enforces compute hour limits for free tier users.
 * Runs periodically to check usage and stop workspaces that have exceeded limits.
 */

import { db, PlanType } from '../db/index.js';
import { getProvisioner } from '../provisioner/index.js';
import { getUserUsage, PLAN_LIMITS } from './planLimits.js';

export interface ComputeEnforcementConfig {
  enabled: boolean;
  checkIntervalMs: number; // How often to check (default: 15 minutes)
  warningThresholdPercent: number; // When to warn user (default: 80%)
}

const DEFAULT_CONFIG: ComputeEnforcementConfig = {
  enabled: true,
  checkIntervalMs: 15 * 60 * 1000, // 15 minutes
  warningThresholdPercent: 80,
};

export interface EnforcementResult {
  userId: string;
  plan: PlanType;
  computeHoursUsed: number;
  computeHoursLimit: number;
  action: 'none' | 'warning' | 'stopped';
  workspacesStopped: string[];
}

export class ComputeEnforcementService {
  private config: ComputeEnforcementConfig;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning: boolean = false;

  constructor(config: Partial<ComputeEnforcementConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the enforcement service
   */
  start(): void {
    if (!this.config.enabled) {
      console.log('[compute-enforcement] Service disabled');
      return;
    }

    if (this.isRunning) {
      console.warn('[compute-enforcement] Service already running');
      return;
    }

    this.isRunning = true;
    console.log(
      `[compute-enforcement] Started (checking every ${this.config.checkIntervalMs / 1000}s)`
    );

    // Run immediately on start
    this.runEnforcement().catch((err) => {
      console.error('[compute-enforcement] Initial run failed:', err);
    });

    // Then run periodically
    this.checkTimer = setInterval(() => {
      this.runEnforcement().catch((err) => {
        console.error('[compute-enforcement] Periodic run failed:', err);
      });
    }, this.config.checkIntervalMs);
  }

  /**
   * Stop the enforcement service
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    this.isRunning = false;
    console.log('[compute-enforcement] Stopped');
  }

  /**
   * Run enforcement check for all free tier users
   */
  async runEnforcement(): Promise<EnforcementResult[]> {
    const results: EnforcementResult[] = [];

    try {
      // Get all users on free tier
      const freeUsers = await db.users.findByPlan('free');
      console.log(`[compute-enforcement] Checking ${freeUsers.length} free tier users`);

      for (const user of freeUsers) {
        try {
          const result = await this.enforceUserLimits(user.id);
          results.push(result);

          if (result.action !== 'none') {
            console.log(
              `[compute-enforcement] User ${user.id.substring(0, 8)}: ${result.action} ` +
                `(${result.computeHoursUsed.toFixed(2)}/${result.computeHoursLimit}h)`
            );
          }
        } catch (err) {
          console.error(`[compute-enforcement] Error for user ${user.id}:`, err);
        }
      }

      const stopped = results.filter((r) => r.action === 'stopped').length;
      const warned = results.filter((r) => r.action === 'warning').length;

      if (stopped > 0 || warned > 0) {
        console.log(
          `[compute-enforcement] Summary: ${stopped} stopped, ${warned} warned, ` +
            `${results.length - stopped - warned} ok`
        );
      }
    } catch (err) {
      console.error('[compute-enforcement] Failed to run enforcement:', err);
    }

    return results;
  }

  /**
   * Enforce limits for a specific user
   */
  async enforceUserLimits(userId: string): Promise<EnforcementResult> {
    const user = await db.users.findById(userId);
    const plan = (user?.plan as PlanType) || 'free';
    const limits = PLAN_LIMITS[plan];
    const usage = await getUserUsage(userId);

    const result: EnforcementResult = {
      userId,
      plan,
      computeHoursUsed: usage.computeHoursThisMonth,
      computeHoursLimit: limits.maxComputeHoursPerMonth,
      action: 'none',
      workspacesStopped: [],
    };

    // Skip if user has unlimited compute (paid plans may have high limits)
    if (limits.maxComputeHoursPerMonth === Infinity) {
      return result;
    }

    // Check if user has exceeded limit
    if (usage.computeHoursThisMonth >= limits.maxComputeHoursPerMonth) {
      // Stop all running workspaces
      const workspaces = await db.workspaces.findByUserId(userId);
      const runningWorkspaces = workspaces.filter((w) => w.status === 'running');

      if (runningWorkspaces.length > 0) {
        const provisioner = getProvisioner();

        for (const workspace of runningWorkspaces) {
          try {
            await provisioner.stop(workspace.id);
            result.workspacesStopped.push(workspace.id);
            console.log(
              `[compute-enforcement] Stopped workspace ${workspace.id.substring(0, 8)} ` +
                `for user ${userId.substring(0, 8)} (limit exceeded)`
            );
          } catch (err) {
            console.error(
              `[compute-enforcement] Failed to stop workspace ${workspace.id}:`,
              err
            );
          }
        }

        result.action = 'stopped';

        // TODO: Send notification email to user
        // await sendLimitReachedEmail(userId, usage.computeHoursThisMonth, limits.maxComputeHoursPerMonth);
      }
    } else {
      // Check if approaching limit (warning)
      const usagePercent =
        (usage.computeHoursThisMonth / limits.maxComputeHoursPerMonth) * 100;
      if (usagePercent >= this.config.warningThresholdPercent) {
        result.action = 'warning';
        // TODO: Send warning email to user (once per day)
        // await sendLimitWarningEmail(userId, usage.computeHoursThisMonth, limits.maxComputeHoursPerMonth);
      }
    }

    return result;
  }

  /**
   * Manually trigger enforcement for a specific user
   */
  async enforceUser(userId: string): Promise<EnforcementResult> {
    return this.enforceUserLimits(userId);
  }

  /**
   * Get service status
   */
  getStatus(): { enabled: boolean; isRunning: boolean; checkIntervalMs: number } {
    return {
      enabled: this.config.enabled,
      isRunning: this.isRunning,
      checkIntervalMs: this.config.checkIntervalMs,
    };
  }
}

// Singleton instance
let _computeEnforcement: ComputeEnforcementService | null = null;

export function getComputeEnforcementService(): ComputeEnforcementService {
  if (!_computeEnforcement) {
    _computeEnforcement = new ComputeEnforcementService();
  }
  return _computeEnforcement;
}

export function createComputeEnforcementService(
  config: Partial<ComputeEnforcementConfig> = {}
): ComputeEnforcementService {
  _computeEnforcement = new ComputeEnforcementService(config);
  return _computeEnforcement;
}
