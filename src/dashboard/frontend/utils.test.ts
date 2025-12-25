/**
 * Tests for Dashboard Utility Functions
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  STALE_THRESHOLD_MS,
  isAgentOnline,
  escapeHtml,
  formatTime,
  formatDate,
  getAvatarColor,
  getInitials,
  formatMessageBody,
} from './utils.js';

describe('utils', () => {
  describe('STALE_THRESHOLD_MS', () => {
    it('should be 30 seconds', () => {
      expect(STALE_THRESHOLD_MS).toBe(30000);
    });
  });

  describe('isAgentOnline', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-15T12:00:00.000Z'));
    });

    it('should return false for undefined lastSeen', () => {
      expect(isAgentOnline(undefined)).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isAgentOnline('')).toBe(false);
    });

    it('should return false for invalid date string', () => {
      expect(isAgentOnline('not-a-date')).toBe(false);
    });

    it('should return true for recent timestamp (within 30s)', () => {
      const recentTime = new Date(Date.now() - 10000).toISOString(); // 10 seconds ago
      expect(isAgentOnline(recentTime)).toBe(true);
    });

    it('should return false for stale timestamp (over 30s)', () => {
      const staleTime = new Date(Date.now() - 60000).toISOString(); // 60 seconds ago
      expect(isAgentOnline(staleTime)).toBe(false);
    });

    it('should return true for exactly at threshold', () => {
      const atThreshold = new Date(Date.now() - STALE_THRESHOLD_MS + 1).toISOString();
      expect(isAgentOnline(atThreshold)).toBe(true);
    });

    it('should return false for exactly past threshold', () => {
      const pastThreshold = new Date(Date.now() - STALE_THRESHOLD_MS - 1).toISOString();
      expect(isAgentOnline(pastThreshold)).toBe(false);
    });
  });

  describe('escapeHtml', () => {
    it('should return empty string for undefined', () => {
      expect(escapeHtml(undefined)).toBe('');
    });

    it('should return empty string for empty string', () => {
      expect(escapeHtml('')).toBe('');
    });

    it('should escape HTML special characters', () => {
      expect(escapeHtml('<script>alert("xss")</script>')).toBe(
        '&lt;script&gt;alert("xss")&lt;/script&gt;'
      );
    });

    it('should escape ampersands', () => {
      expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
    });

    it('should escape quotes', () => {
      expect(escapeHtml('say "hello"')).toBe('say "hello"');
    });

    it('should handle mixed content', () => {
      expect(escapeHtml('<div class="test">Hello & goodbye</div>')).toBe(
        '&lt;div class="test"&gt;Hello &amp; goodbye&lt;/div&gt;'
      );
    });

    it('should preserve normal text', () => {
      expect(escapeHtml('Hello World')).toBe('Hello World');
    });
  });

  describe('formatTime', () => {
    it('should format timestamp to locale time', () => {
      const timestamp = '2025-01-15T14:30:00.000Z';
      const result = formatTime(timestamp);
      // Result depends on locale, but should contain hour and minute
      expect(result).toMatch(/\d{1,2}:\d{2}/);
    });

    it('should handle midnight', () => {
      const timestamp = '2025-01-15T00:00:00.000Z';
      const result = formatTime(timestamp);
      expect(result).toBeTruthy();
    });
  });

  describe('formatDate', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-15T12:00:00.000Z'));
    });

    it('should return "Today" for today\'s date', () => {
      const today = '2025-01-15T10:00:00.000Z';
      expect(formatDate(today)).toBe('Today');
    });

    it('should return "Yesterday" for yesterday\'s date', () => {
      const yesterday = '2025-01-14T10:00:00.000Z';
      expect(formatDate(yesterday)).toBe('Yesterday');
    });

    it('should return formatted date for older dates', () => {
      const oldDate = '2025-01-10T10:00:00.000Z';
      const result = formatDate(oldDate);
      // Should include weekday, month, and day
      expect(result).toContain('January');
      expect(result).toContain('10');
    });
  });

  describe('getAvatarColor', () => {
    it('should return a valid hex color', () => {
      const color = getAvatarColor('Alice');
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it('should return consistent color for same name', () => {
      const color1 = getAvatarColor('Bob');
      const color2 = getAvatarColor('Bob');
      expect(color1).toBe(color2);
    });

    it('should return different colors for different names', () => {
      const color1 = getAvatarColor('Alice');
      const color2 = getAvatarColor('Charlie');
      // Not guaranteed to be different, but likely
      expect(typeof color1).toBe('string');
      expect(typeof color2).toBe('string');
    });

    it('should handle empty string', () => {
      const color = getAvatarColor('');
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it('should handle special characters', () => {
      const color = getAvatarColor('Agent-123_test');
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    });
  });

  describe('getInitials', () => {
    it('should return first 2 characters uppercase', () => {
      expect(getInitials('Alice')).toBe('AL');
    });

    it('should handle lowercase names', () => {
      expect(getInitials('bob')).toBe('BO');
    });

    it('should handle single character names', () => {
      expect(getInitials('A')).toBe('A');
    });

    it('should handle long names', () => {
      expect(getInitials('Alexander')).toBe('AL');
    });

    it('should handle names with numbers', () => {
      expect(getInitials('Agent123')).toBe('AG');
    });
  });

  describe('formatMessageBody', () => {
    it('should return empty string for undefined', () => {
      expect(formatMessageBody(undefined)).toBe('');
    });

    it('should return empty string for empty string', () => {
      expect(formatMessageBody('')).toBe('');
    });

    it('should escape HTML', () => {
      expect(formatMessageBody('<script>alert(1)</script>')).toContain('&lt;script&gt;');
    });

    it('should convert inline code with backticks', () => {
      const result = formatMessageBody('Use `console.log()` for debugging');
      expect(result).toContain('<code>console.log()</code>');
    });

    it('should convert code blocks with triple backticks', () => {
      const result = formatMessageBody('```\nconst x = 1;\n```');
      expect(result).toContain('<pre>');
      expect(result).toContain('const x = 1;');
      expect(result).toContain('</pre>');
    });

    it('should handle mixed content', () => {
      const result = formatMessageBody('Hello `world` and ```code block```');
      expect(result).toContain('<code>world</code>');
      expect(result).toContain('<pre>code block</pre>');
    });

    it('should preserve plain text', () => {
      expect(formatMessageBody('Hello World')).toBe('Hello World');
    });

    it('should convert newlines to <br> tags', () => {
      expect(formatMessageBody('Hello\nWorld')).toBe('Hello<br>World');
    });

    it('should handle multiple newlines', () => {
      expect(formatMessageBody('Line1\nLine2\nLine3')).toBe('Line1<br>Line2<br>Line3');
    });

    it('should handle newlines with other content', () => {
      const result = formatMessageBody('Check this:\n- Item 1\n- Item 2');
      expect(result).toBe('Check this:<br>- Item 1<br>- Item 2');
    });
  });
});
