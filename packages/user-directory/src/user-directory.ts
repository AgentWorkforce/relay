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
import { createLogger } from '@agent-relay/resiliency';

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
  cursor: {
    dir: '.cursor',
    credentialsFile: 'auth.json',
  },
};

/**
 * All supported providers for initialization
 */
const ALL_PROVIDERS = Object.keys(PROVIDER_CONFIGS);

/**
 * Valid provider names for credential operations.
 * Includes aliases like 'anthropic' for 'claude' and 'google' for 'gemini'.
 */
const VALID_PROVIDERS = new Set([
  ...ALL_PROVIDERS,
  'anthropic', // alias for claude
  'google',    // alias for gemini
]);

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
   * Write an API key to the appropriate credential file for a provider.
   * Handles provider-specific formats (e.g., Gemini uses .env format).
   *
   * @param userId - User ID
   * @param provider - Provider name (gemini, google, etc.)
   * @param apiKey - The API key to write
   * @returns Path to the written credential file
   */
  writeApiKeyCredential(userId: string, provider: string, apiKey: string): string {
    this.validateUserId(userId);
    const userHome = this.getUserHome(userId);

    // Gemini CLI reads from ~/.gemini/.env with GEMINI_API_KEY
    if (provider === 'gemini' || provider === 'google') {
      const geminiDir = path.join(userHome, '.gemini');
      this.ensureDirectory(geminiDir);
      const envPath = path.join(geminiDir, '.env');
      fs.writeFileSync(envPath, `GEMINI_API_KEY="${apiKey}"\n`, { mode: 0o600 });
      logger.info(`Wrote Gemini API key for user ${userId} to ${envPath}`);
      return envPath;
    }

    // For other providers, use JSON format in the standard credential path
    const credPath = this.getProviderCredentialPath(userId, provider);
    const credDir = path.dirname(credPath);
    this.ensureDirectory(credDir);

    const credData = { apiKey, createdAt: new Date().toISOString() };
    fs.writeFileSync(credPath, JSON.stringify(credData, null, 2), { mode: 0o600 });
    logger.info(`Wrote ${provider} API key for user ${userId} to ${credPath}`);
    return credPath;
  }

  /**
   * Delete the credential file for a provider.
   * Removes all known credential paths for the provider.
   *
   * @param userId - User ID
   * @param provider - Provider name (claude, codex, gemini, etc.)
   * @returns Array of deleted file paths
   * @throws Error if provider is invalid
   */
  deleteProviderCredentials(userId: string, provider: string): string[] {
    this.validateUserId(userId);
    this.validateProvider(provider);
    // Normalize provider to lowercase after validation
    const normalizedProvider = provider.toLowerCase().trim();
    const userHome = this.getUserHome(userId);
    const deleted: string[] = [];

    // Get all potential credential paths for this provider
    const pathsToDelete: string[] = [];

    // Add standard credential path
    const config = PROVIDER_CONFIGS[normalizedProvider];
    if (config) {
      const providerDir = path.join(userHome, config.dir);
      pathsToDelete.push(path.join(providerDir, config.credentialsFile));
    }

    // Handle Gemini/Google special case (.gemini/.env)
    if (normalizedProvider === 'gemini' || normalizedProvider === 'google') {
      pathsToDelete.push(path.join(userHome, '.gemini', '.env'));
    }

    // Handle anthropic special case (both .credentials.json and credentials.json)
    if (normalizedProvider === 'anthropic' || normalizedProvider === 'claude') {
      const claudeDir = path.join(userHome, '.claude');
      pathsToDelete.push(path.join(claudeDir, '.credentials.json'));
      pathsToDelete.push(path.join(claudeDir, 'credentials.json'));
    }

    // Delete each file if it exists
    for (const credPath of pathsToDelete) {
      try {
        if (fs.existsSync(credPath)) {
          fs.unlinkSync(credPath);
          deleted.push(credPath);
          logger.info(`Deleted ${normalizedProvider} credential file for user ${userId}: ${credPath}`);
        }
      } catch (err) {
        logger.warn('Failed to delete credential file', { path: credPath, error: String(err) });
      }
    }

    return deleted;
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
   * Validate a provider name to prevent injection attacks.
   *
   * @param provider - Provider name to validate
   * @throws Error if provider is invalid
   */
  private validateProvider(provider: string): void {
    if (!provider || typeof provider !== 'string') {
      throw new Error('Provider name is required');
    }

    const normalizedProvider = provider.toLowerCase().trim();
    if (!VALID_PROVIDERS.has(normalizedProvider)) {
      throw new Error(`Invalid provider: ${normalizedProvider.substring(0, 20)}`);
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
