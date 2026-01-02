/**
 * Agent Spawner
 * Handles spawning and releasing worker agents via node-pty.
 * Workers run headlessly with output capture for logs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './utils.js';
import { getProjectPaths } from '../utils/project-namespace.js';
import { resolveCommand } from '../utils/command-resolver.js';
import { PtyWrapper, type PtyWrapperConfig, type SummaryEvent, type SessionEndEvent } from '../wrapper/pty-wrapper.js';
import { selectShadowCli } from './shadow-cli.js';
import type {
  SpawnRequest,
  SpawnResult,
  WorkerInfo,
  SpawnWithShadowRequest,
  SpawnWithShadowResult,
  SpeakOnTrigger,
} from './types.js';

/**
 * Cloud persistence handler interface.
 * Implement this to persist agent session data to cloud storage.
 */
export interface CloudPersistenceHandler {
  onSummary: (agentName: string, event: SummaryEvent) => Promise<void>;
  onSessionEnd: (agentName: string, event: SessionEndEvent) => Promise<void>;
}

/** Worker metadata stored in workers.json */
interface WorkerMeta {
  name: string;
  cli: string;
  task: string;
  /** Optional team name this agent belongs to */
  team?: string;
  spawnedAt: number;
  pid?: number;
  logFile?: string;
}

/** Stored listener references for cleanup */
interface ListenerBindings {
  output?: (data: string) => void;
  summary?: (event: SummaryEvent) => void;
  sessionEnd?: (event: SessionEndEvent) => void;
}

interface ActiveWorker extends WorkerInfo {
  pty: PtyWrapper;
  logFile?: string;
  listeners?: ListenerBindings;
}

export class AgentSpawner {
  private activeWorkers: Map<string, ActiveWorker> = new Map();
  private agentsPath: string;
  private projectRoot: string;
  private socketPath?: string;
  private logsDir: string;
  private workersPath: string;
  private dashboardPort?: number;
  private cloudPersistence?: CloudPersistenceHandler;

  constructor(projectRoot: string, _tmuxSession?: string, dashboardPort?: number) {
    const paths = getProjectPaths(projectRoot);
    this.projectRoot = paths.projectRoot;
    this.agentsPath = path.join(paths.teamDir, 'agents.json');
    this.socketPath = paths.socketPath;
    this.logsDir = path.join(paths.teamDir, 'worker-logs');
    this.workersPath = path.join(paths.teamDir, 'workers.json');
    this.dashboardPort = dashboardPort;

    // Ensure logs directory exists
    fs.mkdirSync(this.logsDir, { recursive: true });
  }

  /**
   * Set the dashboard port (for nested spawn API calls).
   * Called after the dashboard server starts and we know the actual port.
   */
  setDashboardPort(port: number): void {
    this.dashboardPort = port;
  }

  /**
   * Set cloud persistence handler for forwarding PtyWrapper events.
   * When set, 'summary' and 'session-end' events from spawned agents
   * are forwarded to the handler for cloud persistence (PostgreSQL/Redis).
   *
   * Note: Enable via RELAY_CLOUD_ENABLED=true environment variable.
   */
  setCloudPersistence(handler: CloudPersistenceHandler): void {
    this.cloudPersistence = handler;
    console.log('[spawner] Cloud persistence handler set');
  }

  /**
   * Bind cloud persistence event handlers to a PtyWrapper.
   * Returns the listener references for cleanup.
   */
  private bindCloudPersistenceEvents(name: string, pty: PtyWrapper): Partial<ListenerBindings> {
    if (!this.cloudPersistence) return {};

    const summaryListener = async (event: SummaryEvent) => {
      try {
        await this.cloudPersistence!.onSummary(name, event);
      } catch (err) {
        console.error(`[spawner] Cloud persistence summary error for ${name}:`, err);
      }
    };

    const sessionEndListener = async (event: SessionEndEvent) => {
      try {
        await this.cloudPersistence!.onSessionEnd(name, event);
      } catch (err) {
        console.error(`[spawner] Cloud persistence session-end error for ${name}:`, err);
      }
    };

    pty.on('summary', summaryListener);
    pty.on('session-end', sessionEndListener);

    return { summary: summaryListener, sessionEnd: sessionEndListener };
  }

