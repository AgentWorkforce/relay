import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  findProjectRoot,
  getProjectPaths,
  getGlobalPaths,
  ensureProjectDir,
  listProjects,
} from './project-namespace.js';

describe('project-namespace', () => {
  describe('findProjectRoot', () => {
    it('should find project root from current directory', () => {
      // agent-relay has .git, so should find it
      const root = findProjectRoot();
      expect(root).toBeTruthy();
      expect(fs.existsSync(path.join(root, '.git')) || fs.existsSync(path.join(root, 'package.json'))).toBe(true);
    });

    it('should find project root from subdirectory', () => {
      const subDir = path.join(process.cwd(), 'src');
      if (fs.existsSync(subDir)) {
        const root = findProjectRoot(subDir);
        expect(root).toBe(path.resolve(process.cwd()));
      }
    });

    it('should return start directory if no markers found', () => {
      // Use temp dir with no project markers
      const tempDir = os.tmpdir();
      const root = findProjectRoot(tempDir);
      // Should return the temp dir or find a marker up the chain
      expect(root).toBeTruthy();
    });
  });

  describe('getProjectPaths', () => {
    it('should return all required paths', () => {
      const paths = getProjectPaths();

      expect(paths.dataDir).toBeTruthy();
      expect(paths.teamDir).toBeTruthy();
      expect(paths.dbPath).toBeTruthy();
      expect(paths.socketPath).toBeTruthy();
      expect(paths.projectRoot).toBeTruthy();
      expect(paths.projectId).toBeTruthy();
    });

    it('should generate consistent paths for same project', () => {
      const paths1 = getProjectPaths();
      const paths2 = getProjectPaths();

      expect(paths1.projectId).toBe(paths2.projectId);
      expect(paths1.dataDir).toBe(paths2.dataDir);
    });

    it('should generate different paths for different projects', () => {
      const paths1 = getProjectPaths('/tmp/project-a');
      const paths2 = getProjectPaths('/tmp/project-b');

      expect(paths1.projectId).not.toBe(paths2.projectId);
      expect(paths1.dataDir).not.toBe(paths2.dataDir);
    });

    it('should have consistent structure', () => {
      const paths = getProjectPaths();

      expect(paths.teamDir).toBe(path.join(paths.dataDir, 'team'));
      expect(paths.dbPath).toBe(path.join(paths.dataDir, 'messages.sqlite'));
      expect(paths.socketPath).toBe(path.join(paths.dataDir, 'relay.sock'));
    });

    it('should use 12-char hash for projectId', () => {
      const paths = getProjectPaths();
      expect(paths.projectId).toMatch(/^[a-f0-9]{12}$/);
    });
  });

  describe('getGlobalPaths', () => {
    it('should return global paths', () => {
      const paths = getGlobalPaths();

      expect(paths.projectId).toBe('global');
      expect(paths.dataDir).toContain('.agent-relay');
      expect(paths.dataDir).not.toMatch(/[a-f0-9]{12}$/);
    });
  });

  describe('ensureProjectDir', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = path.join(os.tmpdir(), `agent-relay-test-${Date.now()}`);
    });

    afterEach(() => {
      // Clean up test directory
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should create data directory if not exists', () => {
      // Create a test project dir
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(path.join(testDir, 'package.json'), '{}');

      const paths = ensureProjectDir(testDir);

      expect(fs.existsSync(paths.dataDir)).toBe(true);
      expect(fs.existsSync(paths.teamDir)).toBe(true);
    });

    it('should write .project marker file', () => {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(path.join(testDir, 'package.json'), '{}');

      const paths = ensureProjectDir(testDir);
      const markerPath = path.join(paths.dataDir, '.project');

      expect(fs.existsSync(markerPath)).toBe(true);

      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
      expect(marker.projectRoot).toBe(testDir);
      expect(marker.projectId).toBe(paths.projectId);
      expect(marker.createdAt).toBeTruthy();
    });
  });

  describe('listProjects', () => {
    it('should return array of projects', () => {
      const projects = listProjects();

      expect(Array.isArray(projects)).toBe(true);
      // Each project should have required fields
      for (const project of projects) {
        expect(project.projectId).toBeTruthy();
        expect(project.projectRoot).toBeTruthy();
        expect(project.dataDir).toBeTruthy();
      }
    });

    it('should include current project if initialized', () => {
      // Get current project paths
      const currentPaths = getProjectPaths();
      const markerPath = path.join(currentPaths.dataDir, '.project');

      // Only test if project marker exists (project has been properly initialized)
      if (fs.existsSync(markerPath)) {
        const projects = listProjects();
        const found = projects.find(p => p.projectId === currentPaths.projectId);
        expect(found).toBeTruthy();
      }
    });
  });
});
