/**
 * Agent Resiliency Metrics
 *
 * Collects and exposes metrics about agent health, crashes, and restarts.
 * - Prometheus-compatible format
 * - In-memory aggregation
 * - Real-time stats
 */

export interface AgentMetrics {
  name: string;
  spawns: number;
  crashes: number;
  restarts: number;
  successfulRestarts: number;
  failedRestarts: number;
  currentStatus: 'healthy' | 'unhealthy' | 'dead' | 'unknown';
  uptimeMs: number;
  lastCrashAt?: Date;
  lastCrashReason?: string;
  avgUptimeMs: number;
  memoryUsageBytes?: number;
  cpuUsagePercent?: number;
}

export interface SystemMetrics {
  totalAgents: number;
  healthyAgents: number;
  unhealthyAgents: number;
  deadAgents: number;
  totalCrashes: number;
  totalRestarts: number;
  uptimeSeconds: number;
  memoryUsageMb: number;
}

export interface MetricPoint {
  name: string;
  value: number;
  labels: Record<string, string>;
  timestamp: number;
}

class MetricsCollector {
  private agents = new Map<string, AgentMetrics>();
  private startTime = Date.now();
  private history: MetricPoint[] = [];
  private maxHistorySize = 10000;

  /**
   * Record an agent spawn
   */
  recordSpawn(name: string): void {
    const metrics = this.getOrCreate(name);
    metrics.spawns++;
    metrics.currentStatus = 'healthy';
    this.record('agent_spawns_total', 1, { agent: name });
  }

  /**
   * Record an agent crash
   */
  recordCrash(name: string, reason: string): void {
    const metrics = this.getOrCreate(name);
    metrics.crashes++;
    metrics.lastCrashAt = new Date();
    metrics.lastCrashReason = reason;
    metrics.currentStatus = 'unhealthy';

    // Update average uptime
    if (metrics.spawns > 0) {
      const currentUptime = Date.now() - (this.startTime + metrics.uptimeMs);
      metrics.avgUptimeMs =
        (metrics.avgUptimeMs * (metrics.spawns - 1) + currentUptime) / metrics.spawns;
    }

    this.record('agent_crashes_total', 1, { agent: name, reason });
  }

  /**
   * Record a restart attempt
   */
  recordRestartAttempt(name: string): void {
    const metrics = this.getOrCreate(name);
    metrics.restarts++;
    metrics.currentStatus = 'unhealthy';
    this.record('agent_restart_attempts_total', 1, { agent: name });
  }

  /**
   * Record a successful restart
   */
  recordRestartSuccess(name: string): void {
    const metrics = this.getOrCreate(name);
    metrics.successfulRestarts++;
    metrics.currentStatus = 'healthy';
    this.record('agent_restart_success_total', 1, { agent: name });
  }

  /**
   * Record a failed restart
   */
  recordRestartFailure(name: string, reason: string): void {
    const metrics = this.getOrCreate(name);
    metrics.failedRestarts++;
    this.record('agent_restart_failures_total', 1, { agent: name, reason });
  }

  /**
   * Mark agent as dead (exceeded max restarts)
   */
  recordDead(name: string): void {
    const metrics = this.getOrCreate(name);
    metrics.currentStatus = 'dead';
    this.record('agent_dead_total', 1, { agent: name });
  }

  /**
   * Update resource usage
   */
  updateResourceUsage(name: string, memoryBytes: number, cpuPercent: number): void {
    const metrics = this.getOrCreate(name);
    metrics.memoryUsageBytes = memoryBytes;
    metrics.cpuUsagePercent = cpuPercent;
    this.record('agent_memory_bytes', memoryBytes, { agent: name });
    this.record('agent_cpu_percent', cpuPercent, { agent: name });
  }

  /**
   * Get metrics for a specific agent
   */
  getAgentMetrics(name: string): AgentMetrics | undefined {
    return this.agents.get(name);
  }

