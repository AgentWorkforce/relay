/**
 * Credential Writer
 *
 * Writes CLI credentials in provider-specific formats.
 * Each CLI tool (Claude, Codex, etc.) has its own credential file format
 * that must be written to the appropriate location.
 *
 * This module handles:
 * 1. Creating per-user HOME directories
 * 2. Writing credentials in the correct format for each provider
 * 3. Copying necessary config files (like gh CLI config)
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Credential data from the database
 */
export interface CredentialData {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date | string;
  scopes?: string[];
}

/**
 * Provider-specific credential formats
 */
export type ProviderType = 'anthropic' | 'openai' | 'gemini' | 'github';

/**
 * Base directory for per-user home directories in workspaces
 */
const USER_HOMES_BASE = '/home/workspace-users';

/**
 * Get the container's default HOME directory
 */
function getContainerHome(): string {
  return process.env.HOME || '/home/workspace';
}

/**
 * Get the per-user HOME directory path
 */
export function getUserHomePath(userId: string): string {
  return path.join(USER_HOMES_BASE, userId);
}

/**
 * Write Claude CLI credentials
 *
 * Claude CLI reads from: $HOME/.claude/.credentials.json
 * Format: { "claudeAiOauth": { "accessToken": "...", "refreshToken": "...", "expiresAt": "..." } }
 */
async function writeClaudeCredentials(userHome: string, creds: CredentialData): Promise<void> {
  const claudeDir = path.join(userHome, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });

  const credentialData = {
    claudeAiOauth: {
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt instanceof Date
        ? creds.expiresAt.toISOString()
        : creds.expiresAt,
    },
  };

  await fs.writeFile(
    path.join(claudeDir, '.credentials.json'),
    JSON.stringify(credentialData, null, 2),
    { mode: 0o600 } // Restrictive permissions for credentials
  );
}

/**
 * Write Codex (OpenAI) CLI credentials
 *
 * Codex CLI reads from: $HOME/.codex/auth.json
 * Format: { "tokens": { "access_token": "...", "refresh_token": "..." } }
 */
async function writeCodexCredentials(userHome: string, creds: CredentialData): Promise<void> {
  const codexDir = path.join(userHome, '.codex');
  await fs.mkdir(codexDir, { recursive: true });

  const credentialData = {
    tokens: {
      access_token: creds.accessToken,
      refresh_token: creds.refreshToken,
    },
  };

  await fs.writeFile(
    path.join(codexDir, 'auth.json'),
    JSON.stringify(credentialData, null, 2),
    { mode: 0o600 }
  );
}

/**
 * Write Gemini CLI credentials
 *
 * Gemini CLI reads from: $HOME/.gemini/credentials.json
 * Format may vary - this is a placeholder for the actual format
 */
async function writeGeminiCredentials(userHome: string, creds: CredentialData): Promise<void> {
  const geminiDir = path.join(userHome, '.gemini');
  await fs.mkdir(geminiDir, { recursive: true });

  const credentialData = {
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt instanceof Date
      ? creds.expiresAt.toISOString()
      : creds.expiresAt,
  };

  await fs.writeFile(
    path.join(geminiDir, 'credentials.json'),
    JSON.stringify(credentialData, null, 2),
    { mode: 0o600 }
  );
}

/**
 * Copy gh CLI config from container HOME to user HOME
 *
 * gh CLI config is at: $HOME/.config/gh/hosts.yml
 * We copy this so users can run gh commands (gh pr create, etc.)
 *
 * Note: GH_TOKEN env var is also set, which gh CLI will use.
 * This is a fallback for cases where env var isn't picked up.
 */
async function copyGhConfig(userHome: string): Promise<void> {
  const containerHome = getContainerHome();
  const srcConfig = path.join(containerHome, '.config', 'gh');
  const dstConfig = path.join(userHome, '.config', 'gh');

  try {
    // Check if source config exists
    await fs.access(srcConfig);

    // Create destination directory
    await fs.mkdir(path.dirname(dstConfig), { recursive: true });

    // Copy recursively
    await copyDir(srcConfig, dstConfig);
  } catch {
    // gh config doesn't exist in container - that's fine, GH_TOKEN env will work
  }
}

/**
 * Recursively copy a directory
 */
async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);

    if (entry.isDirectory()) {
      await copyDir(srcPath, dstPath);
    } else {
      await fs.copyFile(srcPath, dstPath);
    }
  }
}

/**
 * Write credentials for a specific provider
 */
export async function writeProviderCredentials(
  userHome: string,
  provider: ProviderType,
  creds: CredentialData
): Promise<void> {
  switch (provider) {
    case 'anthropic':
      await writeClaudeCredentials(userHome, creds);
      break;
    case 'openai':
      await writeCodexCredentials(userHome, creds);
      break;
    case 'gemini':
      await writeGeminiCredentials(userHome, creds);
      break;
    case 'github':
      // GitHub uses GH_TOKEN env var, but we can also copy gh config
      await copyGhConfig(userHome);
      break;
    default:
      console.warn(`[credential-writer] Unknown provider: ${provider}`);
  }
}

/**
 * Prepare a user's HOME directory with their credentials
 *
 * Creates per-user HOME directory and writes credentials for the specified provider.
 * Returns the path to the user's HOME directory.
 *
 * @param userId - User ID (used for directory naming)
 * @param provider - Provider type (anthropic, openai, etc.)
 * @param creds - Credential data from database
 * @returns Path to user's HOME directory
 */
export async function prepareUserHome(
  userId: string,
  provider: ProviderType,
  creds: CredentialData
): Promise<string> {
  const userHome = getUserHomePath(userId);

  // Create user home directory
  await fs.mkdir(userHome, { recursive: true });

  // Write provider credentials
  await writeProviderCredentials(userHome, provider, creds);

  // Always copy gh config for git operations
  await copyGhConfig(userHome);

  console.log(`[credential-writer] Prepared HOME for user ${userId.substring(0, 8)}... at ${userHome}`);

  return userHome;
}

/**
 * Clean up a user's HOME directory
 *
 * Removes the per-user HOME directory and all contents.
 * Call this when a user's session ends or credentials are revoked.
 */
export async function cleanupUserHome(userId: string): Promise<void> {
  const userHome = getUserHomePath(userId);

  try {
    await fs.rm(userHome, { recursive: true, force: true });
    console.log(`[credential-writer] Cleaned up HOME for user ${userId.substring(0, 8)}...`);
  } catch (err) {
    console.warn(`[credential-writer] Failed to cleanup HOME for user ${userId.substring(0, 8)}...:`, err);
  }
}
