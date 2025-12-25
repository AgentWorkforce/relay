/**
 * Unit tests for Bridge Utilities
 */

import { describe, it, expect } from 'vitest';
import { parseTarget, escapeForShell, escapeForTmux } from './utils.js';

describe('Bridge Utils', () => {
  describe('parseTarget', () => {
    it('parses project:agent format', () => {
      const result = parseTarget('auth:Alice');
      expect(result).toEqual({
        projectId: 'auth',
        agentName: 'Alice',
      });
    });

    it('parses wildcard project', () => {
      const result = parseTarget('*:lead');
      expect(result).toEqual({
        projectId: '*',
        agentName: 'lead',
      });
    });

    it('parses wildcard agent', () => {
      const result = parseTarget('frontend:*');
      expect(result).toEqual({
        projectId: 'frontend',
        agentName: '*',
      });
    });

    it('parses double wildcard', () => {
      const result = parseTarget('*:*');
      expect(result).toEqual({
        projectId: '*',
        agentName: '*',
      });
    });

    it('returns null for invalid format (no colon)', () => {
      const result = parseTarget('invalidformat');
      expect(result).toBeNull();
    });

    it('returns null for too many colons', () => {
      const result = parseTarget('a:b:c');
      expect(result).toBeNull();
    });
  });

  describe('escapeForShell', () => {
    it('escapes backslashes', () => {
      expect(escapeForShell('path\\to\\file')).toBe('path\\\\to\\\\file');
    });

    it('escapes double quotes', () => {
      expect(escapeForShell('say "hello"')).toBe('say \\"hello\\"');
    });

    it('escapes dollar signs', () => {
      expect(escapeForShell('$HOME/path')).toBe('\\$HOME/path');
    });

    it('escapes backticks', () => {
      expect(escapeForShell('echo `date`')).toBe('echo \\`date\\`');
    });

    it('escapes exclamation marks', () => {
      expect(escapeForShell('Hello!')).toBe('Hello\\!');
    });

    it('handles multiple special characters', () => {
      expect(escapeForShell('$var "test" `cmd`')).toBe('\\$var \\"test\\" \\`cmd\\`');
    });
  });

  describe('escapeForTmux', () => {
    it('replaces newlines with spaces', () => {
      expect(escapeForTmux('line1\nline2\nline3')).toBe('line1 line2 line3');
    });

    it('replaces carriage returns with spaces', () => {
      expect(escapeForTmux('line1\r\nline2')).toBe('line1 line2');
    });

    it('escapes shell special characters', () => {
      expect(escapeForTmux('$var')).toBe('\\$var');
    });

    it('handles complex input', () => {
      const input = 'Hello\nWorld\r\n$test "quoted"';
      const expected = 'Hello World \\$test \\"quoted\\"';
      expect(escapeForTmux(input)).toBe(expected);
    });
  });
});
