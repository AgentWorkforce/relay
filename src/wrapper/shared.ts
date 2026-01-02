/**
 * Shared types and utilities for TmuxWrapper and PtyWrapper
 *
 * This module contains common code to prevent drift between the two
 * wrapper implementations and reduce duplication.
 */

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
export type CliType = 'claude' | 'codex' | 'gemini' | 'droid' | 'spawned' | 'other';

/**
 * Injection timing constants
 */
export const INJECTION_CONSTANTS = {
  /** Maximum retry attempts for injection */
  MAX_RETRIES: 3,
  /** Timeout for output stability check (ms) */
  STABILITY_TIMEOUT_MS: 3000,
  /** Polling interval for stability check (ms) */
  STABILITY_POLL_MS: 200,
  /** Required consecutive stable polls before injection */
  REQUIRED_STABLE_POLLS: 2,
  /** Timeout for injection verification (ms) */
  VERIFICATION_TIMEOUT_MS: 2000,
  /** Delay between message and Enter key (ms) */
  ENTER_DELAY_MS: 50,
  /** Backoff multiplier for retries (ms per attempt) */
  RETRY_BACKOFF_MS: 300,
  /** Delay between processing queued messages (ms) */
  QUEUE_PROCESS_DELAY_MS: 500,
} as const;

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
  result = result.replace(/^\s*(\[\??\d*[A-Za-z])+\s*/g, '');

  return result;
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the injection string for a relay message.
 * Format: Relay message from {from} [{shortId}]{hints}: {body}
 */
export function buildInjectionString(msg: QueuedMessage): string {
  const shortId = msg.messageId.substring(0, 8);

  // Strip ANSI and normalize whitespace
  const sanitizedBody = stripAnsi(msg.body).replace(/[\r\n]+/g, ' ').trim();

  // Thread hint
  const threadHint = msg.thread ? ` [thread:${msg.thread}]` : '';

  // Importance indicator: [!!] for high (>75), [!] for medium (>50)
  const importanceHint =
    msg.importance !== undefined && msg.importance > 75
      ? ' [!!]'
      : msg.importance !== undefined && msg.importance > 50
        ? ' [!]'
        : '';

  // Channel indicator for broadcasts
  const channelHint = msg.originalTo === '*' ? ' [#general]' : '';

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

  return `Relay message from ${msg.from} [${shortId}]${threadHint}${importanceHint}${channelHint}${attachmentHint}: ${sanitizedBody}`;
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
  if (cmdLower.includes('gemini')) return 'gemini';
  if (cmdLower.includes('codex')) return 'codex';
  if (cmdLower.includes('claude')) return 'claude';
  if (cmdLower.includes('droid')) return 'droid';
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
    return cli === 'claude' || cli === 'codex' || cli === 'gemini';
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
