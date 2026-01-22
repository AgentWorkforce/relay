/**
 * Project Namespace Utility
 *
 * Generates project-specific paths for agent-relay data storage.
 * This allows multiple projects to use agent-relay simultaneously
 * without conflicts.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

/**
 * Get the base directory for agent-relay data.
 * Priority:
 * 1. AGENT_RELAY_DATA_DIR environment variable
 * 2. XDG_DATA_HOME/agent-relay (Linux/macOS standard)
 * 3. ~/.agent-relay (fallback)
 */
function getBaseDir(): string {
  // Explicit override
  if (process.env.AGENT_RELAY_DATA_DIR) {
    return process.env.AGENT_RELAY_DATA_DIR;
  }

  // XDG Base Directory Specification
  const xdgDataHome = process.env.XDG_DATA_HOME;
  if (xdgDataHome) {
    return path.join(xdgDataHome, 'agent-relay');
  }

  // Default: ~/.agent-relay
  return path.join(os.homedir(), '.agent-relay');
}

const BASE_DIR = getBaseDir();

/**
 * Generate a short hash of a path for namespacing
 */
function hashPath(projectPath: string): string {
  const normalized = path.resolve(projectPath);
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  return hash.substring(0, 12); // First 12 chars is enough
}

/**
 * Get the project root by looking for common markers
 */
export function findProjectRoot(startDir: string = process.cwd()): string {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  const markers = ['.git', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', '.agent-relay'];

  while (current !== root) {
    for (const marker of markers) {
      if (fs.existsSync(path.join(current, marker))) {
        return current;
      }
    }
    current = path.dirname(current);
  }

  // Fallback to start directory
  return path.resolve(startDir);
}

/**
 * Get namespaced paths for a project
 */
export interface ProjectPaths {
  /** Root directory for all agent-relay data for this project */
  dataDir: string;
  /** Team data directory */
  teamDir: string;
  /** SQLite database path */
  dbPath: string;
  /** Unix socket path */
  socketPath: string;
  /** The project root that was used */
  projectRoot: string;
  /** Short identifier for the project */
  projectId: string;
}

export function getProjectPaths(projectRoot?: string): ProjectPaths {
  const root = projectRoot ?? findProjectRoot();
  const projectId = hashPath(root);
  const dataDir = path.join(BASE_DIR, projectId);

  return {
    dataDir,
    teamDir: path.join(dataDir, 'team'),
    dbPath: path.join(dataDir, 'messages.sqlite'),
    socketPath: path.join(dataDir, 'relay.sock'),
    projectRoot: root,
    projectId,
  };
}

/**
 * Get the default paths (for backwards compatibility or explicit global usage)
 */
export function getGlobalPaths(): ProjectPaths {
  return {
    dataDir: BASE_DIR,
    teamDir: path.join(BASE_DIR, 'team'),
    dbPath: path.join(BASE_DIR, 'messages.sqlite'),
    socketPath: path.join(BASE_DIR, 'relay.sock'),
    projectRoot: process.cwd(),
    projectId: 'global',
  };
}

/**
 * Ensure the project data directory exists
 */
export function ensureProjectDir(projectRoot?: string): ProjectPaths {
  const paths = getProjectPaths(projectRoot);

  if (!fs.existsSync(paths.dataDir)) {
    fs.mkdirSync(paths.dataDir, { recursive: true });
  }
  if (!fs.existsSync(paths.teamDir)) {
    fs.mkdirSync(paths.teamDir, { recursive: true });
  }

  // Write a marker file with project info
  const markerPath = path.join(paths.dataDir, '.project');
  fs.writeFileSync(markerPath, JSON.stringify({
    projectRoot: paths.projectRoot,
    projectId: paths.projectId,
    createdAt: new Date().toISOString(),
  }, null, 2));

  return paths;
}

/**
 * List all known projects
 */
export function listProjects(): Array<{ projectId: string; projectRoot: string; dataDir: string }> {
  if (!fs.existsSync(BASE_DIR)) {
    return [];
  }

  const projects: Array<{ projectId: string; projectRoot: string; dataDir: string }> = [];

  for (const entry of fs.readdirSync(BASE_DIR)) {
    const dataDir = path.join(BASE_DIR, entry);
    const markerPath = path.join(dataDir, '.project');

    if (fs.existsSync(markerPath)) {
      try {
        const info = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
        projects.push({
          projectId: entry,
          projectRoot: info.projectRoot,
          dataDir,
        });
      } catch {
        // Invalid marker, skip
      }
    }
  }

  return projects;
}

/**
 * Detect the actual workspace directory for cloud deployments.
 *
 * In cloud workspaces, repos are cloned to /workspace/{repo-name}.
 * This function finds the correct working directory:
 *
 * Priority:
 * 1. WORKSPACE_CWD env var (explicit override)
 * 2. If baseDir itself is a git repo, use it
 * 3. Scan baseDir for cloned repos - use the first one found (alphabetically)
 * 4. Fall back to baseDir
 *
 * @param baseDir - The base workspace directory (e.g., /workspace)
 * @returns The actual workspace path to use
 */
export function detectWorkspacePath(baseDir: string): string {
  // 1. Explicit override
  if (process.env.WORKSPACE_CWD) {
    return process.env.WORKSPACE_CWD;
  }

  // 2. Check if baseDir itself is a git repo
  if (fs.existsSync(path.join(baseDir, '.git'))) {
    return baseDir;
  }

  // 3. Scan for cloned repos (directories with .git)
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    const repos: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const repoPath = path.join(baseDir, entry.name);
        const gitPath = path.join(repoPath, '.git');
        if (fs.existsSync(gitPath)) {
          repos.push(repoPath);
        }
      }
    }

    // Sort alphabetically for consistent behavior
    repos.sort();

    // Use the first repo found
    if (repos.length > 0) {
      if (repos.length > 1) {
        console.log(`[workspace] Multiple repos found, using first: ${repos[0]} (others: ${repos.slice(1).join(', ')})`);
      } else {
        console.log(`[workspace] Detected repo: ${repos[0]}`);
      }
      return repos[0];
    }
  } catch (err) {
    // Failed to scan, fall back
    console.warn(`[workspace] Failed to scan ${baseDir}:`, err);
  }

  // 4. Fall back to baseDir
  return baseDir;
}

/**
 * List all git repos in a workspace directory.
 * Useful for allowing users to select which repo to work in.
 *
 * @param baseDir - The base workspace directory
 * @returns Array of repo paths
 */
export function listWorkspaceRepos(baseDir: string): string[] {
  const repos: string[] = [];

  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const repoPath = path.join(baseDir, entry.name);
        const gitPath = path.join(repoPath, '.git');
        if (fs.existsSync(gitPath)) {
          repos.push(repoPath);
        }
      }
    }

    repos.sort();
  } catch {
    // Failed to scan
  }

  return repos;
}
