/**
 * Shared types and utilities for TmuxWrapper and PtyWrapper
 *
 * This module contains common code to prevent drift between the two
 * wrapper implementations and reduce duplication.
 */

import type { SyncMeta } from '@agent-relay/protocol/types';

/**
 * Message priority levels for queue ordering.
 * Lower numbers = higher priority (processed first).
 */
export const MESSAGE_PRIORITY = {
  /** System-critical messages (sync ACKs, errors) - skip idle wait */
  URGENT: 0,
  /** Time-sensitive messages (user requests) - reduced idle wait */
  HIGH: 1,
  /** Normal agent-to-agent messages */
  NORMAL: 2,
  /** Batch/background messages - can wait longer */
  LOW: 3,
} as const;

export type MessagePriority = typeof MESSAGE_PRIORITY[keyof typeof MESSAGE_PRIORITY];

/**
 * Get priority from importance value or default to NORMAL.
 * Maps importance number to priority level.
 */
export function getPriorityFromImportance(importance?: number): MessagePriority {
  if (importance === undefined) return MESSAGE_PRIORITY.NORMAL;
  if (importance >= 90) return MESSAGE_PRIORITY.URGENT;
  if (importance >= 70) return MESSAGE_PRIORITY.HIGH;
  if (importance >= 30) return MESSAGE_PRIORITY.NORMAL;
  return MESSAGE_PRIORITY.LOW;
}

/**
 * Sort messages by priority (lower number = higher priority).
 * Stable sort - maintains order within same priority.
 */
export function sortByPriority(messages: QueuedMessage[]): QueuedMessage[] {
  return [...messages].sort((a, b) => {
    const priorityA = getPriorityFromImportance(a.importance);
    const priorityB = getPriorityFromImportance(b.importance);
    return priorityA - priorityB;
  });
}

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
 *
 * Performance tuning (2024-01):
 * - QUEUE_PROCESS_DELAY_MS: 500ms → 100ms (5x faster message throughput)
 * - STABILITY_POLL_MS: 200ms → 100ms (faster idle detection)
 * - ENTER_DELAY_MS: 100ms → 50ms (faster message completion)
 * - RETRY_BACKOFF_MS: 300ms → 200ms (faster recovery)
 *
 * Use AdaptiveThrottle class for dynamic backpressure handling.
 */
export const INJECTION_CONSTANTS = {
  /** Maximum retry attempts for injection */
  MAX_RETRIES: 3,
  /** Timeout for output stability check (ms) */
  STABILITY_TIMEOUT_MS: 3000,
  /** Polling interval for stability check (ms) - reduced from 200ms */
  STABILITY_POLL_MS: 100,
  /** Required consecutive stable polls before injection */
  REQUIRED_STABLE_POLLS: 2,
  /** Timeout for injection verification (ms) */
  VERIFICATION_TIMEOUT_MS: 2000,
  /** Delay between message and Enter key (ms) - reduced from 100ms */
  ENTER_DELAY_MS: 50,
  /** Backoff multiplier for retries (ms per attempt) - reduced from 300ms */
  RETRY_BACKOFF_MS: 200,
  /** Base delay between processing queued messages (ms) - reduced from 500ms */
  QUEUE_PROCESS_DELAY_MS: 100,
  /** Maximum delay when under backpressure (ms) */
  QUEUE_PROCESS_DELAY_MAX_MS: 500,
  /** Threshold for increasing delay (consecutive failures) */
  BACKPRESSURE_THRESHOLD: 2,
} as const;

/**
 * Adaptive throttle for message queue processing.
 * Increases delay when failures occur, decreases on success.
 *
 * This allows fast messaging under normal conditions (~100ms between messages)
 * while automatically backing off when the system is under stress.
 */
export class AdaptiveThrottle {
  private consecutiveFailures = 0;
  private currentDelay: number = INJECTION_CONSTANTS.QUEUE_PROCESS_DELAY_MS;

  /** Get current delay in milliseconds */
  getDelay(): number {
    return this.currentDelay;
  }

