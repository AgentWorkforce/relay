/**
 * CgroupManager - Manage CPU limits for agents using Linux cgroups v2
 *
 * Provides per-agent CPU isolation to prevent one agent (e.g., running npm install)
 * from starving other agents of CPU resources.
 *
 * Features:
 * - Auto-detects cgroups v2 availability
 * - Creates per-agent cgroups with CPU limits
 * - Gracefully degrades when cgroups unavailable
 * - Cleans up cgroups when agents exit
 *
 * Usage:
 * ```typescript
 * const manager = getCgroupManager();
 * await manager.createAgentCgroup('worker1', { cpuPercent: 50 });
 * await manager.addProcess('worker1', pid);
 * // ... agent runs with CPU limit ...
 * await manager.removeAgentCgroup('worker1');
 * ```
 *
 * Requirements:
 * - Linux with cgroups v2 (unified hierarchy)
 * - Write access to cgroup directory (delegated or root)
 * - cpu controller enabled in cgroup
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * CPU limit configuration for an agent
 */
export interface CpuLimitConfig {
  /** CPU percentage limit (1-100 per core, e.g., 200 = 2 full cores). Default: 100 */
  cpuPercent?: number;
  /** CPU period in microseconds. Default: 100000 (100ms) */
  cpuPeriodUs?: number;
}

/**
 * Cgroup info for an agent
 */
export interface AgentCgroupInfo {
  name: string;
  path: string;
  pids: number[];
  cpuLimit: CpuLimitConfig;
  createdAt: number;
}

/**
 * Events emitted by CgroupManager
 */
export interface CgroupManagerEvents {
  'cgroup-created': (info: { agentName: string; path: string; cpuPercent: number }) => void;
  'cgroup-removed': (info: { agentName: string }) => void;
  'process-added': (info: { agentName: string; pid: number }) => void;
  'error': (error: Error) => void;
}

/**
 * Default cgroup base path for agent-relay
 */
const DEFAULT_CGROUP_BASE = '/sys/fs/cgroup/agent-relay';

/**
 * Default CPU settings
 */
const DEFAULT_CPU_PERCENT = 100; // 100% of one core
const DEFAULT_CPU_PERIOD_US = 100000; // 100ms period

/**
 * CgroupManager singleton for managing agent CPU limits
 */
export class CgroupManager extends EventEmitter {
  private cgroupBase: string;
  private available: boolean;
  private agentCgroups: Map<string, AgentCgroupInfo> = new Map();
  private initialized = false;

  constructor(cgroupBase: string = DEFAULT_CGROUP_BASE) {
    super();
    this.cgroupBase = cgroupBase;
    this.available = false;
  }

  /**
   * Initialize the cgroup manager and detect availability
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) {
      return this.available;
    }

    this.initialized = true;
    this.available = await this.detectCgroupsV2();

    if (this.available) {
      // Ensure base directory exists
      try {
        await this.ensureBaseCgroup();
      } catch (err: any) {
        console.warn(`[cgroup-manager] Failed to create base cgroup: ${err.message}`);
        this.available = false;
      }
    }

    return this.available;
  }

  /**
   * Check if cgroups v2 is available and we have write access
   */
  private async detectCgroupsV2(): Promise<boolean> {
    // Check for cgroups v2 unified hierarchy
    const cgroupRoot = '/sys/fs/cgroup';

    // Check if cgroup2 is mounted (unified hierarchy)
    if (!existsSync(join(cgroupRoot, 'cgroup.controllers'))) {
      console.info('[cgroup-manager] cgroups v2 not detected (no unified hierarchy)');
      return false;
    }

    // Check if cpu controller is available
    try {
      const controllers = readFileSync(join(cgroupRoot, 'cgroup.controllers'), 'utf-8');
      if (!controllers.includes('cpu')) {
        console.info('[cgroup-manager] CPU controller not available in cgroups');
        return false;
      }
    } catch (err: any) {
      console.info(`[cgroup-manager] Cannot read cgroup controllers: ${err.message}`);
      return false;
    }

    // Check if we can write to cgroup directory
    // In production, agent-relay cgroup should be pre-created with proper delegation
    try {
      const testPath = join(cgroupRoot, 'agent-relay-test-' + process.pid);
      mkdirSync(testPath, { recursive: true });
      rmSync(testPath, { recursive: true, force: true });
      console.info('[cgroup-manager] cgroups v2 available with write access');
      return true;
    } catch (err: any) {
      // Try delegated cgroup path
      if (existsSync(this.cgroupBase)) {
        console.info('[cgroup-manager] Using delegated cgroup at ' + this.cgroupBase);
        return true;
      }
      console.info(`[cgroup-manager] No write access to cgroups: ${err.message}`);
      return false;
    }
  }

