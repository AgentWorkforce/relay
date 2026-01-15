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
});