  /**
   * Unbind all tracked listeners from a PtyWrapper.
   */
  private unbindListeners(pty: PtyWrapper, listeners?: ListenerBindings): void {
    if (!listeners) return;

    if (listeners.output) {
      pty.off('output', listeners.output);
    }
    if (listeners.summary) {
      pty.off('summary', listeners.summary);
    }
    if (listeners.sessionEnd) {
      pty.off('session-end', listeners.sessionEnd);
    }
  }

  /**
   * Spawn a new worker agent using node-pty
   */
  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    const { name, cli, task, team } = request;
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
      const commandName = cliParts[0];
      const args = cliParts.slice(1);

      // Resolve full path to avoid posix_spawnp failures
      const command = resolveCommand(commandName);
      console.log(`[spawner] Resolved '${commandName}' -> '${command}'`);
      if (command === commandName && !commandName.startsWith('/')) {
        // Command wasn't resolved - it might not exist
        console.warn(`[spawner] Warning: Could not resolve path for '${commandName}', spawn may fail`);
      }

      // Add --dangerously-skip-permissions for Claude agents
      const isClaudeCli = commandName.startsWith('claude');
      if (isClaudeCli && !args.includes('--dangerously-skip-permissions')) {
        args.push('--dangerously-skip-permissions');
      }

      // Add --dangerously-bypass-approvals-and-sandbox for Codex agents
      const isCodexCli = commandName.startsWith('codex');
      if (isCodexCli && !args.includes('--dangerously-bypass-approvals-and-sandbox')) {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      }

      if (debug) console.log(`[spawner:debug] Spawning ${name} with: ${command} ${args.join(' ')}`);

      // Create PtyWrapper config
      // Use dashboardPort for nested spawns (API-based, works in non-TTY contexts)
      // Fall back to callbacks only if no dashboardPort is set
      const ptyConfig: PtyWrapperConfig = {
        name,
        command,
        args,
        socketPath: this.socketPath,
        cwd: this.projectRoot,
        logsDir: this.logsDir,
        dashboardPort: this.dashboardPort,
        // Shadow agent configuration
        shadowOf: request.shadowOf,
        shadowSpeakOn: request.shadowSpeakOn,
        // Only use callbacks if dashboardPort is not set (for backwards compatibility)
        onSpawn: this.dashboardPort ? undefined : async (workerName, workerCli, workerTask) => {
          // Handle nested spawn requests (legacy path, may fail in non-TTY)
          if (debug) console.log(`[spawner:debug] Nested spawn: ${workerName}`);
          await this.spawn({
            name: workerName,
            cli: workerCli,
            task: workerTask,
            // Nested spawns don't inherit team - they're flat by default
          });
        },
        onRelease: this.dashboardPort ? undefined : async (workerName) => {
          // Handle release requests from workers (legacy path)
          if (debug) console.log(`[spawner:debug] Release request: ${workerName}`);
          await this.release(workerName);
        },
        onExit: (code) => {
          if (debug) console.log(`[spawner:debug] Worker ${name} exited with code ${code}`);
          // Clean up listeners before removing from tracking
          const worker = this.activeWorkers.get(name);
          if (worker?.listeners) {
            this.unbindListeners(worker.pty, worker.listeners);
          }
          this.activeWorkers.delete(name);
          try {
            this.saveWorkersMetadata();
          } catch (err) {
            console.error(`[spawner] Failed to save metadata on exit:`, err);
          }
        },
      };

      // Create and start the pty wrapper
      const pty = new PtyWrapper(ptyConfig);

      // Track listener references for proper cleanup
      const listeners: ListenerBindings = {};

