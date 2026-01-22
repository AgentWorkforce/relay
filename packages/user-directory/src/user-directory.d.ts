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
/**
 * Service for managing per-user directories on workspace volumes.
 * Enables multi-user credential storage without conflicts.
 */
export declare class UserDirectoryService {
    private baseDir;
    private usersDir;
    /**
     * Create a new UserDirectoryService.
     * @param baseDir - Base data directory (e.g., /data)
     */
    constructor(baseDir: string);
    /**
     * Get the home directory path for a user.
     * Creates the directory if it doesn't exist.
     *
     * @param userId - User ID (UUID or similar)
     * @returns Absolute path to user's home directory
     * @throws Error if userId is invalid
     */
    getUserHome(userId: string): string;
    /**
     * Ensure a provider's credential directory exists for a user.
     *
     * @param userId - User ID
     * @param provider - Provider name (claude, codex, gemini, etc.)
     * @returns Absolute path to provider directory
     */
    ensureProviderDir(userId: string, provider: string): string;
    /**
     * Initialize a complete user environment with all provider directories.
     *
     * @param userId - User ID
     * @returns User's home directory path
     */
    initializeUserEnvironment(userId: string): string;
    /**
     * Get environment variables for spawning an agent with user-specific HOME.
     *
     * @param userId - User ID
     * @returns Environment variables to merge with process.env
     */
    getUserEnvironment(userId: string): Record<string, string>;
    /**
     * List all user IDs that have directories.
     *
     * @returns Array of user IDs
     */
    listUsers(): string[];
    /**
     * Check if a user has an existing directory.
     *
     * @param userId - User ID
     * @returns True if directory exists
     */
    hasUserDirectory(userId: string): boolean;
    /**
     * Get the path to a provider's credentials file for a user.
     *
     * @param userId - User ID
     * @param provider - Provider name
     * @returns Absolute path to credentials file
     */
    getProviderCredentialPath(userId: string, provider: string): string;
    /**
     * Write an API key to the appropriate credential file for a provider.
     * Handles provider-specific formats (e.g., Gemini uses .env format).
     *
     * @param userId - User ID
     * @param provider - Provider name (gemini, google, etc.)
     * @param apiKey - The API key to write
     * @returns Path to the written credential file
     */
    writeApiKeyCredential(userId: string, provider: string, apiKey: string): string;
    /**
     * Validate a user ID to prevent path traversal and other issues.
     *
     * @param userId - User ID to validate
     * @throws Error if userId is invalid
     */
    private validateUserId;
    /**
     * Ensure a directory exists, creating it recursively if needed.
     */
    private ensureDirectory;
}
/**
 * Get the default data directory for user directories.
 * Uses AGENT_RELAY_DATA_DIR if set, otherwise /data (for Fly.io volumes).
 */
export declare function getDefaultDataDir(): string;
/**
 * Get the singleton UserDirectoryService instance.
 */
export declare function getUserDirectoryService(): UserDirectoryService;
/**
 * Create a new UserDirectoryService for testing or custom paths.
 */
export declare function createUserDirectoryService(baseDir: string): UserDirectoryService;
//# sourceMappingURL=user-directory.d.ts.map