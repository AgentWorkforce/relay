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
export declare class StuckDetector extends EventEmitter {
    private config;
    private lastOutputTime;
    private recentOutputs;
    private checkInterval;
    private isStuck;
    private stuckReason;
    constructor(config?: StuckDetectorConfig);
    /**
     * Start monitoring for stuck conditions.
     * Call this after the agent process starts.
     */
    start(): void;
    /**
     * Stop monitoring.
     */
    stop(): void;
    /**
     * Feed output to the detector.
     * Call this for every output chunk from the agent.
     */
    onOutput(chunk: string): void;
    /**
     * Normalize output for comparison (strip ANSI, trim, lowercase).
     */
    private normalizeOutput;
    /**
     * Check for stuck conditions.
     */
    private checkStuck;
    /**
     * Detect repeated error messages.
     */
    private detectErrorLoop;
    /**
     * Detect repeated output patterns (not necessarily errors).
     */
    private detectOutputLoop;
    /**
     * Emit stuck event.
     */
    private emitStuck;
    /**
     * Check if currently detected as stuck.
     */
    getIsStuck(): boolean;
    /**
     * Get the reason for being stuck (if stuck).
     */
    getStuckReason(): StuckReason | null;
    /**
     * Get time since last output in milliseconds.
     */
    getIdleDuration(): number;
    /**
     * Reset state.
     */
    reset(): void;
}
/**
 * Create a stuck detector with default configuration.
 */
export declare function createStuckDetector(config?: StuckDetectorConfig): StuckDetector;
//# sourceMappingURL=stuck-detector.d.ts.map