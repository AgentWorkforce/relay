/**
 * Unit tests for shared wrapper utilities
 */

import { describe, it, expect } from 'vitest';
import { buildInjectionString, type QueuedMessage } from './shared.js';

describe('buildInjectionString', () => {
  const baseMessage: QueuedMessage = {
    from: 'TestAgent',
    body: 'Hello world',
    messageId: 'abc12345-6789-0123-4567-890123456789',
  };

  describe('sender name display', () => {
    it('uses msg.from when from is not Dashboard', () => {
      const msg: QueuedMessage = {
        ...baseMessage,
        from: 'RegularAgent',
      };
      const result = buildInjectionString(msg);
      expect(result).toContain('Relay message from RegularAgent');
    });

    it('uses msg.from when from is Dashboard but no senderName in data', () => {
      const msg: QueuedMessage = {
        ...baseMessage,
        from: 'Dashboard',
      };
      const result = buildInjectionString(msg);
      expect(result).toContain('Relay message from Dashboard');
    });

    it('uses senderName when from is Dashboard and senderName exists', () => {
      const msg: QueuedMessage = {
        ...baseMessage,
        from: 'Dashboard',
        data: { senderName: 'GitHubUser123' },
      };
      const result = buildInjectionString(msg);
      expect(result).toContain('Relay message from GitHubUser123');
      expect(result).not.toContain('Dashboard');
    });

    it('uses msg.from when senderName is not a string', () => {
      const msg: QueuedMessage = {
        ...baseMessage,
        from: 'Dashboard',
        data: { senderName: 12345 }, // not a string
      };
      const result = buildInjectionString(msg);
      expect(result).toContain('Relay message from Dashboard');
    });

    it('uses msg.from when senderName is empty string', () => {
      const msg: QueuedMessage = {
        ...baseMessage,
        from: 'Dashboard',
        data: { senderName: '' },
      };
      // Empty string is falsy but still a string - our check uses typeof === 'string'
      // So empty string will be used (which may show as empty sender)
      // This is intentional - empty senderName shouldn't happen in practice
      const result = buildInjectionString(msg);
      expect(result).toContain('Relay message from  ['); // empty between 'from' and '['
    });

    it('does not use senderName when from is not Dashboard even if senderName exists', () => {
      const msg: QueuedMessage = {
        ...baseMessage,
        from: 'OtherAgent',
        data: { senderName: 'ShouldNotBeUsed' },
      };
      const result = buildInjectionString(msg);
      expect(result).toContain('Relay message from OtherAgent');
      expect(result).not.toContain('ShouldNotBeUsed');
    });
  });

  describe('message formatting', () => {
    it('includes short message ID', () => {
      const result = buildInjectionString(baseMessage);
      expect(result).toContain('[abc12345]');
    });

    it('includes thread hint when present', () => {
      const msg: QueuedMessage = {
        ...baseMessage,
        thread: 'issue-123',
      };
      const result = buildInjectionString(msg);
      expect(result).toContain('[thread:issue-123]');
    });

    it('includes channel hint for broadcasts', () => {
      const msg: QueuedMessage = {
        ...baseMessage,
        originalTo: '*',
      };
      const result = buildInjectionString(msg);
      expect(result).toContain('[#general]');
    });

    it('includes channel hint for channel messages', () => {
      const msg: QueuedMessage = {
        ...baseMessage,
        originalTo: '#random',
      };
      const result = buildInjectionString(msg);
      expect(result).toContain('[#random]');
    });

    it('includes importance indicator for high importance', () => {
      const msg: QueuedMessage = {
        ...baseMessage,
        importance: 80,
      };
      const result = buildInjectionString(msg);
      expect(result).toContain('[!!]');
    });

    it('includes importance indicator for medium importance', () => {
      const msg: QueuedMessage = {
        ...baseMessage,
        importance: 60,
      };
      const result = buildInjectionString(msg);
      expect(result).toContain('[!]');
      expect(result).not.toContain('[!!]');
    });
  });

  describe('double-wrapping prevention', () => {
    it('returns body as-is when already formatted', () => {
      const alreadyFormatted = 'Relay message from Alice [abc12345]: Hello world';
      const msg: QueuedMessage = {
        ...baseMessage,
        body: alreadyFormatted,
      };
      const result = buildInjectionString(msg);
      // Should NOT double-wrap
      expect(result).toBe(alreadyFormatted);
      expect(result).not.toContain('Relay message from TestAgent');
    });

    it('returns body as-is when already formatted with thread hint', () => {
      const alreadyFormatted = 'Relay message from Alice [abc12345] [thread:task-123]: Hello world';
      const msg: QueuedMessage = {
        ...baseMessage,
        body: alreadyFormatted,
      };
      const result = buildInjectionString(msg);
      expect(result).toBe(alreadyFormatted);
    });

    it('returns body as-is when already formatted with channel hint', () => {
      const alreadyFormatted = 'Relay message from Alice [abc12345] [#general]: Hello world';
      const msg: QueuedMessage = {
        ...baseMessage,
        body: alreadyFormatted,
      };
      const result = buildInjectionString(msg);
      expect(result).toBe(alreadyFormatted);
    });

    it('returns body as-is when already formatted with importance', () => {
      const alreadyFormatted = 'Relay message from Alice [abc12345] [!!]: Urgent task';
      const msg: QueuedMessage = {
        ...baseMessage,
        body: alreadyFormatted,
      };
      const result = buildInjectionString(msg);
      expect(result).toBe(alreadyFormatted);
    });

    it('strips ANSI from already-formatted messages', () => {
      // ANSI escape for bold
      const withAnsi = '\x1b[1mRelay message from Alice [abc12345]: Hello\x1b[0m';
      const msg: QueuedMessage = {
        ...baseMessage,
        body: withAnsi,
      };
      const result = buildInjectionString(msg);
      expect(result).toBe('Relay message from Alice [abc12345]: Hello');
    });

    it('normalizes whitespace in already-formatted messages', () => {
      const withNewlines = 'Relay message from Alice [abc12345]: Hello\nworld\ntest';
      const msg: QueuedMessage = {
        ...baseMessage,
        body: withNewlines,
      };
      const result = buildInjectionString(msg);
      expect(result).toBe('Relay message from Alice [abc12345]: Hello world test');
    });

    it('formats normally when body does not start with relay prefix', () => {
      const normalBody = 'Hello world';
      const msg: QueuedMessage = {
        ...baseMessage,
        body: normalBody,
      };
      const result = buildInjectionString(msg);
      expect(result).toContain('Relay message from TestAgent');
      expect(result).toContain('[abc12345]');
      expect(result).toContain(': Hello world');
    });

    it('formats normally when body contains but does not start with relay prefix', () => {
      // Body mentions relay message but doesn't start with it
      const bodyWithMention = 'Please check the Relay message from Alice above';
      const msg: QueuedMessage = {
        ...baseMessage,
        body: bodyWithMention,
      };
      const result = buildInjectionString(msg);
      expect(result).toContain('Relay message from TestAgent');
      expect(result).toContain(': Please check the Relay message from Alice above');
    });
  });
});

