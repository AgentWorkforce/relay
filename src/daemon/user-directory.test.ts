/**
 * User Directory Service Tests
 *
 * TDD tests for per-user credential storage on workspace volumes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { UserDirectoryService } from './user-directory.js';

describe('UserDirectoryService', () => {
  let tempDir: string;
  let service: UserDirectoryService;

  beforeEach(() => {
    // Create temp directory for tests
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-dir-test-'));
    service = new UserDirectoryService(tempDir);
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create base users directory if it does not exist', () => {
      const usersDir = path.join(tempDir, 'users');
      expect(fs.existsSync(usersDir)).toBe(true);
    });

    it('should handle existing base directory', () => {
      // Service already created in beforeEach, create another
      const service2 = new UserDirectoryService(tempDir);
      expect(service2).toBeDefined();
    });
  });

  describe('getUserHome', () => {
    it('should return path to user home directory', () => {
      const userId = 'user-123';
      const homePath = service.getUserHome(userId);
      expect(homePath).toBe(path.join(tempDir, 'users', userId));
    });

    it('should create directory if it does not exist', () => {
      const userId = 'user-456';
      const homePath = service.getUserHome(userId);
      expect(fs.existsSync(homePath)).toBe(true);
    });

    it('should handle user ID with special characters', () => {
      const userId = 'user_abc-123';
      const homePath = service.getUserHome(userId);
      expect(homePath).toBe(path.join(tempDir, 'users', userId));
      expect(fs.existsSync(homePath)).toBe(true);
    });
  });

  describe('ensureProviderDir', () => {
    it('should create .claude directory for user', () => {
      const userId = 'user-123';
      const claudeDir = service.ensureProviderDir(userId, 'claude');
      expect(claudeDir).toBe(path.join(tempDir, 'users', userId, '.claude'));
      expect(fs.existsSync(claudeDir)).toBe(true);
    });

    it('should create .codex directory for user', () => {
      const userId = 'user-123';
      const codexDir = service.ensureProviderDir(userId, 'codex');
      expect(codexDir).toBe(path.join(tempDir, 'users', userId, '.codex'));
      expect(fs.existsSync(codexDir)).toBe(true);
    });

    it('should create .config/gcloud directory for gemini', () => {
      const userId = 'user-123';
      const geminiDir = service.ensureProviderDir(userId, 'gemini');
      expect(geminiDir).toBe(path.join(tempDir, 'users', userId, '.config', 'gcloud'));
      expect(fs.existsSync(geminiDir)).toBe(true);
    });

    it('should be idempotent - calling twice does not error', () => {
      const userId = 'user-123';
      service.ensureProviderDir(userId, 'claude');
      const dir2 = service.ensureProviderDir(userId, 'claude');
      expect(fs.existsSync(dir2)).toBe(true);
    });
  });

  describe('initializeUserEnvironment', () => {
    it('should create all provider directories for a user', () => {
      const userId = 'user-789';
      service.initializeUserEnvironment(userId);

      // Check all expected directories exist
      expect(fs.existsSync(path.join(tempDir, 'users', userId, '.claude'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'users', userId, '.codex'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'users', userId, '.config', 'gcloud'))).toBe(true);
    });

    it('should return the user home path', () => {
      const userId = 'user-789';
      const homePath = service.initializeUserEnvironment(userId);
      expect(homePath).toBe(path.join(tempDir, 'users', userId));
    });
  });

  describe('getUserEnvironment', () => {
    it('should return environment with HOME set to user directory', () => {
      const userId = 'user-123';
      const env = service.getUserEnvironment(userId);
      expect(env.HOME).toBe(path.join(tempDir, 'users', userId));
    });

    it('should include XDG config home for proper config paths', () => {
      const userId = 'user-123';
      const env = service.getUserEnvironment(userId);
      expect(env.XDG_CONFIG_HOME).toBe(path.join(tempDir, 'users', userId, '.config'));
    });

    it('should include user ID as environment variable', () => {
      const userId = 'user-123';
      const env = service.getUserEnvironment(userId);
      expect(env.AGENT_RELAY_USER_ID).toBe(userId);
    });
  });

  describe('listUsers', () => {
    it('should return empty array when no users', () => {
      const users = service.listUsers();
      expect(users).toEqual([]);
    });

    it('should return list of user IDs with directories', () => {
      service.getUserHome('user-1');
      service.getUserHome('user-2');
      service.getUserHome('user-3');

      const users = service.listUsers();
      expect(users).toHaveLength(3);
      expect(users).toContain('user-1');
      expect(users).toContain('user-2');
      expect(users).toContain('user-3');
    });
  });

  describe('hasUserDirectory', () => {
    it('should return false for non-existent user', () => {
      expect(service.hasUserDirectory('non-existent')).toBe(false);
    });

    it('should return true after getUserHome creates directory', () => {
      const userId = 'user-123';
      service.getUserHome(userId);
      expect(service.hasUserDirectory(userId)).toBe(true);
    });
  });

  describe('getProviderCredentialPath', () => {
    it('should return claude credentials path', () => {
      const userId = 'user-123';
      const credPath = service.getProviderCredentialPath(userId, 'claude');
      expect(credPath).toBe(path.join(tempDir, 'users', userId, '.claude', '.credentials.json'));
    });

    it('should return codex credentials path', () => {
      const userId = 'user-123';
      const credPath = service.getProviderCredentialPath(userId, 'codex');
      expect(credPath).toBe(path.join(tempDir, 'users', userId, '.codex', 'credentials.json'));
    });

    it('should return gemini credentials path', () => {
      const userId = 'user-123';
      const credPath = service.getProviderCredentialPath(userId, 'gemini');
      expect(credPath).toBe(path.join(tempDir, 'users', userId, '.config', 'gcloud', 'application_default_credentials.json'));
    });
  });

  describe('edge cases', () => {
    it('should handle very long user IDs', () => {
      const longUserId = 'a'.repeat(200);
      const homePath = service.getUserHome(longUserId);
      expect(fs.existsSync(homePath)).toBe(true);
    });

    it('should reject user IDs with path traversal attempts', () => {
      expect(() => service.getUserHome('../../../etc')).toThrow();
      expect(() => service.getUserHome('user/../admin')).toThrow();
    });

    it('should reject empty user ID', () => {
      expect(() => service.getUserHome('')).toThrow();
    });
  });
});
