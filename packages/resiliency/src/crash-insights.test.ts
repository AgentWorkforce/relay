/**
 * Tests for Crash Insights Service
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import {
  CrashInsightsService,
  getCrashInsights,
} from './crash-insights.js';
import type { AgentMemoryMonitor, CrashMemoryContext } from './memory-monitor.js';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue('{"crashes": []}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

describe('CrashInsightsService', () => {
  let service: CrashInsightsService;
  let mockMemoryMonitor: Partial<AgentMemoryMonitor>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock memory monitor
    mockMemoryMonitor = {
      getCrashContext: vi.fn().mockReturnValue({
        agentName: 'test-agent',
        pid: 12345,
        crashTime: new Date(),
        lastKnownMemory: {
          timestamp: new Date(),
          rssBytes: 500 * 1024 * 1024,
          heapUsedBytes: 300 * 1024 * 1024,
          heapTotalBytes: 400 * 1024 * 1024,
          externalBytes: 0,
          cpuPercent: 50,
        },
        peakMemory: 600 * 1024 * 1024,
        averageMemory: 400 * 1024 * 1024,
        memoryTrend: 'growing',
        recentHistory: [],
        likelyCause: 'oom',
        analysisNotes: ['Memory was at high level'],
      } as CrashMemoryContext),
    };

    service = new CrashInsightsService(mockMemoryMonitor as AgentMemoryMonitor);
  });

  afterEach(() => {
    service.clear();
  });

  describe('recordCrash', () => {
    it('should record a crash with all details', () => {
      const record = service.recordCrash({
        agentName: 'test-agent',
        pid: 12345,
        exitCode: 137,
        signal: 'SIGKILL',
        reason: 'Process killed',
        stackTrace: 'Error: OOM',
        lastOutput: 'Working on task...',
      });

      expect(record.id).toMatch(/^crash-\d+-[a-z0-9]+$/);
      expect(record.agentName).toBe('test-agent');
      expect(record.pid).toBe(12345);
      expect(record.exitCode).toBe(137);
      expect(record.signal).toBe('SIGKILL');
      expect(record.reason).toBe('Process killed');
      expect(record.crashTime).toBeInstanceOf(Date);
      expect(record.analysis).toBeDefined();
    });

    it('should emit crash event', () => {
      const handler = vi.fn();
      service.on('crash', handler);

      const record = service.recordCrash({
        agentName: 'test-agent',
        pid: 12345,
        exitCode: 1,
        signal: null,
        reason: 'Error',
      });

      expect(handler).toHaveBeenCalledWith(record);
    });

    it('should get memory context from monitor', () => {
      service.recordCrash({
        agentName: 'test-agent',
        pid: 12345,
        exitCode: 137,
        signal: 'SIGKILL',
        reason: 'Killed',
      });

      expect(mockMemoryMonitor.getCrashContext).toHaveBeenCalledWith('test-agent');
    });

    it('should store crash in history', () => {
      service.recordCrash({
        agentName: 'test-agent',
        pid: 12345,
        exitCode: 1,
        signal: null,
        reason: 'Error',
      });

      const history = service.getCrashHistory();
      expect(history.length).toBe(1);
      expect(history[0].agentName).toBe('test-agent');
    });

    it('should trim crash history when exceeding max', () => {
      // Record many crashes
      for (let i = 0; i < 1005; i++) {
        service.recordCrash({
          agentName: `agent-${i}`,
          pid: i,
          exitCode: 1,
          signal: null,
          reason: 'Error',
        });
      }

      const history = service.getCrashHistory(undefined, 2000);
      expect(history.length).toBeLessThanOrEqual(1000);
    });

    it('should truncate lastOutput to limit', () => {
      const longOutput = 'x'.repeat(5000);
      const record = service.recordCrash({
        agentName: 'test-agent',
        pid: 12345,
        exitCode: 1,
        signal: null,
        reason: 'Error',
        lastOutput: longOutput,
      });

      expect(record.lastOutput?.length).toBe(2000);
    });
  });

  describe('getCrashHistory', () => {
    beforeEach(() => {
      // Record a few crashes
      service.recordCrash({
        agentName: 'agent-a',
        pid: 111,
        exitCode: 1,
        signal: null,
        reason: 'Error A',
      });
      service.recordCrash({
        agentName: 'agent-b',
        pid: 222,
        exitCode: 1,
        signal: null,
        reason: 'Error B',
      });
      service.recordCrash({
        agentName: 'agent-a',
        pid: 333,
        exitCode: 1,
        signal: null,
        reason: 'Error A2',
      });
    });

    it('should return all crashes', () => {
      const history = service.getCrashHistory();
      expect(history.length).toBe(3);
    });

    it('should filter by agent name', () => {
      const history = service.getCrashHistory('agent-a');
      expect(history.length).toBe(2);
      expect(history.every(c => c.agentName === 'agent-a')).toBe(true);
    });

    it('should respect limit', () => {
      const history = service.getCrashHistory(undefined, 2);
      expect(history.length).toBe(2);
    });

    it('should return crashes in reverse chronological order', () => {
      const history = service.getCrashHistory();
      // Most recent first
      expect(history[0].reason).toBe('Error A2');
    });
  });

  describe('getCrash', () => {
    it('should return crash by ID', () => {
      const record = service.recordCrash({
        agentName: 'test-agent',
        pid: 12345,
        exitCode: 1,
        signal: null,
        reason: 'Error',
      });

      const found = service.getCrash(record.id);
      expect(found).toEqual(record);
    });

    it('should return undefined for unknown ID', () => {
      const found = service.getCrash('nonexistent-id');
      expect(found).toBeUndefined();
    });
  });

  describe('getStats', () => {
    beforeEach(() => {
      // Record crashes with different characteristics
      // OOM crash for agent-a
      vi.mocked(mockMemoryMonitor.getCrashContext!).mockReturnValueOnce({
        agentName: 'agent-a',
        pid: 111,
        crashTime: new Date(),
        lastKnownMemory: null,
        peakMemory: 2 * 1024 * 1024 * 1024,
        averageMemory: 0,
        memoryTrend: 'growing',
        recentHistory: [],
        likelyCause: 'oom',
        analysisNotes: [],
      });
      service.recordCrash({
        agentName: 'agent-a',
        pid: 111,
        exitCode: 137,
        signal: 'SIGKILL',
        reason: 'OOM',
      });

      // Regular crash for agent-b
      vi.mocked(mockMemoryMonitor.getCrashContext!).mockReturnValueOnce({
        agentName: 'agent-b',
        pid: 222,
        crashTime: new Date(),
        lastKnownMemory: null,
        peakMemory: 100 * 1024 * 1024,
        averageMemory: 0,
        memoryTrend: 'stable',
        recentHistory: [],
        likelyCause: 'unknown',
        analysisNotes: [],
      });
      service.recordCrash({
        agentName: 'agent-b',
        pid: 222,
        exitCode: 1,
        signal: null,
        reason: 'Error',
      });

      // Another crash for agent-a
      vi.mocked(mockMemoryMonitor.getCrashContext!).mockReturnValueOnce({
        agentName: 'agent-a',
        pid: 333,
        crashTime: new Date(),
        lastKnownMemory: null,
        peakMemory: 1.8 * 1024 * 1024 * 1024,
        averageMemory: 0,
        memoryTrend: 'growing',
        recentHistory: [],
        likelyCause: 'memory_leak',
        analysisNotes: [],
      });
      service.recordCrash({
        agentName: 'agent-a',
        pid: 333,
        exitCode: 137,
        signal: 'SIGKILL',
        reason: 'Memory leak',
      });
    });

    it('should return total crash count', () => {
      const stats = service.getStats();
      expect(stats.totalCrashes).toBe(3);
    });

    it('should count crashes by agent', () => {
      const stats = service.getStats();
      expect(stats.crashesByAgent['agent-a']).toBe(2);
      expect(stats.crashesByAgent['agent-b']).toBe(1);
    });

    it('should count crashes by cause', () => {
      const stats = service.getStats();
      expect(stats.crashesByCause).toBeDefined();
    });

    it('should identify most crash-prone agent', () => {
      const stats = service.getStats();
      expect(stats.mostCrashProne?.agent).toBe('agent-a');
      expect(stats.mostCrashProne?.count).toBe(2);
    });

    it('should include recent crashes', () => {
      const stats = service.getStats();
      expect(stats.recentCrashes.length).toBeLessThanOrEqual(10);
    });

    it('should detect patterns', () => {
      const stats = service.getStats();
      expect(Array.isArray(stats.patterns)).toBe(true);
    });
  });

  describe('getInsights', () => {
    it('should return health score', () => {
      const insights = service.getInsights();
      expect(insights.healthScore).toBeGreaterThanOrEqual(0);
      expect(insights.healthScore).toBeLessThanOrEqual(100);
    });

    it('should return summary', () => {
      const insights = service.getInsights();
      expect(typeof insights.summary).toBe('string');
    });

    it('should return stable summary when no crashes', () => {
      const insights = service.getInsights();
      expect(insights.summary).toContain('No crashes recorded');
    });

    it('should identify issues with OOM crashes', () => {
      // Record OOM crash
      vi.mocked(mockMemoryMonitor.getCrashContext!).mockReturnValueOnce({
        agentName: 'agent-a',
        pid: 111,
        crashTime: new Date(),
        lastKnownMemory: null,
        peakMemory: 2 * 1024 * 1024 * 1024,
        averageMemory: 0,
        memoryTrend: 'growing',
        recentHistory: [],
        likelyCause: 'oom',
        analysisNotes: [],
      });
      service.recordCrash({
        agentName: 'agent-a',
        pid: 111,
        exitCode: 137,
        signal: 'SIGKILL',
        reason: 'OOM',
      });

      const insights = service.getInsights();
      const oomIssue = insights.topIssues.find(i => i.issue.includes('out of memory'));
      expect(oomIssue).toBeDefined();
      expect(oomIssue?.severity).toBe('high');
    });

    it('should reduce health score for crashes', () => {
      // Record several crashes
      for (let i = 0; i < 5; i++) {
        service.recordCrash({
          agentName: 'agent',
          pid: i,
          exitCode: 1,
          signal: null,
          reason: 'Error',
        });
      }

      const insights = service.getInsights();
      expect(insights.healthScore).toBeLessThan(100);
    });

    it('should include trend information', () => {
      const insights = service.getInsights();
      expect(Array.isArray(insights.trends)).toBe(true);
    });
  });

  describe('crash analysis', () => {
    it('should detect OOM from exit code 137', () => {
      vi.mocked(mockMemoryMonitor.getCrashContext!).mockReturnValueOnce({
        agentName: 'test-agent',
        pid: 12345,
        crashTime: new Date(),
        lastKnownMemory: null,
        peakMemory: 0,
        averageMemory: 0,
        memoryTrend: 'unknown',
        recentHistory: [],
        likelyCause: 'unknown',
        analysisNotes: [],
      });

      const record = service.recordCrash({
        agentName: 'test-agent',
        pid: 12345,
        exitCode: 137,
        signal: 'SIGKILL',
        reason: 'Killed',
      });

      expect(record.analysis.likelyCause).toBe('oom');
    });

    it('should detect segfault from SIGSEGV', () => {
      vi.mocked(mockMemoryMonitor.getCrashContext!).mockReturnValueOnce({
        agentName: 'test-agent',
        pid: 12345,
        crashTime: new Date(),
        lastKnownMemory: null,
        peakMemory: 0,
        averageMemory: 0,
        memoryTrend: 'unknown',
        recentHistory: [],
        likelyCause: 'unknown',
        analysisNotes: [],
      });

      const record = service.recordCrash({
        agentName: 'test-agent',
        pid: 12345,
        exitCode: 139,
        signal: 'SIGSEGV',
        reason: 'Segfault',
      });

      expect(record.analysis.likelyCause).toBe('error');
    });

    it('should detect V8 heap failure from stack trace', () => {
      vi.mocked(mockMemoryMonitor.getCrashContext!).mockReturnValueOnce({
        agentName: 'test-agent',
        pid: 12345,
        crashTime: new Date(),
        lastKnownMemory: null,
        peakMemory: 0,
        averageMemory: 0,
        memoryTrend: 'unknown',
        recentHistory: [],
        likelyCause: 'unknown',
        analysisNotes: [],
      });

      const record = service.recordCrash({
        agentName: 'test-agent',
        pid: 12345,
        exitCode: 1,
        signal: null,
        reason: 'Error',
        stackTrace: 'FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory',
      });

      expect(record.analysis.likelyCause).toBe('oom');
      expect(record.analysis.confidence).toBe('high');
    });

    it('should provide recommendations', () => {
      const record = service.recordCrash({
        agentName: 'test-agent',
        pid: 12345,
        exitCode: 137,
        signal: 'SIGKILL',
        reason: 'Killed',
      });

      expect(record.analysis.recommendations.length).toBeGreaterThan(0);
    });
  });

  describe('setMemoryMonitor', () => {
    it('should allow setting memory monitor after construction', () => {
      const newService = new CrashInsightsService();
      const newMonitor = {
        getCrashContext: vi.fn().mockReturnValue({
          agentName: 'test',
          pid: 123,
          crashTime: new Date(),
          lastKnownMemory: null,
          peakMemory: 0,
          averageMemory: 0,
          memoryTrend: 'unknown',
          recentHistory: [],
          likelyCause: 'unknown',
          analysisNotes: [],
        }),
      } as unknown as AgentMemoryMonitor;

      newService.setMemoryMonitor(newMonitor);

      newService.recordCrash({
        agentName: 'test',
        pid: 123,
        exitCode: 1,
        signal: null,
        reason: 'Error',
      });

      expect(newMonitor.getCrashContext).toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('should clear all crashes', () => {
      service.recordCrash({
        agentName: 'test',
        pid: 123,
        exitCode: 1,
        signal: null,
        reason: 'Error',
      });

      service.clear();

      expect(service.getCrashHistory().length).toBe(0);
    });

    it('should emit cleared event', () => {
      const handler = vi.fn();
      service.on('cleared', handler);

      service.clear();

      expect(handler).toHaveBeenCalled();
    });
  });

  describe('persistence', () => {
    it('should save crashes to disk', () => {
      service.recordCrash({
        agentName: 'test',
        pid: 123,
        exitCode: 1,
        signal: null,
        reason: 'Error',
      });

      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled();
    });

    it('should create directory if it does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      service.recordCrash({
        agentName: 'test',
        pid: 123,
        exitCode: 1,
        signal: null,
        reason: 'Error',
      });

      expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalled();
    });

    it('should load crashes from disk on construction', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        crashes: [{
          id: 'crash-123',
          agentName: 'loaded-agent',
          pid: 456,
          crashTime: new Date().toISOString(),
          exitCode: 1,
          signal: null,
          reason: 'Loaded crash',
          memoryContext: {
            agentName: 'loaded-agent',
            pid: 456,
            crashTime: new Date().toISOString(),
            lastKnownMemory: null,
            peakMemory: 0,
            averageMemory: 0,
            memoryTrend: 'unknown',
            recentHistory: [],
            likelyCause: 'unknown',
            analysisNotes: [],
          },
          environment: {
            nodeVersion: 'v18.0.0',
            platform: 'linux',
            arch: 'x64',
            systemMemory: { total: 16000000000, free: 8000000000 },
            uptime: 3600,
          },
          analysis: {
            likelyCause: 'unknown',
            confidence: 'low',
            summary: 'Test crash',
            details: [],
            recommendations: [],
            relatedCrashes: [],
          },
        }],
      }));

      const loadedService = new CrashInsightsService();
      const history = loadedService.getCrashHistory();

      expect(history.length).toBe(1);
      expect(history[0].agentName).toBe('loaded-agent');
    });
  });
});

describe('getCrashInsights singleton', () => {
  it('should return same instance', () => {
    const instance1 = getCrashInsights();
    const instance2 = getCrashInsights();

    expect(instance1).toBe(instance2);
  });
});
