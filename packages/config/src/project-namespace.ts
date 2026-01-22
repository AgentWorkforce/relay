/**
 * Project Namespace Utility
 *
 * Generates project-specific paths for agent-relay data storage.
 * Data is stored in .agent-relay/ within the project root directory.
 * This allows multiple projects to use agent-relay simultaneously
 * without conflicts, and keeps data with the project.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

/**
 * Get the global base directory for agent-relay data (used for cross-project data).
 * Priority:
 * 1. AGENT_RELAY_DATA_DIR environment variable
 * 2. XDG_DATA_HOME/agent-relay (Linux/macOS standard)
 * 3. ~/.agent-relay (fallback)
 */
function getGlobalBaseDir(): string {
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

const GLOBAL_BASE_DIR = getGlobalBaseDir();

/** Directory name within project root */
const PROJECT_DATA_DIR = '.agent-relay';

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
  // Store data in project-local .agent-relay/ directory
  const dataDir = path.join(root, PROJECT_DATA_DIR);

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
    dataDir: GLOBAL_BASE_DIR,
    teamDir: path.join(GLOBAL_BASE_DIR, 'team'),
    dbPath: path.join(GLOBAL_BASE_DIR, 'messages.sqlite'),
    socketPath: path.join(GLOBAL_BASE_DIR, 'relay.sock'),
    projectRoot: process.cwd(),
    projectId: 'global',
  };
}

/**
 * Add .agent-relay/ to gitignore.
 * - For cloud (WORKSPACE_ID set): use global gitignore (~/.config/git/ignore)
 * - For local: add to project's .gitignore
 *
 * Returns true if gitignore was modified (for logging purposes)
 */
function ensureGitignore(projectRoot: string): { modified: boolean; location: 'global' | 'local' | null } {
  const isCloud = !!process.env.WORKSPACE_ID;

  // For cloud, use global gitignore to avoid modifying the repo
  if (isCloud) {
    return ensureGlobalGitignore();
  }

  // For local, add to project .gitignore
  const gitignorePath = path.join(projectRoot, '.gitignore');

  try {
    let content = '';
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, 'utf-8');
      // Check if .agent-relay is already in gitignore
      const lines = content.split('\n');
      const hasEntry = lines.some(line => {
        const trimmed = line.trim();
        return trimmed === '.agent-relay' || trimmed === '.agent-relay/' || trimmed === '/.agent-relay' || trimmed === '/.agent-relay/';
      });
      if (hasEntry) {
        return { modified: false, location: null }; // Already present
      }
    }

    // Add .agent-relay/ to gitignore
    const newEntry = '.agent-relay/';
    const newContent = content.endsWith('\n') || content === ''
      ? `${content}${newEntry}\n`
      : `${content}\n${newEntry}\n`;

    fs.writeFileSync(gitignorePath, newContent, 'utf-8');
    return { modified: true, location: 'local' };
  } catch {
    // Silently ignore errors (e.g., no write permission)
    return { modified: false, location: null };
  }
}

/**
 * Add .agent-relay/ to global gitignore (~/.config/git/ignore)
 * This is used for cloud environments to avoid modifying the repo
 */
function ensureGlobalGitignore(): { modified: boolean; location: 'global' | 'local' | null } {
  // XDG standard: ~/.config/git/ignore
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const globalGitignoreDir = path.join(xdgConfig, 'git');
  const globalGitignorePath = path.join(globalGitignoreDir, 'ignore');

  try {
    // Ensure directory exists
    if (!fs.existsSync(globalGitignoreDir)) {
      fs.mkdirSync(globalGitignoreDir, { recursive: true });
    }

    let content = '';
    if (fs.existsSync(globalGitignorePath)) {
      content = fs.readFileSync(globalGitignorePath, 'utf-8');
      // Check if .agent-relay is already in gitignore
      const lines = content.split('\n');
      const hasEntry = lines.some(line => {
        const trimmed = line.trim();
        return trimmed === '.agent-relay' || trimmed === '.agent-relay/' || trimmed === '/.agent-relay' || trimmed === '/.agent-relay/';
      });
      if (hasEntry) {
        return { modified: false, location: null }; // Already present
      }
    }

    // Add .agent-relay/ to global gitignore
    const newEntry = '.agent-relay/';
    const newContent = content.endsWith('\n') || content === ''
      ? `${content}${newEntry}\n`
      : `${content}\n${newEntry}\n`;

    fs.writeFileSync(globalGitignorePath, newContent, 'utf-8');
    return { modified: true, location: 'global' };
  } catch {
    // Silently ignore errors
    return { modified: false, location: null };
  }
}

/**
 * Ensure the project data directory exists
 */
export function ensureProjectDir(projectRoot?: string): ProjectPaths {
  const paths = getProjectPaths(projectRoot);

  // Auto-add to .gitignore on first creation
  const isFirstCreation = !fs.existsSync(paths.dataDir);

  if (isFirstCreation) {
    fs.mkdirSync(paths.dataDir, { recursive: true });

    // Add to gitignore and notify user
    const gitignoreResult = ensureGitignore(paths.projectRoot);
    if (gitignoreResult.modified) {
      if (gitignoreResult.location === 'global') {
        console.log('[agent-relay] Added .agent-relay/ to global gitignore (~/.config/git/ignore)');
      } else if (gitignoreResult.location === 'local') {
        console.log('[agent-relay] Added .agent-relay/ to .gitignore');
      }
    }
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
 * List all known projects (scans global base dir for legacy data)
 * Note: With project-local storage, this only finds projects that
 * used the old global storage location.
 */
export function listProjects(): Array<{ projectId: string; projectRoot: string; dataDir: string }> {
  if (!fs.existsSync(GLOBAL_BASE_DIR)) {
    return [];
  }

  const projects: Array<{ projectId: string; projectRoot: string; dataDir: string }> = [];

  for (const entry of fs.readdirSync(GLOBAL_BASE_DIR)) {
    const dataDir = path.join(GLOBAL_BASE_DIR, entry);
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