      // Hook up output events for live log streaming
      const outputListener = (data: string) => {
        // Broadcast to any connected WebSocket clients via global function
        const broadcast = (global as any).__broadcastLogOutput;
        if (broadcast) {
          broadcast(name, data);
        }
      };
      pty.on('output', outputListener);
      listeners.output = outputListener;

      // Bind cloud persistence events (if enabled) and store references
      const cloudListeners = this.bindCloudPersistenceEvents(name, pty);
      if (cloudListeners.summary) listeners.summary = cloudListeners.summary;
      if (cloudListeners.sessionEnd) listeners.sessionEnd = cloudListeners.sessionEnd;

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

      // Send task via relay message if provided (not via direct PTY injection)
      // This ensures the agent is ready to receive before processing the task
      if (task && task.trim()) {
        if (debug) console.log(`[spawner:debug] Will send task via relay: ${task.substring(0, 50)}...`);

        // If we have dashboard API, send task as relay message
        if (this.dashboardPort) {
          // Wait a moment for the agent's relay client to be ready
          await sleep(1000);
          try {
            const response = await fetch(`http://localhost:${this.dashboardPort}/api/send`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                to: name,
                message: task,
                from: '__spawner__',
              }),
            });
            const result = await response.json() as { success: boolean; error?: string };
            if (result.success) {
              if (debug) console.log(`[spawner:debug] Task sent via relay to ${name}`);
            } else {
              console.warn(`[spawner] Failed to send task via relay: ${result.error}`);
              // Fall back to direct injection
              pty.write(task + '\r');
            }
          } catch (err: any) {
            console.warn(`[spawner] Relay send failed, falling back to direct injection: ${err.message}`);
            pty.write(task + '\r');
          }
        } else {
          // No dashboard API available - use direct injection as fallback
          if (debug) console.log(`[spawner:debug] No dashboard API, using direct injection`);
          pty.write(task + '\r');
        }
      }

      // Track the worker
      const workerInfo: ActiveWorker = {
        name,
        cli,
        task,
        team,
        spawnedAt: Date.now(),
        pid: pty.pid,
        pty,
        logFile: pty.logPath,
        listeners, // Store for cleanup
      };
      this.activeWorkers.set(name, workerInfo);
      this.saveWorkersMetadata();

      const teamInfo = team ? ` [team: ${team}]` : '';
      const shadowInfo = request.shadowOf ? ` [shadow of: ${request.shadowOf}]` : '';
      console.log(`[spawner] Spawned ${name} (${cli})${teamInfo}${shadowInfo} [pid: ${pty.pid}]`);

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

  /** Role presets for shadow agents */
  private static readonly ROLE_PRESETS: Record<string, SpeakOnTrigger[]> = {
    reviewer: ['CODE_WRITTEN', 'REVIEW_REQUEST', 'EXPLICIT_ASK'],
    auditor: ['SESSION_END', 'EXPLICIT_ASK'],
    active: ['ALL_MESSAGES'],
  };

  /**
   * Spawn a primary agent with its shadow agent
   *
   * Example usage:
   * ```ts
   * const result = await spawner.spawnWithShadow({
   *   primary: { name: 'Lead', command: 'claude', task: 'Implement feature X' },
   *   shadow: { name: 'Auditor', role: 'reviewer', speakOn: ['CODE_WRITTEN'] }
   * });
   * ```
   */
  async spawnWithShadow(request: SpawnWithShadowRequest): Promise<SpawnWithShadowResult> {
    const { primary, shadow } = request;
    const debug = process.env.DEBUG_SPAWN === '1';

    // Resolve shadow speakOn triggers
    let speakOn: SpeakOnTrigger[] = ['EXPLICIT_ASK']; // Default

    // Check for role preset
    if (shadow.role && AgentSpawner.ROLE_PRESETS[shadow.role.toLowerCase()]) {
      speakOn = AgentSpawner.ROLE_PRESETS[shadow.role.toLowerCase()];
    }

    // Override with explicit speakOn if provided
    if (shadow.speakOn && shadow.speakOn.length > 0) {
      speakOn = shadow.speakOn;
    }

    // Build shadow task prompt
    const defaultPrompt = `You are a shadow agent monitoring "${primary.name}". You receive copies of their messages. Your role: ${shadow.role || 'observer'}. Stay passive unless your triggers activate: ${speakOn.join(', ')}.`;
    const shadowTask = shadow.prompt || defaultPrompt;

    // Decide how to run the shadow (subagent for Claude/OpenCode primaries, process fallback otherwise)
    let shadowSelection: Awaited<ReturnType<typeof selectShadowCli>> | null = null;
    try {
      shadowSelection = await selectShadowCli(primary.command || 'claude', {
        preferredShadowCli: shadow.command,
      });
    } catch (err: any) {
      console.warn(`[spawner] Shadow CLI selection failed for ${shadow.name}: ${err.message}`);
    }

    if (debug) {
      const mode = shadowSelection?.mode ?? 'unknown';
      const cli = shadowSelection?.command ?? shadow.command ?? primary.command ?? 'claude';
      console.log(
        `[spawner] spawnWithShadow: primary=${primary.name}, shadow=${shadow.name}, mode=${mode}, cli=${cli}, speakOn=${speakOn.join(',')}`
      );
    }

    // Step 1: Spawn primary agent
    const primaryResult = await this.spawn({
      name: primary.name,
      cli: primary.command || 'claude',
      task: primary.task || '',
      team: primary.team,
    });

    if (!primaryResult.success) {
      return {
        success: false,
        primary: primaryResult,
        error: `Failed to spawn primary agent: ${primaryResult.error}`,
      };
    }

    // Step 2: Wait for primary to register before spawning shadow
    // The spawn() method already waits, but we add a small delay for stability
    await sleep(1000);

    // Subagent mode: no separate process needed
    if (shadowSelection?.mode === 'subagent') {
      console.log(
        `[spawner] Shadow ${shadow.name} will run as ${shadowSelection.cli} subagent inside ${primary.name} (no separate process)`
      );
      return {
        success: true,
        primary: primaryResult,
        shadow: {
          success: true,
          name: shadow.name,
        },
      };
    }

    // No available shadow CLI - proceed without spawning a shadow process
    if (!shadowSelection) {
      console.warn(`[spawner] No authenticated shadow CLI available; ${primary.name} will run without a shadow`);
      return {
        success: true,
        primary: primaryResult,
        error: 'Shadow spawn skipped: no authenticated shadow CLI available',
      };
    }

    // Step 3: Spawn shadow agent with shadowOf and shadowSpeakOn
    const shadowResult = await this.spawn({
      name: shadow.name,
      // Use the selected/validated CLI for process-mode shadows
      cli: shadowSelection.command || shadow.command || primary.command || 'claude',
      task: shadowTask,
      shadowOf: primary.name,
      shadowSpeakOn: speakOn,
    });

    if (!shadowResult.success) {
      console.warn(`[spawner] Shadow agent ${shadow.name} failed to spawn, primary ${primary.name} continues without shadow`);
      return {
        success: true, // Primary succeeded, overall operation is partial success
        primary: primaryResult,
        shadow: shadowResult,
        error: `Shadow spawn failed: ${shadowResult.error}`,
      };
    }

    console.log(`[spawner] Spawned pair: ${primary.name} with shadow ${shadow.name} (speakOn: ${speakOn.join(',')})`);

    return {
      success: true,
      primary: primaryResult,
      shadow: shadowResult,
    };
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
      // Unbind all listeners first to prevent memory leaks
      this.unbindListeners(worker.pty, worker.listeners);

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
      // Still unbind and remove from tracking
      this.unbindListeners(worker.pty, worker.listeners);
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
      team: w.team,
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
      team: worker.team,
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
        team: w.team,
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
