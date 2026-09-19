export interface CollectWithRetryOptions {
  retries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Return false for terminal failures that must be surfaced immediately. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

/**
 * Run a bounded operation with the fleet CLI's small retry delay.
 *
 * The result records whether another attempt actually ran. Callers that need
 * richer failure metadata can retain the thrown value in their operation;
 * this helper deliberately keeps the existing fleet-list rendering contract.
 */
export async function collectWithRetry<T>(
  label: string,
  fn: () => Promise<T>,
  options?: CollectWithRetryOptions
): Promise<{ ok: true; value: T; retried: boolean } | { ok: false; error: string; retried: boolean }> {
  const retries = options?.retries ?? 1;
  const baseDelay = options?.baseDelayMs ?? 500;
  const sleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  let attempts = 0;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    attempts += 1;
    try {
      const value = await fn();
      return { ok: true, value, retried: attempt > 0 };
    } catch (error) {
      lastError = error;
      if (attempt >= retries || options?.shouldRetry?.(error, attempt + 1) === false) break;
      // Keep the established fleet-list delay shape while making later
      // attempts wait slightly longer, without introducing test randomness.
      const delay = baseDelay + Math.floor(baseDelay * (attempt / (retries + 1)));
      await sleep(delay);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  return { ok: false, error: `${label}: ${message}`, retried: attempts > 1 };
}