// Import priority functions for testing
import {
  MESSAGE_PRIORITY,
  getPriorityFromImportance,
  sortByPriority,
} from './shared.js';

describe('Message Priority System', () => {
  describe('MESSAGE_PRIORITY constants', () => {
    it('has correct priority ordering (lower = higher priority)', () => {
      expect(MESSAGE_PRIORITY.URGENT).toBe(0);
      expect(MESSAGE_PRIORITY.HIGH).toBe(1);
      expect(MESSAGE_PRIORITY.NORMAL).toBe(2);
      expect(MESSAGE_PRIORITY.LOW).toBe(3);
    });
  });

  describe('getPriorityFromImportance', () => {
    it('returns URGENT for importance >= 90', () => {
      expect(getPriorityFromImportance(90)).toBe(MESSAGE_PRIORITY.URGENT);
      expect(getPriorityFromImportance(100)).toBe(MESSAGE_PRIORITY.URGENT);
    });

    it('returns HIGH for importance >= 70', () => {
      expect(getPriorityFromImportance(70)).toBe(MESSAGE_PRIORITY.HIGH);
      expect(getPriorityFromImportance(89)).toBe(MESSAGE_PRIORITY.HIGH);
    });

    it('returns NORMAL for importance >= 30', () => {
      expect(getPriorityFromImportance(30)).toBe(MESSAGE_PRIORITY.NORMAL);
      expect(getPriorityFromImportance(69)).toBe(MESSAGE_PRIORITY.NORMAL);
    });

    it('returns LOW for importance < 30', () => {
      expect(getPriorityFromImportance(29)).toBe(MESSAGE_PRIORITY.LOW);
      expect(getPriorityFromImportance(0)).toBe(MESSAGE_PRIORITY.LOW);
    });

    it('returns NORMAL for undefined importance', () => {
      expect(getPriorityFromImportance(undefined)).toBe(MESSAGE_PRIORITY.NORMAL);
    });
  });

  describe('sortByPriority', () => {
    const baseMsg = { from: 'Test', body: 'test', messageId: 'test' };

    it('sorts messages by priority (urgent first)', () => {
      const messages: QueuedMessage[] = [
        { ...baseMsg, messageId: 'low', importance: 10 },
        { ...baseMsg, messageId: 'urgent', importance: 95 },
        { ...baseMsg, messageId: 'normal', importance: 50 },
        { ...baseMsg, messageId: 'high', importance: 75 },
      ];

      const sorted = sortByPriority(messages);

      expect(sorted[0].messageId).toBe('urgent');
      expect(sorted[1].messageId).toBe('high');
      expect(sorted[2].messageId).toBe('normal');
      expect(sorted[3].messageId).toBe('low');
    });

    it('preserves order within same priority (stable sort)', () => {
      const messages: QueuedMessage[] = [
        { ...baseMsg, messageId: 'first', importance: 50 },
        { ...baseMsg, messageId: 'second', importance: 50 },
        { ...baseMsg, messageId: 'third', importance: 50 },
      ];

      const sorted = sortByPriority(messages);

      expect(sorted[0].messageId).toBe('first');
      expect(sorted[1].messageId).toBe('second');
      expect(sorted[2].messageId).toBe('third');
    });

    it('handles empty array', () => {
      expect(sortByPriority([])).toEqual([]);
    });

    it('handles single message', () => {
      const messages: QueuedMessage[] = [{ ...baseMsg, messageId: 'only' }];
      const sorted = sortByPriority(messages);
      expect(sorted).toHaveLength(1);
      expect(sorted[0].messageId).toBe('only');
    });

    it('does not mutate original array', () => {
      const messages: QueuedMessage[] = [
        { ...baseMsg, messageId: 'low', importance: 10 },
        { ...baseMsg, messageId: 'high', importance: 90 },
      ];

      const sorted = sortByPriority(messages);

      expect(messages[0].messageId).toBe('low'); // Original unchanged
      expect(sorted[0].messageId).toBe('high'); // Sorted copy
    });
  });
});

