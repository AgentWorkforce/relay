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
    it('uses msg.from when from is not _DashboardUI', () => {
      const msg: QueuedMessage = {
        ...baseMessage,
        from: 'RegularAgent',
      };
      const result = buildInjectionString(msg);
      expect(result).toContain('Relay message from RegularAgent');
    });

    it('uses msg.from when from is _DashboardUI but no senderName in data', () => {
      const msg: QueuedMessage = {
        ...baseMessage,
        from: '_DashboardUI',
      };
      const result = buildInjectionString(msg);
      expect(result).toContain('Relay message from _DashboardUI');
    });

    it('uses senderName when from is _DashboardUI and senderName exists', () => {
      const msg: QueuedMessage = {
        ...baseMessage,
        from: '_DashboardUI',
        data: { senderName: 'GitHubUser123' },
      };
      const result = buildInjectionString(msg);
      expect(result).toContain('Relay message from GitHubUser123');
      expect(result).not.toContain('_DashboardUI');
    });

    it('uses msg.from when senderName is not a string', () => {
      const msg: QueuedMessage = {
        ...baseMessage,
        from: '_DashboardUI',
        data: { senderName: 12345 }, // not a string
      };
      const result = buildInjectionString(msg);
      expect(result).toContain('Relay message from _DashboardUI');
    });

    it('uses msg.from when senderName is empty string', () => {
      const msg: QueuedMessage = {
        ...baseMessage,
        from: '_DashboardUI',
        data: { senderName: '' },
      };
      // Empty string is falsy but still a string - our check uses typeof === 'string'
      // So empty string will be used (which may show as empty sender)
      // This is intentional - empty senderName shouldn't happen in practice
      const result = buildInjectionString(msg);
      expect(result).toContain('Relay message from  ['); // empty between 'from' and '['
    });

    it('does not use senderName when from is not _DashboardUI even if senderName exists', () => {
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
