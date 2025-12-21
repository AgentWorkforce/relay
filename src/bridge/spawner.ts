/**
 * Agent Spawner
 * Handles spawning and releasing worker agents via tmux.
 */

import { execAsync, sleep, escapeForTmux } from './utils.js';
import type { SpawnRequest, SpawnResult, WorkerInfo } from './types.js';

export class AgentSpawner {
  private activeWorkers: Map<string, WorkerInfo> = new Map();
  private tmuxSession: string;

  constructor(
    private projectRoot: string,
    tmuxSession?: string
  ) {
    // Default session name based on project
    this.tmuxSession = tmuxSession || 'relay-workers';
  }

  /**
   * Ensure the worker tmux session exists
   */
  async ensureSession(): Promise<void> {
    try {
      await execAsync(`tmux has-session -t ${this.tmuxSession} 2>/dev/null`);
    } catch {
      // Session doesn't exist, create it
      await execAsync(
        `tmux new-session -d -s ${this.tmuxSession} -c "${this.projectRoot}"`
      );
      console.log(`[spawner] Created session ${this.tmuxSession}`);
    }
  }

  /**
   * Spawn a new worker agent
   */
  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    const { name, cli, task, requestedBy } = request;

    // Check if worker already exists
    if (this.activeWorkers.has(name)) {
      return {
        success: false,
        name,
        error: `Worker ${name} already exists`,
      };
    }

    try {
      await this.ensureSession();

      // Create new window for worker
      const windowName = name;
      await execAsync(
        `tmux new-window -t ${this.tmuxSession} -n ${windowName} -c "${this.projectRoot}"`
      );

      // Build the agent-relay command
      const cmd = `agent-relay -n ${name} ${cli}`;

      // Send the command
      await execAsync(
        `tmux send-keys -t ${this.tmuxSession}:${windowName} '${cmd}' Enter`
      );

      // Wait for agent to start
      await sleep(3000);

      // Inject the initial task
      const escapedTask = escapeForTmux(task);
      await execAsync(
        `tmux send-keys -t ${this.tmuxSession}:${windowName} -l "${escapedTask}"`
      );
      await sleep(100);
      await execAsync(
        `tmux send-keys -t ${this.tmuxSession}:${windowName} Enter`
      );

      // Track the worker
      const workerInfo: WorkerInfo = {
        name,
        cli,
        task,
        spawnedBy: requestedBy,
        spawnedAt: Date.now(),
        window: `${this.tmuxSession}:${windowName}`,
      };
      this.activeWorkers.set(name, workerInfo);

      console.log(`[spawner] Spawned ${name} (${cli}) for ${requestedBy}`);

      return {
        success: true,
        name,
        window: workerInfo.window,
      };
    } catch (err: any) {
      console.error(`[spawner] Failed to spawn ${name}:`, err.message);
      return {
        success: false,
        name,
        error: err.message,
      };
    }
  }

  /**
   * Release (terminate) a worker
   */
  async release(name: string): Promise<boolean> {
    const worker = this.activeWorkers.get(name);
    if (!worker) {
      console.log(`[spawner] Worker ${name} not found`);
      return false;
    }

    try {
      // Send exit command gracefully
      await execAsync(
        `tmux send-keys -t ${worker.window} '/exit' Enter`
      ).catch(() => {});

      // Wait a bit for graceful shutdown
      await sleep(2000);

      // Kill the window
      await execAsync(
        `tmux kill-window -t ${worker.window}`
      ).catch(() => {});

      this.activeWorkers.delete(name);
      console.log(`[spawner] Released ${name}`);

      return true;
    } catch (err: any) {
      console.error(`[spawner] Failed to release ${name}:`, err.message);
      // Still remove from tracking
      this.activeWorkers.delete(name);
      return false;
    }
  }

  /**
   * Release all workers
   */
  async releaseAll(): Promise<void> {
    const workers = Array.from(this.activeWorkers.keys());
    for (const name of workers) {
      await this.release(name);
    }
  }

  /**
   * Get all active workers
   */
  getActiveWorkers(): WorkerInfo[] {
    return Array.from(this.activeWorkers.values());
  }

  /**
   * Check if a worker exists
   */
  hasWorker(name: string): boolean {
    return this.activeWorkers.has(name);
  }

  /**
   * Get worker info
   */
  getWorker(name: string): WorkerInfo | undefined {
    return this.activeWorkers.get(name);
  }
}
