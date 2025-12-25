/**
 * Unit tests for Bridge Configuration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  resolvePath,
  getDefaultLeadName,
  resolveProjects,
  validateDaemons,
} from './config.js';

// Mock fs module
vi.mock('node:fs');
vi.mock('../utils/project-namespace.js', () => ({
  getProjectPaths: vi.fn((projectPath: string) => ({
    projectId: 'test-project-id',
    socketPath: `/tmp/agent-relay/test-project-id/relay.sock`,
    dataDir: `/tmp/agent-relay/test-project-id`,
    teamDir: `/tmp/agent-relay/test-project-id/team`,
    dbPath: `/tmp/agent-relay/test-project-id/messages.sqlite`,
    projectRoot: projectPath,
  })),
}));

describe('Bridge Config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('resolvePath', () => {
    it('expands ~ to home directory', () => {
      const homedir = os.homedir();
      const result = resolvePath('~/projects/test');
      expect(result).toBe(path.join(homedir, 'projects/test'));
    });

    it('resolves relative paths to absolute', () => {
      const result = resolvePath('./relative/path');
      expect(path.isAbsolute(result)).toBe(true);
    });

    it('keeps absolute paths unchanged', () => {
      const result = resolvePath('/absolute/path');
      expect(result).toBe('/absolute/path');
    });
  });

  describe('getDefaultLeadName', () => {
    it('capitalizes directory name', () => {
      expect(getDefaultLeadName('/path/to/auth-service')).toBe('Auth-service');
      expect(getDefaultLeadName('/path/to/frontend')).toBe('Frontend');
      expect(getDefaultLeadName('/path/to/API')).toBe('API');
    });

    it('handles single-letter directory names', () => {
      expect(getDefaultLeadName('/path/to/a')).toBe('A');
    });
  });

  describe('resolveProjects', () => {
    it('creates project configs from CLI paths', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const projects = resolveProjects(['/path/to/auth', '/path/to/frontend']);

      expect(projects).toHaveLength(2);
      expect(projects[0]).toMatchObject({
        path: '/path/to/auth',
        leadName: 'Auth',
        cli: 'claude',
      });
      expect(projects[1]).toMatchObject({
        path: '/path/to/frontend',
        leadName: 'Frontend',
        cli: 'claude',
      });
    });

    it('applies CLI override to all projects', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const projects = resolveProjects(['/path/to/auth'], 'codex');

      expect(projects[0].cli).toBe('codex');
    });

    it('skips non-existent paths', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const projects = resolveProjects(['/nonexistent/path']);

      expect(projects).toHaveLength(0);
    });
  });

  describe('validateDaemons', () => {
    it('separates projects with and without running daemons', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).includes('auth');
      });

      const projects = [
        { path: '/auth', id: 'auth', socketPath: '/tmp/auth/relay.sock', leadName: 'Auth', cli: 'claude' },
        { path: '/frontend', id: 'frontend', socketPath: '/tmp/frontend/relay.sock', leadName: 'Frontend', cli: 'claude' },
      ];

      const { valid, missing } = validateDaemons(projects);

      expect(valid).toHaveLength(1);
      expect(valid[0].id).toBe('auth');
      expect(missing).toHaveLength(1);
      expect(missing[0].id).toBe('frontend');
    });

    it('returns all valid when all daemons running', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const projects = [
        { path: '/auth', id: 'auth', socketPath: '/tmp/auth/relay.sock', leadName: 'Auth', cli: 'claude' },
      ];

      const { valid, missing } = validateDaemons(projects);

      expect(valid).toHaveLength(1);
      expect(missing).toHaveLength(0);
    });
  });
});
