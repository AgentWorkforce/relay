/**
 * Unit tests for Bridge Utilities
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
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
    let existsSyncSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      existsSyncSpy = vi.spyOn(fs, 'existsSync');
    });

    afterEach(() => {
      existsSyncSpy.mockRestore();
    });

    // Helper: projectRoot IS a git repo (spawned agent inside a repo)
    function mockIsGitRepo() {
      existsSyncSpy.mockImplementation((p) => String(p).endsWith('.git'));
    }

    // Helper: projectRoot is NOT a git repo (lead/daemon at workspace root)
    function mockNotGitRepo() {
      existsSyncSpy.mockReturnValue(false);
    }

    // === Case 1: Spawned agent in a repo (projectRoot has .git) ===
    describe('when projectRoot is a git repo (spawned agent)', () => {
      const projectRoot = '/data/repos/relay';

      beforeEach(() => mockIsGitRepo());

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
        expect(resolveAgentCwd(projectRoot, undefined)).toEqual({ cwd: '/data/repos/relay' });
      });

      it('defaults to projectRoot when cwd is null', () => {
        expect(resolveAgentCwd(projectRoot, null)).toEqual({ cwd: '/data/repos/relay' });
      });

      it('defaults to projectRoot when cwd is empty string', () => {
        expect(resolveAgentCwd(projectRoot, '')).toEqual({ cwd: '/data/repos/relay' });
      });

      it('rejects path traversal above workspace root', () => {
        const result = resolveAgentCwd(projectRoot, '../../etc/passwd');
        expect(result).toHaveProperty('error');
        expect((result as { error: string }).error).toContain('must be within the workspace root');
      });

      it('allows workspace root itself', () => {
        const result = resolveAgentCwd(projectRoot, '.');
        expect(result).toEqual({ cwd: '/data/repos' });
      });
    });

    // === Case 2: Lead/daemon at workspace root (no .git) ===
    describe('when projectRoot is the workspace root (lead/daemon)', () => {
      const projectRoot = '/data/repos';

      beforeEach(() => mockNotGitRepo());

      it('resolves repo name correctly', () => {
        const result = resolveAgentCwd(projectRoot, 'relaycast');
        expect(result).toEqual({ cwd: '/data/repos/relaycast' });
      });

      it('resolves another repo name', () => {
        const result = resolveAgentCwd(projectRoot, 'relay');
        expect(result).toEqual({ cwd: '/data/repos/relay' });
      });

      it('resolves subdirectory within a repo', () => {
        const result = resolveAgentCwd(projectRoot, 'relay/packages/bridge');
        expect(result).toEqual({ cwd: '/data/repos/relay/packages/bridge' });
      });

      it('defaults to projectRoot when no cwd', () => {
        expect(resolveAgentCwd(projectRoot, undefined)).toEqual({ cwd: '/data/repos' });
      });

      it('rejects path traversal', () => {
        const result = resolveAgentCwd(projectRoot, '../etc/passwd');
        expect(result).toHaveProperty('error');
      });

      it('allows workspace root itself', () => {
        const result = resolveAgentCwd(projectRoot, '.');
        expect(result).toEqual({ cwd: '/data/repos' });
      });
    });

    // === Case 3: Single-repo local setup ===
    describe('single-repo local setup', () => {
      const projectRoot = '/home/user/myproject';

      it('defaults correctly (with .git)', () => {
        mockIsGitRepo();
        expect(resolveAgentCwd(projectRoot, undefined)).toEqual({ cwd: '/home/user/myproject' });
      });

      it('resolves sibling when projectRoot is a repo', () => {
        mockIsGitRepo();
        const result = resolveAgentCwd(projectRoot, 'other-project');
        expect(result).toEqual({ cwd: '/home/user/other-project' });
      });

      it('resolves same dir name when projectRoot is a repo', () => {
        mockIsGitRepo();
        const result = resolveAgentCwd(projectRoot, 'myproject');
        expect(result).toEqual({ cwd: '/home/user/myproject' });
      });

      it('defaults correctly (without .git)', () => {
        mockNotGitRepo();
        expect(resolveAgentCwd(projectRoot, undefined)).toEqual({ cwd: '/home/user/myproject' });
      });

      it('resolves child dir when projectRoot has no .git', () => {
        mockNotGitRepo();
        const result = resolveAgentCwd(projectRoot, 'subdir');
        expect(result).toEqual({ cwd: '/home/user/myproject/subdir' });
      });
    });
  });
});
