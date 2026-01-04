/**
 * Trajectory Configuration
 *
 * Handles repo-level opt-in/opt-out for trajectory storage.
 * When trajectories are opt-out (not in source control), they're stored
 * in the user's home directory instead of the repo.
 *
 * DECISIONS:
 * 1. Default behavior: trajectories are OPT-OUT (stored outside repo)
 *    - Reasoning: Most repos won't want trajectory files in source control
 *    - Users must explicitly opt-in to store in repo
 *
 * 2. Setting location: .relay/config.json in repo root
 *    - Reasoning: Keeps relay config separate from .claude/ which may have other uses
 *    - Alternative considered: .claude/settings.json - rejected to avoid conflicts
 *
 * 3. User-level storage: ~/.config/agent-relay/trajectories/<project-hash>/
 *    - Reasoning: XDG-compliant, project-isolated, survives repo deletion
 */

import { existsSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { getProjectPaths } from '../utils/project-namespace.js';

/**
 * Relay config structure
 */
export interface RelayConfig {
  /** Trajectory settings */
  trajectories?: {
    /**
     * Whether to store trajectories in the repo (.trajectories/)
     * Default: false (stored in ~/.config/agent-relay/trajectories/)
     */
    storeInRepo?: boolean;
  };
}

/**
 * Cache for config to avoid repeated file reads
 */
let configCache: { path: string; config: RelayConfig; mtime: number } | null = null;

/**
 * Get the relay config file path
 */
export function getRelayConfigPath(projectRoot?: string): string {
  const root = projectRoot ?? getProjectPaths().projectRoot;
  return join(root, '.relay', 'config.json');
}

/**
 * Read the relay config from the repo
 */
export function readRelayConfig(projectRoot?: string): RelayConfig {
  const configPath = getRelayConfigPath(projectRoot);

  // Check cache
  if (configCache && configCache.path === configPath) {
    try {
      const stat = statSync(configPath);
      if (stat.mtimeMs === configCache.mtime) {
        return configCache.config;
      }
    } catch {
      // File may not exist or be readable
    }
  }

  try {
    if (!existsSync(configPath)) {
      return {};
    }

    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as RelayConfig;

    // Update cache
    try {
      const stat = statSync(configPath);
      configCache = { path: configPath, config, mtime: stat.mtimeMs };
    } catch {
      // Ignore cache update failures
    }

    return config;
  } catch (err) {
    console.warn('[trajectory-config] Failed to read config:', err);
    return {};
  }
}

/**
 * Check if trajectories should be stored in the repo
 */
export function shouldStoreInRepo(projectRoot?: string): boolean {
  const config = readRelayConfig(projectRoot);
  // Default to false - trajectories are stored outside repo by default
  return config.trajectories?.storeInRepo === true;
}

/**
 * Get a hash of the project path for user-level storage isolation
 */
export function getProjectHash(projectRoot?: string): string {
  const root = projectRoot ?? getProjectPaths().projectRoot;
  return createHash('sha256').update(root).digest('hex').slice(0, 16);
}

/**
 * Get the user-level trajectories directory
 */
export function getUserTrajectoriesDir(projectRoot?: string): string {
  const projectHash = getProjectHash(projectRoot);
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configDir, 'agent-relay', 'trajectories', projectHash);
}

/**
 * Get the repo-level trajectories directory
 */
export function getRepoTrajectoriesDir(projectRoot?: string): string {
  const root = projectRoot ?? getProjectPaths().projectRoot;
  return join(root, '.trajectories');
}

/**
 * Get the primary trajectories directory based on config
 * This is where new trajectories will be written
 */
export function getPrimaryTrajectoriesDir(projectRoot?: string): string {
  if (shouldStoreInRepo(projectRoot)) {
    return getRepoTrajectoriesDir(projectRoot);
  }
  return getUserTrajectoriesDir(projectRoot);
}

/**
 * Get all trajectories directories (for reading)
 * Returns both repo and user-level if they exist
 */
export function getAllTrajectoriesDirs(projectRoot?: string): string[] {
  const dirs: string[] = [];

  const repoDir = getRepoTrajectoriesDir(projectRoot);
  if (existsSync(repoDir)) {
    dirs.push(repoDir);
  }

  const userDir = getUserTrajectoriesDir(projectRoot);
  if (existsSync(userDir)) {
    dirs.push(userDir);
  }

  return dirs;
}

/**
 * Ensure the primary trajectories directory exists
 */
export function ensureTrajectoriesDir(projectRoot?: string): string {
  const dir = getPrimaryTrajectoriesDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Get trajectory environment variables for trail CLI
 * Sets TRAJECTORIES_DATA_DIR to the appropriate location
 */
export function getTrajectoryEnvVars(projectRoot?: string): Record<string, string> {
  const dataDir = getPrimaryTrajectoriesDir(projectRoot);
  return {
    TRAJECTORIES_DATA_DIR: dataDir,
  };
}

/**
 * Check if project has opted into repo-level trajectory storage
 */
export function isTrajectoryOptedIn(projectRoot?: string): boolean {
  return shouldStoreInRepo(projectRoot);
}

/**
 * Get a human-readable description of where trajectories are stored
 */
export function getTrajectoriesStorageDescription(projectRoot?: string): string {
  if (shouldStoreInRepo(projectRoot)) {
    return `repo (.trajectories/)`;
  }
  return `user (~/.config/agent-relay/trajectories/)`;
}
