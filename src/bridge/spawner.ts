/**
 * Agent Spawner
 * Handles spawning and releasing worker agents via node-pty.
 * Workers run headlessly with output capture for logs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './utils.js';
import { getProjectPaths } from '../utils/project-namespace.js';
import { PtyWrapper, type PtyWrapperConfig } from '../wrapper/pty-wrapper.js';
import type { SpawnRequest, SpawnResult, WorkerInfo } from './types.js';

/** Worker metadata stored in workers.json */
interface WorkerMeta {
  name: string;
  cli: string;
  task: string;
  spawnedBy: string;
  spawnedAt: number;
  pid?: number;
  logFile?: string;
}

interface ActiveWorker extends WorkerInfo {
  pty: PtyWrapper;
  logFile?: string;
}

export class AgentSpawner {
  private activeWorkers: Map<string, ActiveWorker> = new Map();
  private agentsPath: string;
  private projectRoot: string;
  private socketPath?: string;
  private logsDir: string;
  private workersPath: string;

  constructor(projectRoot: string, _tmuxSession?: string) {
    const paths = getProjectPaths(projectRoot);
    this.projectRoot = paths.projectRoot;
    this.agentsPath = path.join(paths.teamDir, 'agents.json');
    this.socketPath = paths.socketPath;
    this.logsDir = path.join(paths.teamDir, 'worker-logs');
    this.workersPath = path.join(paths.teamDir, 'workers.json');

    // Ensure logs directory exists
    fs.mkdirSync(this.logsDir, { recursive: true });
  }

  /**
   * Spawn a new worker agent using node-pty
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
      // Parse CLI command
      const cliParts = cli.split(' ');
      const command = cliParts[0];
      const args = cliParts.slice(1);

      // Add --dangerously-skip-permissions for Claude agents
      const isClaudeCli = command.startsWith('claude');
      if (isClaudeCli && !args.includes('--dangerously-skip-permissions')) {
        args.push('--dangerously-skip-permissions');
      }

      // Add --dangerously-bypass-approvals-and-sandbox for Codex agents
      const isCodexCli = command.startsWith('codex');
      if (isCodexCli && !args.includes('--dangerously-bypass-approvals-and-sandbox')) {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      }

      if (debug) console.log(`[spawner:debug] Spawning ${name} with: ${command} ${args.join(' ')}`);

      // Create PtyWrapper config
      const ptyConfig: PtyWrapperConfig = {
        name,
        command,
        args,
        socketPath: this.socketPath,
        cwd: this.projectRoot,
        logsDir: this.logsDir,
        onSpawn: async (workerName, workerCli, workerTask) => {
          // Handle nested spawn requests
          if (debug) console.log(`[spawner:debug] Nested spawn: ${workerName}`);
          await this.spawn({
            name: workerName,
            cli: workerCli,
            task: workerTask,
            requestedBy: name,
          });
        },
        onRelease: async (workerName) => {
          // Handle release requests from workers
          if (debug) console.log(`[spawner:debug] Release request: ${workerName}`);
          await this.release(workerName);
        },
        onExit: (code) => {
          if (debug) console.log(`[spawner:debug] Worker ${name} exited with code ${code}`);
          this.activeWorkers.delete(name);
          this.saveWorkersMetadata();
        },
      };

      // Create and start the pty wrapper
      const pty = new PtyWrapper(ptyConfig);
      await pty.start();

      if (debug) console.log(`[spawner:debug] PTY started, pid: ${pty.pid}`);

      // Wait for the agent to register with the daemon
      const registered = await this.waitForAgentRegistration(name, 30_000, 500);
      if (!registered) {
        const error = `Worker ${name} failed to register within 30s`;
        console.error(`[spawner] ${error}`);
        pty.kill();
        return {
          success: false,
          name,
          error,
        };
      }

      // Inject the initial task if provided
      if (task && task.trim()) {
        if (debug) console.log(`[spawner:debug] Injecting task: ${task.substring(0, 50)}...`);
        pty.write(task + '\r');
      }

      // Track the worker
      const workerInfo: ActiveWorker = {
        name,
        cli,
        task,
        spawnedBy: requestedBy,
        spawnedAt: Date.now(),
        pid: pty.pid,
        pty,
        logFile: pty.logPath,
      };
      this.activeWorkers.set(name, workerInfo);
      this.saveWorkersMetadata();

      console.log(`[spawner] Spawned ${name} (${cli}) for ${requestedBy} [pid: ${pty.pid}]`);

      return {
        success: true,
        name,
        pid: pty.pid,
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
      // Stop the pty process gracefully
      worker.pty.stop();

      // Wait for graceful shutdown
      await sleep(2000);

      // Force kill if still running
      if (worker.pty.isRunning) {
        worker.pty.kill();
      }

      this.activeWorkers.delete(name);
      this.saveWorkersMetadata();
      console.log(`[spawner] Released ${name}`);

      return true;
    } catch (err: any) {
      console.error(`[spawner] Failed to release ${name}:`, err.message);
      // Still remove from tracking
      this.activeWorkers.delete(name);
      this.saveWorkersMetadata();
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
   * Get all active workers (returns WorkerInfo without pty reference)
   */
  getActiveWorkers(): WorkerInfo[] {
    return Array.from(this.activeWorkers.values()).map((w) => ({
      name: w.name,
      cli: w.cli,
      task: w.task,
      spawnedBy: w.spawnedBy,
      spawnedAt: w.spawnedAt,
      pid: w.pid,
    }));
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
    const worker = this.activeWorkers.get(name);
    if (!worker) return undefined;
    return {
      name: worker.name,
      cli: worker.cli,
      task: worker.task,
      spawnedBy: worker.spawnedBy,
      spawnedAt: worker.spawnedAt,
      pid: worker.pid,
    };
  }

