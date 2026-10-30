/**
 * Project Namespace Utility
 *
 * Generates project-specific paths for agent-relay data storage.
 * Data is stored in .agentworkforce/relay/ within the project root directory.
 * This allows multiple projects to use agent-relay simultaneously
 * without conflicts, and keeps data with the project.
 */

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Directory name within project root */
const PROJECT_DATA_DIR = '.agentworkforce/relay';

/** The machine-wide workspace store every relay home keeps. */
const WORKSPACE_STORE_FILE = 'workspaces.json';

/**
 * Generate a short hash of a path for namespacing
 */
function hashPath(projectPath: string): string {
  const normalized = path.resolve(projectPath);
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  return hash.substring(0, 12); // First 12 chars is enough
}

/**
 * The CLI's own machine-wide data folder: `AGENT_RELAY_HOME`, default
 * `~/.agentworkforce/relay`. It holds `workspaces.json`, `cloud-auth.json`,
 * fleet-node files and binaries, so it is never a project's data folder.
 * @param env - Environment to read `AGENT_RELAY_HOME` from
 * @returns The relay home, resolved but not canonicalized
 */
export function relayHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AGENT_RELAY_HOME?.trim();
  return path.resolve(configured || path.join(os.homedir(), PROJECT_DATA_DIR));
}

/**
 * `target` with symlinks resolved as far as it exists: the nearest existing
 * ancestor is canonicalized and the missing rest appended, so a folder that
 * does not exist yet still compares equal to the one it will be created as.
 */
function canonicalPath(target: string): string {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...missing.reverse());
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Whether `dataDir` is a relay home rather than a project's data folder:
 * this process's relay home, compared as canonical paths (symlinks resolved;
 * the same file system object when both exist, which also covers a
 * case-insensitive volume), or any folder holding a machine-wide workspace
 * store (`workspaces.json`), which no project folder does, such as the real
 * `~/.agentworkforce/relay` while `HOME` or `AGENT_RELAY_HOME` points
 * elsewhere.
 * @param dataDir - A project's `.agentworkforce/relay` folder
 * @param env - Environment to read `AGENT_RELAY_HOME` from
 */
export function isRelayHomeDir(dataDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (fs.existsSync(path.join(dataDir, WORKSPACE_STORE_FILE))) return true;
  const home = relayHomeDir(env);
  try {
    const a = fs.statSync(dataDir);
    const b = fs.statSync(home);
    if (a.dev === b.dev && a.ino === b.ino) return true;
  } catch {
    // One of them does not exist yet: compare where they would be.
  }
  return canonicalPath(dataDir) === canonicalPath(home);
}

/** A project pin was about to be written into the relay home. */
export class RelayHomeProjectError extends Error {
  constructor(public readonly dataDir: string) {
    super(
      `Refusing to use ${dataDir} as this project's Relay folder: it is the Relay home ` +
        '(AGENT_RELAY_HOME), where Relay keeps its machine-wide workspaces, sign-in and binaries. ' +
        'Run this inside a project folder (cd into the project first), or set AGENT_RELAY_PROJECT ' +
        'to the project folder.'
    );
    this.name = 'RelayHomeProjectError';
  }
}

/**
 * Refuse to treat the relay home as a project's data folder. Every writer of
 * a project pin (`workspace-key.json`) calls this first.
 * @param dataDir - The project's `.agentworkforce/relay` folder
 * @param env - Environment to read `AGENT_RELAY_HOME` from
 * @throws RelayHomeProjectError when `dataDir` is the relay home
 */
export function assertNotRelayHome(dataDir: string, env: NodeJS.ProcessEnv = process.env): void {
  if (isRelayHomeDir(dataDir, env)) throw new RelayHomeProjectError(dataDir);
}

/**
 * Get the project root by looking for common markers
 *
 * Priority:
 * 1. AGENT_RELAY_PROJECT environment variable (for worktrees/subprojects)
 * 2. An explicitly pinned nested project, or the enclosing Git checkout
 * 3. The nearest package marker when outside Git
 *
 * The relay home (`~/.agentworkforce/relay` by default) is never a marker: a
 * folder under the home directory is not part of a "project" rooted at `~`.
 */
