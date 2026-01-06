/**
 * User Directory Service
 *
 * Manages per-user directories on workspace volumes for CLI credential storage.
 * Each user gets their own home directory at /data/users/{userId}/ with
 * provider-specific subdirectories for credentials.
 *
 * Structure:
 * /data/
 * └── users/
 *     ├── {userId1}/
 *     │   ├── .claude/
 *     │   │   └── .credentials.json
 *     │   ├── .codex/
 *     │   │   └── credentials.json
 *     │   └── .config/
 *     │       └── gcloud/
 *     │           └── application_default_credentials.json
 *     └── {userId2}/
 *         └── ...
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../resiliency/logger.js';

const logger = createLogger('user-directory');

/**
 * Provider configuration for credential paths
 */
interface ProviderConfig {
  /** Directory relative to user home */
  dir: string;
  /** Credentials file name */
  credentialsFile: string;
}

const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  claude: {
    dir: '.claude',
    credentialsFile: '.credentials.json',
  },
  codex: {
    dir: '.codex',
    credentialsFile: 'credentials.json',
  },
  gemini: {
    dir: '.config/gcloud',
    credentialsFile: 'application_default_credentials.json',
  },
  opencode: {
    dir: '.opencode',
    credentialsFile: 'credentials.json',
  },
  droid: {
    dir: '.factory',
    credentialsFile: 'credentials.json',
  },
};

/**
 * All supported providers for initialization
 */
const ALL_PROVIDERS = Object.keys(PROVIDER_CONFIGS);

/**
 * Service for managing per-user directories on workspace volumes.
 * Enables multi-user credential storage without conflicts.
 */
export class UserDirectoryService {
  private baseDir: string;
  private usersDir: string;

  /**
   * Create a new UserDirectoryService.
   * @param baseDir - Base data directory (e.g., /data)
   */
  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.usersDir = path.join(baseDir, 'users');

    // Ensure users directory exists
    this.ensureDirectory(this.usersDir);
    logger.info(`UserDirectoryService initialized at ${this.usersDir}`);
  }

  /**
   * Get the home directory path for a user.
   * Creates the directory if it doesn't exist.
   *
   * @param userId - User ID (UUID or similar)
   * @returns Absolute path to user's home directory
   * @throws Error if userId is invalid
   */
  getUserHome(userId: string): string {
    this.validateUserId(userId);

    const userHome = path.join(this.usersDir, userId);
    this.ensureDirectory(userHome);

    return userHome;
  }

  /**
   * Ensure a provider's credential directory exists for a user.
   *
   * @param userId - User ID
   * @param provider - Provider name (claude, codex, gemini, etc.)
   * @returns Absolute path to provider directory
   */
  ensureProviderDir(userId: string, provider: string): string {
    this.validateUserId(userId);

    const config = PROVIDER_CONFIGS[provider];
    if (!config) {
      // For unknown providers, use .{provider} directory
      const userHome = this.getUserHome(userId);
      const providerDir = path.join(userHome, `.${provider}`);
      this.ensureDirectory(providerDir);
      return providerDir;
    }

    const userHome = this.getUserHome(userId);
    const providerDir = path.join(userHome, config.dir);
    this.ensureDirectory(providerDir);

    return providerDir;
  }

  /**
   * Initialize a complete user environment with all provider directories.
   *
   * @param userId - User ID
   * @returns User's home directory path
   */
  initializeUserEnvironment(userId: string): string {
    this.validateUserId(userId);

    const userHome = this.getUserHome(userId);

    // Create all provider directories
    for (const provider of ALL_PROVIDERS) {
      this.ensureProviderDir(userId, provider);
    }

    logger.info(`Initialized user environment for ${userId} at ${userHome}`);
    return userHome;
  }

  /**
   * Get environment variables for spawning an agent with user-specific HOME.
   *
   * @param userId - User ID
   * @returns Environment variables to merge with process.env
   */
  getUserEnvironment(userId: string): Record<string, string> {
    const userHome = this.getUserHome(userId);

    return {
      HOME: userHome,
      XDG_CONFIG_HOME: path.join(userHome, '.config'),
      AGENT_RELAY_USER_ID: userId,
    };
  }

  /**
   * List all user IDs that have directories.
   *
   * @returns Array of user IDs
   */
  listUsers(): string[] {
    try {
      const entries = fs.readdirSync(this.usersDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  /**
   * Check if a user has an existing directory.
   *
   * @param userId - User ID
   * @returns True if directory exists
   */
  hasUserDirectory(userId: string): boolean {
    const userHome = path.join(this.usersDir, userId);
    return fs.existsSync(userHome);
  }

  /**
   * Get the path to a provider's credentials file for a user.
   *
   * @param userId - User ID
   * @param provider - Provider name
   * @returns Absolute path to credentials file
   */
  getProviderCredentialPath(userId: string, provider: string): string {
    const config = PROVIDER_CONFIGS[provider];
    if (!config) {
      const userHome = this.getUserHome(userId);
      return path.join(userHome, `.${provider}`, 'credentials.json');
    }

    const providerDir = this.ensureProviderDir(userId, provider);
    return path.join(providerDir, config.credentialsFile);
  }

  /**
   * Validate a user ID to prevent path traversal and other issues.
   *
   * @param userId - User ID to validate
   * @throws Error if userId is invalid
   */
  private validateUserId(userId: string): void {
    if (!userId || userId.trim() === '') {
      throw new Error('User ID cannot be empty');
    }

    // Prevent path traversal
    if (userId.includes('..') || userId.includes('/') || userId.includes('\\')) {
      throw new Error('User ID contains invalid characters');
    }

    // Ensure resolved path is within users directory
    const resolved = path.resolve(this.usersDir, userId);
    if (!resolved.startsWith(this.usersDir)) {
      throw new Error('User ID would escape users directory');
    }
  }

  /**
   * Ensure a directory exists, creating it recursively if needed.
   */
  private ensureDirectory(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }
}

/**
 * Get the default data directory for user directories.
 * Uses AGENT_RELAY_DATA_DIR if set, otherwise /data (for Fly.io volumes).
 */
export function getDefaultDataDir(): string {
  return process.env.AGENT_RELAY_DATA_DIR || '/data';
}

/**
 * Singleton instance for the workspace.
 */
let _instance: UserDirectoryService | null = null;

/**
 * Get the singleton UserDirectoryService instance.
 */
export function getUserDirectoryService(): UserDirectoryService {
  if (!_instance) {
    _instance = new UserDirectoryService(getDefaultDataDir());
  }
  return _instance;
}

/**
 * Create a new UserDirectoryService for testing or custom paths.
 */
export function createUserDirectoryService(baseDir: string): UserDirectoryService {
  return new UserDirectoryService(baseDir);
}
