/**
 * Retry utility with exponential backoff for flaky async operations
 * Created by Agent1-18e54f29 as part of swarm collaboration
 */

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_OPTIONS = {
  maxAttempts: 3,
  initialDelay: 100,
  maxDelay: 5000,
  backoffMultiplier: 2,
  retryOn: () => true
};

/**
 * Retry an async function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Retry options
 * @param {number} options.maxAttempts - Maximum number of attempts (default: 3)
 * @param {number} options.initialDelay - Initial delay in ms (default: 100)
 * @param {number} options.maxDelay - Maximum delay in ms (default: 5000)
 * @param {number} options.backoffMultiplier - Multiplier for each retry (default: 2)
 * @param {Function} options.retryOn - Function to determine if error should trigger retry
 * @returns {Promise<any>} Result of the function
 * @throws {Error} Last error if all retries fail
 */
export async function retry(fn, options = {}) {
  const config = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError;
  let delay = config.initialDelay;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      // Check if we should retry this error
      if (!config.retryOn(error)) {
        throw error;
      }

      // If this was the last attempt, throw
      if (attempt === config.maxAttempts) {
        throw error;
      }

      // Wait before retrying
      await sleep(delay);

      // Calculate next delay with exponential backoff
      delay = Math.min(delay * config.backoffMultiplier, config.maxDelay);
    }
  }

  throw lastError;
}

/**
 * Create a retry wrapper with preset options
 * @param {Object} options - Default options for all retries
 * @returns {Function} Configured retry function
 */
export function createRetrier(options = {}) {
  return (fn, overrideOptions = {}) => retry(fn, { ...options, ...overrideOptions });
}

/**
 * Retry with linear backoff instead of exponential
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Retry options
 * @returns {Promise<any>} Result of the function
 */
export async function retryLinear(fn, options = {}) {
  return retry(fn, { ...options, backoffMultiplier: 1 });
}

/**
 * Retry with no delay between attempts
 * @param {Function} fn - Async function to retry
 * @param {number} maxAttempts - Maximum attempts
 * @returns {Promise<any>} Result of the function
 */
export async function retryImmediate(fn, maxAttempts = 3) {
  return retry(fn, { maxAttempts, initialDelay: 0, backoffMultiplier: 1 });
}

/**
 * Simple sleep utility (used internally)
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
