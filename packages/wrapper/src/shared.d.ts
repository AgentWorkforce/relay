/**
 * Shared types and utilities for TmuxWrapper and PtyWrapper
 *
 * This module contains common code to prevent drift between the two
 * wrapper implementations and reduce duplication.
 */
import type { SyncMeta } from '@relay/protocol/types';
/**
 * Message queued for injection into an agent's terminal
 */
export interface QueuedMessage {
    from: string;
    body: string;
    messageId: string;
    thread?: string;
    importance?: number;
    data?: Record<string, unknown>;
    sync?: SyncMeta;
    /** Original 'to' field - '*' indicates broadcast */
    originalTo?: string;
}
/**
 * Result of an injection attempt with retry
 */
export interface InjectionResult {
    success: boolean;
    attempts: number;
    fallbackUsed?: boolean;
}
/**
 * Metrics tracking injection reliability
 */
export interface InjectionMetrics {
    total: number;
    successFirstTry: number;
    successWithRetry: number;
    failed: number;
}
/**
 * CLI types for special handling
 */
export type CliType = 'claude' | 'codex' | 'gemini' | 'droid' | 'opencode' | 'cursor' | 'spawned' | 'other';
/**
 * Injection timing constants
 */
export declare const INJECTION_CONSTANTS: {
    /** Maximum retry attempts for injection */
    readonly MAX_RETRIES: 3;
    /** Timeout for output stability check (ms) */
    readonly STABILITY_TIMEOUT_MS: 3000;
    /** Polling interval for stability check (ms) */
    readonly STABILITY_POLL_MS: 200;
    /** Required consecutive stable polls before injection */
    readonly REQUIRED_STABLE_POLLS: 2;
    /** Timeout for injection verification (ms) */
    readonly VERIFICATION_TIMEOUT_MS: 2000;
    /** Delay between message and Enter key (ms) */
    readonly ENTER_DELAY_MS: 100;
    /** Backoff multiplier for retries (ms per attempt) */
    readonly RETRY_BACKOFF_MS: 300;
    /** Delay between processing queued messages (ms) */
    readonly QUEUE_PROCESS_DELAY_MS: 500;
};
/**
 * Strip ANSI escape codes from a string.
 * Converts cursor movements to spaces to preserve visual layout.
 */
export declare function stripAnsi(str: string): string;
/**
 * Sleep for a given number of milliseconds
 */
export declare function sleep(ms: number): Promise<void>;
/**
 * Build the injection string for a relay message.
 * Format: Relay message from {from} [{shortId}]{hints}: {body}
 *
 * If the body is already formatted (starts with "Relay message from"),
 * returns it as-is to prevent double-wrapping.
 */
export declare function buildInjectionString(msg: QueuedMessage): string;
/**
 * Calculate injection success rate from metrics
 */
export declare function calculateSuccessRate(metrics: InjectionMetrics): number;
/**
 * Create a fresh injection metrics object
 */
export declare function createInjectionMetrics(): InjectionMetrics;
/**
 * Detect CLI type from command string
 */
export declare function detectCliType(command: string): CliType;
/**
 * Get the default relay prefix (unified for all agent types)
 */
export declare function getDefaultRelayPrefix(): string;
/**
 * CLI-specific quirks and handling
 */
export declare const CLI_QUIRKS: {
    /**
     * CLIs that support bracketed paste mode.
     * Others may interpret the escape sequences literally.
     */
    readonly supportsBracketedPaste: (cli: CliType) => boolean;
    /**
     * Gemini interprets certain keywords (While, For, If, etc.) as shell commands.
     * Wrap message in backticks to prevent shell keyword interpretation.
     */
    readonly wrapForGemini: (body: string) => string;
    /**
     * Get prompt pattern regex for a CLI type.
     * Used to detect when input line is clear.
     */
    readonly getPromptPattern: (cli: CliType) => RegExp;
    /**
     * Check if a line looks like a shell prompt (for Gemini safety check).
     * Gemini can drop into shell mode - we skip injection to avoid executing commands.
     */
    readonly isShellPrompt: (line: string) => boolean;
};
/**
 * Callbacks for wrapper-specific injection operations.
 * These allow the shared injection logic to work with both
 * TmuxWrapper (tmux paste) and PtyWrapper (PTY write).
 */
export interface InjectionCallbacks {
    /** Get current output content for verification */
    getOutput: () => Promise<string>;
    /** Perform the actual injection (write to terminal) */
    performInjection: (injection: string) => Promise<void>;
    /** Log a message (debug/info level) */
    log: (message: string) => void;
    /** Log an error message */
    logError: (message: string) => void;
    /** Get the injection metrics object to update */
    getMetrics: () => InjectionMetrics;
    /**
     * Skip verification and trust that write succeeded.
     * Set to true for PTY-based injection where CLIs don't echo input.
     * When true, injection succeeds on first attempt without verification.
     */
    skipVerification?: boolean;
}
/**
 * Verify that an injected message appeared in the output.
 * Uses a callback to get output content, allowing different backends
 * (tmux capture-pane, PTY buffer) to be used.
 *
 * @param shortId - First 8 chars of message ID
 * @param from - Sender name
 * @param getOutput - Callback to retrieve current output
 * @returns true if message pattern found in output
 */
export declare function verifyInjection(shortId: string, from: string, getOutput: () => Promise<string>): Promise<boolean>;
/**
 * Inject a message with retry logic and verification.
 * Includes dedup check to prevent double-injection race condition.
 *
 * This consolidates the retry/verification logic that was duplicated
 * in TmuxWrapper and PtyWrapper.
 *
 * @param injection - The formatted injection string
 * @param shortId - First 8 chars of message ID for verification
 * @param from - Sender name for verification pattern
 * @param callbacks - Wrapper-specific callbacks for injection operations
 * @returns Result indicating success/failure and attempt count
 */
export declare function injectWithRetry(injection: string, shortId: string, from: string, callbacks: InjectionCallbacks): Promise<InjectionResult>;
//# sourceMappingURL=shared.d.ts.map