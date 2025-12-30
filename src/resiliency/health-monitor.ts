/**
 * Agent Health Monitor
 *
 * Monitors spawned agent processes and ensures they stay alive.
 * - Periodic health checks (process liveness)
 * - Auto-restart on crash
 * - Death detection and logging
 * - Metrics collection
 */

import { EventEmitter } from 'events';

export interface AgentHealth {
  name: string;
  pid: number;
  status: 'healthy' | 'unresponsive' | 'dead' | 'restarting';
  lastHealthCheck: Date;
  lastResponse: Date;
  restartCount: number;
  consecutiveFailures: number;
  uptime: number; // ms
  startedAt: Date;
  memoryUsage?: number;
  cpuUsage?: number;
  lastError?: string;
}

export interface HealthMonitorConfig {
  checkIntervalMs: number; // How often to check health (default: 5000)
  responseTimeoutMs: number; // Max time to wait for response (default: 10000)
  maxRestarts: number; // Max restarts before giving up (default: 5)
  restartCooldownMs: number; // Time between restarts (default: 2000)
  maxConsecutiveFailures: number; // Failures before marking dead (default: 3)
}

export interface AgentProcess {
  name: string;
  pid: number;
  isAlive: () => boolean;
  kill: (signal?: string) => void;
  restart: () => Promise<void>;
  sendHealthCheck?: () => Promise<boolean>;
}

const DEFAULT_CONFIG: HealthMonitorConfig = {
  checkIntervalMs: 5000,
  responseTimeoutMs: 10000,
  maxRestarts: 5,
  restartCooldownMs: 2000,
  maxConsecutiveFailures: 3,
};

export class AgentHealthMonitor extends EventEmitter {
  private agents = new Map<string, AgentProcess>();
  private health = new Map<string, AgentHealth>();
  private intervalId?: ReturnType<typeof setInterval>;
  private config: HealthMonitorConfig;
  private isRunning = false;

