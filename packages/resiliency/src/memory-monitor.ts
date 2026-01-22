/**
 * Agent Memory Monitor
 *
 * Comprehensive memory monitoring for agent processes:
 * - Detailed memory metrics (RSS, heap, external)
 * - Memory trend analysis (growing/stable/shrinking)
 * - High watermark tracking
 * - Configurable thresholds for proactive alerting
 * - Memory history for trend analysis
 * - Crash prevention through memory pressure detection
 */

import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import * as os from 'os';

export interface MemorySnapshot {
  timestamp: Date;
  rssBytes: number; // Resident Set Size - actual memory used
  heapUsedBytes: number; // V8 heap used (for Node processes)
  heapTotalBytes: number; // V8 heap total
  externalBytes: number; // C++ objects bound to V8
  cpuPercent: number;
}

export interface AgentMemoryMetrics {
  name: string;
  pid: number;
  current: MemorySnapshot;
  highWatermark: number; // Peak RSS in bytes
  lowWatermark: number; // Lowest RSS in bytes
  averageRss: number; // Rolling average RSS
  trend: 'growing' | 'stable' | 'shrinking' | 'unknown';
  trendRatePerMinute: number; // Bytes per minute growth/shrink rate
  alertLevel: 'normal' | 'warning' | 'critical' | 'oom_imminent';
  lastAlertAt?: Date;
  memoryHistory: MemorySnapshot[]; // Recent history for trend analysis
  startedAt: Date;
  uptimeMs: number;
}

export interface MemoryThresholds {
  warningBytes: number; // Default: 512MB
  criticalBytes: number; // Default: 1GB
  oomImminentBytes: number; // Default: 1.5GB
  trendGrowthRateWarning: number; // Bytes/minute that triggers warning
  historyRetentionMinutes: number; // How long to keep history
  historyMaxSamples: number; // Max samples to retain
}

export interface MemoryMonitorConfig {
  checkIntervalMs: number; // How often to check (default: 10000)
  thresholds: MemoryThresholds;
  enableTrendAnalysis: boolean;
  enableProactiveAlerts: boolean;
}

export interface MemoryAlert {
  type: 'warning' | 'critical' | 'oom_imminent' | 'trend_warning' | 'recovered';
  agentName: string;
  pid: number;
  currentRss: number;
  threshold: number;
  message: string;
  recommendation: string;
  timestamp: Date;
}

export interface CrashMemoryContext {
  agentName: string;
  pid: number;
  crashTime: Date;
  lastKnownMemory: MemorySnapshot | null;
  peakMemory: number;
  averageMemory: number;
  memoryTrend: string;
  recentHistory: MemorySnapshot[];
  likelyCause: 'oom' | 'memory_leak' | 'sudden_spike' | 'unknown';
  analysisNotes: string[];
}

const DEFAULT_THRESHOLDS: MemoryThresholds = {
  warningBytes: 512 * 1024 * 1024, // 512MB
  criticalBytes: 1024 * 1024 * 1024, // 1GB
  oomImminentBytes: 1.5 * 1024 * 1024 * 1024, // 1.5GB
  trendGrowthRateWarning: 10 * 1024 * 1024, // 10MB per minute
  historyRetentionMinutes: 60, // Keep 1 hour of history
  historyMaxSamples: 360, // Max 360 samples (every 10s for 1 hour)
};

const DEFAULT_CONFIG: MemoryMonitorConfig = {
  checkIntervalMs: 10000, // Every 10 seconds
  thresholds: DEFAULT_THRESHOLDS,
  enableTrendAnalysis: true,
  enableProactiveAlerts: true,
};

export class AgentMemoryMonitor extends EventEmitter {
  private agents = new Map<string, AgentMemoryMetrics>();
  private pids = new Map<string, number>(); // name -> pid
  private intervalId?: ReturnType<typeof setInterval>;
  private config: MemoryMonitorConfig;
  private isRunning = false;
  private alertCooldowns = new Map<string, Date>(); // Prevent alert spam