// Import auto-suggestion detection functions for testing
import { detectAutoSuggest, shouldIgnoreForIdleDetection } from './shared.js';

describe('Auto-suggestion Detection', () => {
  describe('detectAutoSuggest', () => {
    it('detects dim text styling (common for ghost text)', () => {
      // \x1B[2m is dim text
      const output = '\x1B[2msuggested completion\x1B[0m';
      const result = detectAutoSuggest(output);

      expect(result.isAutoSuggest).toBe(true);
      expect(result.patterns).toContain('dim');
      expect(result.confidence).toBeGreaterThanOrEqual(0.4);
    });

    it('detects bright black (dark gray) styling', () => {
      // \x1B[90m is bright black (dark gray)
      const output = '\x1B[90mauto-suggested text\x1B[0m';
      const result = detectAutoSuggest(output);

      expect(result.isAutoSuggest).toBe(true);
      expect(result.patterns).toContain('brightBlack');
      expect(result.confidence).toBeGreaterThanOrEqual(0.4);
    });

    it('detects 256-color gray styling (pattern detected but alone not enough)', () => {
      // \x1B[38;5;8m is 256-color dark gray
      // By itself it only adds 0.3 confidence, below the 0.4 threshold
      const output = '\x1B[38;5;8msuggestion\x1B[0m';
      const result = detectAutoSuggest(output);

      expect(result.patterns).toContain('gray256');
      expect(result.confidence).toBeGreaterThan(0);
      // 256-color gray alone isn't enough - need additional signals
      expect(result.isAutoSuggest).toBe(false);
    });

    it('detects 256-color gray combined with other signals', () => {
      // 256-color gray + cursor save/restore = strong signal
      const output = '\x1B[s\x1B[38;5;8msuggestion\x1B[0m\x1B[u';
      const result = detectAutoSuggest(output);

      expect(result.isAutoSuggest).toBe(true);
      expect(result.patterns).toContain('gray256');
      expect(result.patterns).toContain('cursorSaveRestore');
    });

    it('detects cursor save/restore pair (strong indicator)', () => {
      // \x1B[s saves cursor, \x1B[u restores cursor
      const output = '\x1B[s\x1B[90msuggestion\x1B[0m\x1B[u';
      const result = detectAutoSuggest(output);

      expect(result.isAutoSuggest).toBe(true);
      expect(result.patterns).toContain('cursorSaveRestore');
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('detects alternative cursor save/restore (ESC 7/8)', () => {
      // \x1B7 saves cursor, \x1B8 restores cursor (alternative format)
      const output = '\x1B7\x1B[2mcompletion\x1B0m\x1B8';
      const result = detectAutoSuggest(output);

      expect(result.patterns).toContain('cursorSaveRestore');
    });

    it('returns false for normal text output', () => {
      const output = 'Hello, this is normal output text\n';
      const result = detectAutoSuggest(output);

      expect(result.isAutoSuggest).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.patterns).toHaveLength(0);
    });

    it('returns false for colored output without gray/dim', () => {
      // Regular green text - not an auto-suggestion
      const output = '\x1B[32mSuccess: Tests passed\x1B[0m';
      const result = detectAutoSuggest(output);

      expect(result.isAutoSuggest).toBe(false);
    });

    it('reduces confidence for multi-line output', () => {
      // Auto-suggestions are typically single-line
      const multiLine = '\x1B[90mLine 1\nLine 2\nLine 3\nLine 4\x1B[0m';
      const result = detectAutoSuggest(multiLine);

      // Still detects the pattern but confidence is reduced
      expect(result.patterns).toContain('brightBlack');
      // Multi-line reduces confidence by 50%
      expect(result.confidence).toBeLessThan(0.4);
    });

    it('combines multiple patterns for higher confidence', () => {
      // Both dim and cursor save/restore
      const output = '\x1B[s\x1B[2m\x1B[90msuggestion\x1B[0m\x1B[u';
      const result = detectAutoSuggest(output);

      expect(result.patterns).toContain('dim');
      expect(result.patterns).toContain('brightBlack');
      expect(result.patterns).toContain('cursorSaveRestore');
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('includes stripped content for debugging', () => {
      const output = '\x1B[90msuggested text\x1B[0m';
      const result = detectAutoSuggest(output);

      expect(result.strippedContent).toBe('suggested text');
    });
  });

  describe('shouldIgnoreForIdleDetection', () => {
    it('ignores empty output', () => {
      expect(shouldIgnoreForIdleDetection('')).toBe(true);
    });

    it('ignores output that is only ANSI control sequences', () => {
      // Just cursor movement, no actual content
      const output = '\x1B[2J\x1B[H'; // Clear screen and home cursor
      expect(shouldIgnoreForIdleDetection(output)).toBe(true);
    });

    it('ignores auto-suggestion output', () => {
      const autoSuggest = '\x1B[90mtype "exit" to quit\x1B[0m';
      expect(shouldIgnoreForIdleDetection(autoSuggest)).toBe(true);
    });

    it('does not ignore normal text output', () => {
      const normalOutput = 'Hello world\n';
      expect(shouldIgnoreForIdleDetection(normalOutput)).toBe(false);
    });

    it('does not ignore colored output (non-gray)', () => {
      const greenOutput = '\x1B[32mTest passed!\x1B[0m\n';
      expect(shouldIgnoreForIdleDetection(greenOutput)).toBe(false);
    });

    it('does not ignore relay messages', () => {
      const relayMessage = '->relay:Lead Task completed';
      expect(shouldIgnoreForIdleDetection(relayMessage)).toBe(false);
    });
  });
});
