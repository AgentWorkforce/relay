/**
 * Timing Utilities for Tests
 * Agent1-02bdbc9d's contribution to the Test Utilities Module
 */

/**
 * Sleep for a specified number of milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>} Resolves after the delay
 * @example
 * await sleep(1000); // Wait 1 second
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wait for a condition to become true
 * @param {Function} condition - Function that returns boolean or Promise<boolean>
 * @param {Object} options - Configuration options
 * @param {number} [options.timeout=5000] - Maximum time to wait in ms
 * @param {number} [options.interval=100] - Polling interval in ms
 * @param {string} [options.message='Condition not met within timeout'] - Error message
 * @returns {Promise<void>} Resolves when condition is true
 * @throws {Error} If timeout is reached before condition is true
 * @example
 * await waitFor(() => element.isVisible, { timeout: 3000 });
 */
export async function waitFor(condition, options = {}) {
  const {
    timeout = 5000,
    interval = 100,
    message = 'Condition not met within timeout'
  } = options;

  const startTime = Date.now();

  while (true) {
    const result = await Promise.resolve(condition());
    if (result) {
      return;
    }

    if (Date.now() - startTime >= timeout) {
      throw new Error(message);
    }

    await sleep(interval);
  }
}

/**
 * Wrap a promise with a timeout
 * @param {Promise<T>} promise - The promise to wrap
 * @param {number} ms - Timeout in milliseconds
 * @param {string} [message='Operation timed out'] - Error message on timeout
 * @returns {Promise<T>} The original promise result or throws on timeout
 * @throws {Error} If the promise doesn't resolve within the timeout
 * @example
 * const result = await withTimeout(fetchData(), 5000);
 */
export function withTimeout(promise, ms, message = 'Operation timed out') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms)
    )
  ]);
}

/**
 * Create a deferred promise that can be resolved/rejected externally
 * @returns {{promise: Promise, resolve: Function, reject: Function}}
 * @example
 * const { promise, resolve } = deferred();
 * setTimeout(() => resolve('done'), 1000);
 * await promise;
 */
export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Measure execution time of an async function
 * @param {Function} fn - Async function to measure
 * @returns {Promise<{result: any, duration: number}>} Result and duration in ms
 * @example
 * const { result, duration } = await measureTime(() => fetchData());
 * console.log(`Took ${duration}ms`);
 */
export async function measureTime(fn) {
  const start = Date.now();
  const result = await fn();
  const duration = Date.now() - start;
  return { result, duration };
}

/**
 * Retry with delay between attempts
 * @param {Function} fn - Function to retry
 * @param {Object} options - Configuration
 * @param {number} [options.retries=3] - Number of retry attempts
 * @param {number} [options.delay=1000] - Delay between retries in ms
 * @returns {Promise<any>} Result of successful execution
 * @throws {Error} Last error if all retries fail
 */
export async function retryWithDelay(fn, options = {}) {
  const { retries = 3, delay = 1000 } = options;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(delay);
      }
    }
  }

  throw lastError;
}
