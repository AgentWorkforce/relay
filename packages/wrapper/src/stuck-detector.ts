/**
 * StuckDetector - Detect when an agent is stuck
 *
 * Implements agent-relay-501: Stuck detection heuristics
 *
 * Detects five stuck conditions:
 * 1. Extended idle (no output for 10+ minutes)
 * 2. Error loop (same error message repeated 3+ times)
 * 3. Output loop (same output pattern repeated 3+ times)
 * 4. Tool loop (same file operated on 10+ times in 5 minutes)
 * 5. Output flood (abnormally high output rate suggesting infinite loop)
 *
 * Emits 'stuck' event when detected, with reason and details.
 */

import { EventEmitter } from 'node:events';

export type StuckReason = 'extended_idle' | 'error_loop' | 'output_loop' | 'tool_loop' | 'output_flood';

/**
 * Tracked tool invocation for loop detection
 */
interface ToolInvocation {
  tool: string;      // 'Read', 'Write', 'Edit', 'Bash', etc.
  target: string;    // File path or command
  timestamp: number;
}

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
  /** Target file/command (for tool_loop) */
  targetFile?: string;
  /** Tool name (for tool_loop) */
  toolName?: string;
  /** Output rate in lines per minute (for output_flood) */
  linesPerMinute?: number;
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
  /** Threshold for same file operations before considered stuck (default: 10) */
  toolLoopThreshold?: number;
  /** Time window for tool loop detection (ms, default: 5 minutes) */
  toolLoopWindowMs?: number;
  /** Output lines per minute threshold for flood detection (default: 5000) */
  outputFloodLinesPerMinute?: number;
  /** Minimum duration before flood detection activates (ms, default: 2 minutes) */
  outputFloodMinDurationMs?: number;
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
  toolLoopThreshold: 10, // Same file operated on 10+ times = likely stuck
  toolLoopWindowMs: 5 * 60 * 1000, // 5 minute window for tool loop detection
  outputFloodLinesPerMinute: 5000, // 5000+ lines/min is abnormal
  outputFloodMinDurationMs: 2 * 60 * 1000, // Wait 2 minutes before flood detection
};

/** Patterns to extract tool invocations from Claude Code output */
const TOOL_PATTERNS = [
  // Claude Code tool patterns: ⏺ Write(path), ⏺ Read(path), etc.
  /[⏺●]\s*(Read|Write|Edit|Glob|Grep|Bash)\(([^)]+)\)/g,
  // Alternative patterns without symbols
  /\b(Read|Write|Edit)\s*\(\s*([^)]+)\s*\)/g,
];

export class StuckDetector extends EventEmitter {
  private config: Required<StuckDetectorConfig>;
  private lastOutputTime = Date.now();
  private recentOutputs: string[] = [];
  private checkInterval: NodeJS.Timeout | null = null;
  private isStuck = false;
  private stuckReason: StuckReason | null = null;

  // Tool loop detection
  private toolInvocations: ToolInvocation[] = [];

  // Output flood detection
  private outputLineCount = 0;
  private outputStartTime = Date.now();

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
    this.toolInvocations = [];
    this.outputLineCount = 0;
    this.outputStartTime = Date.now();

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

    // Track output volume (count newlines)
    const lineCount = (chunk.match(/\n/g) || []).length;
    this.outputLineCount += lineCount;

    // Extract and track tool invocations
    this.extractToolInvocations(chunk);

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
   * Extract tool invocations from output and track them.
   */
  private extractToolInvocations(chunk: string): void {
    const now = Date.now();

    // Strip ANSI codes for cleaner matching
    // eslint-disable-next-line no-control-regex
    const clean = chunk.replace(/\x1B(?:\[[0-9;?]*[A-Za-z]|\].*?(?:\x07|\x1B\\)|[@-Z\\-_])/g, '');

    // Track what we've already matched in this chunk to prevent duplicates
    const matchedInChunk = new Set<string>();

    for (const pattern of TOOL_PATTERNS) {
      // Reset lastIndex for global regex
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(clean)) !== null) {
        const tool = match[1];
        const target = match[2].trim();

        // Normalize file paths (remove ~ prefix, trailing whitespace)
        const normalizedTarget = target
          .replace(/^~\//, '')
          .replace(/\s+$/, '');

        // Deduplicate within this chunk (multiple patterns may match same invocation)
        const key = `${tool}:${normalizedTarget}`;
        if (matchedInChunk.has(key)) continue;
        matchedInChunk.add(key);

        this.toolInvocations.push({
          tool,
          target: normalizedTarget,
          timestamp: now,
        });
      }
    }

