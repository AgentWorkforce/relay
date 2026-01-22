/**
 * Unit tests for TmuxWrapper constants and utilities
 */

import { describe, it, expect } from 'vitest';
import { getDefaultPrefix } from './tmux-wrapper.js';
import {
  type InjectionResult,
  INJECTION_CONSTANTS,
  createInjectionMetrics,
} from './shared.js';

describe('TmuxWrapper constants', () => {
  // Unified prefix across all CLI types
  describe('getDefaultPrefix', () => {
    it('returns ->relay: for gemini CLI type', () => {
      expect(getDefaultPrefix('gemini')).toBe('->relay:');
    });

    it('returns ->relay: for claude CLI type', () => {
      expect(getDefaultPrefix('claude')).toBe('->relay:');
    });

    it('returns ->relay: for codex CLI type', () => {
      expect(getDefaultPrefix('codex')).toBe('->relay:');
    });

    it('returns ->relay: for other CLI type', () => {
      expect(getDefaultPrefix('other')).toBe('->relay:');
    });
  });
});

describe('String truncation safety', () => {
  // Test the truncation pattern used throughout tmux-wrapper
  // Pattern: str.substring(0, Math.min(LIMIT, str.length))

  const safeSubstring = (str: string, maxLen: number): string => {
    return str.substring(0, Math.min(maxLen, str.length));
  };

  describe('safeSubstring helper pattern', () => {
    it('truncates long strings', () => {
      const longString = 'a'.repeat(100);
      expect(safeSubstring(longString, 40)).toBe('a'.repeat(40));
      expect(safeSubstring(longString, 40)).toHaveLength(40);
    });

    it('preserves short strings', () => {
      const shortString = 'hello';
      expect(safeSubstring(shortString, 40)).toBe('hello');
      expect(safeSubstring(shortString, 40)).toHaveLength(5);
    });

    it('handles exact length strings', () => {
      const exactString = 'a'.repeat(40);
      expect(safeSubstring(exactString, 40)).toBe(exactString);
      expect(safeSubstring(exactString, 40)).toHaveLength(40);
    });

    it('handles empty strings', () => {
      expect(safeSubstring('', 40)).toBe('');
      expect(safeSubstring('', 40)).toHaveLength(0);
    });

    it('handles strings shorter than limit', () => {
      expect(safeSubstring('ab', 40)).toBe('ab');
    });

    it('handles limit of 0', () => {
      expect(safeSubstring('hello', 0)).toBe('');
    });

    it('handles unicode characters', () => {
      const unicodeStr = ''.repeat(100);
      expect(safeSubstring(unicodeStr, 10)).toBe(''.repeat(10));
    });
  });

  describe('DEBUG_LOG_TRUNCATE_LENGTH constant (40)', () => {
    const DEBUG_LOG_TRUNCATE_LENGTH = 40;

    it('truncates debug log content appropriately', () => {
      const longMessage = 'This is a very long debug message that exceeds the limit';
      const truncated = safeSubstring(longMessage, DEBUG_LOG_TRUNCATE_LENGTH);
      expect(truncated).toBe('This is a very long debug message that e');
      expect(truncated).toHaveLength(40);
    });
  });

  describe('RELAY_LOG_TRUNCATE_LENGTH constant (50)', () => {
    const RELAY_LOG_TRUNCATE_LENGTH = 50;

    it('truncates relay command log content appropriately', () => {
      const longMessage = 'This is a very long relay message that definitely exceeds the fifty character limit';
      const truncated = safeSubstring(longMessage, RELAY_LOG_TRUNCATE_LENGTH);
      expect(truncated).toBe('This is a very long relay message that definitely ');
      expect(truncated).toHaveLength(50);
    });
  });
});

describe('Cursor stability constants', () => {
  // These test the logic that uses STABLE_CURSOR_THRESHOLD and MAX_PROMPT_CURSOR_POSITION

  const STABLE_CURSOR_THRESHOLD = 3;
  const MAX_PROMPT_CURSOR_POSITION = 4;

  describe('STABLE_CURSOR_THRESHOLD', () => {
    it('requires 3 or more stable polls to consider input clear', () => {
      // Simulate cursor stability counting
      let stableCursorCount = 0;
      const cursorX = 2;

      // First poll - not stable yet
      stableCursorCount++;
      expect(stableCursorCount >= STABLE_CURSOR_THRESHOLD).toBe(false);

      // Second poll - still not stable
      stableCursorCount++;
      expect(stableCursorCount >= STABLE_CURSOR_THRESHOLD).toBe(false);

      // Third poll - now stable
      stableCursorCount++;
      expect(stableCursorCount >= STABLE_CURSOR_THRESHOLD).toBe(true);
      expect(cursorX <= MAX_PROMPT_CURSOR_POSITION).toBe(true);
    });

    it('resets count when cursor moves', () => {
      let stableCursorCount = 2;
      let lastCursorX = 2;
      const newCursorX = 5; // Cursor moved

      if (newCursorX !== lastCursorX) {
        stableCursorCount = 0;
        lastCursorX = newCursorX;
      }

      expect(stableCursorCount).toBe(0);
    });
  });

  describe('MAX_PROMPT_CURSOR_POSITION', () => {
    it('considers positions 0-4 as typical prompt positions', () => {
      expect(0 <= MAX_PROMPT_CURSOR_POSITION).toBe(true);
      expect(1 <= MAX_PROMPT_CURSOR_POSITION).toBe(true);
      expect(2 <= MAX_PROMPT_CURSOR_POSITION).toBe(true);
      expect(3 <= MAX_PROMPT_CURSOR_POSITION).toBe(true);
      expect(4 <= MAX_PROMPT_CURSOR_POSITION).toBe(true);
    });

    it('considers positions > 4 as likely having user input', () => {
      expect(5 <= MAX_PROMPT_CURSOR_POSITION).toBe(false);
      expect(10 <= MAX_PROMPT_CURSOR_POSITION).toBe(false);
    });

    it('works with combined stability check', () => {
      const stableCursorCount = 3;
      const cursorAtPrompt = 2;
      const cursorWithInput = 10;

      // At prompt position - should be considered clear
      const isClearAtPrompt =
        stableCursorCount >= STABLE_CURSOR_THRESHOLD &&
        cursorAtPrompt <= MAX_PROMPT_CURSOR_POSITION;
      expect(isClearAtPrompt).toBe(true);

      // With input - should not be considered clear
      const isClearWithInput =
        stableCursorCount >= STABLE_CURSOR_THRESHOLD &&
        cursorWithInput <= MAX_PROMPT_CURSOR_POSITION;
      expect(isClearWithInput).toBe(false);
    });
  });
});

