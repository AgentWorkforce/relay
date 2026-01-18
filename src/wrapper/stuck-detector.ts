/**
 * StuckDetector - Detect when an agent is stuck
 *
 * Implements agent-relay-501: Stuck detection heuristics
 *
 * Detects three stuck conditions:
 * 1. Extended idle (no output for 10+ minutes)
 * 2. Error loop (same error message repeated 3+ times)
 * 3. Output loop (same output pattern repeated 3+ times)
 *
 * Emits 'stuck' event when detected, with reason and details.
 */

import { EventEmitter } from 'node:events';

export type StuckReason = 'extended_idle' | 'error_loop' | 'output_loop';

export interface StuckEvent {
  reason: StuckReason;
  details: string;
  timestamp: number;
  /** Time since last output in ms (for extended_idle) */
  idleDurationMs?: number;
  /** Repeated content (for loops) */
  repeatedContent?: string;
  /** Number of repetitions (for loops) */
  repetitions?: number;
}

export interface StuckDetectorConfig {
  /** Duration of inactivity before considered stuck (ms, default: 10 minutes) */
  extendedIdleMs?: number;
  /** Number of repeated outputs before considered stuck (default: 3) */
  loopThreshold?: number;
  /** Check interval (ms, default: 30 seconds) */
  checkIntervalMs?: number;
  /** Minimum output length to consider for loop detection */
  minLoopLength?: number;
  /** Error patterns to detect (regexes) */
  errorPatterns?: RegExp[];
}

const DEFAULT_CONFIG: Required<StuckDetectorConfig> = {
  extendedIdleMs: 10 * 60 * 1000, // 10 minutes
  loopThreshold: 3,
  checkIntervalMs: 30 * 1000, // 30 seconds
  minLoopLength: 20, // Minimum chars to consider a meaningful loop
  errorPatterns: [
    /error:/i,
    /failed:/i,
    /exception:/i,
    /timeout/i,
    /connection refused/i,
    /permission denied/i,
    /command not found/i,
    /no such file/i,
  ],
};

export class StuckDetector extends EventEmitter {
  private config: Required<StuckDetectorConfig>;
  private lastOutputTime = Date.now();
  private recentOutputs: string[] = [];
  private checkInterval: NodeJS.Timeout | null = null;
  private isStuck = false;
  private stuckReason: StuckReason | null = null;

