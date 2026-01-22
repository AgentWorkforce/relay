/**
 * Workspace Repository Manager
 *
 * Manages repository cloning, updating, and removal for workspace containers.
 * Uses a file-based tracking system (repos.json) to persist state across restarts.
 *
 * This replaces the static REPOSITORIES env var approach, allowing dynamic
 * repo management without workspace restart.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { createLogger } from '@agent-relay/resiliency';

const logger = createLogger('repo-manager');

export interface RepoInfo {
  /** Full GitHub repo name (e.g., "owner/repo") */
  fullName: string;
  /** Local directory name */
  localName: string;
  /** Absolute path to the cloned repo */
  path: string;
  /** Current status */
  status: 'cloned' | 'cloning' | 'error' | 'removed';
  /** Last sync timestamp */
  lastSynced?: string;
  /** Default branch */
  defaultBranch?: string;
  /** Error message if status is 'error' */
  error?: string;
  /** When the repo was added */
  addedAt: string;
}

export interface ReposConfig {
  version: number;
  workspaceDir: string;
  repos: Record<string, RepoInfo>;
  lastUpdated: string;
}

export interface SyncResult {
  success: boolean;
  repo: string;
  action: 'cloned' | 'updated' | 'already_synced' | 'error';
  path?: string;
  error?: string;
}

export interface RepoManagerConfig {
  workspaceDir: string;
  configFile?: string;
}

const DEFAULT_CONFIG_FILE = 'repos.json';

export class RepoManager extends EventEmitter {
  private workspaceDir: string;
  private configPath: string;
  private config: ReposConfig;

  constructor(options: RepoManagerConfig) {
    super();
    this.workspaceDir = options.workspaceDir;
    this.configPath = path.join(
      this.workspaceDir,
      options.configFile || DEFAULT_CONFIG_FILE
    );
    this.config = this.loadConfig();
  }

