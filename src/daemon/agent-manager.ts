/**
 * Agent Manager
 * Manages agents across workspaces with integrated resiliency.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { createLogger } from '../resiliency/logger.js';
import { getSupervisor } from '../resiliency/supervisor.js';
import { detectProvider } from '../resiliency/provider-context.js';
import { PtyWrapper, type PtyWrapperConfig, type SummaryEvent, type SessionEndEvent } from '../wrapper/pty-wrapper.js';
import { resolveCommand } from '../utils/command-resolver.js';
import type {
  Agent,
  ProviderType,
  DaemonEvent,
  SpawnAgentRequest,
} from './types.js';

/**
 * Optional cloud persistence handler.
 * When set, agent-manager forwards PtyWrapper events to this handler.
 */
export interface CloudPersistenceHandler {
  onSummary: (agentId: string, event: SummaryEvent) => Promise<void>;
  onSessionEnd: (agentId: string, event: SessionEndEvent) => Promise<void>;
  /** Optional cleanup method for tests and graceful shutdown */
  destroy?: () => void;
}

const logger = createLogger('agent-manager');

function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

interface ManagedAgent extends Agent {
  pty?: PtyWrapper;
}

export class AgentManager extends EventEmitter {
  private agents = new Map<string, ManagedAgent>();
  private supervisor = getSupervisor({
    autoRestart: true,
    maxRestarts: 5,
    contextPersistence: {
      enabled: true,
      autoInjectOnRestart: true,
    },
  });
  private dataDir: string;
  private logsDir: string;
  private cloudPersistence?: CloudPersistenceHandler;

  constructor(dataDir: string) {
    super();
    this.dataDir = dataDir;
    this.logsDir = path.join(dataDir, 'logs');

    // Ensure directories exist
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }

    // Setup supervisor event handlers
    this.setupSupervisorEvents();

    // Start supervisor
    this.supervisor.start();