  constructor(config: Partial<HealthMonitorConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register an agent for health monitoring
   */
  register(agent: AgentProcess): void {
    this.agents.set(agent.name, agent);
    this.health.set(agent.name, {
      name: agent.name,
      pid: agent.pid,
      status: 'healthy',
      lastHealthCheck: new Date(),
      lastResponse: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
      uptime: 0,
      startedAt: new Date(),
    });

    this.emit('registered', { name: agent.name, pid: agent.pid });
    this.log('info', `Registered agent for health monitoring: ${agent.name} (PID: ${agent.pid})`);
  }

  /**
   * Unregister an agent from health monitoring
   */
  unregister(name: string): void {
    this.agents.delete(name);
    this.health.delete(name);
    this.emit('unregistered', { name });
    this.log('info', `Unregistered agent: ${name}`);
  }

  /**
   * Start the health monitoring loop
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.log('info', 'Health monitor started', {
      checkInterval: this.config.checkIntervalMs,
      maxRestarts: this.config.maxRestarts,
    });

    this.intervalId = setInterval(() => {
      this.checkAll();
    }, this.config.checkIntervalMs);

    // Initial check
    this.checkAll();
  }

  /**
   * Stop the health monitoring loop
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.isRunning = false;
    this.log('info', 'Health monitor stopped');
  }

  /**
   * Get health status for all agents
   */
  getAll(): AgentHealth[] {
    return Array.from(this.health.values()).map((h) => ({
      ...h,
      uptime: Date.now() - h.startedAt.getTime(),
    }));
  }

  /**
   * Get health status for a specific agent
   */
  get(name: string): AgentHealth | undefined {
    const health = this.health.get(name);
    if (health) {
      return { ...health, uptime: Date.now() - health.startedAt.getTime() };
    }
    return undefined;
  }

  /**
   * Check health of all registered agents
   */
  private async checkAll(): Promise<void> {
    const checks = Array.from(this.agents.entries()).map(([name, agent]) =>
      this.checkAgent(name, agent)
    );
    await Promise.all(checks);
  }

  /**
   * Check health of a single agent
   */
  private async checkAgent(name: string, agent: AgentProcess): Promise<void> {
    const health = this.health.get(name);
    if (!health) return;

    health.lastHealthCheck = new Date();

    try {
      // First check: Is the process alive?
      const isAlive = this.isProcessAlive(agent.pid);

      if (!isAlive) {
        await this.handleDeath(name, agent, health, 'Process not found');
        return;
      }

      // Second check: Does it respond to health check?
      if (agent.sendHealthCheck) {
        const responded = await Promise.race([
          agent.sendHealthCheck(),
          new Promise<false>((resolve) =>
            setTimeout(() => resolve(false), this.config.responseTimeoutMs)
          ),
        ]);

        if (!responded) {
          health.consecutiveFailures++;
          this.log('warn', `Agent unresponsive: ${name}`, {
            failures: health.consecutiveFailures,
            max: this.config.maxConsecutiveFailures,
          });

          if (health.consecutiveFailures >= this.config.maxConsecutiveFailures) {
            health.status = 'unresponsive';
            await this.handleDeath(name, agent, health, 'Unresponsive after multiple health checks');
          } else {
            health.status = 'unresponsive';
            this.emit('unhealthy', { name, health });
          }
          return;
        }
      }

      // Get memory/CPU usage if available
      try {
        const usage = await this.getProcessUsage(agent.pid);
        health.memoryUsage = usage.memory;
        health.cpuUsage = usage.cpu;
      } catch {
        // Ignore usage errors
      }

      // All good
      health.status = 'healthy';
      health.lastResponse = new Date();
      health.consecutiveFailures = 0;

      this.emit('healthy', { name, health });
    } catch (error) {
      health.consecutiveFailures++;
      health.lastError = error instanceof Error ? error.message : String(error);
      this.log('error', `Health check error for ${name}`, { error: health.lastError });

      if (health.consecutiveFailures >= this.config.maxConsecutiveFailures) {
        await this.handleDeath(name, agent, health, health.lastError);
      }
    }
  }

  /**
   * Handle agent death - attempt restart or mark as dead
   */
  private async handleDeath(
    name: string,
    agent: AgentProcess,
    health: AgentHealth,
    reason: string
  ): Promise<void> {
    this.log('error', `Agent died: ${name}`, {
      reason,
      restartCount: health.restartCount,
      maxRestarts: this.config.maxRestarts,
    });

    this.emit('died', { name, reason, restartCount: health.restartCount });

    // Check if we should attempt restart
    if (health.restartCount >= this.config.maxRestarts) {
      health.status = 'dead';
      health.lastError = `Exceeded max restarts (${this.config.maxRestarts}): ${reason}`;
      this.log('error', `Agent permanently dead: ${name}`, { reason: health.lastError });
      this.emit('permanentlyDead', { name, health });
      return;
    }

    // Attempt restart
    health.status = 'restarting';
    health.restartCount++;

    this.log('info', `Attempting restart ${health.restartCount}/${this.config.maxRestarts}: ${name}`);
    this.emit('restarting', { name, attempt: health.restartCount });

    // Wait cooldown
    await new Promise((resolve) => setTimeout(resolve, this.config.restartCooldownMs));

    try {
      await agent.restart();

      // Update health after successful restart
      health.status = 'healthy';
      health.consecutiveFailures = 0;
      health.startedAt = new Date();
      health.lastResponse = new Date();
      health.pid = agent.pid;

      this.log('info', `Agent restarted successfully: ${name}`, {
        newPid: agent.pid,
        attempt: health.restartCount,
      });

      this.emit('restarted', { name, pid: agent.pid, attempt: health.restartCount });
    } catch (error) {
      health.lastError = error instanceof Error ? error.message : String(error);
      this.log('error', `Restart failed: ${name}`, { error: health.lastError });
      this.emit('restartFailed', { name, error: health.lastError });

      // Recursively try again if under limit
      if (health.restartCount < this.config.maxRestarts) {
        await this.handleDeath(name, agent, health, health.lastError);
      } else {
        health.status = 'dead';
        this.emit('permanentlyDead', { name, health });
      }
    }
  }

  /**
   * Check if a process is alive by PID
   */
  private isProcessAlive(pid: number): boolean {
    try {
      // Sending signal 0 checks if process exists without killing it
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get memory and CPU usage for a process
   */
  private async getProcessUsage(pid: number): Promise<{ memory: number; cpu: number }> {
    const { execSync } = await import('child_process');

    try {
      // This works on Linux/Mac
      const output = execSync(`ps -o rss=,pcpu= -p ${pid}`, { encoding: 'utf8' }).trim();
      const [rss, cpu] = output.split(/\s+/);
      return {
        memory: parseInt(rss, 10) * 1024, // RSS in bytes
        cpu: parseFloat(cpu),
      };
    } catch {
      return { memory: 0, cpu: 0 };
    }
  }

  /**
   * Structured logging
   */
  private log(
    level: 'info' | 'warn' | 'error',
    message: string,
    context?: Record<string, unknown>
  ): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      component: 'health-monitor',
      message,
      ...context,
    };

    this.emit('log', entry);

    // Also log to console with structure
    const prefix = `[health-monitor]`;
    switch (level) {
      case 'info':
        console.log(prefix, message, context ? JSON.stringify(context) : '');
        break;
      case 'warn':
        console.warn(prefix, message, context ? JSON.stringify(context) : '');
        break;
      case 'error':
        console.error(prefix, message, context ? JSON.stringify(context) : '');
        break;
    }
  }
}

// Singleton instance
let _monitor: AgentHealthMonitor | null = null;

export function getHealthMonitor(config?: Partial<HealthMonitorConfig>): AgentHealthMonitor {
  if (!_monitor) {
    _monitor = new AgentHealthMonitor(config);
  }
  return _monitor;
}
