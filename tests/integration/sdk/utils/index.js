/**
 * Test Utilities - Main Entry Point
 * Integrates all test utilities built by the swarm:
 * - retry.js by Agent1-18e54f29
 * - timing.js by Agent1-02bdbc9d
 * - index.js (integration) by Agent3
 */

// Re-export everything from retry.js
export {
  retry,
  createRetrier,
  retryLinear,
  retryImmediate,
  DEFAULT_RETRY_OPTIONS
} from './retry.js';

// Re-export everything from timing.js
export {
  sleep,
  waitFor,
  withTimeout,
  deferred,
  measureTime,
  retryWithDelay
} from './timing.js';

/**
 * Combined utility: retry with timeout
 * Retries a function with exponential backoff, but fails if total time exceeds timeout
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Options
 * @param {number} [options.maxAttempts=3] - Max retry attempts
 * @param {number} [options.timeout=10000] - Total timeout in ms
 * @param {number} [options.initialDelay=100] - Initial retry delay
 * @returns {Promise<any>} Result of the function
 */
export async function retryWithTimeout(fn, options = {}) {
  const { timeout = 10000, maxAttempts = 3, initialDelay = 100 } = options;

  const { withTimeout } = await import('./timing.js');
  const { retry } = await import('./retry.js');

  return withTimeout(
    retry(fn, { maxAttempts, initialDelay }),
    timeout,
    `Operation timed out after ${timeout}ms`
  );
}

/**
 * Wait for a value to change
 * @param {Function} getValue - Function that returns current value
 * @param {any} expectedValue - Value to wait for
 * @param {Object} options - Options for waitFor
 * @returns {Promise<void>}
 */
export async function waitForValue(getValue, expectedValue, options = {}) {
  const { waitFor } = await import('./timing.js');
  return waitFor(
    async () => (await getValue()) === expectedValue,
    { message: `Value did not become ${expectedValue}`, ...options }
  );
}

/**
 * Measure retry performance
 * @param {Function} fn - Function to retry
 * @param {Object} options - Retry options
 * @returns {Promise<{result: any, attempts: number, totalTime: number}>}
 */
export async function measureRetry(fn, options = {}) {
  const { measureTime } = await import('./timing.js');
  const { retry } = await import('./retry.js');

  let attempts = 0;
  const wrappedFn = async (attempt) => {
    attempts = attempt;
    return fn(attempt);
  };

  const { result, duration } = await measureTime(() => retry(wrappedFn, options));

  return {
    result,
    attempts,
    totalTime: duration
  };
}

// Import directly for default export (avoid Promise issues)
import {
  retry,
  createRetrier,
  retryLinear,
  retryImmediate,
} from './retry.js';

import {
  sleep,
  waitFor,
  withTimeout,
  deferred,
  measureTime,
  retryWithDelay,
} from './timing.js';

export default {
  // Retry utilities
  retry,
  createRetrier,
  retryLinear,
  retryImmediate,

  // Timing utilities
  sleep,
  waitFor,
  withTimeout,
  deferred,
  measureTime,
  retryWithDelay,

  // Combined utilities
  retryWithTimeout,
  waitForValue,
  measureRetry
};