    logger.info('Agent manager initialized');
  }

  /**
   * Set cloud persistence handler for forwarding PtyWrapper events.
   * When set, 'summary' and 'session-end' events from agents are forwarded
   * to the handler for cloud persistence (PostgreSQL/Redis).
   */
  setCloudPersistence(handler: CloudPersistenceHandler): void {
    this.cloudPersistence = handler;
    logger.info('Cloud persistence handler set');
  }

  /**
   * Spawn a new agent in a workspace
   */
  async spawn(
    workspaceId: string,
    workspacePath: string,
    request: SpawnAgentRequest
  ): Promise<Agent> {
    const { name, task } = request;

    // Check if agent already exists
    const existing = this.findByName(workspaceId, name);
    if (existing) {
      throw new Error(`Agent ${name} already exists in workspace`);
    }

    // Determine provider and CLI
    const provider = request.provider || detectProvider(name);
    const cli = this.getCliCommand(provider);

    logger.info('Spawning agent', { name, workspaceId, provider, cli });

    try {
      // Parse CLI command
      const cliParts = cli.split(' ');
      const commandName = cliParts[0];
      const args = [...cliParts.slice(1)];

      // Resolve full path
      const command = resolveCommand(commandName);

      // Add required flags for non-interactive mode
      if (provider === 'claude' && !args.includes('--dangerously-skip-permissions')) {
        args.push('--dangerously-skip-permissions');
      }
      if (provider === 'codex' && !args.includes('--dangerously-bypass-approvals-and-sandbox')) {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      }

      // Create agent record
      const agent: ManagedAgent = {
        id: generateId(),
        name,
        workspaceId,
        provider,
        status: 'running',
        spawnedAt: new Date(),
        restartCount: 0,
        task,
        logFile: path.join(this.logsDir, `${name}-${Date.now()}.log`),
      };

      // Create PTY config
      const ptyConfig: PtyWrapperConfig = {
        name,
        command,
        args,
        cwd: workspacePath,
        logsDir: this.logsDir,
        onExit: (code) => {
          logger.info('Agent process exited', { name, code });
          this.handleAgentExit(agent.id, code);
        },
      };

      // Create and start PTY
      const pty = new PtyWrapper(ptyConfig);
      await pty.start();

      agent.pid = pty.pid;
      agent.pty = pty;

      // Subscribe to PtyWrapper events for cloud persistence
      this.bindPtyEvents(agent.id, pty);

      // Inject initial task
      if (task && task.trim()) {
        pty.write(task + '\r');
      }

      // Track agent
      this.agents.set(agent.id, agent);

      // Add to supervisor for health monitoring
      this.supervisor.supervise(
        {
          name: agent.name,
          cli,
          task,
          pid: agent.pid!,
          spawnedAt: agent.spawnedAt,
          workingDir: workspacePath,
          provider,
        },
        {
          isAlive: () => {
            try {
              process.kill(agent.pid!, 0);
              return true;
            } catch {
              return false;
            }
          },
          kill: (signal) => {
            try {
              process.kill(agent.pid!, signal);
            } catch {
              // Already dead
            }
          },
          restart: async () => {
            await this.restartAgent(agent.id, workspacePath);
          },
        }
      );

      logger.info('Agent spawned', { id: agent.id, name, pid: agent.pid });

      this.emitEvent({
        type: 'agent:spawned',
        workspaceId,
        agentId: agent.id,
        data: this.toPublicAgent(agent),
        timestamp: new Date(),
      });

      return this.toPublicAgent(agent);
    } catch (err) {
      logger.error('Failed to spawn agent', { name, error: String(err) });
      throw err;
    }
  }

  /**
   * Stop an agent
   */
  async stop(agentId: string): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return false;
    }

    logger.info('Stopping agent', { id: agentId, name: agent.name });

    try {
      // Remove from supervisor
      this.supervisor.unsupervise(agent.name);

      // Stop PTY (handles auto-save internally)
      if (agent.pty) {
        await agent.pty.stop();

        // Force kill if still running
        if (agent.pty.isRunning) {
          await agent.pty.kill();
        }
      }

      agent.status = 'stopped';
      this.agents.delete(agentId);

      this.emitEvent({
        type: 'agent:stopped',
        workspaceId: agent.workspaceId,
        agentId,
        data: { name: agent.name },
        timestamp: new Date(),
      });

      return true;
    } catch (err) {
      logger.error('Failed to stop agent', { id: agentId, error: String(err) });
      return false;
    }
  }

  /**
   * Stop all agents in a workspace
   */
  async stopAllInWorkspace(workspaceId: string): Promise<void> {
    const agents = this.getByWorkspace(workspaceId);
    for (const agent of agents) {
      await this.stop(agent.id);
    }
  }

  /**
   * Stop all agents
   */
  async stopAll(): Promise<void> {
    const agentIds = Array.from(this.agents.keys());
    for (const id of agentIds) {
      await this.stop(id);
    }
  }

  /**
   * Get an agent by ID
   */
  get(agentId: string): Agent | undefined {
    const agent = this.agents.get(agentId);
    return agent ? this.toPublicAgent(agent) : undefined;
  }

  /**
   * Get all agents in a workspace
   */
  getByWorkspace(workspaceId: string): Agent[] {
    return Array.from(this.agents.values())
      .filter((a) => a.workspaceId === workspaceId)
      .map((a) => this.toPublicAgent(a));
  }

  /**
   * Get all agents
   */
  getAll(): Agent[] {
    return Array.from(this.agents.values()).map((a) => this.toPublicAgent(a));
  }

  /**
   * Find agent by name in a workspace
   */
  findByName(workspaceId: string, name: string): Agent | undefined {
    const agent = Array.from(this.agents.values()).find(
      (a) => a.workspaceId === workspaceId && a.name === name
    );
    return agent ? this.toPublicAgent(agent) : undefined;
  }

  /**
   * Get agent output/logs
   */
  getOutput(agentId: string, limit?: number): string[] | null {
    const agent = this.agents.get(agentId);
    if (!agent?.pty) return null;
    return agent.pty.getOutput(limit);
  }

  /**
   * Get raw output from agent
   */
  getRawOutput(agentId: string): string | null {
    const agent = this.agents.get(agentId);
    if (!agent?.pty) return null;
    return agent.pty.getRawOutput();
  }

  /**
   * Send input to an agent
   */
  sendInput(agentId: string, input: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent?.pty) return false;
    agent.pty.write(input);
    return true;
  }

  /**
   * Restart an agent
   */
  private async restartAgent(agentId: string, workspacePath: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    logger.info('Restarting agent', { id: agentId, name: agent.name });

    agent.status = 'restarting';
    agent.restartCount++;

    try {
      // Get CLI command
      const cli = this.getCliCommand(agent.provider);
      const cliParts = cli.split(' ');
      const command = resolveCommand(cliParts[0]);
      const args = [...cliParts.slice(1)];

      if (agent.provider === 'claude' && !args.includes('--dangerously-skip-permissions')) {
        args.push('--dangerously-skip-permissions');
      }
      if (agent.provider === 'codex' && !args.includes('--dangerously-bypass-approvals-and-sandbox')) {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      }

      // Create new PTY
      const ptyConfig: PtyWrapperConfig = {
        name: agent.name,
        command,
        args,
        cwd: workspacePath,
        logsDir: this.logsDir,
        onExit: (code) => {
          this.handleAgentExit(agent.id, code);
        },
      };

      const pty = new PtyWrapper(ptyConfig);
      await pty.start();

      agent.pid = pty.pid;
      agent.pty = pty;
      agent.status = 'running';
      agent.spawnedAt = new Date();

      // Re-bind events for the new PTY
      this.bindPtyEvents(agent.id, pty);

      logger.info('Agent restarted', { id: agentId, name: agent.name, pid: agent.pid });

      this.emitEvent({
        type: 'agent:restarted',
        workspaceId: agent.workspaceId,
        agentId,
        data: { name: agent.name, restartCount: agent.restartCount },
        timestamp: new Date(),
      });
    } catch (err) {
      logger.error('Failed to restart agent', { id: agentId, error: String(err) });
      agent.status = 'crashed';
    }
  }

  /**
   * Handle agent exit
   */
  private handleAgentExit(agentId: string, code: number | null): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    if (agent.status === 'running') {
      agent.status = code === 0 ? 'stopped' : 'crashed';

      if (agent.status === 'crashed') {
        // Get the continuity agentId for resume info
        const continuityAgentId = agent.agentId ?? agent.pty?.getAgentId();

        this.emitEvent({
          type: 'agent:crashed',
          workspaceId: agent.workspaceId,
          agentId,
          data: {
            name: agent.name,
            exitCode: code,
            continuityAgentId,
            resumeInstructions: continuityAgentId
              ? `To resume this agent's work, use: --resume ${continuityAgentId}`
              : undefined,
          },
          timestamp: new Date(),
        });
      }
    }
  }

  /**
   * Bind PtyWrapper events to cloud persistence and daemon events.
   *
   * Events bound:
   * - 'summary': Agent output a [[SUMMARY]] block
   * - 'session-end': Agent output a [[SESSION_END]] block
   * - 'injection-failed': Message injection failed after retries
   */
  private bindPtyEvents(agentId: string, pty: PtyWrapper): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Forward summary events
    pty.on('summary', async (event: SummaryEvent) => {
      logger.info('Agent summary', {
        agentId,
        name: event.agentName,
        task: event.summary.currentTask,
      });

      // Emit daemon event
      this.emitEvent({
        type: 'agent:summary',
        workspaceId: agent.workspaceId,
        agentId,
        data: { summary: event.summary },
        timestamp: new Date(),
      });

      // Forward to cloud persistence if configured
      if (this.cloudPersistence) {
        try {
          await this.cloudPersistence.onSummary(agentId, event);
        } catch (err) {
          logger.error('Cloud persistence failed for summary', { agentId, error: String(err) });
        }
      }
    });

    // Forward session-end events
    pty.on('session-end', async (event: SessionEndEvent) => {
      logger.info('Agent session ended', {
        agentId,
        name: event.agentName,
        summary: event.marker.summary,
      });

      // Emit daemon event
      this.emitEvent({
        type: 'agent:session-end',
        workspaceId: agent.workspaceId,
        agentId,
        data: { marker: event.marker },
        timestamp: new Date(),
      });

      // Forward to cloud persistence if configured
      if (this.cloudPersistence) {
        try {
          await this.cloudPersistence.onSessionEnd(agentId, event);
        } catch (err) {
          logger.error('Cloud persistence failed for session-end', { agentId, error: String(err) });
        }
      }
    });

    // Log injection failures
    pty.on('injection-failed', (event) => {
      logger.warn('Message injection failed', {
        agentId,
        messageId: event.messageId,
        from: event.from,
        attempts: event.attempts,
      });

      this.emitEvent({
        type: 'agent:injection-failed',
        workspaceId: agent.workspaceId,
        agentId,
        data: event,
        timestamp: new Date(),
      });
    });
  }

  /**
   * Setup supervisor event handlers
   */
  private setupSupervisorEvents(): void {
    this.supervisor.on('died', ({ name, reason }) => {
      logger.warn('Agent died (supervisor)', { name, reason });
    });

    this.supervisor.on('restarted', ({ name, pid }) => {
      logger.info('Agent restarted (supervisor)', { name, pid });
    });

    this.supervisor.on('permanentlyDead', ({ name }) => {
      logger.error('Agent permanently dead', { name });
      // Find and update agent status
      const agent = Array.from(this.agents.values()).find((a) => a.name === name);
      if (agent) {
        agent.status = 'crashed';
      }
    });
  }

  /**
   * Get CLI command for provider
   */
  private getCliCommand(provider: ProviderType): string {
    switch (provider) {
      case 'claude':
        return 'claude';
      case 'codex':
        return 'codex';
      case 'gemini':
        return 'gemini';
      default:
        return 'claude';
    }
  }

  /**
   * Convert internal agent to public agent (without pty reference)
   */
  private toPublicAgent(agent: ManagedAgent): Agent {
    return {
      id: agent.id,
      name: agent.name,
      workspaceId: agent.workspaceId,
      provider: agent.provider,
      status: agent.status,
      pid: agent.pid,
      task: agent.task,
      spawnedAt: agent.spawnedAt,
      lastHealthCheck: agent.lastHealthCheck,
      restartCount: agent.restartCount,
      logFile: agent.logFile,
      agentId: agent.agentId ?? agent.pty?.getAgentId(),
    };
  }

  /**
   * Emit a daemon event
   */
  private emitEvent(event: DaemonEvent): void {
    this.emit('event', event);
  }

  /**
   * Shutdown the agent manager
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down agent manager');
    await this.stopAll();
    this.supervisor.stop();
  }
}

let agentManagerInstance: AgentManager | undefined;

export function getAgentManager(dataDir?: string): AgentManager {
  if (!agentManagerInstance) {
    const dir = dataDir || path.join(process.env.HOME || '', '.agent-relay', 'daemon');
    agentManagerInstance = new AgentManager(dir);
  }
  return agentManagerInstance;
}