    // Prune old invocations outside the window
    const windowStart = now - this.config.toolLoopWindowMs;
    this.toolInvocations = this.toolInvocations.filter(
      inv => inv.timestamp >= windowStart
    );
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

    // Check 4: Tool loop (same file operated on repeatedly)
    const toolLoop = this.detectToolLoop();
    if (toolLoop) {
      this.emitStuck({
        reason: 'tool_loop',
        details: `${toolLoop.tool} called on "${toolLoop.target}" ${toolLoop.count} times in ${Math.round(this.config.toolLoopWindowMs / 60000)} minutes`,
        timestamp: Date.now(),
        targetFile: toolLoop.target,
        toolName: toolLoop.tool,
        repetitions: toolLoop.count,
      });
      return;
    }

    // Check 5: Output flood (abnormally high output rate)
    const flood = this.detectOutputFlood();
    if (flood) {
      this.emitStuck({
        reason: 'output_flood',
        details: `Abnormally high output: ${flood.linesPerMinute.toFixed(0)} lines/min over ${Math.round(flood.durationMs / 60000)} minutes`,
        timestamp: Date.now(),
        linesPerMinute: flood.linesPerMinute,
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
   * Detect when the same file is being operated on repeatedly.
   * This catches cases like an agent repeatedly reading/writing the same file
   * in a loop, even if the output content differs each time.
   */
  private detectToolLoop(): { tool: string; target: string; count: number } | null {
    if (this.toolInvocations.length < this.config.toolLoopThreshold) {
      return null;
    }

    // Count operations per file (combining all tool types)
    const fileCounts = new Map<string, { count: number; tools: Set<string> }>();

    for (const inv of this.toolInvocations) {
      const existing = fileCounts.get(inv.target);
      if (existing) {
        existing.count++;
        existing.tools.add(inv.tool);
      } else {
        fileCounts.set(inv.target, { count: 1, tools: new Set([inv.tool]) });
      }
    }

    // Find files that exceed the threshold
    for (const [target, data] of Array.from(fileCounts.entries())) {
      if (data.count >= this.config.toolLoopThreshold) {
        // Report the most common tool used on this file
        const toolCounts = new Map<string, number>();
        for (const inv of this.toolInvocations) {
          if (inv.target === target) {
            toolCounts.set(inv.tool, (toolCounts.get(inv.tool) || 0) + 1);
          }
        }

        let maxTool = 'Unknown';
        let maxCount = 0;
        for (const [tool, toolCount] of Array.from(toolCounts.entries())) {
          if (toolCount > maxCount) {
            maxTool = tool;
            maxCount = toolCount;
          }
        }

        return { tool: maxTool, target, count: data.count };
      }
    }

    return null;
  }

  /**
   * Detect abnormally high output rates that suggest an infinite loop.
   * Only triggers after minimum duration to avoid false positives during
   * normal high-output operations (like builds or tests).
   */
  private detectOutputFlood(): { linesPerMinute: number; durationMs: number } | null {
    const durationMs = Date.now() - this.outputStartTime;

    // Don't check until minimum duration has passed
    if (durationMs < this.config.outputFloodMinDurationMs) {
      return null;
    }

    const durationMinutes = durationMs / 60000;
    const linesPerMinute = this.outputLineCount / durationMinutes;

    if (linesPerMinute >= this.config.outputFloodLinesPerMinute) {
      return { linesPerMinute, durationMs };
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
    this.toolInvocations = [];
    this.outputLineCount = 0;
    this.outputStartTime = Date.now();
  }

  /**
   * Get current output statistics (useful for debugging).
   */
  getOutputStats(): { lineCount: number; durationMs: number; linesPerMinute: number } {
    const durationMs = Date.now() - this.outputStartTime;
    const durationMinutes = Math.max(durationMs / 60000, 0.001); // Avoid division by zero
    return {
      lineCount: this.outputLineCount,
      durationMs,
      linesPerMinute: this.outputLineCount / durationMinutes,
    };
  }

  /**
   * Get recent tool invocations (useful for debugging).
   */
  getToolInvocations(): ToolInvocation[] {
    return [...this.toolInvocations];
  }
}

/**
 * Create a stuck detector with default configuration.
 */
export function createStuckDetector(config: StuckDetectorConfig = {}): StuckDetector {
  return new StuckDetector(config);
}
