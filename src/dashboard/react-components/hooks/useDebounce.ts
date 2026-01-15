/**
 * useDebounce Hook
 *
 * Returns a debounced value that only updates after a delay.
 * Useful for search inputs and other rapid-change scenarios.
 */

import { useState, useEffect } from 'react';

/**
 * Debounce a value by a specified delay.
 * @param value - The value to debounce
 * @param delay - Delay in milliseconds (default: 300ms)
 */
export function useDebounce<T>(value: T, delay: number = 300): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}
