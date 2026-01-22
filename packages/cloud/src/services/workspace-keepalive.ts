/**
 * Workspace Keepalive Service
 *
 * Prevents Fly.io from idling workspace machines that have active agents running.
 *
 * Problem: Fly.io uses request-based concurrency tracking to determine when to
 * idle a machine. If a Claude agent is running but no HTTP requests are coming
 * in (e.g., no one has the dashboard open), Fly.io may idle the machine.
 *
 * Solution: The cloud server periodically pings workspace machines that have
 * active agents. This inbound HTTP request counts as activity for Fly.io's
 * idle detection, keeping the machine awake.
 *
 * Flow:
 * 1. Daemons report their running agents via heartbeat
 * 2. This service queries for workspaces with active agents
 * 3. Pings each workspace's /keep-alive endpoint
 * 4. Workspace stays awake as long as agents are active
 */

import { EventEmitter } from 'events';
import { db } from '../db/index.js';

export interface WorkspaceKeepaliveConfig {
  /** How often to ping active workspaces (default: 60s) */
  pingIntervalMs: number;
  /** Request timeout for keep-alive pings (default: 5s) */
  requestTimeoutMs: number;
  /** Consider daemon stale if last heartbeat older than this (default: 2 min) */
  staleThresholdMs: number;
  /** Enable verbose logging (default: false) */
  verbose: boolean;
}

export interface KeepaliveStats {
  lastRun: Date | null;
  totalPings: number;
  successfulPings: number;
  failedPings: number;
  activeWorkspaces: number;
}

interface WorkspaceWithAgents {
  workspaceId: string;
  publicUrl: string;
  daemonId: string;
  daemonName: string;
  agentCount: number;
}

const DEFAULT_CONFIG: WorkspaceKeepaliveConfig = {
  pingIntervalMs: 60_000, // 1 minute (well under Fly's ~5-10 min idle timeout)
  requestTimeoutMs: 5_000, // 5 seconds
  staleThresholdMs: 2 * 60 * 1000, // 2 minutes
  verbose: false,
};

export class WorkspaceKeepaliveService extends EventEmitter {
  private config: WorkspaceKeepaliveConfig;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stats: KeepaliveStats = {
    lastRun: null,
    totalPings: 0,
    successfulPings: 0,
    failedPings: 0,
    activeWorkspaces: 0,
  };

