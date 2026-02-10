/**
 * Unit tests for Bridge Utilities
 */

import { describe, it, expect } from 'vitest';
import { parseTarget, escapeForShell, escapeForTmux, resolveAgentCwd } from './utils.js';

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

  describe('resolveAgentCwd', () => {
    // Multi-repo workspace: /data/repos/relay is the project, /data/repos is the workspace root
    const projectRoot = '/data/repos/relay';

    it('resolves sibling repo name to workspace root', () => {
      const result = resolveAgentCwd(projectRoot, 'relaycast');
      expect(result).toEqual({ cwd: '/data/repos/relaycast' });
    });

    it('resolves same repo name back to project root', () => {
      const result = resolveAgentCwd(projectRoot, 'relay');
      expect(result).toEqual({ cwd: '/data/repos/relay' });
    });

    it('resolves subdirectory within sibling repo', () => {
      const result = resolveAgentCwd(projectRoot, 'relaycast/packages/app');
      expect(result).toEqual({ cwd: '/data/repos/relaycast/packages/app' });
    });

    it('defaults to projectRoot when no cwd is provided', () => {
      const result = resolveAgentCwd(projectRoot, undefined);
      expect(result).toEqual({ cwd: '/data/repos/relay' });
    });

    it('defaults to projectRoot when cwd is null', () => {
      const result = resolveAgentCwd(projectRoot, null);
      expect(result).toEqual({ cwd: '/data/repos/relay' });
    });

    it('defaults to projectRoot when cwd is empty string', () => {
      const result = resolveAgentCwd(projectRoot, '');
      expect(result).toEqual({ cwd: '/data/repos/relay' });
    });

    it('rejects path traversal above workspace root', () => {
      const result = resolveAgentCwd(projectRoot, '../../etc/passwd');
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('must be within the workspace root');
    });

    it('rejects traversal with ../', () => {
      const result = resolveAgentCwd(projectRoot, '../../../tmp');
      expect(result).toHaveProperty('error');
    });

    it('allows workspace root itself (parent dir)', () => {
      // CWD: "." resolves to /data/repos (the workspace root) which is allowed
      const result = resolveAgentCwd(projectRoot, '.');
      expect(result).toEqual({ cwd: '/data/repos' });
    });

    // Single-repo setup: /home/user/myproject is the only project
    it('works in single-repo setup — defaults correctly', () => {
      const singleRoot = '/home/user/myproject';
      const result = resolveAgentCwd(singleRoot, undefined);
      expect(result).toEqual({ cwd: '/home/user/myproject' });
    });

    it('works in single-repo setup — resolves sibling name', () => {
      const singleRoot = '/home/user/myproject';
      const result = resolveAgentCwd(singleRoot, 'other-project');
      expect(result).toEqual({ cwd: '/home/user/other-project' });
    });

    it('works in single-repo setup — resolves same dir name', () => {
      const singleRoot = '/home/user/myproject';
      const result = resolveAgentCwd(singleRoot, 'myproject');
      expect(result).toEqual({ cwd: '/home/user/myproject' });
    });
  });
});
