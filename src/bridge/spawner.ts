/**
 * Agent Spawner
 * Handles spawning and releasing worker agents via tmux.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execAsync, sleep, escapeForTmux } from './utils.js';
import { getProjectPaths } from '../utils/project-namespace.js';
import type { SpawnRequest, SpawnResult, WorkerInfo } from './types.js';

export class AgentSpawner {
  private activeWorkers: Map<string, WorkerInfo> = new Map();
  private tmuxSession: string;
  private agentsPath: string;

  constructor(
    projectRoot: string,
    tmuxSession?: string
  ) {
    const paths = getProjectPaths(projectRoot);
    this.projectRoot = paths.projectRoot;
    this.agentsPath = path.join(paths.teamDir, 'agents.json');

    // Default session name based on project
    this.tmuxSession = tmuxSession || 'relay-workers';
  }
  private projectRoot: string;

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
    const debug = process.env.DEBUG_SPAWN === '1';

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
      if (debug) console.log(`[spawner:debug] Session ${this.tmuxSession} ready`);

      // Create new window for worker
      const windowName = name;
      const newWindowCmd = `tmux new-window -t ${this.tmuxSession} -n ${windowName} -c "${this.projectRoot}"`;
      if (debug) console.log(`[spawner:debug] Creating window: ${newWindowCmd}`);
      await execAsync(newWindowCmd);

      // Build the agent-relay command
      // Unset TMUX to allow Claude to run inside tmux (it refuses to nest by default)
      // Use full path to agent-relay to avoid PATH issues with nvm/shell init
      let agentRelayPath: string;
      try {
        const { stdout } = await execAsync('which agent-relay');
        agentRelayPath = stdout.trim();
        if (debug) console.log(`[spawner:debug] Found agent-relay at: ${agentRelayPath}`);
      } catch {
        // Fallback to npx if which fails
        agentRelayPath = 'npx agent-relay';
        if (debug) console.log(`[spawner:debug] Using npx fallback`);
      }

      // Add --dangerously-skip-permissions for Claude agents to avoid permission dialogs
      const isClaudeCli = cli.startsWith('claude');
      const cliWithFlags = isClaudeCli ? `${cli} --dangerously-skip-permissions` : cli;
      const cmd = `unset TMUX && ${agentRelayPath} -n ${name} ${cliWithFlags}`;
      if (debug) console.log(`[spawner:debug] Agent command: ${cmd}`);

      // Send the command
      const sendCmd = `tmux send-keys -t ${this.tmuxSession}:${windowName} '${cmd}' Enter`;
      if (debug) console.log(`[spawner:debug] Sending: ${sendCmd}`);
      await execAsync(sendCmd);

      // Wait for the agent to register with the daemon before injecting tasks
      const registered = await this.waitForAgentRegistration(name, 30_000, 500);
      if (!registered) {
        const error = `Worker ${name} failed to register within 30s`;
        console.error(`[spawner] ${error}`);
        // Clean up the tmux window to avoid orphaned workers
        await execAsync(`tmux kill-window -t ${this.tmuxSession}:${windowName}`).catch(() => {});
        return {
          success: false,
          name,
          error,
        };
      }

      // Inject the initial task if provided
      if (task && task.trim()) {
        const escapedTask = escapeForTmux(task);
        if (debug) console.log(`[spawner:debug] Injecting task: ${escapedTask.substring(0, 50)}...`);
        await execAsync(
          `tmux send-keys -t ${this.tmuxSession}:${windowName} -l "${escapedTask}"`
        );
        await sleep(100);
        await execAsync(
          `tmux send-keys -t ${this.tmuxSession}:${windowName} Enter`
        );
      }

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
      if (debug) console.error(`[spawner:debug] Full error:`, err);
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

  /**
   * Wait for an agent to appear in the registry (agents.json)
   */
  private async waitForAgentRegistration(
    name: string,
    timeoutMs = 30_000,
    pollIntervalMs = 500
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (this.isAgentRegistered(name)) {
        return true;
      }

      await sleep(pollIntervalMs);
    }

    return false;
  }

  private isAgentRegistered(name: string): boolean {
    if (!this.agentsPath) return false;
    if (!fs.existsSync(this.agentsPath)) return false;

    try {
      const raw = JSON.parse(fs.readFileSync(this.agentsPath, 'utf-8'));
      const agents: Array<{ name?: string }> = Array.isArray(raw?.agents)
        ? raw.agents
        : raw?.agents && typeof raw.agents === 'object'
          ? Object.values(raw.agents)
          : [];

      return agents.some((a) => a?.name === name);
    } catch (err: any) {
      console.error('[spawner] Failed to read agents registry:', err.message);
      return false;
    }
  }
}
