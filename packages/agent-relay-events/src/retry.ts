import { NoRetry } from './types.js';

/**
 * Default delivery retry delays from the runtime spec.
 */
export const DEFAULT_RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 300_000, 1_800_000] as const;

/**
 * Sleeps for the provided duration.
 */
export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Retry delay aborted');
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Retry delay aborted'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Computes the jittered retry delay for a delivery attempt.
 */
export function computeRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const index = Math.max(0, Math.min(attempt - 1, DEFAULT_RETRY_DELAYS_MS.length - 1));
  const base = DEFAULT_RETRY_DELAYS_MS[index];
  const jitter = Math.round(base * 0.2 * random());
  return base + jitter;
}

/**
 * Runs an async operation with the default runtime retry policy.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  maxAttempts = DEFAULT_RETRY_DELAYS_MS.length,
  signal?: AbortSignal
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (error instanceof NoRetry) {
        throw error;
      }

      lastError = error;
      if (attempt >= maxAttempts) {
        break;
      }

      await delay(computeRetryDelayMs(attempt), signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Event delivery failed');
}
