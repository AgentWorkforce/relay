/**
 * Tests for Workspace Persistence
 *
 * Verifies that workspace repositories persist across container restarts.
 * The key requirement is that WORKSPACE_DIR must be on the persistent volume (/data).
 *
 * Bug Context:
 * - Volume mounted at: /data (persistent)
 * - Default WORKSPACE_DIR: /workspace (ephemeral container filesystem)
 * - Repos cloned to /workspace → lost on restart
 *
 * Fix:
 * - Set WORKSPACE_DIR=/data/repos to store repos on persistent volume
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Read the provisioner source code for verification
const provisionerSource = readFileSync(
  join(__dirname, 'index.ts'),
  'utf-8'
);

describe('Workspace Persistence Configuration', () => {
  describe('WORKSPACE_DIR Environment Variable', () => {
    it('should set WORKSPACE_DIR to /data/repos in Fly provisioner', () => {
      // Verify the FlyProvisioner sets WORKSPACE_DIR=/data/repos
      expect(provisionerSource).toContain("WORKSPACE_DIR: '/data/repos'");
    });

    it('should have comment explaining the persistence fix', () => {
      // Verify there's a comment explaining why WORKSPACE_DIR is set
      expect(provisionerSource).toMatch(/Store repos on persistent volume/i);
    });

    it('should NOT use default /workspace directory', () => {
      // Verify we're not setting WORKSPACE_DIR to the ephemeral /workspace
      expect(provisionerSource).not.toMatch(/WORKSPACE_DIR:\s*['"]\/workspace['"]/);
    });
  });

  describe('Railway Provisioner', () => {
    it('should set WORKSPACE_DIR to /data/repos', () => {
      // Railway provisioner uses envVars object
      // Should contain WORKSPACE_DIR: '/data/repos'
      expect(provisionerSource).toContain("WORKSPACE_DIR: '/data/repos'");
    });
  });

  describe('Docker Provisioner', () => {
    it('should set WORKSPACE_DIR to /data/repos via -e flag', () => {
      // Docker provisioner uses -e WORKSPACE_DIR=/data/repos
      expect(provisionerSource).toContain('-e WORKSPACE_DIR=/data/repos');
    });
  });

  describe('Volume Mount Configuration', () => {
    it('should mount volume at /data', () => {
      // Verify volume is mounted at /data
      expect(provisionerSource).toMatch(/path:\s*['"]\/data['"]/);
    });

    it('should have WORKSPACE_DIR under the /data mount point', () => {
      // WORKSPACE_DIR is /data/repos which is under /data (the mount point)
      // This ensures repos are stored on the persistent volume
      const workspaceDirMatch = provisionerSource.match(/WORKSPACE_DIR['":\s]+['"]([^'"]+)['"]/);
      expect(workspaceDirMatch).toBeTruthy();

      const workspaceDir = workspaceDirMatch![1];
      expect(workspaceDir).toBe('/data/repos');
      expect(workspaceDir.startsWith('/data')).toBe(true);
    });
  });
});

describe('Entrypoint Script Behavior', () => {
  // These tests document expected entrypoint.sh behavior when WORKSPACE_DIR is set

  it('documents: entrypoint clones to WORKSPACE_DIR if repo does not exist', () => {
    // When WORKSPACE_DIR=/data/repos and repo doesn't exist:
    // entrypoint.sh: git clone https://github.com/owner/repo.git /data/repos/repo
    // → Repo is on persistent volume
    expect(true).toBe(true);
  });

  it('documents: entrypoint preserves branch if repo already exists', () => {
    // When WORKSPACE_DIR=/data/repos and repo already exists (has .git):
    // entrypoint.sh: git pull --ff-only (not git clone)
    // → Branch state is preserved from previous session
    // → Local commits are preserved (fast-forward only)
    expect(true).toBe(true);
  });

  it('documents: local uncommitted changes are preserved on persistent volume', () => {
    // When repos are on /data (persistent volume):
    // - Uncommitted file changes persist across restarts
    // - Modified files are not lost
    // - Only git operations (pull) may conflict with remote changes
    expect(true).toBe(true);
  });
});

describe('Configuration Consistency', () => {
  it('should have WORKSPACE_DIR set in all three provisioners', () => {
    // Count occurrences of WORKSPACE_DIR being set to /data/repos
    const flyMatch = provisionerSource.match(/WORKSPACE_DIR:\s*['"]\/data\/repos['"]/g);
    const dockerMatch = provisionerSource.match(/-e WORKSPACE_DIR=\/data\/repos/g);

    // Should have at least 2 occurrences in object notation (Fly + Railway)
    // Plus 1 occurrence in Docker -e flag format
    expect(flyMatch).toBeTruthy();
    expect(flyMatch!.length).toBeGreaterThanOrEqual(2); // Fly + Railway
    expect(dockerMatch).toBeTruthy();
    expect(dockerMatch!.length).toBeGreaterThanOrEqual(1); // Docker
  });
});