  constructor(config: Partial<WorkspaceKeepaliveConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the keepalive service
   */
  start(): void {
    if (this.pingTimer) {
      return; // Already running
    }

    console.log('[keepalive] Starting workspace keepalive service', {
      intervalMs: this.config.pingIntervalMs,
    });

    // Initial ping
    this.pingActiveWorkspaces().catch((err) => {
      console.error('[keepalive] Initial ping failed:', err);
    });

    // Start periodic pings
    this.pingTimer = setInterval(() => {
      this.pingActiveWorkspaces().catch((err) => {
        console.error('[keepalive] Periodic ping failed:', err);
      });
    }, this.config.pingIntervalMs);
  }

  /**
   * Stop the keepalive service
   */
  stop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
      console.log('[keepalive] Stopped workspace keepalive service');
    }
  }

  /**
   * Get current statistics
   */
  getStats(): KeepaliveStats {
    return { ...this.stats };
  }

  /**
   * Find workspaces with active agents and ping them
   */
  async pingActiveWorkspaces(): Promise<void> {
    const startTime = Date.now();

    try {
      // Find workspaces with active agents
      const activeWorkspaces = await this.findWorkspacesWithActiveAgents();
      this.stats.activeWorkspaces = activeWorkspaces.length;
      this.stats.lastRun = new Date();

      if (activeWorkspaces.length === 0) {
        if (this.config.verbose) {
          console.log('[keepalive] No active workspaces to ping');
        }
        return;
      }

      if (this.config.verbose) {
        console.log(`[keepalive] Pinging ${activeWorkspaces.length} active workspace(s)`);
      }

      // Ping each workspace in parallel
      const results = await Promise.allSettled(
        activeWorkspaces.map((ws) => this.pingWorkspace(ws))
      );

      // Update stats
      for (const result of results) {
        this.stats.totalPings++;
        if (result.status === 'fulfilled' && result.value) {
          this.stats.successfulPings++;
        } else {
          this.stats.failedPings++;
        }
      }

      const duration = Date.now() - startTime;
      if (this.config.verbose) {
        console.log(`[keepalive] Ping cycle complete`, {
          workspaces: activeWorkspaces.length,
          durationMs: duration,
        });
      }

      this.emit('ping-cycle', {
        workspaces: activeWorkspaces.length,
        duration,
        results: results.map((r) => r.status === 'fulfilled' && r.value),
      });
    } catch (err) {
      console.error('[keepalive] Error in ping cycle:', err);
      this.emit('error', err);
    }
  }

  /**
   * Find all workspaces that have daemons with active agents
   */
  private async findWorkspacesWithActiveAgents(): Promise<WorkspaceWithAgents[]> {
    const staleThreshold = new Date(Date.now() - this.config.staleThresholdMs);

    // Get all workspaces and check each for active agents
    const allWorkspaces = await db.workspaces.findAll();

    const activeWorkspaces: WorkspaceWithAgents[] = [];

    for (const workspace of allWorkspaces) {
      // Skip workspaces that aren't running or don't have a URL
      if (workspace.status !== 'running' || !workspace.publicUrl) {
        continue;
      }

      // Get daemons for this workspace
      const daemons = await db.linkedDaemons.findByWorkspaceId(workspace.id);

      for (const daemon of daemons) {
        // Skip offline daemons or those with stale heartbeats
        if (daemon.status !== 'online') continue;
        if (daemon.lastSeenAt && daemon.lastSeenAt < staleThreshold) continue;

        // Check if daemon has any active agents
        const metadata = daemon.metadata as Record<string, unknown> | null;
        const agents = (metadata?.agents as Array<{ name: string; status: string }>) || [];

        // Count agents that appear to be active (not offline/disconnected)
        const activeAgents = agents.filter((a) =>
          a.status === 'online' || a.status === 'running' || a.status === 'active'
        );

        if (activeAgents.length > 0) {
          activeWorkspaces.push({
            workspaceId: workspace.id,
            publicUrl: workspace.publicUrl,
            daemonId: daemon.id,
            daemonName: daemon.name,
            agentCount: activeAgents.length,
          });
          // Only need one daemon per workspace to keep it alive
          break;
        }
      }
    }

    return activeWorkspaces;
  }

  /**
   * Ping a single workspace's keep-alive endpoint
   */
  private async pingWorkspace(workspace: WorkspaceWithAgents): Promise<boolean> {
    const url = `${workspace.publicUrl.replace(/\/$/, '')}/keep-alive`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'AgentRelay-Keepalive/1.0',
        },
      });

      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json() as { ok: boolean; activeAgents?: number };
        if (this.config.verbose) {
          console.log(`[keepalive] Pinged ${workspace.daemonName}`, {
            workspaceId: workspace.workspaceId,
            activeAgents: data.activeAgents,
          });
        }
        return true;
      } else {
        console.warn(`[keepalive] Ping failed for ${workspace.daemonName}:`, {
          status: response.status,
          url,
        });
        return false;
      }
    } catch (err) {
      // Don't log aborted requests as errors (timeout is expected for stopped machines)
      if (err instanceof Error && err.name === 'AbortError') {
        if (this.config.verbose) {
          console.log(`[keepalive] Ping timeout for ${workspace.daemonName} (machine may be starting)`);
        }
      } else {
        console.warn(`[keepalive] Ping error for ${workspace.daemonName}:`, err);
      }
      return false;
    }
  }
}

// Singleton instance
let _keepaliveService: WorkspaceKeepaliveService | null = null;

/**
 * Get or create the keepalive service singleton
 */
export function getWorkspaceKeepaliveService(
  config?: Partial<WorkspaceKeepaliveConfig>
): WorkspaceKeepaliveService {
  if (!_keepaliveService) {
    _keepaliveService = new WorkspaceKeepaliveService(config);
  }
  return _keepaliveService;
}

/**
 * Create a new keepalive service (for testing)
 */
export function createWorkspaceKeepaliveService(
  config?: Partial<WorkspaceKeepaliveConfig>
): WorkspaceKeepaliveService {
  return new WorkspaceKeepaliveService(config);
}
