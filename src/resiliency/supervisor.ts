/**
 * Agent Supervisor
 *
 * High-level supervisor that combines health monitoring, logging, and metrics
 * to provide comprehensive agent resiliency.
 */

import { EventEmitter } from 'events';
import { AgentHealthMonitor, getHealthMonitor, HealthMonitorConfig, AgentProcess, AgentHealth } from './health-monitor.js';
import { Logger, createLogger, LogLevel } from './logger.js';
import { metrics } from './metrics.js';
import { ContextPersistence, getContextPersistence } from './context-persistence.js';
import { createContextHandler, detectProvider, ProviderType } from './provider-context.js';
import { LeaderWatchdog } from './leader-watchdog.js';
import { StatelessLeadCoordinator, LeadHeartbeat } from './stateless-lead.js';

export interface SupervisedAgent {
  name: string;
  cli: string;
  task?: string;
  pid: number;
  logFile?: string;
  spawnedAt: Date;
  workingDir?: string;
  provider?: ProviderType;
}

export interface SupervisorConfig {
  healthCheck: Partial<HealthMonitorConfig>;
  logging: {
    level: LogLevel;
    file?: string;
  };
  autoRestart: boolean;
  maxRestarts: number;
  notifyOnCrash: boolean;
  contextPersistence: {
    enabled: boolean;
    baseDir?: string;
    autoInjectOnRestart: boolean;
  };
  /** Leader coordination (P0-P3) */
  leaderCoordination?: {
    enabled: boolean;
    /** Path to .beads directory */
    beadsDir: string;
    /** Callback to send relay messages */
    sendRelay?: (to: string, message: string) => Promise<void>;
  };
}

const DEFAULT_CONFIG: SupervisorConfig = {
  healthCheck: {
    checkIntervalMs: 5000,
    maxRestarts: 5,
  },
  logging: {
    level: 'info',
  },
  autoRestart: true,
  maxRestarts: 5,
  notifyOnCrash: true,
  contextPersistence: {
    enabled: true,
    autoInjectOnRestart: true,
  },
};

export class AgentSupervisor extends EventEmitter {
  private config: SupervisorConfig;
  private healthMonitor: AgentHealthMonitor;
  private logger: Logger;
  private agents = new Map<string, SupervisedAgent>();
  private restarters = new Map<string, () => Promise<void>>();
  private contextPersistence?: ContextPersistence;
  private contextHandlers = new Map<string, ReturnType<typeof createContextHandler>>();
  private leaderWatchdog?: LeaderWatchdog;
  private leadCoordinator?: StatelessLeadCoordinator;
  private supervisorAgentId: string;

