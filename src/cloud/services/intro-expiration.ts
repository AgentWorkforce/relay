/**
 * Intro Expiration Service
 *
 * Handles auto-resize of workspaces when the free tier introductory period expires.
 * Free users get Pro-level resources (2 CPU / 4GB) for the first 14 days,
 * then get automatically downsized to standard free tier (1 CPU / 2GB).
 */

import { db, PlanType } from '../db/index.js';
import { getProvisioner } from '../provisioner/index.js';

export const INTRO_PERIOD_DAYS = 14;

export interface IntroExpirationConfig {
  enabled: boolean;
  checkIntervalMs: number; // How often to check (default: 1 hour)
}

const DEFAULT_CONFIG: IntroExpirationConfig = {
  enabled: true,
  checkIntervalMs: 60 * 60 * 1000, // 1 hour
};

export interface IntroStatus {
  isIntroPeriod: boolean;
  daysRemaining: number;
  introPeriodDays: number;
  expiresAt: Date | null;
}

export interface ExpirationResult {
  userId: string;
  workspaceId: string;
  workspaceName: string;
  action: 'resized' | 'skipped' | 'error';
  reason?: string;
}

/**
 * Get intro period status for a user
 */
export function getIntroStatus(userCreatedAt: Date | string | null, plan: string): IntroStatus {
  const introPeriodDays = INTRO_PERIOD_DAYS;

  // Only free tier users get intro bonus
  if (plan !== 'free' || !userCreatedAt) {
    return {
      isIntroPeriod: false,
      daysRemaining: 0,
      introPeriodDays,
      expiresAt: null,
    };
  }

  const createdAt = typeof userCreatedAt === 'string' ? new Date(userCreatedAt) : userCreatedAt;
  const daysSinceSignup = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
  const isIntroPeriod = daysSinceSignup < introPeriodDays;
  const daysRemaining = Math.max(0, Math.ceil(introPeriodDays - daysSinceSignup));

  const expiresAt = new Date(createdAt.getTime() + introPeriodDays * 24 * 60 * 60 * 1000);

  return {
    isIntroPeriod,
    daysRemaining,
    introPeriodDays,
    expiresAt,
  };
}

export class IntroExpirationService {
  private config: IntroExpirationConfig;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning: boolean = false;

  constructor(config: Partial<IntroExpirationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the expiration service
   */
  start(): void {
    if (!this.config.enabled) {
      console.log('[intro-expiration] Service disabled');
      return;
    }

    if (this.isRunning) {
      console.warn('[intro-expiration] Service already running');
      return;
    }

    this.isRunning = true;
    console.log(
      `[intro-expiration] Started (checking every ${this.config.checkIntervalMs / 1000 / 60} minutes)`
    );

    // Run immediately on start
    this.runExpirationCheck().catch((err) => {
      console.error('[intro-expiration] Initial run failed:', err);
    });

    // Then run periodically
    this.checkTimer = setInterval(() => {
      this.runExpirationCheck().catch((err) => {
        console.error('[intro-expiration] Periodic run failed:', err);
      });
    }, this.config.checkIntervalMs);
  }

  /**
   * Stop the expiration service
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    this.isRunning = false;
    console.log('[intro-expiration] Stopped');
  }

  /**
   * Run expiration check for all free tier users with expired intro periods
   */
  async runExpirationCheck(): Promise<ExpirationResult[]> {
    const results: ExpirationResult[] = [];

    try {
      // Get all users on free tier
      const freeUsers = await db.users.findByPlan('free');

      // Filter to users whose intro period has expired
      const expiredUsers = freeUsers.filter((user) => {
        const status = getIntroStatus(user.createdAt, user.plan || 'free');
        return !status.isIntroPeriod && status.expiresAt !== null;
      });

      if (expiredUsers.length === 0) {
        return results;
      }

      console.log(`[intro-expiration] Checking ${expiredUsers.length} users with expired intro periods`);

      for (const user of expiredUsers) {
        try {
          const userResults = await this.checkAndResizeUserWorkspaces(user.id);
          results.push(...userResults);
        } catch (err) {
          console.error(`[intro-expiration] Error checking user ${user.id}:`, err);
        }
      }

      // Summary
      const resized = results.filter((r) => r.action === 'resized').length;
      const skipped = results.filter((r) => r.action === 'skipped').length;
      const errors = results.filter((r) => r.action === 'error').length;

      if (resized > 0 || errors > 0) {
        console.log(`[intro-expiration] Results: ${resized} resized, ${skipped} skipped, ${errors} errors`);
      }

      return results;
    } catch (err) {
      console.error('[intro-expiration] Run failed:', err);
      return results;
    }
  }

  /**
   * Check and resize workspaces for a user whose intro period has expired
   */
  private async checkAndResizeUserWorkspaces(userId: string): Promise<ExpirationResult[]> {
    const results: ExpirationResult[] = [];
    const provisioner = getProvisioner();

    // Get user's workspaces
    const workspaces = await db.workspaces.findByUserId(userId);

    for (const workspace of workspaces) {
      try {
        // Check if workspace has intro-sized resources
        // We detect this by checking if it has 4GB memory (intro size) vs 2GB (standard)
        const config = workspace.config as Record<string, unknown> | null;
        const resourceTier = config?.resourceTier as string | undefined;

        // Skip if already resized to standard free tier
        // Intro workspaces would have been provisioned with medium tier (4GB)
        // Standard free tier is small (2GB)
        if (resourceTier === 'small') {
          results.push({
            userId,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            action: 'skipped',
            reason: 'Already at standard free tier size',
          });
          continue;
        }

        // Skip if workspace is not running (resize happens on next start)
        if (workspace.status !== 'running') {
          results.push({
            userId,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            action: 'skipped',
            reason: `Workspace status is ${workspace.status}`,
          });
          continue;
        }

        // Resize to standard free tier (small: 1 CPU / 2GB)
        // Use skipRestart=true to not disrupt running agents
        // The config is saved and will apply on next restart
        console.log(`[intro-expiration] Resizing workspace ${workspace.name} to standard free tier`);

        await provisioner.resize(workspace.id, {
          name: 'small',
          cpuCores: 1,
          cpuKind: 'shared',
          memoryMb: 2048,
          maxAgents: 2,
        }, true); // skipRestart = true for graceful resize

        results.push({
          userId,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          action: 'resized',
          reason: 'Intro period expired, downsized to standard free tier (applies on next restart)',
        });

      } catch (err) {
        console.error(`[intro-expiration] Failed to resize workspace ${workspace.id}:`, err);
        results.push({
          userId,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          action: 'error',
          reason: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    return results;
  }
}

// Singleton instance
let _service: IntroExpirationService | null = null;

export function getIntroExpirationService(): IntroExpirationService {
  if (!_service) {
    _service = new IntroExpirationService();
  }
  return _service;
}

export function startIntroExpirationService(): void {
  getIntroExpirationService().start();
}

export function stopIntroExpirationService(): void {
  if (_service) {
    _service.stop();
  }
}
