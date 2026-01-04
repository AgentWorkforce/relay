/**
 * Crash Insights Service
 *
 * Captures and analyzes agent crashes to provide actionable insights:
 * - Memory state at crash time
 * - Crash history and patterns
 * - Root cause analysis
 * - Recommendations for prevention
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentMemoryMonitor,
  CrashMemoryContext,
  formatBytes,
} from './memory-monitor.js';

export interface CrashRecord {
  id: string;
  agentName: string;
  pid: number;
  crashTime: Date;
  exitCode: number | null;
  signal: string | null;
  reason: string;
  memoryContext: CrashMemoryContext;
  stackTrace?: string;
  lastOutput?: string;
  environment: {
    nodeVersion: string;
    platform: string;
    arch: string;
    systemMemory: { total: number; free: number };
    uptime: number;
  };
  analysis: CrashAnalysis;
}

export interface CrashAnalysis {
  likelyCause: 'oom' | 'memory_leak' | 'sudden_spike' | 'signal' | 'error' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  details: string[];
  recommendations: string[];
  relatedCrashes: string[]; // IDs of similar crashes
}

export interface CrashPattern {
  pattern: string;
  occurrences: number;
  lastSeen: Date;
  affectedAgents: string[];
  avgMemoryAtCrash: number;
  commonCause: string;
}

export interface CrashStats {
  totalCrashes: number;
  crashesByAgent: Record<string, number>;
  crashesByCause: Record<string, number>;
  avgTimeBetweenCrashes: number;
  mostCrashProne: { agent: string; count: number } | null;
  recentCrashes: CrashRecord[];
  patterns: CrashPattern[];
}

export class CrashInsightsService extends EventEmitter {
  private crashes: CrashRecord[] = [];
  private memoryMonitor: AgentMemoryMonitor | null = null;
  private persistPath: string;
  private maxCrashHistory = 1000;

  constructor(memoryMonitor?: AgentMemoryMonitor) {
    super();
    this.memoryMonitor = memoryMonitor || null;

    // Set up persistence path
    const dataDir =
      process.env.AGENT_RELAY_DATA_DIR ||
      path.join(os.homedir(), '.local', 'share', 'agent-relay');
    this.persistPath = path.join(dataDir, 'crash-insights.json');

    // Load existing crash history
    this.loadCrashes();
  }

  /**
   * Set the memory monitor instance
   */
  setMemoryMonitor(monitor: AgentMemoryMonitor): void {
    this.memoryMonitor = monitor;
  }

  /**
   * Record a crash event
   */
  recordCrash(params: {
    agentName: string;
    pid: number;
    exitCode: number | null;
    signal: string | null;
    reason: string;
    stackTrace?: string;
    lastOutput?: string;
  }): CrashRecord {
    const id = `crash-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const crashTime = new Date();

    // Get memory context from memory monitor
    const memoryContext = this.memoryMonitor
      ? this.memoryMonitor.getCrashContext(params.agentName)
      : this.createEmptyMemoryContext(params.agentName, params.pid, crashTime);

    // Analyze the crash
    const analysis = this.analyzeCrash({
      ...params,
      memoryContext,
    });

    const record: CrashRecord = {
      id,
      agentName: params.agentName,
      pid: params.pid,
      crashTime,
      exitCode: params.exitCode,
      signal: params.signal,
      reason: params.reason,
      memoryContext,
      stackTrace: params.stackTrace,
      lastOutput: params.lastOutput?.slice(-2000), // Keep last 2KB
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        systemMemory: {
          total: os.totalmem(),
          free: os.freemem(),
        },
        uptime: process.uptime(),
      },
      analysis,
    };

    // Add to history
    this.crashes.unshift(record);

    // Trim history
    if (this.crashes.length > this.maxCrashHistory) {
      this.crashes = this.crashes.slice(0, this.maxCrashHistory);
    }

    // Persist
    this.saveCrashes();

    // Emit event
    this.emit('crash', record);

    this.log('error', `Crash recorded for ${params.agentName}`, {
      id,
      cause: analysis.likelyCause,
      confidence: analysis.confidence,
    });

    return record;
  }

  /**
   * Get crash history for an agent
   */
  getCrashHistory(agentName?: string, limit = 50): CrashRecord[] {
    let history = this.crashes;
    if (agentName) {
      history = history.filter((c) => c.agentName === agentName);
    }
    return history.slice(0, limit);
  }

  /**
   * Get a specific crash record
   */
  getCrash(id: string): CrashRecord | undefined {
    return this.crashes.find((c) => c.id === id);
  }

  /**
   * Get crash statistics
   */
  getStats(): CrashStats {
    const crashesByAgent: Record<string, number> = {};
    const crashesByCause: Record<string, number> = {};
    const agentCrashTimes: Record<string, number[]> = {};

    for (const crash of this.crashes) {
      crashesByAgent[crash.agentName] = (crashesByAgent[crash.agentName] || 0) + 1;
      crashesByCause[crash.analysis.likelyCause] =
        (crashesByCause[crash.analysis.likelyCause] || 0) + 1;

      if (!agentCrashTimes[crash.agentName]) {
        agentCrashTimes[crash.agentName] = [];
      }
      agentCrashTimes[crash.agentName].push(crash.crashTime.getTime());
    }

    // Find most crash-prone agent
    let mostCrashProne: { agent: string; count: number } | null = null;
    for (const [agent, count] of Object.entries(crashesByAgent)) {
      if (!mostCrashProne || count > mostCrashProne.count) {
        mostCrashProne = { agent, count };
      }
    }

    // Calculate average time between crashes
    let totalIntervals = 0;
    let intervalCount = 0;
    for (const times of Object.values(agentCrashTimes)) {
      if (times.length > 1) {
        const sorted = times.sort((a, b) => a - b);
        for (let i = 1; i < sorted.length; i++) {
          totalIntervals += sorted[i] - sorted[i - 1];
          intervalCount++;
        }
      }
    }

    const avgTimeBetweenCrashes = intervalCount > 0 ? totalIntervals / intervalCount : 0;

    // Detect patterns
    const patterns = this.detectPatterns();

    return {
      totalCrashes: this.crashes.length,
      crashesByAgent,
      crashesByCause,
      avgTimeBetweenCrashes,
      mostCrashProne,
      recentCrashes: this.crashes.slice(0, 10),
      patterns,
    };
  }

  /**
   * Get insights and recommendations
   */
  getInsights(): {
    summary: string;
    topIssues: Array<{ issue: string; severity: 'high' | 'medium' | 'low'; recommendation: string }>;
    healthScore: number;
    trends: Array<{ metric: string; trend: 'improving' | 'stable' | 'degrading'; details: string }>;
  } {
    const stats = this.getStats();
    const issues: Array<{ issue: string; severity: 'high' | 'medium' | 'low'; recommendation: string }> = [];
    const trends: Array<{ metric: string; trend: 'improving' | 'stable' | 'degrading'; details: string }> = [];

    // Analyze OOM crashes
    const oomCrashes = stats.crashesByCause['oom'] || 0;
    if (oomCrashes > 0) {
      issues.push({
        issue: `${oomCrashes} crash${oomCrashes > 1 ? 'es' : ''} caused by out of memory`,
        severity: 'high',
        recommendation: 'Increase memory limits or optimize agent memory usage',
      });
    }

    // Analyze memory leaks
    const leakCrashes = stats.crashesByCause['memory_leak'] || 0;
    if (leakCrashes > 0) {
      issues.push({
        issue: `${leakCrashes} crash${leakCrashes > 1 ? 'es' : ''} likely caused by memory leaks`,
        severity: 'high',
        recommendation: 'Investigate agent code for memory leaks, consider periodic restarts',
      });
    }

    // Check crash frequency
    const recentCrashes = this.crashes.filter(
      (c) => Date.now() - c.crashTime.getTime() < 24 * 60 * 60 * 1000
    ).length;
    if (recentCrashes > 5) {
      issues.push({
        issue: `${recentCrashes} crashes in the last 24 hours`,
        severity: recentCrashes > 10 ? 'high' : 'medium',
        recommendation: 'Investigate root cause, consider rolling back recent changes',
      });
    }

    // Check repeat offenders
    if (stats.mostCrashProne && stats.mostCrashProne.count > 5) {
      issues.push({
        issue: `Agent "${stats.mostCrashProne.agent}" has crashed ${stats.mostCrashProne.count} times`,
        severity: 'medium',
        recommendation: 'Investigate why this agent is unstable',
      });
    }

    // Calculate health score (0-100)
    let healthScore = 100;
    healthScore -= oomCrashes * 10;
    healthScore -= leakCrashes * 8;
    healthScore -= recentCrashes * 3;
    healthScore = Math.max(0, Math.min(100, healthScore));

    // Analyze trends
    const last24h = this.crashes.filter(
      (c) => Date.now() - c.crashTime.getTime() < 24 * 60 * 60 * 1000
    ).length;
    const prev24h = this.crashes.filter(
      (c) =>
        Date.now() - c.crashTime.getTime() >= 24 * 60 * 60 * 1000 &&
        Date.now() - c.crashTime.getTime() < 48 * 60 * 60 * 1000
    ).length;

    let crashTrend: 'improving' | 'stable' | 'degrading' = 'stable';
    if (last24h < prev24h * 0.7) crashTrend = 'improving';
    else if (last24h > prev24h * 1.3) crashTrend = 'degrading';

    trends.push({
      metric: 'Crash frequency',
      trend: crashTrend,
      details: `${last24h} crashes in last 24h vs ${prev24h} in previous 24h`,
    });

    return {
      summary: this.generateSummary(stats),
      topIssues: issues.sort((a, b) => {
        const severityOrder = { high: 0, medium: 1, low: 2 };
        return severityOrder[a.severity] - severityOrder[b.severity];
      }),
      healthScore,
      trends,
    };
  }

  /**
   * Analyze a crash and determine likely cause
   */
  private analyzeCrash(params: {
    agentName: string;
    pid: number;
    exitCode: number | null;
    signal: string | null;
    reason: string;
    memoryContext: CrashMemoryContext;
    stackTrace?: string;
  }): CrashAnalysis {
    const details: string[] = [];
    const recommendations: string[] = [];
    let likelyCause: CrashAnalysis['likelyCause'] = 'unknown';
    let confidence: CrashAnalysis['confidence'] = 'low';

    // Check memory-based causes first
    if (params.memoryContext.likelyCause !== 'unknown') {
      likelyCause = params.memoryContext.likelyCause;
      confidence = 'high';
      details.push(...params.memoryContext.analysisNotes);
    }

    // Check signal
    if (params.signal) {
      details.push(`Process received signal: ${params.signal}`);
      if (params.signal === 'SIGKILL') {
        if (likelyCause === 'unknown') {
          likelyCause = 'oom';
          confidence = 'medium';
        }
        details.push('SIGKILL often indicates OOM killer intervention');
        recommendations.push('Check system logs for OOM killer activity');
      } else if (params.signal === 'SIGSEGV') {
        likelyCause = 'error';
        confidence = 'high';
        details.push('Segmentation fault - memory access violation');
        recommendations.push('Check for native module issues or memory corruption');
      }
    }

    // Check exit code
    if (params.exitCode !== null) {
      details.push(`Exit code: ${params.exitCode}`);
      if (params.exitCode === 137) {
        // 128 + 9 (SIGKILL)
        if (likelyCause === 'unknown') {
          likelyCause = 'oom';
          confidence = 'high';
        }
        details.push('Exit code 137 typically indicates OOM kill');
      }
    }

    // Check stack trace for clues
    if (params.stackTrace) {
      if (params.stackTrace.includes('FATAL ERROR: CALL_AND_RETRY_LAST')) {
        likelyCause = 'oom';
        confidence = 'high';
        details.push('V8 heap allocation failure detected');
        recommendations.push('Increase Node.js memory limit with --max-old-space-size');
      }
      if (params.stackTrace.includes('RangeError: Invalid array length')) {
        likelyCause = 'memory_leak';
        confidence = 'medium';
        details.push('Array grew too large - possible unbounded growth');
        recommendations.push('Review array handling code for unbounded growth');
      }
    }

    // Add memory-specific recommendations
    if (likelyCause === 'oom' || likelyCause === 'memory_leak') {
      recommendations.push('Review agent memory usage patterns');
      recommendations.push('Consider implementing memory limits or checkpoints');
      if (params.memoryContext.peakMemory > 1024 * 1024 * 1024) {
        recommendations.push(
          `Peak memory was ${formatBytes(params.memoryContext.peakMemory)} - consider memory profiling`
        );
      }
    }

    // Find related crashes
    const relatedCrashes = this.findRelatedCrashes(params.agentName, likelyCause);

    // Generate summary
    const summary = this.generateCrashSummary(likelyCause, confidence, params);

    return {
      likelyCause,
      confidence,
      summary,
      details,
      recommendations:
        recommendations.length > 0
          ? recommendations
          : ['Monitor agent for recurrence', 'Check logs for additional context'],
      relatedCrashes,
    };
  }

  /**
   * Find related crashes
   */
  private findRelatedCrashes(agentName: string, cause: string): string[] {
    return this.crashes
      .filter(
        (c) =>
          (c.agentName === agentName || c.analysis.likelyCause === cause) &&
          Date.now() - c.crashTime.getTime() < 7 * 24 * 60 * 60 * 1000 // Last 7 days
      )
      .slice(0, 5)
      .map((c) => c.id);
  }

  /**
   * Detect crash patterns
   */
  private detectPatterns(): CrashPattern[] {
    const patterns: CrashPattern[] = [];
    const causeGroups: Record<string, CrashRecord[]> = {};

    // Group by cause
    for (const crash of this.crashes) {
      const cause = crash.analysis.likelyCause;
      if (!causeGroups[cause]) {
        causeGroups[cause] = [];
      }
      causeGroups[cause].push(crash);
    }

    // Create patterns for significant groups
    for (const [cause, crashes] of Object.entries(causeGroups)) {
      if (crashes.length >= 3) {
        const agents = [...new Set(crashes.map((c) => c.agentName))];
        const avgMemory =
          crashes.reduce((sum, c) => sum + (c.memoryContext.peakMemory || 0), 0) /
          crashes.length;

        patterns.push({
          pattern: `${cause}_pattern`,
          occurrences: crashes.length,
          lastSeen: crashes[0].crashTime,
          affectedAgents: agents,
          avgMemoryAtCrash: avgMemory,
          commonCause: cause,
        });
      }
    }

    return patterns;
  }

  /**
   * Generate crash summary
   */
  private generateCrashSummary(
    cause: string,
    confidence: string,
    params: { agentName: string; reason: string }
  ): string {
    const causeDescriptions: Record<string, string> = {
      oom: 'ran out of memory',
      memory_leak: 'experienced a memory leak',
      sudden_spike: 'had a sudden memory spike',
      signal: 'was terminated by a signal',
      error: 'encountered an error',
      unknown: 'crashed for unknown reasons',
    };

    return `Agent "${params.agentName}" ${causeDescriptions[cause] || 'crashed'} (${confidence} confidence). ${params.reason}`;
  }

  /**
   * Generate overall summary
   */
  private generateSummary(stats: CrashStats): string {
    if (stats.totalCrashes === 0) {
      return 'No crashes recorded. System is stable.';
    }

    const parts: string[] = [];
    parts.push(`${stats.totalCrashes} total crash${stats.totalCrashes > 1 ? 'es' : ''} recorded.`);

    if (stats.mostCrashProne) {
      parts.push(
        `Most unstable: "${stats.mostCrashProne.agent}" (${stats.mostCrashProne.count} crashes).`
      );
    }

    const topCause = Object.entries(stats.crashesByCause).sort((a, b) => b[1] - a[1])[0];
    if (topCause) {
      parts.push(`Primary cause: ${topCause[0]} (${topCause[1]} occurrences).`);
    }

    return parts.join(' ');
  }

  /**
   * Create empty memory context when no monitor available
   */
  private createEmptyMemoryContext(
    agentName: string,
    pid: number,
    crashTime: Date
  ): CrashMemoryContext {
    return {
      agentName,
      pid,
      crashTime,
      lastKnownMemory: null,
      peakMemory: 0,
      averageMemory: 0,
      memoryTrend: 'unknown',
      recentHistory: [],
      likelyCause: 'unknown',
      analysisNotes: ['Memory monitoring was not enabled'],
    };
  }

  /**
   * Load crashes from disk
   */
  private loadCrashes(): void {
    try {
      if (fs.existsSync(this.persistPath)) {
        const data = fs.readFileSync(this.persistPath, 'utf-8');
        const parsed = JSON.parse(data);
        this.crashes = parsed.crashes.map((c: any) => ({
          ...c,
          crashTime: new Date(c.crashTime),
          memoryContext: {
            ...c.memoryContext,
            crashTime: new Date(c.memoryContext.crashTime),
            lastKnownMemory: c.memoryContext.lastKnownMemory
              ? {
                  ...c.memoryContext.lastKnownMemory,
                  timestamp: new Date(c.memoryContext.lastKnownMemory.timestamp),
                }
              : null,
            recentHistory: c.memoryContext.recentHistory.map((h: any) => ({
              ...h,
              timestamp: new Date(h.timestamp),
            })),
          },
        }));
        this.log('info', `Loaded ${this.crashes.length} crash records`);
      }
    } catch (error) {
      this.log('warn', 'Failed to load crash history', { error: String(error) });
      this.crashes = [];
    }
  }

  /**
   * Save crashes to disk
   */
  private saveCrashes(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        this.persistPath,
        JSON.stringify({ crashes: this.crashes }, null, 2)
      );
    } catch (error) {
      this.log('error', 'Failed to save crash history', { error: String(error) });
    }
  }

  /**
   * Clear all crash history
   */
  clear(): void {
    this.crashes = [];
    this.saveCrashes();
    this.emit('cleared');
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
      component: 'crash-insights',
      message,
      ...context,
    };

    this.emit('log', entry);

    const prefix = `[crash-insights]`;
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
let _crashInsights: CrashInsightsService | null = null;

export function getCrashInsights(
  memoryMonitor?: AgentMemoryMonitor
): CrashInsightsService {
  if (!_crashInsights) {
    _crashInsights = new CrashInsightsService(memoryMonitor);
  }
  return _crashInsights;
}
