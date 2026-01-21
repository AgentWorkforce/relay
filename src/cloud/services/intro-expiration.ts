/**
 * Intro Expiration Service
 *
 * Handles auto-resize and auto-destroy of free tier workspaces:
 * 1. Resize: Free users get Pro-level resources (2 CPU / 4GB) for the first 14 days,
 *    then get automatically downsized to standard free tier (1 CPU / 2GB).
 * 2. Destroy: Free workspaces inactive for 7+ days after intro expires get auto-destroyed
 *    to prevent ongoing infrastructure costs for churned users.
 */

import { db } from '../db/index.js';
import { getProvisioner } from '../provisioner/index.js';

export const INTRO_PERIOD_DAYS = 14;
export const DESTROY_GRACE_PERIOD_DAYS = 7; // Days of inactivity after intro before auto-destroy

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
  action: 'resized' | 'destroyed' | 'skipped' | 'error';
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
          const userResults = await this.checkAndProcessUserWorkspaces(user.id, user.createdAt);
          results.push(...userResults);
        } catch (err) {
          console.error(`[intro-expiration] Error checking user ${user.id}:`, err);
        }
      }

      // Summary
      const resized = results.filter((r) => r.action === 'resized').length;
      const destroyed = results.filter((r) => r.action === 'destroyed').length;
      const skipped = results.filter((r) => r.action === 'skipped').length;
      const errors = results.filter((r) => r.action === 'error').length;

      if (resized > 0 || destroyed > 0 || errors > 0) {
        console.log(`[intro-expiration] Results: ${resized} resized, ${destroyed} destroyed, ${skipped} skipped, ${errors} errors`);
      }

      return results;
    } catch (err) {
      console.error('[intro-expiration] Run failed:', err);
      return results;
    }
  }

  /**
   * Check and process workspaces for a user whose intro period has expired
   * - Resize workspaces that are still at intro-tier resources
   * - Destroy workspaces that have been inactive for DESTROY_GRACE_PERIOD_DAYS
   */
  private async checkAndProcessUserWorkspaces(userId: string, userCreatedAt: Date): Promise<ExpirationResult[]> {
    const results: ExpirationResult[] = [];
    const provisioner = getProvisioner();

    // Get user's workspaces
    const workspaces = await db.workspaces.findByUserId(userId);

    // Calculate when intro period expired for this user
    const introExpiredAt = new Date(userCreatedAt.getTime() + INTRO_PERIOD_DAYS * 24 * 60 * 60 * 1000);
    const destroyThreshold = new Date(introExpiredAt.getTime() + DESTROY_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
    const now = new Date();

    for (const workspace of workspaces) {
      try {
        // Check if workspace has intro-sized resources
        const config = workspace.config as Record<string, unknown> | null;
        const resourceTier = config?.resourceTier as string | undefined;

        // Check last activity via linked daemons
        const daemons = await db.linkedDaemons.findByWorkspaceId(workspace.id);
        const lastActivity = daemons.length > 0
          ? daemons.reduce((latest, d) => {
              const seen = d.lastSeenAt ? new Date(d.lastSeenAt) : new Date(0);
              return seen > latest ? seen : latest;
            }, new Date(0))
          : workspace.updatedAt; // Fall back to workspace updatedAt

        // Check if workspace should be destroyed (inactive for grace period after intro)
        const daysSinceActivity = (now.getTime() - lastActivity.getTime()) / (1000 * 60 * 60 * 24);
        const shouldDestroy = now > destroyThreshold && daysSinceActivity >= DESTROY_GRACE_PERIOD_DAYS;

        if (shouldDestroy) {
          console.log(`[intro-expiration] Destroying inactive free workspace ${workspace.name} (${daysSinceActivity.toFixed(1)} days inactive)`);

          try {
            await provisioner.deprovision(workspace.id);
            results.push({
              userId,
              workspaceId: workspace.id,
              workspaceName: workspace.name,
              action: 'destroyed',
              reason: `Inactive for ${Math.round(daysSinceActivity)} days after intro period expired`,
            });
          } catch (deprovisionErr) {
            console.error(`[intro-expiration] Failed to destroy workspace ${workspace.id}:`, deprovisionErr);
            results.push({
              userId,
              workspaceId: workspace.id,
              workspaceName: workspace.name,
              action: 'error',
              reason: `Failed to destroy: ${deprovisionErr instanceof Error ? deprovisionErr.message : 'Unknown error'}`,
            });
          }
          continue;
        }

        // Skip resize if already at standard free tier
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

        // Resize to standard free tier (small: 2 CPU / 2GB)
        // Use skipRestart=true to not disrupt running agents
        console.log(`[intro-expiration] Resizing workspace ${workspace.name} to standard free tier`);

        await provisioner.resize(workspace.id, {
          name: 'small',
          cpuCores: 2,
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
        console.error(`[intro-expiration] Failed to process workspace ${workspace.id}:`, err);
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
