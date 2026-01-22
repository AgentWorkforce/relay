/**
 * Stateless Lead Coordinator
 *
 * Implements P0: Lead reads from Beads, no in-memory task queue.
 * All task state lives in Beads. If lead crashes, new lead picks up.
 *
 * Key principles:
 * - Lead is a coordinator, not a state holder
 * - Beads is the single source of truth for task state
 * - Any agent can become lead by reading from Beads
 * - Tasks are assigned by updating Beads, not in-memory
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

/**
 * Task from Beads
 */
export interface BeadsTask {
  id: string;
  title: string;
  description?: string;
  status: 'open' | 'in_progress' | 'blocked' | 'closed';
  priority: number;
  assignee?: string;
  leaseExpires?: number; // P1: Lease timeout (epoch ms)
  tags?: string[];
  created_at: string;
  updated_at: string;
}

/**
 * Lead heartbeat (P2)
 */
export interface LeadHeartbeat {
  leadName: string;
  leadId: string;
  timestamp: number;
  activeTaskCount: number;
  assignedAgents: string[];
}

/**
 * Configuration for stateless lead
 */
export interface StatelessLeadConfig {
  /** Path to .beads directory */
  beadsDir: string;
  /** Agent name for this lead */
  agentName: string;
  /** Unique agent ID */
  agentId: string;
  /** How often to poll Beads for ready tasks (ms) */
  pollIntervalMs: number;
  /** Heartbeat interval (ms) */
  heartbeatIntervalMs: number;
  /** Lease duration for assigned tasks (ms) - P1 */
  leaseDurationMs: number;
  /** Callback to send relay messages */
  sendRelay: (to: string, message: string) => Promise<void>;
  /** Callback to get available workers */
  getAvailableWorkers: () => Promise<string[]>;
}

const DEFAULT_CONFIG: Partial<StatelessLeadConfig> = {
  pollIntervalMs: 5000,
  heartbeatIntervalMs: 10000,
  leaseDurationMs: 300000, // 5 minutes
};

/**
 * Stateless Lead Coordinator
 *
 * Reads tasks from Beads JSONL, assigns to workers, tracks via Beads updates.
 * No in-memory task queue - all state persisted to Beads.
 */
export class StatelessLeadCoordinator extends EventEmitter {
  private config: StatelessLeadConfig;
  private issuesPath: string;
  private heartbeatPath: string;
  private pollInterval?: ReturnType<typeof setInterval>;
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private isRunning = false;

