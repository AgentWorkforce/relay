/**
 * Agent Supervisor
 *
 * High-level supervisor that combines health monitoring, logging, and metrics
 * to provide comprehensive agent resiliency.
 */

import { EventEmitter } from 'events';
import { AgentHealthMonitor, getHealthMonitor, HealthMonitorConfig, AgentProcess } from './health-monitor';
import { Logger, createLogger, LogLevel } from './logger';
import { metrics } from './metrics';

export interface SupervisedAgent {
  name: string;
  cli: string;
  task?: string;
  pid: number;
  logFile?: string;
  spawnedAt: Date;
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
};

export class AgentSupervisor extends EventEmitter {
  private config: SupervisorConfig;
  private healthMonitor: AgentHealthMonitor;
  private logger: Logger;
  private agents = new Map<string, SupervisedAgent>();
  private restarters = new Map<string, () => Promise<void>>();

  constructor(config: Partial<SupervisorConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.logger = createLogger('supervisor', {
      level: this.config.logging.level,
      file: this.config.logging.file,
    });

    this.healthMonitor = getHealthMonitor(this.config.healthCheck);
    this.setupHealthMonitorEvents();
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
    this.healthMonitor.on('healthy', ({ name, health }) => {
      this.emit('healthy', { name, health });
    });

    this.healthMonitor.on('unhealthy', ({ name, health }) => {
      this.logger.warn('Agent unhealthy', {
        name,
        consecutiveFailures: health.consecutiveFailures,
      });
      this.emit('unhealthy', { name, health });
    });

    this.healthMonitor.on('died', ({ name, reason, restartCount }) => {
      this.logger.error('Agent died', { name, reason, restartCount });
      metrics.recordCrash(name, reason);
      this.emit('died', { name, reason, restartCount });

      if (this.config.notifyOnCrash) {
        this.notifyCrash(name, reason);
      }
    });

    this.healthMonitor.on('restarting', ({ name, attempt }) => {
      this.logger.info('Restarting agent', { name, attempt });
      metrics.recordRestartAttempt(name);
      this.emit('restarting', { name, attempt });
    });

    this.healthMonitor.on('restarted', ({ name, pid, attempt }) => {
      this.logger.info('Agent restarted', { name, pid, attempt });
      metrics.recordRestartSuccess(name);

      // Update our agent record
      const agent = this.agents.get(name);
      if (agent) {
        agent.pid = pid;
        agent.spawnedAt = new Date();
      }

      this.emit('restarted', { name, pid, attempt });
    });

    this.healthMonitor.on('restartFailed', ({ name, error }) => {
      this.logger.error('Restart failed', { name, error });
      metrics.recordRestartFailure(name, error);
      this.emit('restartFailed', { name, error });
    });

    this.healthMonitor.on('permanentlyDead', ({ name, health }) => {
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