  /**
   * Get metrics for all agents
   */
  getAllAgentMetrics(): AgentMetrics[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get system-wide metrics
   */
  getSystemMetrics(): SystemMetrics {
    const allMetrics = this.getAllAgentMetrics();

    return {
      totalAgents: allMetrics.length,
      healthyAgents: allMetrics.filter((m) => m.currentStatus === 'healthy').length,
      unhealthyAgents: allMetrics.filter((m) => m.currentStatus === 'unhealthy').length,
      deadAgents: allMetrics.filter((m) => m.currentStatus === 'dead').length,
      totalCrashes: allMetrics.reduce((sum, m) => sum + m.crashes, 0),
      totalRestarts: allMetrics.reduce((sum, m) => sum + m.restarts, 0),
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      memoryUsageMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    };
  }

  /**
   * Export metrics in Prometheus format
   */
  toPrometheus(): string {
    const lines: string[] = [];
    const system = this.getSystemMetrics();

    // System metrics
    lines.push('# HELP agent_relay_uptime_seconds Total uptime in seconds');
    lines.push('# TYPE agent_relay_uptime_seconds gauge');
    lines.push(`agent_relay_uptime_seconds ${system.uptimeSeconds}`);

    lines.push('# HELP agent_relay_agents_total Total number of agents');
    lines.push('# TYPE agent_relay_agents_total gauge');
    lines.push(`agent_relay_agents_total ${system.totalAgents}`);

    lines.push('# HELP agent_relay_agents_healthy Number of healthy agents');
    lines.push('# TYPE agent_relay_agents_healthy gauge');
    lines.push(`agent_relay_agents_healthy ${system.healthyAgents}`);

    lines.push('# HELP agent_relay_agents_unhealthy Number of unhealthy agents');
    lines.push('# TYPE agent_relay_agents_unhealthy gauge');
    lines.push(`agent_relay_agents_unhealthy ${system.unhealthyAgents}`);

    lines.push('# HELP agent_relay_agents_dead Number of dead agents');
    lines.push('# TYPE agent_relay_agents_dead gauge');
    lines.push(`agent_relay_agents_dead ${system.deadAgents}`);

    lines.push('# HELP agent_relay_crashes_total Total number of crashes');
    lines.push('# TYPE agent_relay_crashes_total counter');
    lines.push(`agent_relay_crashes_total ${system.totalCrashes}`);

    lines.push('# HELP agent_relay_restarts_total Total number of restart attempts');
    lines.push('# TYPE agent_relay_restarts_total counter');
    lines.push(`agent_relay_restarts_total ${system.totalRestarts}`);

    lines.push('# HELP agent_relay_memory_bytes Memory usage in bytes');
    lines.push('# TYPE agent_relay_memory_bytes gauge');
    lines.push(`agent_relay_memory_bytes ${system.memoryUsageMb * 1024 * 1024}`);

    // Per-agent metrics
    lines.push('# HELP agent_crashes_total Crashes per agent');
    lines.push('# TYPE agent_crashes_total counter');
    for (const m of this.getAllAgentMetrics()) {
      lines.push(`agent_crashes_total{agent="${m.name}"} ${m.crashes}`);
    }

    lines.push('# HELP agent_restarts_total Restart attempts per agent');
    lines.push('# TYPE agent_restarts_total counter');
    for (const m of this.getAllAgentMetrics()) {
      lines.push(`agent_restarts_total{agent="${m.name}"} ${m.restarts}`);
    }

    lines.push('# HELP agent_status Current agent status (0=unknown, 1=healthy, 2=unhealthy, 3=dead)');
    lines.push('# TYPE agent_status gauge');
    for (const m of this.getAllAgentMetrics()) {
      const statusValue =
        m.currentStatus === 'healthy'
          ? 1
          : m.currentStatus === 'unhealthy'
            ? 2
            : m.currentStatus === 'dead'
              ? 3
              : 0;
      lines.push(`agent_status{agent="${m.name}"} ${statusValue}`);
    }

    return lines.join('\n');
  }

  /**
   * Export metrics as JSON
   */
  toJSON(): { system: SystemMetrics; agents: AgentMetrics[] } {
    return {
      system: this.getSystemMetrics(),
      agents: this.getAllAgentMetrics(),
    };
  }

  /**
   * Get recent metric history
   */
  getHistory(name?: string, since?: Date): MetricPoint[] {
    let points = this.history;

    if (since) {
      const sinceTs = since.getTime();
      points = points.filter((p) => p.timestamp >= sinceTs);
    }

    if (name) {
      points = points.filter((p) => p.labels.agent === name);
    }

    return points;
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.agents.clear();
    this.history = [];
    this.startTime = Date.now();
  }

  /**
   * Get or create agent metrics
   */
  private getOrCreate(name: string): AgentMetrics {
    let metrics = this.agents.get(name);
    if (!metrics) {
      metrics = {
        name,
        spawns: 0,
        crashes: 0,
        restarts: 0,
        successfulRestarts: 0,
        failedRestarts: 0,
        currentStatus: 'unknown',
        uptimeMs: 0,
        avgUptimeMs: 0,
      };
      this.agents.set(name, metrics);
    }
    return metrics;
  }

  /**
   * Record a metric point
   */
  private record(name: string, value: number, labels: Record<string, string>): void {
    const point: MetricPoint = {
      name,
      value,
      labels,
      timestamp: Date.now(),
    };

    this.history.push(point);

    // Trim history if too large
    if (this.history.length > this.maxHistorySize) {
      this.history = this.history.slice(-this.maxHistorySize / 2);
    }
  }
}

// Singleton instance
export const metrics = new MetricsCollector();