  constructor(config: Partial<MemoryMonitorConfig> = {}) {
    super();
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      thresholds: {
        ...DEFAULT_THRESHOLDS,
        ...config.thresholds,
      },
    };
  }

  /**
   * Register an agent for memory monitoring
   */
  register(name: string, pid: number): void {
    const now = new Date();
    const initialSnapshot: MemorySnapshot = {
      timestamp: now,
      rssBytes: 0,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
      cpuPercent: 0,
    };

    this.agents.set(name, {
      name,
      pid,
      current: initialSnapshot,
      highWatermark: 0,
      lowWatermark: Infinity,
      averageRss: 0,
      trend: 'unknown',
      trendRatePerMinute: 0,
      alertLevel: 'normal',
      memoryHistory: [],
      startedAt: now,
      uptimeMs: 0,
    });

    this.pids.set(name, pid);

    this.emit('registered', { name, pid });
    this.log('info', `Registered agent for memory monitoring: ${name} (PID: ${pid})`);

    // Immediate first sample
    if (this.isRunning) {
      this.sampleAgent(name).catch(() => {});
    }
  }

  /**
   * Update PID for an agent (after restart)
   */
  updatePid(name: string, newPid: number): void {
    const metrics = this.agents.get(name);
    if (metrics) {
      metrics.pid = newPid;
      // Reset metrics but keep history for trend continuity
      metrics.highWatermark = 0;
      metrics.lowWatermark = Infinity;
      metrics.alertLevel = 'normal';
      metrics.startedAt = new Date();
    }
    this.pids.set(name, newPid);
    this.log('info', `Updated PID for ${name}: ${newPid}`);
  }

  /**
   * Unregister an agent
   */
  unregister(name: string): void {
    const metrics = this.agents.get(name);
    this.agents.delete(name);
    this.pids.delete(name);
    this.alertCooldowns.delete(name);

    if (metrics) {
      this.emit('unregistered', { name, finalMetrics: metrics });
    }
    this.log('info', `Unregistered agent: ${name}`);
  }

  /**
   * Start memory monitoring
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.log('info', 'Memory monitor started', {
      checkInterval: this.config.checkIntervalMs,
      thresholds: this.config.thresholds,
    });

    this.intervalId = setInterval(() => {
      this.sampleAll().catch((err) => {
        this.log('error', 'Failed to sample agents', { error: String(err) });
      });
    }, this.config.checkIntervalMs);

    // Initial sample
    this.sampleAll().catch(() => {});
  }

  /**
   * Stop memory monitoring
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.isRunning = false;
    this.log('info', 'Memory monitor stopped');
  }

  /**
   * Get memory metrics for all agents
   */
  getAll(): AgentMemoryMetrics[] {
    return Array.from(this.agents.values()).map((m) => ({
      ...m,
      uptimeMs: Date.now() - m.startedAt.getTime(),
    }));
  }

  /**
   * Get memory metrics for a specific agent
   */
  get(name: string): AgentMemoryMetrics | undefined {
    const metrics = this.agents.get(name);
    if (metrics) {
      return {
        ...metrics,
        uptimeMs: Date.now() - metrics.startedAt.getTime(),
      };
    }
    return undefined;
  }

  /**
   * Get crash context for an agent (for crash analysis)
   */
  getCrashContext(name: string): CrashMemoryContext {
    const metrics = this.agents.get(name);
    const now = new Date();

    if (!metrics) {
      return {
        agentName: name,
        pid: this.pids.get(name) || 0,
        crashTime: now,
        lastKnownMemory: null,
        peakMemory: 0,
        averageMemory: 0,
        memoryTrend: 'unknown',
        recentHistory: [],
        likelyCause: 'unknown',
        analysisNotes: ['No memory data available - agent was not being monitored'],
      };
    }

    const recentHistory = metrics.memoryHistory.slice(-30); // Last 30 samples
    const analysisNotes: string[] = [];
    let likelyCause: CrashMemoryContext['likelyCause'] = 'unknown';

    // Analyze crash cause
    const lastMemory = metrics.current.rssBytes;
    const { thresholds } = this.config;

    if (lastMemory >= thresholds.oomImminentBytes) {
      likelyCause = 'oom';
      analysisNotes.push(`Memory was at OOM-imminent level: ${formatBytes(lastMemory)}`);
    } else if (metrics.trend === 'growing' && metrics.trendRatePerMinute > thresholds.trendGrowthRateWarning) {
      likelyCause = 'memory_leak';
      analysisNotes.push(`Memory was growing at ${formatBytes(metrics.trendRatePerMinute)}/min`);
    } else if (recentHistory.length >= 2) {
      const prevMemory = recentHistory[recentHistory.length - 2]?.rssBytes || 0;
      const spike = lastMemory - prevMemory;
      if (spike > 100 * 1024 * 1024) {
        // 100MB spike
        likelyCause = 'sudden_spike';
        analysisNotes.push(`Sudden memory spike of ${formatBytes(spike)} detected`);
      }
    }

    // Add general analysis notes
    analysisNotes.push(`Peak memory: ${formatBytes(metrics.highWatermark)}`);
    analysisNotes.push(`Average memory: ${formatBytes(metrics.averageRss)}`);
    analysisNotes.push(`Memory trend: ${metrics.trend} (${formatBytes(metrics.trendRatePerMinute)}/min)`);
    analysisNotes.push(`Alert level at crash: ${metrics.alertLevel}`);

    return {
      agentName: name,
      pid: metrics.pid,
      crashTime: now,
      lastKnownMemory: metrics.current,
      peakMemory: metrics.highWatermark,
      averageMemory: metrics.averageRss,
      memoryTrend: metrics.trend,
      recentHistory,
      likelyCause,
      analysisNotes,
    };
  }

  /**
   * Get system-wide memory summary
   */
  getSystemSummary(): {
    totalAgents: number;
    totalMemoryBytes: number;
    agentsByAlertLevel: Record<string, number>;
    topMemoryConsumers: Array<{ name: string; rssBytes: number }>;
    systemMemory: { total: number; free: number; available: number };
  } {
    const allMetrics = this.getAll();
    const byAlertLevel: Record<string, number> = {
      normal: 0,
      warning: 0,
      critical: 0,
      oom_imminent: 0,
    };

    for (const m of allMetrics) {
      byAlertLevel[m.alertLevel] = (byAlertLevel[m.alertLevel] || 0) + 1;
    }

    const totalMemory = allMetrics.reduce((sum, m) => sum + m.current.rssBytes, 0);
    const topConsumers = allMetrics
      .sort((a, b) => b.current.rssBytes - a.current.rssBytes)
      .slice(0, 5)
      .map((m) => ({ name: m.name, rssBytes: m.current.rssBytes }));

    return {
      totalAgents: allMetrics.length,
      totalMemoryBytes: totalMemory,
      agentsByAlertLevel: byAlertLevel,
      topMemoryConsumers: topConsumers,
      systemMemory: this.getSystemMemory(),
    };
  }

  /**
   * Sample memory for all registered agents
   */
  private async sampleAll(): Promise<void> {
    const promises = Array.from(this.agents.keys()).map((name) =>
      this.sampleAgent(name).catch((err) => {
        this.log('warn', `Failed to sample ${name}`, { error: String(err) });
      })
    );
    await Promise.all(promises);
  }

  /**
   * Sample memory for a single agent
   */
  private async sampleAgent(name: string): Promise<void> {
    const metrics = this.agents.get(name);
    if (!metrics) return;

    const pid = metrics.pid;

    // Check if process is still alive
    if (!this.isProcessAlive(pid)) {
      this.log('warn', `Process ${pid} for ${name} is not alive`);
      return;
    }

    try {
      const snapshot = await this.getProcessMemory(pid);
      this.updateMetrics(name, snapshot);
    } catch (error) {
      this.log('warn', `Failed to get memory for ${name}`, { error: String(error) });
    }
  }

  /**
   * Update metrics with new snapshot
   */
  private updateMetrics(name: string, snapshot: MemorySnapshot): void {
    const metrics = this.agents.get(name);
    if (!metrics) return;

    const { thresholds } = this.config;
    const _previousRss = metrics.current.rssBytes;
    const previousAlertLevel = metrics.alertLevel;

    // Update current snapshot
    metrics.current = snapshot;
    metrics.uptimeMs = Date.now() - metrics.startedAt.getTime();

    // Update watermarks
    if (snapshot.rssBytes > metrics.highWatermark) {
      metrics.highWatermark = snapshot.rssBytes;
    }
    if (snapshot.rssBytes < metrics.lowWatermark && snapshot.rssBytes > 0) {
      metrics.lowWatermark = snapshot.rssBytes;
    }

    // Add to history
    metrics.memoryHistory.push(snapshot);

    // Trim history
    const maxAge = Date.now() - thresholds.historyRetentionMinutes * 60 * 1000;
    metrics.memoryHistory = metrics.memoryHistory
      .filter((s) => s.timestamp.getTime() > maxAge)
      .slice(-thresholds.historyMaxSamples);

    // Calculate rolling average
    if (metrics.memoryHistory.length > 0) {
      const sum = metrics.memoryHistory.reduce((acc, s) => acc + s.rssBytes, 0);
      metrics.averageRss = sum / metrics.memoryHistory.length;
    }

    // Analyze trend
    if (this.config.enableTrendAnalysis && metrics.memoryHistory.length >= 6) {
      this.analyzeTrend(metrics);
    }

    // Update alert level
    if (snapshot.rssBytes >= thresholds.oomImminentBytes) {
      metrics.alertLevel = 'oom_imminent';
    } else if (snapshot.rssBytes >= thresholds.criticalBytes) {
      metrics.alertLevel = 'critical';
    } else if (snapshot.rssBytes >= thresholds.warningBytes) {
      metrics.alertLevel = 'warning';
    } else {
      metrics.alertLevel = 'normal';
    }

    // Emit events
    this.emit('sample', { name, snapshot, metrics });

    // Check for alerts
    if (this.config.enableProactiveAlerts) {
      this.checkAlerts(name, metrics, previousAlertLevel);
    }
  }

  /**
   * Analyze memory trend
   */
  private analyzeTrend(metrics: AgentMemoryMetrics): void {
    const history = metrics.memoryHistory;
    if (history.length < 6) {
      metrics.trend = 'unknown';
      return;
    }

    // Use last 6 samples for trend (1 minute at 10s intervals)
    const recent = history.slice(-6);
    const oldest = recent[0];
    const newest = recent[recent.length - 1];

    const timeDeltaMs = newest.timestamp.getTime() - oldest.timestamp.getTime();
    const memoryDelta = newest.rssBytes - oldest.rssBytes;

    // Calculate rate per minute
    const ratePerMinute = timeDeltaMs > 0 ? (memoryDelta / timeDeltaMs) * 60000 : 0;
    metrics.trendRatePerMinute = ratePerMinute;

    // Determine trend (threshold: 1MB/min change)
    const threshold = 1024 * 1024; // 1MB
    if (ratePerMinute > threshold) {
      metrics.trend = 'growing';
    } else if (ratePerMinute < -threshold) {
      metrics.trend = 'shrinking';
    } else {
      metrics.trend = 'stable';
    }
  }

  /**
   * Check and emit alerts
   */
  private checkAlerts(
    name: string,
    metrics: AgentMemoryMetrics,
    previousLevel: string
  ): void {
    const { thresholds } = this.config;
    const now = new Date();

    // Check cooldown (don't spam alerts)
    const lastAlert = this.alertCooldowns.get(name);
    const cooldownMs = 60000; // 1 minute cooldown
    if (lastAlert && now.getTime() - lastAlert.getTime() < cooldownMs) {
      return;
    }

    let alert: MemoryAlert | null = null;

    // Check for level transitions
    if (metrics.alertLevel !== previousLevel) {
      if (metrics.alertLevel === 'oom_imminent') {
        alert = {
          type: 'oom_imminent',
          agentName: name,
          pid: metrics.pid,
          currentRss: metrics.current.rssBytes,
          threshold: thresholds.oomImminentBytes,
          message: `Agent ${name} is about to run out of memory!`,
          recommendation: 'Consider restarting the agent or killing heavy operations',
          timestamp: now,
        };
      } else if (metrics.alertLevel === 'critical') {
        alert = {
          type: 'critical',
          agentName: name,
          pid: metrics.pid,
          currentRss: metrics.current.rssBytes,
          threshold: thresholds.criticalBytes,
          message: `Agent ${name} memory usage is critical`,
          recommendation: 'Monitor closely, may need intervention soon',
          timestamp: now,
        };
      } else if (metrics.alertLevel === 'warning') {
        alert = {
          type: 'warning',
          agentName: name,
          pid: metrics.pid,
          currentRss: metrics.current.rssBytes,
          threshold: thresholds.warningBytes,
          message: `Agent ${name} memory usage is elevated`,
          recommendation: 'Keep monitoring, consider investigation if trend continues',
          timestamp: now,
        };
      } else if (previousLevel !== 'normal' && metrics.alertLevel === 'normal') {
        alert = {
          type: 'recovered',
          agentName: name,
          pid: metrics.pid,
          currentRss: metrics.current.rssBytes,
          threshold: thresholds.warningBytes,
          message: `Agent ${name} memory usage returned to normal`,
          recommendation: 'No action needed',
          timestamp: now,
        };
      }
    }

    // Check for rapid growth trend
    if (
      metrics.trend === 'growing' &&
      metrics.trendRatePerMinute > thresholds.trendGrowthRateWarning &&
      !alert
    ) {
      alert = {
        type: 'trend_warning',
        agentName: name,
        pid: metrics.pid,
        currentRss: metrics.current.rssBytes,
        threshold: thresholds.trendGrowthRateWarning,
        message: `Agent ${name} memory is growing rapidly: ${formatBytes(metrics.trendRatePerMinute)}/min`,
        recommendation: 'Investigate for potential memory leak',
        timestamp: now,
      };
    }

    if (alert) {
      metrics.lastAlertAt = now;
      this.alertCooldowns.set(name, now);
      this.emit('alert', alert);
      this.log(alert.type === 'recovered' ? 'info' : 'warn', alert.message, {
        agent: name,
        type: alert.type,
        rss: formatBytes(alert.currentRss),
      });
    }
  }

  /**
   * Get memory for a process using ps
   */
  private async getProcessMemory(pid: number): Promise<MemorySnapshot> {
    try {
      // ps command for detailed memory: rss, vsz, and CPU
      const output = execSync(`ps -o rss=,vsz=,pcpu= -p ${pid}`, {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();

      const parts = output.split(/\s+/);
      const rssKb = parseInt(parts[0] || '0', 10);
      const _vszKb = parseInt(parts[1] || '0', 10);
      const cpu = parseFloat(parts[2] || '0');

      // Try to get more detailed memory from /proc on Linux
      let heapUsed = 0;
      const heapTotal = 0;
      const external = 0;

      try {
        const smaps = execSync(`cat /proc/${pid}/smaps_rollup 2>/dev/null || echo ""`, {
          encoding: 'utf8',
          timeout: 2000,
        });

        const rssMatch = smaps.match(/Rss:\s+(\d+)\s+kB/);
        if (rssMatch) {
          // Use smaps for more accurate RSS
        }

        // For heap estimation on Linux
        const heapMatch = smaps.match(/Private_Dirty:\s+(\d+)\s+kB/);
        if (heapMatch) {
          heapUsed = parseInt(heapMatch[1], 10) * 1024;
        }
      } catch {
        // Not on Linux or no access to /proc
      }

      return {
        timestamp: new Date(),
        rssBytes: rssKb * 1024,
        heapUsedBytes: heapUsed || rssKb * 1024 * 0.6, // Estimate heap as 60% of RSS
        heapTotalBytes: heapTotal || rssKb * 1024 * 0.8,
        externalBytes: external,
        cpuPercent: cpu,
      };
    } catch {
      return {
        timestamp: new Date(),
        rssBytes: 0,
        heapUsedBytes: 0,
        heapTotalBytes: 0,
        externalBytes: 0,
        cpuPercent: 0,
      };
    }
  }

  /**
   * Get system memory info
   */
  private getSystemMemory(): { total: number; free: number; available: number } {
    try {
      const meminfo = execSync('cat /proc/meminfo', { encoding: 'utf8' });
      const total = parseInt(meminfo.match(/MemTotal:\s+(\d+)/)?.[1] || '0', 10) * 1024;
      const free = parseInt(meminfo.match(/MemFree:\s+(\d+)/)?.[1] || '0', 10) * 1024;
      const available =
        parseInt(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1] || '0', 10) * 1024;

      return { total, free, available };
    } catch {
      // Fallback for non-Linux
      return {
        total: os.totalmem(),
        free: os.freemem(),
        available: os.freemem(),
      };
    }
  }

  /**
   * Check if a process is alive
   */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
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
      component: 'memory-monitor',
      message,
      ...context,
    };

    this.emit('log', entry);

    const prefix = `[memory-monitor]`;
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

/**
 * Format bytes for human-readable display
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(2)} ${sizes[i]}`;
}

// Export utility
export { formatBytes };

// Singleton instance
let _memoryMonitor: AgentMemoryMonitor | null = null;

export function getMemoryMonitor(
  config?: Partial<MemoryMonitorConfig>
): AgentMemoryMonitor {
  if (!_memoryMonitor) {
    _memoryMonitor = new AgentMemoryMonitor(config);
  }
  return _memoryMonitor;
}