  /**
   * Load or initialize the repos config file
   */
  private loadConfig(): ReposConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf-8');
        const config = JSON.parse(data) as ReposConfig;
        logger.info('Loaded repo config', { repoCount: Object.keys(config.repos).length });
        return config;
      }
    } catch (err) {
      logger.warn('Failed to load repo config, starting fresh', { error: String(err) });
    }

    // Initialize new config
    return {
      version: 1,
      workspaceDir: this.workspaceDir,
      repos: {},
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Save the config to disk
   */
  private saveConfig(): void {
    this.config.lastUpdated = new Date().toISOString();
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  /**
   * Get all tracked repos
   */
  getRepos(): RepoInfo[] {
    return Object.values(this.config.repos).filter(r => r.status !== 'removed');
  }

  /**
   * Get a specific repo by full name
   */
  getRepo(fullName: string): RepoInfo | null {
    const key = fullName.toLowerCase();
    return this.config.repos[key] || null;
  }

  /**
   * Sync a repository (clone if new, pull if exists)
   */
  async syncRepo(fullName: string): Promise<SyncResult> {
    const key = fullName.toLowerCase();
    const localName = path.basename(fullName);
    const repoPath = path.join(this.workspaceDir, localName);

    logger.info('Syncing repo', { fullName, repoPath });

    // Update status to cloning
    this.config.repos[key] = {
      fullName,
      localName,
      path: repoPath,
      status: 'cloning',
      addedAt: this.config.repos[key]?.addedAt || new Date().toISOString(),
    };
    this.saveConfig();
    this.emit('repo:syncing', { fullName });

    try {
      const gitDir = path.join(repoPath, '.git');
      const exists = fs.existsSync(gitDir);

      if (exists) {
        // Pull existing repo
        await this.gitPull(repoPath, fullName);
        this.config.repos[key] = {
          ...this.config.repos[key],
          status: 'cloned',
          lastSynced: new Date().toISOString(),
          defaultBranch: this.getDefaultBranch(repoPath),
          error: undefined,
        };
        this.saveConfig();
        this.emit('repo:synced', { fullName, action: 'updated' });

        logger.info('Repo updated', { fullName });
        return { success: true, repo: fullName, action: 'updated', path: repoPath };
      } else {
        // Clone new repo
        await this.gitClone(fullName, repoPath);
        this.config.repos[key] = {
          ...this.config.repos[key],
          status: 'cloned',
          lastSynced: new Date().toISOString(),
          defaultBranch: this.getDefaultBranch(repoPath),
          error: undefined,
        };
        this.saveConfig();

        // Mark directory as safe for git
        this.markSafeDirectory(repoPath);

        this.emit('repo:synced', { fullName, action: 'cloned' });

        logger.info('Repo cloned', { fullName });
        return { success: true, repo: fullName, action: 'cloned', path: repoPath };
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.config.repos[key] = {
        ...this.config.repos[key],
        status: 'error',
        error: errorMsg,
      };
      this.saveConfig();
      this.emit('repo:error', { fullName, error: errorMsg });

      logger.error('Repo sync failed', { fullName, error: errorMsg });
      return { success: false, repo: fullName, action: 'error', error: errorMsg };
    }
  }

  /**
   * Remove a repository
   */
  async removeRepo(fullName: string, deleteFiles: boolean = false): Promise<boolean> {
    const key = fullName.toLowerCase();
    const repo = this.config.repos[key];

    if (!repo) {
      logger.warn('Repo not found for removal', { fullName });
      return false;
    }

    logger.info('Removing repo', { fullName, deleteFiles });

    if (deleteFiles && fs.existsSync(repo.path)) {
      try {
        fs.rmSync(repo.path, { recursive: true, force: true });
        logger.info('Deleted repo files', { fullName, path: repo.path });
      } catch (err) {
        logger.error('Failed to delete repo files', { fullName, error: String(err) });
        // Continue anyway - mark as removed in config
      }
    }

    // Mark as removed (or delete from config entirely)
    if (deleteFiles) {
      delete this.config.repos[key];
    } else {
      this.config.repos[key] = {
        ...repo,
        status: 'removed',
      };
    }
    this.saveConfig();
    this.emit('repo:removed', { fullName });

    return true;
  }

  /**
   * Sync multiple repos (e.g., from initial REPOSITORIES env var)
   */
  async syncRepos(fullNames: string[]): Promise<SyncResult[]> {
    const results: SyncResult[] = [];

    for (const fullName of fullNames) {
      if (!fullName.trim()) continue;
      const result = await this.syncRepo(fullName.trim());
      results.push(result);
    }

    return results;
  }

  /**
   * Initialize from REPOSITORIES env var (backward compatibility)
   */
  async initFromEnv(): Promise<SyncResult[]> {
    const repoList = process.env.REPOSITORIES || '';
    if (!repoList.trim()) {
      logger.info('No REPOSITORIES env var set, skipping initial sync');
      return [];
    }

    const repos = repoList.split(',').map(r => r.trim()).filter(Boolean);
    logger.info('Initializing repos from env', { count: repos.length });

    return this.syncRepos(repos);
  }

  /**
   * Scan workspace directory for existing repos and register them
   * This handles repos that were cloned by entrypoint.sh before daemon started
   */
  scanExistingRepos(): void {
    try {
      const entries = fs.readdirSync(this.workspaceDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === DEFAULT_CONFIG_FILE || entry.name.startsWith('.')) continue;

        const repoPath = path.join(this.workspaceDir, entry.name);
        const gitDir = path.join(repoPath, '.git');

        if (!fs.existsSync(gitDir)) continue;

        // Try to get the remote URL to determine full repo name
        let fullName = entry.name; // Default to directory name
        try {
          const remoteUrl = execSync('git config --get remote.origin.url', {
            cwd: repoPath,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();

          // Parse GitHub URL: https://github.com/owner/repo.git or git@github.com:owner/repo.git
          const match = remoteUrl.match(/github\.com[/:]([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/);
          if (match) {
            fullName = `${match[1]}/${match[2]}`;
          }
        } catch {
          // Couldn't get remote, use directory name
        }

        const key = fullName.toLowerCase();

        // Only register if not already tracked
        if (!this.config.repos[key]) {
          this.config.repos[key] = {
            fullName,
            localName: entry.name,
            path: repoPath,
            status: 'cloned',
            lastSynced: new Date().toISOString(),
            defaultBranch: this.getDefaultBranch(repoPath),
            addedAt: new Date().toISOString(),
          };
          logger.info('Registered existing repo', { fullName, path: repoPath });
        }
      }

      this.saveConfig();
    } catch (err) {
      logger.warn('Failed to scan for existing repos', { error: String(err) });
    }
  }

  /**
   * Clone a repository
   */
  private gitClone(fullName: string, targetPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `https://github.com/${fullName}.git`;
      logger.info('Cloning', { url, targetPath });

      const proc = spawn('git', ['clone', url, targetPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });

      let stderr = '';
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`git clone failed (code ${code}): ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Pull updates for a repository
   */
  private gitPull(repoPath: string, fullName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      logger.info('Pulling', { repoPath });

      // First update remote URL in case it changed
      try {
        const url = `https://github.com/${fullName}.git`;
        execSync(`git remote set-url origin "${url}"`, {
          cwd: repoPath,
          stdio: 'ignore',
        });
      } catch {
        // Ignore - remote might not exist yet
      }

      // Fetch and pull
      const proc = spawn('git', ['pull', '--ff-only'], {
        cwd: repoPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });

      let stderr = '';
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          // Try fetch --all as fallback (handles diverged branches better)
          try {
            execSync('git fetch --all --prune', { cwd: repoPath, stdio: 'ignore' });
            resolve();
          } catch {
            reject(new Error(`git pull failed (code ${code}): ${stderr}`));
          }
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Get the default branch of a repo
   */
  private getDefaultBranch(repoPath: string): string {
    try {
      const result = execSync('git symbolic-ref --short HEAD', {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return result.trim();
    } catch {
      return 'main';
    }
  }

  /**
   * Mark directory as safe for git (prevents "dubious ownership" errors)
   */
  private markSafeDirectory(repoPath: string): void {
    try {
      execSync(`git config --global --add safe.directory "${repoPath}"`, {
        stdio: 'ignore',
      });
    } catch {
      // Ignore errors
    }
  }
}

// Singleton instance
let repoManagerInstance: RepoManager | null = null;

/**
 * Get or create the repo manager instance
 */
export function getRepoManager(workspaceDir?: string): RepoManager {
  if (!repoManagerInstance) {
    const dir = workspaceDir || process.env.WORKSPACE_DIR || '/workspace';
    repoManagerInstance = new RepoManager({ workspaceDir: dir });
  }
  return repoManagerInstance;
}

/**
 * Initialize repo manager (call at startup)
 *
 * 1. Scans workspace for existing repos (handles entrypoint.sh clones)
 * 2. Syncs any repos from REPOSITORIES env var that aren't already cloned
 */
export async function initRepoManager(workspaceDir?: string): Promise<RepoManager> {
  const manager = getRepoManager(workspaceDir);

  // First, scan for repos already cloned by entrypoint.sh
  manager.scanExistingRepos();

  // Then sync any additional repos from env var
  // (syncRepos skips repos that are already cloned and up-to-date)
  await manager.initFromEnv();

  return manager;
}