  constructor(config: StatelessLeadConfig) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config } as StatelessLeadConfig;
    this.issuesPath = path.join(this.config.beadsDir, 'issues.jsonl');
    this.heartbeatPath = path.join(this.config.beadsDir, 'leader-heartbeat.json');
  }

  /**
   * Start the lead coordinator loop
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log(`[stateless-lead] Starting lead coordinator: ${this.config.agentName}`);

    // Write initial heartbeat
    await this.writeHeartbeat();

    // Start polling for ready tasks
    this.pollInterval = setInterval(async () => {
      try {
        await this.pollAndAssign();
      } catch (err) {
        console.error('[stateless-lead] Poll error:', err);
        this.emit('error', err);
      }
    }, this.config.pollIntervalMs);

    // Start heartbeat
    this.heartbeatInterval = setInterval(async () => {
      try {
        await this.writeHeartbeat();
      } catch (err) {
        console.error('[stateless-lead] Heartbeat error:', err);
      }
    }, this.config.heartbeatIntervalMs);

    // Initial poll
    await this.pollAndAssign();

    this.emit('started', { leadName: this.config.agentName });
  }

  /**
   * Stop the lead coordinator
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }

    console.log(`[stateless-lead] Stopped lead coordinator: ${this.config.agentName}`);
    this.emit('stopped', { leadName: this.config.agentName });
  }

  /**
   * Read all tasks from Beads JSONL
   */
  private async readTasks(): Promise<BeadsTask[]> {
    if (!fs.existsSync(this.issuesPath)) {
      return [];
    }

    const content = await fs.promises.readFile(this.issuesPath, 'utf-8');
    const tasks: BeadsTask[] = [];

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        tasks.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }

    return tasks;
  }

  /**
   * Update a task in Beads JSONL
   */
  private async updateTask(taskId: string, updates: Partial<BeadsTask>): Promise<void> {
    const tasks = await this.readTasks();
    const updated = tasks.map((task) => {
      if (task.id === taskId) {
        return {
          ...task,
          ...updates,
          updated_at: new Date().toISOString(),
        };
      }
      return task;
    });

    const content = updated.map((t) => JSON.stringify(t)).join('\n') + '\n';
    await fs.promises.writeFile(this.issuesPath, content, 'utf-8');
  }

  /**
   * Get tasks that are ready to be assigned
   * Ready = open status, not assigned, not blocked, sorted by priority
   */
  private async getReadyTasks(): Promise<BeadsTask[]> {
    const tasks = await this.readTasks();
    const now = Date.now();

    return tasks
      .filter((task) => {
        // Must be open
        if (task.status !== 'open') return false;

        // Not assigned, or lease expired (P1)
        if (task.assignee) {
          if (task.leaseExpires && task.leaseExpires > now) {
            return false; // Still leased
          }
          // Lease expired - task is available again
        }

        return true;
      })
      .sort((a, b) => a.priority - b.priority); // Lower priority number = higher priority
  }

  /**
   * Get tasks currently assigned to agents
   */
  private async getAssignedTasks(): Promise<BeadsTask[]> {
    const tasks = await this.readTasks();
    const now = Date.now();

    return tasks.filter((task) => {
      if (task.status !== 'in_progress') return false;
      if (!task.assignee) return false;
      // Check lease not expired
      if (task.leaseExpires && task.leaseExpires <= now) return false;
      return true;
    });
  }

  /**
   * Poll for ready tasks and assign to available workers
   */
  private async pollAndAssign(): Promise<void> {
    const readyTasks = await this.getReadyTasks();
    if (readyTasks.length === 0) return;

    const workers = await this.config.getAvailableWorkers();
    if (workers.length === 0) {
      console.log('[stateless-lead] No available workers');
      return;
    }

    // Assign one task per available worker
    for (const worker of workers) {
      const task = readyTasks.shift();
      if (!task) break;

      await this.assignTask(task, worker);
    }
  }

  /**
   * Assign a task to a worker
   */
  private async assignTask(task: BeadsTask, worker: string): Promise<void> {
    const leaseExpires = Date.now() + this.config.leaseDurationMs;

    // Update Beads first (source of truth)
    await this.updateTask(task.id, {
      status: 'in_progress',
      assignee: worker,
      leaseExpires,
    });

    // Send task to worker via relay
    const message = `TASK [${task.id}]: ${task.title}${task.description ? '\n\n' + task.description : ''}`;
    await this.config.sendRelay(worker, message);

    console.log(`[stateless-lead] Assigned ${task.id} to ${worker} (lease expires in ${this.config.leaseDurationMs / 1000}s)`);
    this.emit('assigned', { taskId: task.id, worker, leaseExpires });
  }

  /**
   * Handle task completion from worker
   */
  async completeTask(taskId: string, worker: string, reason?: string): Promise<void> {
    await this.updateTask(taskId, {
      status: 'closed',
      assignee: worker,
    });

    console.log(`[stateless-lead] Task ${taskId} completed by ${worker}${reason ? ': ' + reason : ''}`);
    this.emit('completed', { taskId, worker, reason });
  }

  /**
   * Handle task blocked by worker
   */
  async blockTask(taskId: string, worker: string, reason: string): Promise<void> {
    await this.updateTask(taskId, {
      status: 'blocked',
      assignee: worker,
    });

    console.log(`[stateless-lead] Task ${taskId} blocked by ${worker}: ${reason}`);
    this.emit('blocked', { taskId, worker, reason });
  }

  /**
   * Renew lease for a task (worker signals still working)
   */
  async renewLease(taskId: string, worker: string): Promise<void> {
    const leaseExpires = Date.now() + this.config.leaseDurationMs;
    await this.updateTask(taskId, { leaseExpires });

    console.log(`[stateless-lead] Renewed lease for ${taskId} (${worker})`);
    this.emit('leaseRenewed', { taskId, worker, leaseExpires });
  }

  /**
   * Write leader heartbeat to file (P2)
   */
  private async writeHeartbeat(): Promise<void> {
    const assignedTasks = await this.getAssignedTasks();
    const assignedAgents = [...new Set(assignedTasks.map((t) => t.assignee).filter(Boolean))] as string[];

    const heartbeat: LeadHeartbeat = {
      leadName: this.config.agentName,
      leadId: this.config.agentId,
      timestamp: Date.now(),
      activeTaskCount: assignedTasks.length,
      assignedAgents,
    };

    await fs.promises.writeFile(this.heartbeatPath, JSON.stringify(heartbeat, null, 2), 'utf-8');
  }

  /**
   * Read current leader heartbeat (for watchdog - P3)
   */
  static async readHeartbeat(beadsDir: string): Promise<LeadHeartbeat | null> {
    const heartbeatPath = path.join(beadsDir, 'leader-heartbeat.json');

    if (!fs.existsSync(heartbeatPath)) {
      return null;
    }

    try {
      const content = await fs.promises.readFile(heartbeatPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Check if leader is stale (for watchdog - P3)
   */
  static async isLeaderStale(beadsDir: string, staleThresholdMs = 30000): Promise<boolean> {
    const heartbeat = await StatelessLeadCoordinator.readHeartbeat(beadsDir);
    if (!heartbeat) return true;

    return Date.now() - heartbeat.timestamp > staleThresholdMs;
  }

  /**
   * Get current status
   */
  async getStatus(): Promise<{
    isRunning: boolean;
    leadName: string;
    readyTasks: number;
    assignedTasks: number;
    lastHeartbeat: number | null;
  }> {
    const readyTasks = await this.getReadyTasks();
    const assignedTasks = await this.getAssignedTasks();
    const heartbeat = await StatelessLeadCoordinator.readHeartbeat(this.config.beadsDir);

    return {
      isRunning: this.isRunning,
      leadName: this.config.agentName,
      readyTasks: readyTasks.length,
      assignedTasks: assignedTasks.length,
      lastHeartbeat: heartbeat?.timestamp ?? null,
    };
  }
}

/**
 * Create a stateless lead coordinator with defaults
 */
export function createStatelessLead(
  beadsDir: string,
  agentName: string,
  agentId: string,
  callbacks: {
    sendRelay: (to: string, message: string) => Promise<void>;
    getAvailableWorkers: () => Promise<string[]>;
  }
): StatelessLeadCoordinator {
  return new StatelessLeadCoordinator({
    beadsDir,
    agentName,
    agentId,
    ...callbacks,
    pollIntervalMs: 5000,
    heartbeatIntervalMs: 10000,
    leaseDurationMs: 300000,
  });
}
