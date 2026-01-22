/**
 * UniversalIdleDetector - Detect when an agent is waiting for input
 *
 * Works across all CLI tools (Claude, Codex, Gemini, Aider, etc.) by combining:
 * 1. Process state inspection via /proc/{pid}/stat (Linux, 95% confidence)
 * 2. Output silence analysis (cross-platform, 60-80% confidence)
 * 3. Natural ending detection (heuristic, 60% confidence)
 *
 * The hybrid approach ensures reliable idle detection regardless of CLI type.
 */
export interface IdleSignal {
    source: 'process_state' | 'output_silence' | 'natural_ending';
    confidence: number;
    timestamp: number;
    details?: string;
}
export interface IdleResult {
    isIdle: boolean;
    confidence: number;
    signals: IdleSignal[];
}
export interface IdleDetectorConfig {
    /** Minimum silence duration to consider for idle (ms) */
    minSilenceMs?: number;
    /** Output buffer size limit */
    bufferLimit?: number;
    /** Confidence threshold for idle detection (0-1) */
    confidenceThreshold?: number;
}
/**
 * Universal idle detector for any CLI-based agent.
 */
export declare class UniversalIdleDetector {
    private lastOutputTime;
    private outputBuffer;
    private pid;
    private config;
    constructor(config?: IdleDetectorConfig);
    /**
     * Set the PID of the agent process to monitor.
     * Required for Linux process state inspection.
     */
    setPid(pid: number): void;
    /**
     * Get the current PID being monitored.
     */
    getPid(): number | null;
    /**
     * Process output chunk from the agent.
     * Call this for every output received from the agent process.
     */
    onOutput(chunk: string): void;
    /**
     * Check if the agent process is blocked on read (waiting for input).
     * This is the most reliable signal - the OS knows when a process is waiting.
     *
     * Linux-only; returns null on other platforms.
     */
    private isProcessWaitingForInput;
    /**
     * Get milliseconds since last output.
     */
    private getOutputSilenceMs;
    /**
     * Check if the last output ends "naturally" (complete thought vs mid-sentence).
     * Helps distinguish between pauses in output and waiting for input.
     */
    private hasNaturalEnding;
    /**
     * Determine if the agent is idle and ready for input.
     * Combines multiple signals for reliability across all CLI types.
     */
    checkIdle(options?: {
        minSilenceMs?: number;
    }): IdleResult;
    /**
     * Wait for idle state with timeout.
     * Returns the idle result when achieved or after timeout.
     */
    waitForIdle(timeoutMs?: number, pollMs?: number): Promise<IdleResult>;
    /**
     * Reset state (call when agent starts new response).
     */
    reset(): void;
    /**
     * Get time since last output in milliseconds.
     */
    getTimeSinceLastOutput(): number;
}
/**
 * Get the PID of a process running in a tmux pane.
 * Uses tmux list-panes with format specifier.
 */
export declare function getTmuxPanePid(tmuxPath: string, sessionName: string): Promise<number | null>;
/**
 * Create an idle detector configured for the current platform.
 * Logs a warning on non-Linux platforms where process state inspection isn't available.
 */
export declare function createIdleDetector(config?: IdleDetectorConfig, options?: {
    quiet?: boolean;
}): UniversalIdleDetector;
//# sourceMappingURL=idle-detector.d.ts.map