  /** Record a successful injection - decrease delay */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    // Gradually decrease delay on success (exponential decay toward minimum)
    this.currentDelay = Math.max(
      INJECTION_CONSTANTS.QUEUE_PROCESS_DELAY_MS,
      Math.floor(this.currentDelay * 0.7)
    );
  }

  /** Record a failed injection - increase delay if threshold exceeded */
  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= INJECTION_CONSTANTS.BACKPRESSURE_THRESHOLD) {
      // Increase delay when under backpressure (exponential backoff)
      this.currentDelay = Math.min(
        INJECTION_CONSTANTS.QUEUE_PROCESS_DELAY_MAX_MS,
        Math.floor(this.currentDelay * 1.5)
      );
    }
  }

  /** Reset to default state */
  reset(): void {
    this.consecutiveFailures = 0;
    this.currentDelay = INJECTION_CONSTANTS.QUEUE_PROCESS_DELAY_MS;
  }
}

/**
 * Strip ANSI escape codes from a string.
 * Converts cursor movements to spaces to preserve visual layout.
 */
export function stripAnsi(str: string): string {
  // Convert cursor forward movements to spaces (CSI n C)
  // eslint-disable-next-line no-control-regex
  let result = str.replace(/\x1B\[(\d+)C/g, (_m, n) => ' '.repeat(parseInt(n, 10) || 1));

  // Convert single cursor right (CSI C) to space
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\x1B\[C/g, ' ');

  // Remove carriage returns (causes text overwriting issues)
  result = result.replace(/\r(?!\n)/g, '');

  // Strip ANSI escape sequences (with \x1B prefix)
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\x1B(?:\[[0-9;?]*[A-Za-z]|\].*?(?:\x07|\x1B\\)|[@-Z\\-_])/g, '');

  // Strip orphaned CSI sequences that lost their escape byte
  // Requires at least one digit or question mark to avoid stripping legitimate text like [Agent
  result = result.replace(/^\s*(\[(?:\?|\d)\d*[A-Za-z])+\s*/g, '');

  return result;
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ANSI escape patterns for auto-suggestion (ghost text) detection.
 *
 * Claude Code and other CLIs show auto-suggestions using:
 * - Dim text: \x1B[2m
 * - Bright black (gray): \x1B[90m
 * - 256-color gray: \x1B[38;5;8m or \x1B[38;5;240m through \x1B[38;5;250m
 * - Cursor save/restore: \x1B[s / \x1B[u or \x1B7 / \x1B8
 *
 * Auto-suggestions are typically:
 * 1. Styled with dim/gray text
 * 2. Cursor position is saved before, restored after (so cursor doesn't advance)
 * 3. The actual text content is the "ghost" suggestion
 */
// eslint-disable-next-line no-control-regex
const AUTO_SUGGEST_PATTERNS = {
  // Dim text styling - commonly used for ghost text
  dim: /\x1B\[2m/,
  // Bright black (dark gray) - common for suggestions
  brightBlack: /\x1B\[90m/,
  // 256-color grays (8 is dark gray, 240-250 are grays)
  gray256: /\x1B\[38;5;(?:8|24[0-9]|250)m/,
  // Cursor save (CSI s or ESC 7)
  cursorSave: /\x1B\[s|\x1B7/,
  // Cursor restore (CSI u or ESC 8)
  cursorRestore: /\x1B\[u|\x1B8/,
  // Italic text - sometimes used for suggestions
  italic: /\x1B\[3m/,
};

/**
 * Result of auto-suggestion detection.
 */
export interface AutoSuggestResult {
  /** True if the output looks like an auto-suggestion */
  isAutoSuggest: boolean;
  /** Confidence level (0-1) */
  confidence: number;
  /** Which patterns were detected */
  patterns: string[];
  /** The actual content after stripping ANSI (for debugging) */
  strippedContent?: string;
}

/**
 * Detect if terminal output is likely an auto-suggestion (ghost text).
 *
 * Auto-suggestions should NOT reset the idle timer because they represent
 * the CLI showing suggestions to the user, not actual output from the agent.
 *
 * Detection heuristics:
 * 1. Contains dim/gray styling without other foreground colors
 * 2. Has cursor save/restore patterns (suggestion doesn't advance cursor)
 * 3. Stripped content is non-empty but doesn't contain relay commands
 *
 * @param output Raw terminal output including ANSI codes
 * @returns Detection result with confidence and matched patterns
 */
export function detectAutoSuggest(output: string): AutoSuggestResult {
  const patterns: string[] = [];
  let confidence = 0;

  // Check for dim styling (very common for ghost text)
  if (AUTO_SUGGEST_PATTERNS.dim.test(output)) {
    patterns.push('dim');
    confidence += 0.4;
  }

  // Check for bright black (dark gray)
  if (AUTO_SUGGEST_PATTERNS.brightBlack.test(output)) {
    patterns.push('brightBlack');
    confidence += 0.4;
  }

  // Check for 256-color gray
  if (AUTO_SUGGEST_PATTERNS.gray256.test(output)) {
    patterns.push('gray256');
    confidence += 0.3;
  }

  // Check for italic (sometimes used for suggestions)
  if (AUTO_SUGGEST_PATTERNS.italic.test(output)) {
    patterns.push('italic');
    confidence += 0.2;
  }

  // Check for cursor save/restore pair (strong indicator)
  const hasCursorSave = AUTO_SUGGEST_PATTERNS.cursorSave.test(output);
  const hasCursorRestore = AUTO_SUGGEST_PATTERNS.cursorRestore.test(output);

  if (hasCursorSave && hasCursorRestore) {
    patterns.push('cursorSaveRestore');
    confidence += 0.5;
  } else if (hasCursorSave || hasCursorRestore) {
    patterns.push(hasCursorSave ? 'cursorSave' : 'cursorRestore');
    confidence += 0.2;
  }

  // Cap confidence at 1.0
  confidence = Math.min(confidence, 1.0);

  // Strip ANSI to check actual content
  const stripped = stripAnsi(output);

  // If no patterns detected, it's not an auto-suggest
  if (patterns.length === 0) {
    return { isAutoSuggest: false, confidence: 0, patterns, strippedContent: stripped };
  }

  // Additional checks to reduce false positives:
  // - Actual content should be relatively short (suggestions are typically one line)
  // - Should not contain newlines (multi-line output is probably real output)
  const lines = stripped.split('\n').filter(l => l.trim().length > 0);
  if (lines.length > 2) {
    // Multi-line content - less likely to be just a suggestion
    confidence *= 0.5;
  }

  // Consider it an auto-suggest if confidence is above threshold
  const isAutoSuggest = confidence >= 0.4;

  return { isAutoSuggest, confidence, patterns, strippedContent: stripped };
}

/**
 * Check if output should be ignored for idle detection purposes.
 * Returns true if the output is likely an auto-suggestion or control sequence only.
 *
 * @param output Raw terminal output
 * @returns true if output should be ignored for idle detection
 */
export function shouldIgnoreForIdleDetection(output: string): boolean {
  // Empty output should be ignored
  if (!output || output.length === 0) {
    return true;
  }

  // Check if it's an auto-suggestion
  const result = detectAutoSuggest(output);
  if (result.isAutoSuggest) {
    return true;
  }

  // Check if stripped content is empty (only control sequences)
  const stripped = stripAnsi(output).trim();
  if (stripped.length === 0) {
    return true;
  }

  return false;
}

/**
 * Build the injection string for a relay message.
 * Format: Relay message from {from} [{shortId}]{hints}: {body}
 *
 * If the body is already formatted (starts with "Relay message from"),
 * returns it as-is to prevent double-wrapping.
 */
export function buildInjectionString(msg: QueuedMessage): string {
  // Check if body is already formatted (prevents double-wrapping)
  // This can happen when:
  // - Delivering queued/pending messages that were already formatted
  // - Agent output includes quoted relay messages that get re-processed
  // Strip ANSI first so escape codes don't interfere with detection
  const sanitizedBody = stripAnsi(msg.body || '').replace(/[\r\n]+/g, ' ').trim();
  if (sanitizedBody.startsWith('Relay message from ')) {
    // Already formatted - return as-is
    return sanitizedBody;
  }

  const shortId = msg.messageId.substring(0, 8);

  // Use senderName from data if available (for dashboard messages sent via Dashboard)
  // This allows showing the actual GitHub username instead of the system client name
  const displayFrom = (msg.from === 'Dashboard' && typeof msg.data?.senderName === 'string')
    ? msg.data.senderName
    : msg.from;

  // Thread hint
  const threadHint = msg.thread ? ` [thread:${msg.thread}]` : '';

  // Importance indicator: [!!] for high (>75), [!] for medium (>50)
  const importanceHint =
    msg.importance !== undefined && msg.importance > 75
      ? ' [!!]'
      : msg.importance !== undefined && msg.importance > 50
        ? ' [!]'
        : '';

  // Channel indicator for channel messages and broadcasts
  // originalTo will be '*' for broadcasts or the channel name (e.g., '#general') for channel messages
  // Make it clear that replies should go to the channel, not the sender
  const channelHint = msg.originalTo === '*'
    ? ' [#general] (reply to #general, not sender)'
    : msg.originalTo?.startsWith('#')
      ? ` [${msg.originalTo}] (reply to ${msg.originalTo}, not sender)`
      : '';

  // Extract attachment file paths if present
  let attachmentHint = '';
  if (msg.data?.attachments && Array.isArray(msg.data.attachments)) {
    const filePaths = (msg.data.attachments as Array<{ filePath?: string }>)
      .map((att) => att.filePath)
      .filter((p): p is string => typeof p === 'string');
    if (filePaths.length > 0) {
      attachmentHint = ` [Attachments: ${filePaths.join(', ')}]`;
    }
  }

  return `Relay message from ${displayFrom} [${shortId}]${threadHint}${importanceHint}${channelHint}${attachmentHint}: ${sanitizedBody}`;
}

/**
 * Calculate injection success rate from metrics
 */
export function calculateSuccessRate(metrics: InjectionMetrics): number {
  if (metrics.total === 0) return 100;
  const successful = metrics.successFirstTry + metrics.successWithRetry;
  return Math.round((successful / metrics.total) * 10000) / 100;
}

/**
 * Create a fresh injection metrics object
 */
export function createInjectionMetrics(): InjectionMetrics {
  return {
    total: 0,
    successFirstTry: 0,
    successWithRetry: 0,
    failed: 0,
  };
}

/**
 * Detect CLI type from command string
 */
export function detectCliType(command: string): CliType {
  const cmdLower = command.toLowerCase();
  // Extract just the command name (first word, without path)
  const cmdName = cmdLower.split(/[\s/\\]/).pop() || cmdLower;

  if (cmdLower.includes('gemini')) return 'gemini';
  if (cmdLower.includes('codex')) return 'codex';
  if (cmdLower.includes('claude')) return 'claude';
  if (cmdLower.includes('droid')) return 'droid';
  if (cmdLower.includes('opencode')) return 'opencode';
  if (cmdLower.includes('cursor')) return 'cursor';
  // 'agent' is the Cursor CLI command name (both older cursor-agent and newer agent)
  if (cmdName === 'agent' || cmdName === 'cursor-agent') return 'cursor';
  return 'other';
}

/**
 * Get the default relay prefix (unified for all agent types)
 */
export function getDefaultRelayPrefix(): string {
  return '->relay:';
}

/**
 * CLI-specific quirks and handling
 */
export const CLI_QUIRKS = {
  /**
   * CLIs that support bracketed paste mode.
   * Others may interpret the escape sequences literally.
   */
  supportsBracketedPaste: (cli: CliType): boolean => {
    return cli === 'claude' || cli === 'codex' || cli === 'gemini' || cli === 'opencode' || cli === 'cursor';
  },

  /**
   * Gemini interprets certain keywords (While, For, If, etc.) as shell commands.
   * Wrap message in backticks to prevent shell keyword interpretation.
   */
  wrapForGemini: (body: string): string => {
    return `\`${body.replace(/`/g, "'")}\``;
  },

  /**
   * Get prompt pattern regex for a CLI type.
   * Used to detect when input line is clear.
   */
  getPromptPattern: (cli: CliType): RegExp => {
    const patterns: Record<CliType, RegExp> = {
      claude: /^[>›»]\s*$/,
      gemini: /^[>›»]\s*$/,
      codex: /^[>›»]\s*$/,
      droid: /^[>›»]\s*$/,
      opencode: /^[>›»]\s*$/,
      cursor: /^[>›»]\s*$/,
      spawned: /^[>›»]\s*$/,
      other: /^[>$%#➜›»]\s*$/,
    };
    return patterns[cli] || patterns.other;
  },

  /**
   * Check if a line looks like a shell prompt (for Gemini safety check).
   * Gemini can drop into shell mode - we skip injection to avoid executing commands.
   */
  isShellPrompt: (line: string): boolean => {
    const clean = stripAnsi(line).trim();
    return /^\$\s*$/.test(clean) || /^\s*\$\s*$/.test(clean);
  },
} as const;

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
export async function verifyInjection(
  shortId: string,
  from: string,
  getOutput: () => Promise<string>
): Promise<boolean> {
  const expectedPattern = `Relay message from ${from} [${shortId}]`;
  const startTime = Date.now();

  while (Date.now() - startTime < INJECTION_CONSTANTS.VERIFICATION_TIMEOUT_MS) {
    try {
      const output = await getOutput();
      if (output.includes(expectedPattern)) {
        return true;
      }
    } catch {
      // Output retrieval failed, verification fails
      return false;
    }

    await sleep(100);
  }

  return false;
}

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
export async function injectWithRetry(
  injection: string,
  shortId: string,
  from: string,
  callbacks: InjectionCallbacks
): Promise<InjectionResult> {
  const metrics = callbacks.getMetrics();
  metrics.total++;

  // Skip verification mode: trust that write() succeeds without checking output
  // Used for PTY-based injection where CLIs don't echo input back
  if (callbacks.skipVerification) {
    try {
      await callbacks.performInjection(injection);
      metrics.successFirstTry++;
      return { success: true, attempts: 1 };
    } catch (err: any) {
      callbacks.logError(`Injection error: ${err?.message || err}`);
      metrics.failed++;
      return { success: false, attempts: 1 };
    }
  }

  for (let attempt = 0; attempt < INJECTION_CONSTANTS.MAX_RETRIES; attempt++) {
    try {
      // On retry attempts, first check if message already exists (race condition fix)
      // Previous injection may have succeeded but verification timed out
      if (attempt > 0) {
        const alreadyExists = await verifyInjection(shortId, from, callbacks.getOutput);
        if (alreadyExists) {
          metrics.successWithRetry++;
          callbacks.log(`Message already present (late verification), skipping re-injection`);
          return { success: true, attempts: attempt + 1 };
        }
      }

      // Perform the injection
      await callbacks.performInjection(injection);

      // Verify it appeared in output
      const verified = await verifyInjection(shortId, from, callbacks.getOutput);

      if (verified) {
        if (attempt === 0) {
          metrics.successFirstTry++;
        } else {
          metrics.successWithRetry++;
          callbacks.log(`Injection succeeded on attempt ${attempt + 1}`);
        }
        return { success: true, attempts: attempt + 1 };
      }

      // Not verified - log and retry
      callbacks.log(
        `Injection not verified, attempt ${attempt + 1}/${INJECTION_CONSTANTS.MAX_RETRIES}`
      );

      // Backoff before retry
      if (attempt < INJECTION_CONSTANTS.MAX_RETRIES - 1) {
        await sleep(INJECTION_CONSTANTS.RETRY_BACKOFF_MS * (attempt + 1));
      }
    } catch (err: any) {
      callbacks.logError(`Injection error on attempt ${attempt + 1}: ${err?.message || err}`);
    }
  }

  // All retries failed
  metrics.failed++;
  return { success: false, attempts: INJECTION_CONSTANTS.MAX_RETRIES };
}