  constructor(config: StuckDetectorConfig = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start monitoring for stuck conditions.
   * Call this after the agent process starts.
   */
  start(): void {
    this.stop(); // Clear any existing interval
    this.isStuck = false;
    this.stuckReason = null;
    this.lastOutputTime = Date.now();
    this.recentOutputs = [];

    this.checkInterval = setInterval(() => {
      this.checkStuck();
    }, this.config.checkIntervalMs);
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Feed output to the detector.
   * Call this for every output chunk from the agent.
   */
  onOutput(chunk: string): void {
    this.lastOutputTime = Date.now();

    // Normalize and store recent output
    const normalized = this.normalizeOutput(chunk);
    if (normalized.length >= this.config.minLoopLength) {
      this.recentOutputs.push(normalized);

      // Keep only recent outputs (5x threshold for pattern detection)
      const maxOutputs = this.config.loopThreshold * 5;
      if (this.recentOutputs.length > maxOutputs) {
        this.recentOutputs = this.recentOutputs.slice(-maxOutputs);
      }
    }

    // If we were stuck, check if we're unstuck now
    if (this.isStuck) {
      this.isStuck = false;
      this.stuckReason = null;
      this.emit('unstuck', { timestamp: Date.now() });
    }
  }

  /**
   * Normalize output for comparison (strip ANSI, trim, lowercase).
   */
  private normalizeOutput(output: string): string {
    // Strip ANSI escape codes
    // eslint-disable-next-line no-control-regex
    let normalized = output.replace(/\x1B(?:\[[0-9;?]*[A-Za-z]|\].*?(?:\x07|\x1B\\)|[@-Z\\-_])/g, '');
    // Normalize whitespace
    normalized = normalized.replace(/\s+/g, ' ').trim().toLowerCase();
    return normalized;
  }

  /**
   * Check for stuck conditions.
   */
  private checkStuck(): void {
    // Don't re-emit if already stuck
    if (this.isStuck) return;

    // Check 1: Extended idle
    const idleDuration = Date.now() - this.lastOutputTime;
    if (idleDuration >= this.config.extendedIdleMs) {
      this.emitStuck({
        reason: 'extended_idle',
        details: `No output for ${Math.round(idleDuration / 60000)} minutes`,
        timestamp: Date.now(),
        idleDurationMs: idleDuration,
      });
      return;
    }

    // Check 2: Error loop
    const errorLoop = this.detectErrorLoop();
    if (errorLoop) {
      this.emitStuck({
        reason: 'error_loop',
        details: `Same error repeated ${errorLoop.count} times`,
        timestamp: Date.now(),
        repeatedContent: errorLoop.error,
        repetitions: errorLoop.count,
      });
      return;
    }

    // Check 3: Output loop
    const outputLoop = this.detectOutputLoop();
    if (outputLoop) {
      this.emitStuck({
        reason: 'output_loop',
        details: `Same output repeated ${outputLoop.count} times`,
        timestamp: Date.now(),
        repeatedContent: outputLoop.output.substring(0, 100),
        repetitions: outputLoop.count,
      });
      return;
    }
  }

  /**
   * Detect repeated error messages.
   */
  private detectErrorLoop(): { error: string; count: number } | null {
    const errorOutputs: string[] = [];

    for (const output of this.recentOutputs) {
      for (const pattern of this.config.errorPatterns) {
        if (pattern.test(output)) {
          errorOutputs.push(output);
          break;
        }
      }
    }

    if (errorOutputs.length < this.config.loopThreshold) {
      return null;
    }

    // Check if the same error appears repeatedly
    const errorCounts = new Map<string, number>();
    for (const error of errorOutputs) {
      const count = (errorCounts.get(error) || 0) + 1;
      errorCounts.set(error, count);

      if (count >= this.config.loopThreshold) {
        return { error, count };
      }
    }

    return null;
  }

  /**
   * Detect repeated output patterns (not necessarily errors).
   */
  private detectOutputLoop(): { output: string; count: number } | null {
    if (this.recentOutputs.length < this.config.loopThreshold) {
      return null;
    }

    // Check for identical consecutive outputs
    const outputCounts = new Map<string, number>();
    for (const output of this.recentOutputs) {
      const count = (outputCounts.get(output) || 0) + 1;
      outputCounts.set(output, count);

      if (count >= this.config.loopThreshold) {
        return { output, count };
      }
    }

    return null;
  }

  /**
   * Emit stuck event.
   */
  private emitStuck(event: StuckEvent): void {
    this.isStuck = true;
    this.stuckReason = event.reason;
    this.emit('stuck', event);
  }

  /**
   * Check if currently detected as stuck.
   */
  getIsStuck(): boolean {
    return this.isStuck;
  }

  /**
   * Get the reason for being stuck (if stuck).
   */
  getStuckReason(): StuckReason | null {
    return this.stuckReason;
  }

  /**
   * Get time since last output in milliseconds.
   */
  getIdleDuration(): number {
    return Date.now() - this.lastOutputTime;
  }

  /**
   * Reset state.
   */
  reset(): void {
    this.isStuck = false;
    this.stuckReason = null;
    this.lastOutputTime = Date.now();
    this.recentOutputs = [];
  }
}

/**
 * Create a stuck detector with default configuration.
 */
export function createStuckDetector(config: StuckDetectorConfig = {}): StuckDetector {
  return new StuckDetector(config);
}