  /**
   * Get output logs from a worker
   */
  getWorkerOutput(name: string, limit?: number): string[] | null {
    const worker = this.activeWorkers.get(name);
    if (!worker) return null;
    return worker.pty.getOutput(limit);
  }

  /**
   * Get raw output from a worker
   */
  getWorkerRawOutput(name: string): string | null {
    const worker = this.activeWorkers.get(name);
    if (!worker) return null;
    return worker.pty.getRawOutput();
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

  /**
   * Save workers metadata to disk for CLI access
   */
  private saveWorkersMetadata(): void {
    try {
      const workers: WorkerMeta[] = Array.from(this.activeWorkers.values()).map((w) => ({
        name: w.name,
        cli: w.cli,
        task: w.task,
        spawnedBy: w.spawnedBy,
        spawnedAt: w.spawnedAt,
        pid: w.pid,
        logFile: w.logFile,
      }));

      fs.writeFileSync(this.workersPath, JSON.stringify({ workers }, null, 2));
    } catch (err: any) {
      console.error('[spawner] Failed to save workers metadata:', err.message);
    }
  }

  /**
   * Get path to logs directory
   */
  getLogsDir(): string {
    return this.logsDir;
  }

  /**
   * Get path to workers metadata file
   */
  getWorkersPath(): string {
    return this.workersPath;
  }
}

/**
 * Read workers metadata from disk (for CLI use)
 */
export function readWorkersMetadata(projectRoot: string): WorkerMeta[] {
  const paths = getProjectPaths(projectRoot);
  const workersPath = path.join(paths.teamDir, 'workers.json');

  if (!fs.existsSync(workersPath)) {
    return [];
  }

  try {
    const raw = JSON.parse(fs.readFileSync(workersPath, 'utf-8'));
    return Array.isArray(raw?.workers) ? raw.workers : [];
  } catch {
    return [];
  }
}

/**
 * Get the worker logs directory path
 */
export function getWorkerLogsDir(projectRoot: string): string {
  const paths = getProjectPaths(projectRoot);
  return path.join(paths.teamDir, 'worker-logs');
}