  constructor(config: Partial<SupervisorConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.supervisorAgentId = `supervisor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    this.logger = createLogger('supervisor', {
      level: this.config.logging.level,
      file: this.config.logging.file,
    });

    this.healthMonitor = getHealthMonitor(this.config.healthCheck);
    this.setupHealthMonitorEvents();

    // Initialize context persistence if enabled
    if (this.config.contextPersistence.enabled) {
      this.contextPersistence = getContextPersistence(this.config.contextPersistence.baseDir);
      this.contextPersistence.startAutoSave();
      this.logger.info('Context persistence enabled');
    }
  }

  /**
   * Start supervising agents
   */
  start(): void {
    this.logger.info('Agent supervisor started', {
      autoRestart: this.config.autoRestart,
      maxRestarts: this.config.maxRestarts,
    });
    this.healthMonitor.start();
  }

  /**
   * Stop supervising agents
   */
  stop(): void {
    this.logger.info('Agent supervisor stopping');
    this.healthMonitor.stop();

    // Stop leader coordination
    if (this.leaderWatchdog) {
      this.leaderWatchdog.stop();
    }
    if (this.leadCoordinator) {
      this.leadCoordinator.stop().catch((err) => {
        this.logger.error('Error stopping lead coordinator', { error: String(err) });
      });
    }

    // Stop context persistence
    if (this.contextPersistence) {
      this.contextPersistence.stopAutoSave();
    }

    // Cleanup context handlers
    Array.from(this.contextHandlers.entries()).forEach(([name, handler]) => {
      handler.cleanup().catch((err: unknown) => {
        this.logger.error('Error cleaning up context handler', { name, error: String(err) });
      });
    });
  }

  /**
   * Enable leader coordination with watchdog
   * This allows this supervisor to participate in leader election and
   * potentially become the lead coordinator for task distribution.
   */
  enableLeaderCoordination(beadsDir: string, sendRelay: (to: string, message: string) => Promise<void>): void {
    if (this.leaderWatchdog) {
      this.logger.warn('Leader coordination already enabled');
      return;
    }

    this.logger.info('Enabling leader coordination', { beadsDir });

    // Create watchdog to monitor leader health
    this.leaderWatchdog = new LeaderWatchdog({
      beadsDir,
      agentName: 'supervisor',
      agentId: this.supervisorAgentId,
      checkIntervalMs: 5000,
      staleThresholdMs: 30000,
      onBecomeLeader: async () => {
        await this.becomeLeader(beadsDir, sendRelay);
      },
      getHealthyAgents: async () => {
        return this.getHealthyAgents();
      },
    });

    // Forward watchdog events
    this.leaderWatchdog.on('electionStarted', (data) => this.emit('electionStarted', data));
    this.leaderWatchdog.on('electionComplete', (data) => this.emit('electionComplete', data));
    this.leaderWatchdog.on('becameLeader', () => this.emit('becameLeader'));
    this.leaderWatchdog.on('leaderStale', (data) => this.emit('leaderStale', data));

    this.leaderWatchdog.start();
  }

  /**
   * Called when this supervisor wins leader election
   */
  private async becomeLeader(beadsDir: string, sendRelay: (to: string, message: string) => Promise<void>): Promise<void> {
    this.logger.info('This supervisor is becoming the lead coordinator');

    // Stop existing coordinator if any
    if (this.leadCoordinator) {
      await this.leadCoordinator.stop();
    }

    // Create stateless lead coordinator
    this.leadCoordinator = new StatelessLeadCoordinator({
      beadsDir,
      agentName: 'supervisor',
      agentId: this.supervisorAgentId,
      pollIntervalMs: 5000,
      heartbeatIntervalMs: 10000,
      leaseDurationMs: 300000,
      sendRelay,
      getAvailableWorkers: async () => {
        return this.getAvailableWorkerNames();
      },
    });

    // Forward coordinator events
    this.leadCoordinator.on('assigned', (data) => this.emit('taskAssigned', data));
    this.leadCoordinator.on('completed', (data) => this.emit('taskCompleted', data));

    await this.leadCoordinator.start();
  }

  /**
   * Get healthy agents for leader election
   */
  private getHealthyAgents(): Array<{ name: string; id: string; spawnedAt: Date }> {
    const healthyAgents: Array<{ name: string; id: string; spawnedAt: Date }> = [];

    for (const [name, agent] of this.agents) {
      const health = this.healthMonitor.get(name);
      if (health && health.status === 'healthy') {
        healthyAgents.push({
          name: agent.name,
          id: `${agent.name}-${agent.pid}`,
          spawnedAt: agent.spawnedAt,
        });
      }
    }

    // Include supervisor itself as a candidate
    healthyAgents.push({
      name: 'supervisor',
      id: this.supervisorAgentId,
      spawnedAt: new Date(0), // Supervisor is always oldest
    });

    return healthyAgents;
  }

  /**
   * Get available worker names (healthy agents not currently busy)
   */
  private getAvailableWorkerNames(): string[] {
    const available: string[] = [];

    for (const [name, agent] of this.agents) {
      const health = this.healthMonitor.get(name);
      if (health && health.status === 'healthy') {
        available.push(agent.name);
      }
    }

    return available;
  }

  /**
   * Check if this supervisor is currently the leader
   */
  isLeader(): boolean {
    return this.leaderWatchdog?.isCurrentLeader() ?? false;
  }

  /**
   * Get current leader info
   */
  getCurrentLeader(): LeadHeartbeat | null {
    return this.leaderWatchdog?.getCurrentLeader() ?? null;
  }

  /**
   * Add an agent to supervision
   */
  supervise(
    agent: SupervisedAgent,
    options: {
      isAlive: () => boolean;
      kill: (signal?: string) => void;
      restart: () => Promise<void>;
      sendHealthCheck?: () => Promise<boolean>;
    }
  ): void {
    this.agents.set(agent.name, agent);
    this.restarters.set(agent.name, options.restart);

    // Create agent process wrapper for health monitor
    const agentProcess: AgentProcess = {
      name: agent.name,
      pid: agent.pid,
      isAlive: options.isAlive,
      kill: options.kill,
      restart: async () => {
        if (this.config.autoRestart) {
          await options.restart();
          // Update PID after restart
          const updated = this.agents.get(agent.name);
          if (updated) {
            agentProcess.pid = updated.pid;
          }
        }
      },
      sendHealthCheck: options.sendHealthCheck,
    };

    this.healthMonitor.register(agentProcess);
    metrics.recordSpawn(agent.name);

    // Set up context persistence for this agent
    if (this.contextPersistence && this.config.contextPersistence.enabled) {
      const provider = agent.provider || detectProvider(agent.cli);
      const workingDir = agent.workingDir || process.cwd();

      // Initialize agent state
      this.contextPersistence.initAgent(agent.name, agent.cli, agent.task);

      // Create provider-specific context handler
      const contextHandler = createContextHandler({
        provider,
        workingDir,
        agentName: agent.name,
        task: agent.task,
      });

      contextHandler.setup().then(() => {
        this.contextHandlers.set(agent.name, contextHandler);

        // Check for existing handoff to restore
        const handoff = this.contextPersistence?.loadHandoff(agent.name);
        if (handoff && this.config.contextPersistence.autoInjectOnRestart) {
          contextHandler.injectContext(handoff).catch((err) => {
            this.logger.error('Failed to inject context on start', {
              name: agent.name,
              error: String(err),
            });
          });
        }
      }).catch((err) => {
        this.logger.error('Failed to setup context handler', {
          name: agent.name,
          provider,
          error: String(err),
        });
      });
    }

    this.logger.info('Agent added to supervision', {
      name: agent.name,
      cli: agent.cli,
      pid: agent.pid,
    });
  }

  /**
   * Remove an agent from supervision
   */
  unsupervise(name: string): void {
    this.agents.delete(name);
    this.restarters.delete(name);
    this.healthMonitor.unregister(name);

    // Clean up context handler
    const contextHandler = this.contextHandlers.get(name);
    if (contextHandler) {
      contextHandler.saveContext().then(() => {
        return contextHandler.cleanup();
      }).catch((err) => {
        this.logger.error('Error cleaning up context handler', { name, error: String(err) });
      });
      this.contextHandlers.delete(name);
    }

    this.logger.info('Agent removed from supervision', { name });
  }

  /**
   * Update agent info (e.g., after restart)
   */
  updateAgent(name: string, updates: Partial<SupervisedAgent>): void {
    const agent = this.agents.get(name);
    if (agent) {
      Object.assign(agent, updates);
    }
  }

  /**
   * Get all supervised agents
   */
  getAgents(): SupervisedAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get agent status
   */
  getStatus(name: string): {
    agent?: SupervisedAgent;
    health?: ReturnType<AgentHealthMonitor['get']>;
    metrics?: ReturnType<typeof metrics.getAgentMetrics>;
  } {
    return {
      agent: this.agents.get(name),
      health: this.healthMonitor.get(name),
      metrics: metrics.getAgentMetrics(name),
    };
  }

  /**
   * Get overall supervisor status
   */
  getOverallStatus(): {
    agents: SupervisedAgent[];
    health: ReturnType<AgentHealthMonitor['getAll']>;
    systemMetrics: ReturnType<typeof metrics.getSystemMetrics>;
  } {
    return {
      agents: this.getAgents(),
      health: this.healthMonitor.getAll(),
      systemMetrics: metrics.getSystemMetrics(),
    };
  }

  /**
   * Force restart an agent
   */
  async forceRestart(name: string): Promise<void> {
    const restarter = this.restarters.get(name);
    if (!restarter) {
      throw new Error(`Agent ${name} not found`);
    }

    this.logger.info('Force restarting agent', { name });
    metrics.recordRestartAttempt(name);

    try {
      await restarter();
      metrics.recordRestartSuccess(name);
      this.logger.info('Force restart successful', { name });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      metrics.recordRestartFailure(name, reason);
      this.logger.error('Force restart failed', { name, error: reason });
      throw error;
    }
  }

  /**
   * Setup event handlers for health monitor
   */
  private setupHealthMonitorEvents(): void {
    this.healthMonitor.on('healthy', ({ name, health }: { name: string; health: AgentHealth }) => {
      this.emit('healthy', { name, health });
    });

    this.healthMonitor.on('unhealthy', ({ name, health }: { name: string; health: AgentHealth }) => {
      this.logger.warn('Agent unhealthy', {
        name,
        consecutiveFailures: health.consecutiveFailures,
      });
      this.emit('unhealthy', { name, health });
    });

    this.healthMonitor.on('died', ({ name, reason, restartCount }: { name: string; reason: string; restartCount: number }) => {
      this.logger.error('Agent died', { name, reason, restartCount });
      metrics.recordCrash(name, reason);
      this.emit('died', { name, reason, restartCount });

      // Record crash in context persistence for resumption
      if (this.contextPersistence) {
        this.contextPersistence.recordCrash(name, reason);
      }

      if (this.config.notifyOnCrash) {
        this.notifyCrash(name, reason);
      }
    });

    this.healthMonitor.on('restarting', ({ name, attempt }: { name: string; attempt: number }) => {
      this.logger.info('Restarting agent', { name, attempt });
      metrics.recordRestartAttempt(name);

      // Save checkpoint before restart
      if (this.contextPersistence) {
        this.contextPersistence.checkpoint(name);
      }

      this.emit('restarting', { name, attempt });
    });

    this.healthMonitor.on('restarted', ({ name, pid, attempt }: { name: string; pid: number; attempt: number }) => {
      this.logger.info('Agent restarted', { name, pid, attempt });
      metrics.recordRestartSuccess(name);

      // Update our agent record
      const agent = this.agents.get(name);
      if (agent) {
        agent.pid = pid;
        agent.spawnedAt = new Date();
      }

      // Inject context on restart
      if (this.config.contextPersistence.autoInjectOnRestart) {
        const handoff = this.contextPersistence?.loadHandoff(name);
        const contextHandler = this.contextHandlers.get(name);
        if (handoff && contextHandler) {
          contextHandler.injectContext(handoff).catch((err: unknown) => {
            this.logger.error('Failed to inject context after restart', {
              name,
              error: String(err),
            });
          });
        }
      }

      this.emit('restarted', { name, pid, attempt });
    });

    this.healthMonitor.on('restartFailed', ({ name, error }: { name: string; error: string }) => {
      this.logger.error('Restart failed', { name, error });
      metrics.recordRestartFailure(name, error);
      this.emit('restartFailed', { name, error });
    });

    this.healthMonitor.on('permanentlyDead', ({ name, health }: { name: string; health: AgentHealth }) => {
      this.logger.fatal('Agent permanently dead', {
        name,
        restartCount: health.restartCount,
        lastError: health.lastError,
      });
      metrics.recordDead(name);
      this.emit('permanentlyDead', { name, health });

      if (this.config.notifyOnCrash) {
        this.notifyDead(name, health.lastError);
      }
    });

    this.healthMonitor.on('log', (entry) => {
      // Forward health monitor logs
      this.emit('log', entry);
    });
  }

  /**
   * Send notification about agent crash
   */
  private notifyCrash(name: string, reason: string): void {
    // In cloud deployment, this would send to a notification service
    // For now, just emit an event
    this.emit('notification', {
      type: 'crash',
      severity: 'warning',
      title: `Agent ${name} crashed`,
      message: reason,
      timestamp: new Date(),
    });
  }

  /**
   * Send notification about permanently dead agent
   */
  private notifyDead(name: string, reason?: string): void {
    this.emit('notification', {
      type: 'dead',
      severity: 'critical',
      title: `Agent ${name} is permanently dead`,
      message: reason || 'Exceeded max restart attempts',
      timestamp: new Date(),
    });
  }
}

// Singleton instance
let _supervisor: AgentSupervisor | null = null;

export function getSupervisor(config?: Partial<SupervisorConfig>): AgentSupervisor {
  if (!_supervisor) {
    _supervisor = new AgentSupervisor(config);
  }
  return _supervisor;
}
