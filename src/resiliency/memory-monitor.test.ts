/**
 * Tests for Agent Memory Monitor
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AgentMemoryMonitor,
  getMemoryMonitor,
  formatBytes,
  type MemorySnapshot,
  type MemoryAlert,
} from './memory-monitor.js';

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn().mockImplementation((cmd: string) => {
    // Mock ps command output: RSS (KB), VSZ (KB), CPU%
    if (cmd.includes('ps -o rss')) {
      return '102400 204800 5.0'; // ~100MB RSS
    }
    // Mock /proc/meminfo
    if (cmd.includes('/proc/meminfo')) {
      return `
MemTotal:       16384000 kB
MemFree:         8192000 kB
MemAvailable:   10240000 kB
`;
    }
    // Mock smaps_rollup
    if (cmd.includes('smaps_rollup')) {
      return `
Rss: 102400 kB
Private_Dirty: 51200 kB
`;
    }
    return '';
  }),
}));

describe('AgentMemoryMonitor', () => {
  let monitor: AgentMemoryMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    // Create fresh instance for each test
    monitor = new AgentMemoryMonitor({
      checkIntervalMs: 1000,
      enableTrendAnalysis: true,
      enableProactiveAlerts: true,
      thresholds: {
        warningBytes: 512 * 1024 * 1024,
        criticalBytes: 1024 * 1024 * 1024,
        oomImminentBytes: 1.5 * 1024 * 1024 * 1024,
        trendGrowthRateWarning: 10 * 1024 * 1024,
        historyRetentionMinutes: 60,
        historyMaxSamples: 360,
      },
    });
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('registration', () => {
    it('should register an agent', () => {
      monitor.register('test-agent', 12345);

      const metrics = monitor.get('test-agent');
      expect(metrics).toBeDefined();
      expect(metrics?.name).toBe('test-agent');
      expect(metrics?.pid).toBe(12345);
      expect(metrics?.alertLevel).toBe('normal');
      expect(metrics?.trend).toBe('unknown');
    });

    it('should emit registered event', () => {
      const handler = vi.fn();
      monitor.on('registered', handler);

      monitor.register('test-agent', 12345);

      expect(handler).toHaveBeenCalledWith({ name: 'test-agent', pid: 12345 });
    });

    it('should unregister an agent', () => {
      monitor.register('test-agent', 12345);
      monitor.unregister('test-agent');

      expect(monitor.get('test-agent')).toBeUndefined();
    });

    it('should emit unregistered event with final metrics', () => {
      const handler = vi.fn();
      monitor.on('unregistered', handler);

      monitor.register('test-agent', 12345);
      monitor.unregister('test-agent');

      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0][0].name).toBe('test-agent');
      expect(handler.mock.calls[0][0].finalMetrics).toBeDefined();
    });

    it('should update PID for existing agent', () => {
      monitor.register('test-agent', 12345);
      monitor.updatePid('test-agent', 54321);

      const metrics = monitor.get('test-agent');
      expect(metrics?.pid).toBe(54321);
    });

    it('should reset metrics on PID update', () => {
      monitor.register('test-agent', 12345);
      const _metrics = monitor.get('test-agent');

      monitor.updatePid('test-agent', 54321);

      const updatedMetrics = monitor.get('test-agent');
      expect(updatedMetrics?.highWatermark).toBe(0);
      expect(updatedMetrics?.alertLevel).toBe('normal');
    });
  });

  describe('monitoring lifecycle', () => {
    it('should start and stop monitoring', () => {
      expect(monitor['isRunning']).toBe(false);

      monitor.start();
      expect(monitor['isRunning']).toBe(true);

      monitor.stop();
      expect(monitor['isRunning']).toBe(false);
    });

    it('should not start twice', () => {
      monitor.start();
      const intervalId = monitor['intervalId'];

      monitor.start();

      // Should be same interval
      expect(monitor['intervalId']).toBe(intervalId);
    });

    it('should take immediate sample when running and agent is registered', async () => {
      monitor.start();

      const sampleSpy = vi.spyOn(monitor as any, 'sampleAgent');
      monitor.register('test-agent', 12345);

      // Wait for promise to resolve
      await Promise.resolve();

      expect(sampleSpy).toHaveBeenCalledWith('test-agent');
    });
  });

  describe('metrics collection', () => {
    it('should return all registered agents', () => {
      monitor.register('agent-1', 111);
      monitor.register('agent-2', 222);
      monitor.register('agent-3', 333);

      const all = monitor.getAll();

      expect(all.length).toBe(3);
      expect(all.map(a => a.name)).toContain('agent-1');
      expect(all.map(a => a.name)).toContain('agent-2');
      expect(all.map(a => a.name)).toContain('agent-3');
    });

    it('should calculate uptime correctly', () => {
      monitor.register('test-agent', 12345);

      vi.advanceTimersByTime(5000);

      const metrics = monitor.get('test-agent');
      expect(metrics?.uptimeMs).toBeGreaterThanOrEqual(5000);
    });
  });

  describe('system summary', () => {
    it('should return system summary', () => {
      monitor.register('agent-1', 111);
      monitor.register('agent-2', 222);

      const summary = monitor.getSystemSummary();

      expect(summary.totalAgents).toBe(2);
      expect(summary.agentsByAlertLevel).toBeDefined();
      expect(summary.topMemoryConsumers).toBeDefined();
      expect(summary.systemMemory).toBeDefined();
      expect(summary.systemMemory.total).toBeGreaterThan(0);
    });

    it('should aggregate alert levels', () => {
      monitor.register('agent-1', 111);
      monitor.register('agent-2', 222);

      const summary = monitor.getSystemSummary();

      expect(summary.agentsByAlertLevel.normal).toBe(2);
      expect(summary.agentsByAlertLevel.warning).toBe(0);
      expect(summary.agentsByAlertLevel.critical).toBe(0);
    });
  });

  describe('crash context', () => {
    it('should return crash context for monitored agent', () => {
      monitor.register('test-agent', 12345);

      const context = monitor.getCrashContext('test-agent');

      expect(context.agentName).toBe('test-agent');
      expect(context.pid).toBe(12345);
      expect(context.crashTime).toBeInstanceOf(Date);
    });

    it('should return empty context for unknown agent', () => {
      const context = monitor.getCrashContext('unknown-agent');

      expect(context.agentName).toBe('unknown-agent');
      expect(context.lastKnownMemory).toBeNull();
      expect(context.likelyCause).toBe('unknown');
      expect(context.analysisNotes).toContain('No memory data available - agent was not being monitored');
    });

    it('should analyze likely crash cause from memory state', () => {
      // Set up agent with high memory
      monitor.register('oom-agent', 12345);
      const agent = monitor['agents'].get('oom-agent')!;
      agent.current.rssBytes = 2 * 1024 * 1024 * 1024; // 2GB

      const context = monitor.getCrashContext('oom-agent');

      expect(context.likelyCause).toBe('oom');
    });
  });
});

describe('formatBytes', () => {
  it('should format bytes correctly', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
  });

  it('should handle negative values', () => {
    expect(formatBytes(-1024)).toBe('-1.00 KB');
  });

  it('should format fractional values', () => {
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(1024 * 1024 * 1.5)).toBe('1.50 MB');
  });
});

describe('getMemoryMonitor singleton', () => {
  it('should return same instance on repeated calls', () => {
    // Note: This test may interfere with others due to singleton pattern
    // In production, consider using dependency injection instead
    const instance1 = getMemoryMonitor();
    const instance2 = getMemoryMonitor();

    expect(instance1).toBe(instance2);
  });
});

describe('trend analysis', () => {
  let monitor: AgentMemoryMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    monitor = new AgentMemoryMonitor({
      checkIntervalMs: 10000,
      enableTrendAnalysis: true,
      enableProactiveAlerts: false,
    });
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should detect growing trend', () => {
    monitor.register('growing-agent', 12345);
    const agent = monitor['agents'].get('growing-agent')!;

    // Simulate growing memory over 6 samples
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      agent.memoryHistory.push({
        timestamp: new Date(now + i * 10000),
        rssBytes: 100 * 1024 * 1024 + i * 50 * 1024 * 1024, // Growing by 50MB each
        heapUsedBytes: 0,
        heapTotalBytes: 0,
        externalBytes: 0,
        cpuPercent: 0,
      });
    }

    // Trigger trend analysis
    monitor['analyzeTrend'](agent);

    expect(agent.trend).toBe('growing');
    expect(agent.trendRatePerMinute).toBeGreaterThan(0);
  });

  it('should detect shrinking trend', () => {
    monitor.register('shrinking-agent', 12345);
    const agent = monitor['agents'].get('shrinking-agent')!;

    // Simulate shrinking memory
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      agent.memoryHistory.push({
        timestamp: new Date(now + i * 10000),
        rssBytes: 500 * 1024 * 1024 - i * 50 * 1024 * 1024, // Shrinking by 50MB each
        heapUsedBytes: 0,
        heapTotalBytes: 0,
        externalBytes: 0,
        cpuPercent: 0,
      });
    }

    monitor['analyzeTrend'](agent);

    expect(agent.trend).toBe('shrinking');
    expect(agent.trendRatePerMinute).toBeLessThan(0);
  });

  it('should detect stable trend', () => {
    monitor.register('stable-agent', 12345);
    const agent = monitor['agents'].get('stable-agent')!;

    // Simulate stable memory
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      agent.memoryHistory.push({
        timestamp: new Date(now + i * 10000),
        rssBytes: 200 * 1024 * 1024 + (i % 2) * 100 * 1024, // Small fluctuation
        heapUsedBytes: 0,
        heapTotalBytes: 0,
        externalBytes: 0,
        cpuPercent: 0,
      });
    }

    monitor['analyzeTrend'](agent);

    expect(agent.trend).toBe('stable');
  });

  it('should return unknown trend with insufficient history', () => {
    monitor.register('new-agent', 12345);
    const agent = monitor['agents'].get('new-agent')!;

    // Only 2 samples
    agent.memoryHistory.push({
      timestamp: new Date(),
      rssBytes: 100 * 1024 * 1024,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
      cpuPercent: 0,
    });

    monitor['analyzeTrend'](agent);

    expect(agent.trend).toBe('unknown');
  });
});

describe('alert system', () => {
  let monitor: AgentMemoryMonitor;
  let alertHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    monitor = new AgentMemoryMonitor({
      checkIntervalMs: 10000,
      enableTrendAnalysis: true,
      enableProactiveAlerts: true,
      thresholds: {
        warningBytes: 100 * 1024 * 1024, // 100MB for testing
        criticalBytes: 200 * 1024 * 1024, // 200MB
        oomImminentBytes: 300 * 1024 * 1024, // 300MB
        trendGrowthRateWarning: 10 * 1024 * 1024,
        historyRetentionMinutes: 60,
        historyMaxSamples: 360,
      },
    });
    alertHandler = vi.fn();
    monitor.on('alert', alertHandler);
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should emit warning alert when crossing warning threshold', () => {
    monitor.register('test-agent', 12345);

    // Simulate memory update that crosses warning threshold
    const snapshot: MemorySnapshot = {
      timestamp: new Date(),
      rssBytes: 150 * 1024 * 1024, // 150MB > 100MB warning
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
      cpuPercent: 0,
    };

    monitor['updateMetrics']('test-agent', snapshot);

    expect(alertHandler).toHaveBeenCalled();
    const alert = alertHandler.mock.calls[0][0] as MemoryAlert;
    expect(alert.type).toBe('warning');
    expect(alert.agentName).toBe('test-agent');
  });

  it('should emit critical alert when crossing critical threshold', () => {
    monitor.register('test-agent', 12345);

    // First bring to warning level
    monitor['updateMetrics']('test-agent', {
      timestamp: new Date(),
      rssBytes: 150 * 1024 * 1024,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
      cpuPercent: 0,
    });

    // Clear cooldown
    monitor['alertCooldowns'].delete('test-agent');

    // Then to critical level
    monitor['updateMetrics']('test-agent', {
      timestamp: new Date(),
      rssBytes: 250 * 1024 * 1024,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
      cpuPercent: 0,
    });

    const alerts = alertHandler.mock.calls.map(c => c[0] as MemoryAlert);
    const criticalAlert = alerts.find(a => a.type === 'critical');
    expect(criticalAlert).toBeDefined();
  });

  it('should emit recovered alert when returning to normal', () => {
    monitor.register('test-agent', 12345);

    // Go to warning level
    monitor['updateMetrics']('test-agent', {
      timestamp: new Date(),
      rssBytes: 150 * 1024 * 1024,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
      cpuPercent: 0,
    });

    // Clear cooldown
    monitor['alertCooldowns'].delete('test-agent');

    // Return to normal
    monitor['updateMetrics']('test-agent', {
      timestamp: new Date(),
      rssBytes: 50 * 1024 * 1024,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
      cpuPercent: 0,
    });

    const alerts = alertHandler.mock.calls.map(c => c[0] as MemoryAlert);
    const recoveredAlert = alerts.find(a => a.type === 'recovered');
    expect(recoveredAlert).toBeDefined();
  });

  it('should respect alert cooldown', () => {
    monitor.register('test-agent', 12345);

    // First alert
    monitor['updateMetrics']('test-agent', {
      timestamp: new Date(),
      rssBytes: 150 * 1024 * 1024,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
      cpuPercent: 0,
    });

    const initialCallCount = alertHandler.mock.calls.length;

    // Try to trigger another alert immediately (without clearing cooldown)
    monitor['updateMetrics']('test-agent', {
      timestamp: new Date(),
      rssBytes: 250 * 1024 * 1024,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
      cpuPercent: 0,
    });

    // Should not have triggered due to cooldown
    expect(alertHandler.mock.calls.length).toBe(initialCallCount);
  });
});

describe('watermark tracking', () => {
  let monitor: AgentMemoryMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    monitor = new AgentMemoryMonitor({
      checkIntervalMs: 10000,
      enableTrendAnalysis: false,
      enableProactiveAlerts: false,
    });
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should track high watermark', () => {
    monitor.register('test-agent', 12345);

    // First update
    monitor['updateMetrics']('test-agent', {
      timestamp: new Date(),
      rssBytes: 100 * 1024 * 1024,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
      cpuPercent: 0,
    });

    // Higher update
    monitor['updateMetrics']('test-agent', {
      timestamp: new Date(),
      rssBytes: 200 * 1024 * 1024,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
      cpuPercent: 0,
    });

    // Lower update
    monitor['updateMetrics']('test-agent', {
      timestamp: new Date(),
      rssBytes: 150 * 1024 * 1024,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
      cpuPercent: 0,
    });

    const metrics = monitor.get('test-agent');
    expect(metrics?.highWatermark).toBe(200 * 1024 * 1024);
  });

  it('should track low watermark', () => {
    monitor.register('test-agent', 12345);

    // Updates
    monitor['updateMetrics']('test-agent', {
      timestamp: new Date(),
      rssBytes: 200 * 1024 * 1024,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
      cpuPercent: 0,
    });

    monitor['updateMetrics']('test-agent', {
      timestamp: new Date(),
      rssBytes: 50 * 1024 * 1024,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
      cpuPercent: 0,
    });

    monitor['updateMetrics']('test-agent', {
      timestamp: new Date(),
      rssBytes: 100 * 1024 * 1024,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
      cpuPercent: 0,
    });

    const metrics = monitor.get('test-agent');
    expect(metrics?.lowWatermark).toBe(50 * 1024 * 1024);
  });

  it('should calculate rolling average', () => {
    monitor.register('test-agent', 12345);

    // Updates
    monitor['updateMetrics']('test-agent', {
      timestamp: new Date(),
      rssBytes: 100 * 1024 * 1024,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
      cpuPercent: 0,
    });

    monitor['updateMetrics']('test-agent', {
      timestamp: new Date(),
      rssBytes: 200 * 1024 * 1024,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
      cpuPercent: 0,
    });

    const metrics = monitor.get('test-agent');
    expect(metrics?.averageRss).toBe(150 * 1024 * 1024);
  });
});