export function findProjectRoot(startDir: string = process.cwd()): string {
  // Allow explicit override for worktrees and subprojects
  if (process.env.AGENT_RELAY_PROJECT) {
    return path.resolve(process.env.AGENT_RELAY_PROJECT);
  }

  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  const markers = ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', PROJECT_DATA_DIR];
  let nearestPackage: string | undefined;
  while (true) {
    const dataDir = path.join(current, PROJECT_DATA_DIR);
    const relayHomeHere = fs.existsSync(dataDir) && isRelayHomeDir(dataDir);
    // Existing subproject pins remain intentional namespaces. A package.json
    // alone must not split spawn, rebind, node up and attach across projects.
    if (!relayHomeHere && fs.existsSync(path.join(current, PROJECT_DATA_DIR, 'workspace-key.json')))
      return current;
    const gitMarkerPath = path.join(current, '.git');
    let marker: fs.Stats | undefined;
    try {
      marker = fs.lstatSync(gitMarkerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Cannot resolve the repository workspace; check access to its Git project marker.');
      }
    }
    if (marker) {
      if (marker.isDirectory() || marker.isFile()) return current;
      if (marker.isSymbolicLink()) {
        try {
          const target = fs.statSync(gitMarkerPath);
          if (target.isDirectory() || target.isFile()) return current;
        } catch {
          // A dangling or inaccessible .git symlink is a malformed Git marker,
          // not evidence that this directory is outside a checkout.
        }
      }
      throw new Error('Cannot resolve the repository workspace; check access to its Git project marker.');
    }
    for (const marker of markers) {
      if (marker === PROJECT_DATA_DIR && relayHomeHere) continue;
      if (!nearestPackage && fs.existsSync(path.join(current, marker))) nearestPackage = current;
    }
    if (current === root) break;
    current = path.dirname(current);
  }

  // Fallback to start directory
  return nearestPackage ?? path.resolve(startDir);
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
  // Store data in project-local .agentworkforce/relay/ directory
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

/** The `.git` directory or `gitdir:` file nearest `dir`, walking up. */
function findDotGit(dir: string): string | undefined {
  let current = path.resolve(dir);
  for (;;) {
    const candidate = path.join(current, '.git');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * The `info/exclude` git reads for the work tree whose `.git` is `dotGit`.
 * A linked worktree or submodule has a `.git` file pointing at its git
 * directory; a worktree shares `info/exclude` with the main repository
 * through `commondir`, as `git rev-parse --git-path info/exclude` reports.
 */
function gitExcludePath(dotGit: string): string | undefined {
  let gitDir = dotGit;
  // Check and read through one descriptor, so the answer cannot change
  // between them. Some platforms refuse to open a directory (EISDIR); others
  // open it, and FreeBSD would even "read" it, hence fstat.
  let pointerFile: string | undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(dotGit, 'r');
    if (!fs.fstatSync(fd).isDirectory()) pointerFile = fs.readFileSync(fd, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EISDIR') return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (pointerFile !== undefined) {
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(pointerFile);
    if (!match) return undefined;
    gitDir = path.resolve(path.dirname(dotGit), match[1]);
    // A stale pointer (moved or pruned worktree) is not a repository to write into.
    try {
      if (!fs.statSync(gitDir).isDirectory()) return undefined;
    } catch {
      return undefined;
    }
  }
  let commonDir = gitDir;
  try {
    const pointer = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf-8').trim();
    if (pointer) commonDir = path.resolve(gitDir, pointer);
  } catch {
    // Not a linked worktree.
  }
  return path.join(commonDir, 'info', 'exclude');
}

/** Escape a work-tree-relative path into an anchored gitignore pattern. */
function anchoredPattern(relative: string): string {
  return `/${relative
    .split(path.sep)
    .join('/')
    .replace(/[\\*?[\]!#]/g, '\\$&')}/`;
}

/**
 * Keep the project's `.agentworkforce/relay/` directory (workspace key,
 * sockets, local state) out of `git status` by adding it to the repository's
 * `info/exclude`, the per-clone ignore file that is never committed. The
 * project's own `.gitignore` is never modified.
 *
 * Linked worktrees and submodules are handled (the exclude file lives in the
 * repository's common git directory). Outside a git work tree, or on any
 * error, nothing is changed.
 *
 * @param dataDir - The project data directory, `<project>/.agentworkforce/relay`.
 * @returns Whether the exclude file was changed.
 */
export function ensureGitExclude(dataDir: string): { modified: boolean } {
  try {
    const resolved = path.resolve(dataDir);
    const dotGit = findDotGit(resolved);
    if (!dotGit) return { modified: false };
    const relative = path.relative(path.dirname(dotGit), resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return { modified: false };
    const excludePath = gitExcludePath(dotGit);
    if (!excludePath) return { modified: false };

    const pattern = anchoredPattern(relative);
    const bare = pattern.slice(1, -1);
    let content = '';
    try {
      content = fs.readFileSync(excludePath, 'utf-8');
    } catch {
      // No exclude file yet.
    }
    const present = content
      .split('\n')
      .map((line) => line.trim())
      .some((line) => [bare, `${bare}/`, `/${bare}`, pattern].includes(line));
    if (present) return { modified: false };

    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const separator = content === '' || content.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(excludePath, `${separator}${pattern}\n`, 'utf-8');
    return { modified: true };
  } catch {
    // Not a git repository we can write to; never block the caller.
    return { modified: false };
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

    // Add to .git/info/exclude (local per-repo gitignore, not committed)
    const excludeResult = ensureGitExclude(paths.dataDir);
    if (excludeResult.modified) {
      console.log('[agent-relay] Added .agentworkforce/relay/ to .git/info/exclude');
    }
  }
  if (!fs.existsSync(paths.teamDir)) {
    fs.mkdirSync(paths.teamDir, { recursive: true });
  }

  // Write a marker file with project info
  const markerPath = path.join(paths.dataDir, '.project');
  fs.writeFileSync(
    markerPath,
    JSON.stringify(
      {
        projectRoot: paths.projectRoot,
        projectId: paths.projectId,
        createdAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  return paths;
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
        console.log(
          `[workspace] Multiple repos found, using first: ${repos[0]} (others: ${repos.slice(1).join(', ')})`
        );
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

/**
 * Runtime configuration that the broker writes when it starts.
 * CLI commands can read this to use matching storage configuration.
 */
export interface RuntimeConfig {
  /** Storage type currently in use by the broker */
  storageType?: string;
  /** Broker PID */
  brokerPid?: number;
  /** Timestamp when broker started */
  startedAt?: string;
  /** Broker version */
  version?: string;
}

const RUNTIME_CONFIG_FILE = 'runtime.json';

/**
 * Save runtime configuration for the current project.
 * Called by the broker when it starts.
 */
export function saveRuntimeConfig(config: RuntimeConfig, projectRoot?: string): void {
  const paths = getProjectPaths(projectRoot);
  const configPath = path.join(paths.dataDir, RUNTIME_CONFIG_FILE);

  // Ensure data dir exists
  if (!fs.existsSync(paths.dataDir)) {
    fs.mkdirSync(paths.dataDir, { recursive: true });
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * Load runtime configuration for the current project.
 * Returns undefined if no runtime config exists or the broker isn't running.
 */
export function loadRuntimeConfig(projectRoot?: string): RuntimeConfig | undefined {
  const paths = getProjectPaths(projectRoot);
  const configPath = path.join(paths.dataDir, RUNTIME_CONFIG_FILE);

  if (!fs.existsSync(configPath)) {
    return undefined;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as RuntimeConfig;
  } catch {
    return undefined;
  }
}

/**
 * Clear runtime configuration (called when broker stops).
 */
export function clearRuntimeConfig(projectRoot?: string): void {
  const paths = getProjectPaths(projectRoot);
  const configPath = path.join(paths.dataDir, RUNTIME_CONFIG_FILE);

  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
  }
}