  /**
   * Ensure base cgroup directory exists with proper controllers
   */
  private async ensureBaseCgroup(): Promise<void> {
    if (!existsSync(this.cgroupBase)) {
      mkdirSync(this.cgroupBase, { recursive: true });
    }

    // Enable cpu controller in subtree
    const subtreeControlPath = join(this.cgroupBase, 'cgroup.subtree_control');
    if (existsSync(subtreeControlPath)) {
      try {
        writeFileSync(subtreeControlPath, '+cpu');
      } catch {
        // Controller might already be enabled or not available
      }
    }
  }

  /**
   * Check if cgroups are available
   */
  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Create a cgroup for an agent with CPU limits
   *
   * @param agentName - Unique agent identifier
   * @param config - CPU limit configuration
   * @returns true if cgroup was created, false if not available
   */
  async createAgentCgroup(agentName: string, config: CpuLimitConfig = {}): Promise<boolean> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.available) {
      return false;
    }

    // Validate agent name (no path traversal)
    if (agentName.includes('/') || agentName.includes('..')) {
      throw new Error(`Invalid agent name: ${agentName}`);
    }

    const cgroupPath = join(this.cgroupBase, agentName);

    try {
      // Create cgroup directory
      if (!existsSync(cgroupPath)) {
        mkdirSync(cgroupPath, { recursive: true });
      }

      // Configure CPU limit
      const cpuPercent = config.cpuPercent ?? DEFAULT_CPU_PERCENT;
      const cpuPeriodUs = config.cpuPeriodUs ?? DEFAULT_CPU_PERIOD_US;

      // cpu.max format: "$MAX $PERIOD" in microseconds
      // For 50% of one CPU: "50000 100000" (50ms max per 100ms period)
      const cpuMaxUs = Math.floor((cpuPercent / 100) * cpuPeriodUs);
      const cpuMaxValue = `${cpuMaxUs} ${cpuPeriodUs}`;

      writeFileSync(join(cgroupPath, 'cpu.max'), cpuMaxValue);

      // Track the cgroup
      const info: AgentCgroupInfo = {
        name: agentName,
        path: cgroupPath,
        pids: [],
        cpuLimit: { cpuPercent, cpuPeriodUs },
        createdAt: Date.now(),
      };
      this.agentCgroups.set(agentName, info);

      this.emit('cgroup-created', { agentName, path: cgroupPath, cpuPercent });
      console.info(`[cgroup-manager] Created cgroup for ${agentName} with ${cpuPercent}% CPU limit`);

      return true;
    } catch (err: any) {
      const error = new Error(`Failed to create cgroup for ${agentName}: ${err.message}`);
      this.emit('error', error);
      console.warn(`[cgroup-manager] ${error.message}`);
      return false;
    }
  }

  /**
   * Add a process to an agent's cgroup
   *
   * @param agentName - Agent name
   * @param pid - Process ID to add
   * @returns true if process was added
   */
  async addProcess(agentName: string, pid: number): Promise<boolean> {
    if (!this.available) {
      return false;
    }

    const info = this.agentCgroups.get(agentName);
    if (!info) {
      console.warn(`[cgroup-manager] No cgroup found for agent ${agentName}`);
      return false;
    }

    try {
      // Write PID to cgroup.procs
      writeFileSync(join(info.path, 'cgroup.procs'), String(pid));
      info.pids.push(pid);

      this.emit('process-added', { agentName, pid });
      console.info(`[cgroup-manager] Added process ${pid} to cgroup ${agentName}`);

      return true;
    } catch (err: any) {
      console.warn(`[cgroup-manager] Failed to add process ${pid} to cgroup ${agentName}: ${err.message}`);
      return false;
    }
  }

  /**
   * Remove an agent's cgroup
   *
   * @param agentName - Agent name
   * @returns true if cgroup was removed
   */
  async removeAgentCgroup(agentName: string): Promise<boolean> {
    if (!this.available) {
      return false;
    }

    const info = this.agentCgroups.get(agentName);
    if (!info) {
      return false;
    }

    try {
      // Move processes to parent cgroup first (required before removal)
      const parentProcs = join(this.cgroupBase, 'cgroup.procs');
      for (const pid of info.pids) {
        try {
          writeFileSync(parentProcs, String(pid));
        } catch {
          // Process might have exited
        }
      }

      // Remove the cgroup directory
      rmSync(info.path, { recursive: true, force: true });
      this.agentCgroups.delete(agentName);

      this.emit('cgroup-removed', { agentName });
      console.info(`[cgroup-manager] Removed cgroup for ${agentName}`);

      return true;
    } catch (err: any) {
      console.warn(`[cgroup-manager] Failed to remove cgroup ${agentName}: ${err.message}`);
      return false;
    }
  }

  /**
   * Update CPU limit for an existing agent cgroup
   *
   * @param agentName - Agent name
   * @param cpuPercent - New CPU percentage limit
   */
  async updateCpuLimit(agentName: string, cpuPercent: number): Promise<boolean> {
    if (!this.available) {
      return false;
    }

    const info = this.agentCgroups.get(agentName);
    if (!info) {
      return false;
    }

    try {
      const cpuPeriodUs = info.cpuLimit.cpuPeriodUs ?? DEFAULT_CPU_PERIOD_US;
      const cpuMaxUs = Math.floor((cpuPercent / 100) * cpuPeriodUs);
      const cpuMaxValue = `${cpuMaxUs} ${cpuPeriodUs}`;

      writeFileSync(join(info.path, 'cpu.max'), cpuMaxValue);
      info.cpuLimit.cpuPercent = cpuPercent;

      console.info(`[cgroup-manager] Updated CPU limit for ${agentName} to ${cpuPercent}%`);
      return true;
    } catch (err: any) {
      console.warn(`[cgroup-manager] Failed to update CPU limit for ${agentName}: ${err.message}`);
      return false;
    }
  }

  /**
   * Get current CPU usage for an agent (if available)
   *
   * @param agentName - Agent name
   * @returns CPU usage stats or null
   */
  getCpuStats(agentName: string): { usageUsec: number; throttledUsec: number; periods: number } | null {
    if (!this.available) {
      return null;
    }

    const info = this.agentCgroups.get(agentName);
    if (!info) {
      return null;
    }

    try {
      const statPath = join(info.path, 'cpu.stat');
      if (!existsSync(statPath)) {
        return null;
      }

      const stat = readFileSync(statPath, 'utf-8');
      const lines = stat.trim().split('\n');
      const stats: Record<string, number> = {};

      for (const line of lines) {
        const [key, value] = line.split(' ');
        stats[key] = parseInt(value, 10);
      }

      return {
        usageUsec: stats['usage_usec'] ?? 0,
        throttledUsec: stats['throttled_usec'] ?? 0,
        periods: stats['nr_periods'] ?? 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get info about all agent cgroups
   */
  getAllAgentCgroups(): AgentCgroupInfo[] {
    return Array.from(this.agentCgroups.values());
  }

  /**
   * Clean up orphaned cgroups (e.g., after crash)
   */
  async cleanupOrphanedCgroups(): Promise<number> {
    if (!this.available || !existsSync(this.cgroupBase)) {
      return 0;
    }

    let cleaned = 0;

    try {
      const entries = readdirSync(this.cgroupBase, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        // Skip if we're tracking this cgroup
        if (this.agentCgroups.has(entry.name)) continue;

        // Try to remove orphaned cgroup
        try {
          const cgroupPath = join(this.cgroupBase, entry.name);
          rmSync(cgroupPath, { recursive: true, force: true });
          cleaned++;
          console.info(`[cgroup-manager] Cleaned up orphaned cgroup: ${entry.name}`);
        } catch {
          // Might still have processes
        }
      }
    } catch {
      // Ignore errors during cleanup
    }

    return cleaned;
  }

  /**
   * Shutdown and clean up all cgroups
   */
  async shutdown(): Promise<void> {
    for (const [agentName] of this.agentCgroups) {
      await this.removeAgentCgroup(agentName);
    }
  }
}

// Singleton instance
let cgroupManagerInstance: CgroupManager | null = null;

/**
 * Get the singleton CgroupManager instance
 */
export function getCgroupManager(cgroupBase?: string): CgroupManager {
  if (!cgroupManagerInstance) {
    cgroupManagerInstance = new CgroupManager(cgroupBase);
  }
  return cgroupManagerInstance;
}

/**
 * Format bytes for display
 */
export function formatCpuTime(usec: number): string {
  if (usec < 1000) {
    return `${usec}µs`;
  } else if (usec < 1000000) {
    return `${(usec / 1000).toFixed(2)}ms`;
  } else {
    return `${(usec / 1000000).toFixed(2)}s`;
  }
}
