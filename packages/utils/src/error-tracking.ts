/**
 * Error Tracking Utilities
 *
 * Provides traceable error IDs that users can report to support.
 * Support can then search logs for the error ID to find full context.
 *
 * Error ID format: ERR-{timestamp}-{random}
 * Example: ERR-1706012345-a7f3
 *
 * Usage:
 *   const error = createTraceableError('Failed to spawn agent', { agentName, cli });
 *   console.error(error.logMessage); // Full details for logs
 *   return { error: error.userMessage }; // Safe message with ID for user
 */

import { randomBytes } from 'node:crypto';

export interface TraceableError {
  /** Unique error ID for support lookup (e.g., ERR-1706012345-a7f3) */
  errorId: string;
  /** User-facing message with error ID (safe to display) */
  userMessage: string;
  /** Full log message with all context (for server logs) */
  logMessage: string;
  /** ISO timestamp when error occurred */
  timestamp: string;
  /** Original error message */
  message: string;
  /** Additional context data */
  context: Record<string, unknown>;
}

/**
 * Generate a unique error ID.
 * Format: ERR-{unix_timestamp}-{4_random_hex_chars}
 */
export function generateErrorId(): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const random = randomBytes(2).toString('hex');
  return `ERR-${timestamp}-${random}`;
}

/**
 * Create a traceable error with ID for support lookup.
 *
 * @param message - Human-readable error description
 * @param context - Additional context (agentName, workspaceId, etc.)
 * @param originalError - Original error object if wrapping
 * @returns TraceableError with ID, user message, and log message
 *
 * @example
 * ```typescript
 * const error = createTraceableError('Failed to spawn agent', {
 *   agentName: 'Worker1',
 *   cli: 'claude',
 *   reason: 'timeout'
 * });
 *
 * // Log full details for support
 * console.error(error.logMessage);
 * // => [ERR-1706012345-a7f3] Failed to spawn agent | agentName=Worker1 cli=claude reason=timeout
 *
 * // Return safe message to user
 * res.status(500).json({ error: error.userMessage });
 * // => "Failed to spawn agent (Error ID: ERR-1706012345-a7f3 - share this with support)"
 * ```
 */
export function createTraceableError(
  message: string,
  context: Record<string, unknown> = {},
  originalError?: Error
): TraceableError {
  const errorId = generateErrorId();
  const timestamp = new Date().toISOString();

  // Build context string for logging
  const contextPairs = Object.entries(context)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ');

  // Include original error stack if available
  const stackInfo = originalError?.stack
    ? `\n  Original error: ${originalError.message}\n  Stack: ${originalError.stack}`
    : '';

  const logMessage = `[${errorId}] ${message}${contextPairs ? ` | ${contextPairs}` : ''}${stackInfo}`;
  const userMessage = `${message} (Error ID: ${errorId} - share this with support)`;

  return {
    errorId,
    userMessage,
    logMessage,
    timestamp,
    message,
    context: {
      ...context,
      originalError: originalError?.message,
    },
  };
}

/**
 * Log a traceable error and return user-safe response.
 * Convenience wrapper that logs and returns in one call.
 *
 * @example
 * ```typescript
 * const { userMessage, errorId } = logAndTraceError(
 *   'Workspace creation failed',
 *   { workspaceId, userId },
 *   err
 * );
 * res.status(500).json({ error: userMessage, errorId });
 * ```
 */
export function logAndTraceError(
  message: string,
  context: Record<string, unknown> = {},
  originalError?: Error
): TraceableError {
  const error = createTraceableError(message, context, originalError);
  console.error(error.logMessage);
  return error;
}

/**
 * Wrap an async function to automatically trace errors.
 * Useful for API handlers.
 *
 * @example
 * ```typescript
 * app.post('/api/spawn', withErrorTracing(async (req, res) => {
 *   // ... handler code
 *   // Errors automatically get traced
 * }, { endpoint: '/api/spawn' }));
 * ```
 */
export function withErrorTracing<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  baseContext: Record<string, unknown> = {}
): T {
  return (async (...args: unknown[]) => {
    try {
      return await fn(...args);
    } catch (err) {
      const error = logAndTraceError(
        err instanceof Error ? err.message : 'Unknown error',
        baseContext,
        err instanceof Error ? err : undefined
      );
      throw new TracedError(error);
    }
  }) as T;
}

/**
 * Error class that includes trace information.
 * Thrown by withErrorTracing wrapper.
 */
export class TracedError extends Error {
  public readonly errorId: string;
  public readonly userMessage: string;
  public readonly context: Record<string, unknown>;

  constructor(traced: TraceableError) {
    super(traced.message);
    this.name = 'TracedError';
    this.errorId = traced.errorId;
    this.userMessage = traced.userMessage;
    this.context = traced.context;
  }
}

/**
 * Search hint for support: how to find errors in logs.
 * Include this in documentation or support portal.
 */
export const ERROR_SEARCH_HINT = `
To find error details in logs, search for the error ID:

  grep "ERR-1706012345-a7f3" /var/log/agent-relay/*.log

Or in cloud logging:

  fly logs -a agent-relay-cloud | grep "ERR-1706012345-a7f3"

The log entry will include full context: user ID, workspace ID, agent name, etc.
`;