describe('Injection retry logic', () => {
  // Test the retry logic pattern used by injectWithRetry

  describe('INJECTION_CONSTANTS', () => {
    it('has correct MAX_RETRIES', () => {
      expect(INJECTION_CONSTANTS.MAX_RETRIES).toBe(3);
    });

    it('has correct VERIFICATION_TIMEOUT_MS', () => {
      expect(INJECTION_CONSTANTS.VERIFICATION_TIMEOUT_MS).toBe(2000);
    });

    it('has correct RETRY_BACKOFF_MS', () => {
      expect(INJECTION_CONSTANTS.RETRY_BACKOFF_MS).toBe(300);
    });
  });

  describe('InjectionMetrics tracking', () => {
    it('initializes with zero counts', () => {
      const metrics = createInjectionMetrics();
      expect(metrics.total).toBe(0);
      expect(metrics.successFirstTry).toBe(0);
      expect(metrics.successWithRetry).toBe(0);
      expect(metrics.failed).toBe(0);
    });

    it('tracks successful first-try injection', () => {
      const metrics = createInjectionMetrics();

      // Simulate successful first-try injection
      metrics.total++;
      const verified = true;
      const attempt = 0;
      if (verified && attempt === 0) {
        metrics.successFirstTry++;
      }

      expect(metrics.total).toBe(1);
      expect(metrics.successFirstTry).toBe(1);
      expect(metrics.successWithRetry).toBe(0);
      expect(metrics.failed).toBe(0);
    });

    it('tracks successful retry injection', () => {
      const metrics = createInjectionMetrics();

      // Simulate successful injection on retry
      metrics.total++;
      const verified = true;
      const attempt = 2; // Third attempt
      if (verified && attempt > 0) {
        metrics.successWithRetry++;
      }

      expect(metrics.total).toBe(1);
      expect(metrics.successFirstTry).toBe(0);
      expect(metrics.successWithRetry).toBe(1);
      expect(metrics.failed).toBe(0);
    });

    it('tracks failed injection', () => {
      const metrics = createInjectionMetrics();

      // Simulate failed injection after all retries
      metrics.total++;
      metrics.failed++;

      expect(metrics.total).toBe(1);
      expect(metrics.successFirstTry).toBe(0);
      expect(metrics.successWithRetry).toBe(0);
      expect(metrics.failed).toBe(1);
    });
  });

  describe('InjectionResult structure', () => {
    it('returns success result on first try', () => {
      const result: InjectionResult = { success: true, attempts: 1 };
      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);
    });

    it('returns success result after retries', () => {
      const result: InjectionResult = { success: true, attempts: 3 };
      expect(result.success).toBe(true);
      expect(result.attempts).toBe(3);
    });

    it('returns failure result after max retries', () => {
      const result: InjectionResult = {
        success: false,
        attempts: INJECTION_CONSTANTS.MAX_RETRIES,
      };
      expect(result.success).toBe(false);
      expect(result.attempts).toBe(3);
    });

    it('can include fallback flag', () => {
      const result: InjectionResult = {
        success: false,
        attempts: 3,
        fallbackUsed: true,
      };
      expect(result.fallbackUsed).toBe(true);
    });
  });

  describe('Backoff calculation', () => {
    it('increases backoff with each attempt', () => {
      const backoffMs = INJECTION_CONSTANTS.RETRY_BACKOFF_MS;

      // Backoff for attempt 0 (first retry)
      const backoff0 = backoffMs * 1;
      expect(backoff0).toBe(300);

      // Backoff for attempt 1 (second retry)
      const backoff1 = backoffMs * 2;
      expect(backoff1).toBe(600);

      // Backoff for attempt 2 (third retry - but no backoff needed after last attempt)
      const backoff2 = backoffMs * 3;
      expect(backoff2).toBe(900);
    });
  });

  describe('Verification pattern matching', () => {
    it('generates correct expected pattern', () => {
      const shortId = 'abc12345';
      const from = 'TestAgent';
      const expectedPattern = `Relay message from ${from} [${shortId}]`;
      expect(expectedPattern).toBe('Relay message from TestAgent [abc12345]');
    });

    it('handles different agent names', () => {
      const shortId = 'def67890';
      const from = 'Backend';
      const expectedPattern = `Relay message from ${from} [${shortId}]`;
      expect(expectedPattern).toBe('Relay message from Backend [def67890]');
    });
  });
});
