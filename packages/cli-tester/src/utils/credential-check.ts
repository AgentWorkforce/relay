/**
 * Credential checking utilities for CLI authentication testing
 * Verifies and parses credential files for various CLI tools
 */

import { readFileSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type CLIType = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode' | 'droid';

export interface CredentialCheck {
  /** CLI type being checked */
  cli: CLIType;
  /** Whether the credential file exists */
  exists: boolean;
  /** Whether the credentials appear valid (have required fields) */
  valid: boolean;
  /** Whether an access token is present */
  hasAccessToken: boolean;
  /** Whether a refresh token is present */
  hasRefreshToken: boolean;
  /** Token expiration date if available */
  expiresAt?: Date;
  /** Path to the credential file */
  filePath: string;
  /** Raw credential data (tokens redacted) */
  data?: Record<string, unknown>;
  /** Error message if check failed */
  error?: string;
}

/**
 * Get the credential file path for a CLI
 */
export function getCredentialPath(cli: CLIType): string {
  const home = homedir();

  switch (cli) {
    case 'claude':
      return join(home, '.claude', '.credentials.json');
    case 'codex':
      return join(home, '.codex', 'auth.json');
    case 'gemini':
      return join(home, '.config', 'gcloud', 'application_default_credentials.json');
    case 'cursor':
      return join(home, '.cursor', 'auth.json');
    case 'opencode':
      return join(home, '.local', 'share', 'opencode', 'auth.json');
    case 'droid':
      return join(home, '.droid', 'auth.json');
    default:
      throw new Error(`Unknown CLI type: ${cli}`);
  }
}

/**
 * Get all config paths for a CLI (for clearing)
 */
export function getConfigPaths(cli: CLIType): string[] {
  const home = homedir();

  switch (cli) {
    case 'claude':
      return [
        join(home, '.claude', '.credentials.json'),
        join(home, '.claude', 'settings.json'),
        join(home, '.claude', 'settings.local.json'),
      ];
    case 'codex':
      return [
        join(home, '.codex', 'auth.json'),
        join(home, '.codex', 'config.json'),
        join(home, '.codex', 'config.toml'),
      ];
    case 'gemini':
      return [
        join(home, '.config', 'gcloud', 'application_default_credentials.json'),
        join(home, '.gemini', 'credentials.json'),
        join(home, '.gemini', 'settings.json'),
      ];
    case 'cursor':
      return [
        join(home, '.cursor', 'auth.json'),
        join(home, '.cursor', 'settings.json'),
      ];
    case 'opencode':
      return [join(home, '.local', 'share', 'opencode', 'auth.json')];
    case 'droid':
      return [join(home, '.droid', 'auth.json')];
    default:
      throw new Error(`Unknown CLI type: ${cli}`);
  }
}

/**
 * Extract token info from credential data based on CLI type
 */
function extractTokenInfo(
  cli: CLIType,
  data: Record<string, unknown>
): { hasAccessToken: boolean; hasRefreshToken: boolean; expiresAt?: Date } {
  let hasAccessToken = false;
  let hasRefreshToken = false;
  let expiresAt: Date | undefined;

  switch (cli) {
    case 'claude': {
      // Claude format: { claudeAiOauth: { accessToken, refreshToken, expiresAt } }
      const oauth = data.claudeAiOauth as Record<string, unknown> | undefined;
      if (oauth) {
        hasAccessToken = typeof oauth.accessToken === 'string' && oauth.accessToken.length > 0;
        hasRefreshToken = typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0;
        if (typeof oauth.expiresAt === 'number') {
          expiresAt = new Date(oauth.expiresAt);
        }
      }
      break;
    }

    case 'codex': {
      // Codex format: { tokens: { access_token, refresh_token, expires_at } }
      const tokens = data.tokens as Record<string, unknown> | undefined;
      if (tokens) {
        hasAccessToken =
          typeof tokens.access_token === 'string' && tokens.access_token.length > 0;
        hasRefreshToken =
          typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0;
        if (typeof tokens.expires_at === 'number') {
          expiresAt = new Date(tokens.expires_at * 1000); // Unix timestamp
        }
      }
      break;
    }

    case 'gemini': {
      // Google OAuth format: { access_token, refresh_token, expiry_date }
      hasAccessToken =
        typeof data.access_token === 'string' && data.access_token.length > 0;
      hasRefreshToken =
        typeof data.refresh_token === 'string' && data.refresh_token.length > 0;
      if (typeof data.expiry_date === 'number') {
        expiresAt = new Date(data.expiry_date);
      }
      break;
    }

    case 'cursor':
    case 'opencode':
    case 'droid': {
      // Generic format: { accessToken, refreshToken } or { access_token, refresh_token }
      hasAccessToken =
        (typeof data.accessToken === 'string' && data.accessToken.length > 0) ||
        (typeof data.access_token === 'string' && data.access_token.length > 0);
      hasRefreshToken =
        (typeof data.refreshToken === 'string' && data.refreshToken.length > 0) ||
        (typeof data.refresh_token === 'string' && data.refresh_token.length > 0);
      break;
    }
  }

  return { hasAccessToken, hasRefreshToken, expiresAt };
}

/**
 * Redact sensitive values in credential data
 */
function redactData(data: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') {
      // Redact anything that looks like a token
      if (
        key.toLowerCase().includes('token') ||
        key.toLowerCase().includes('secret') ||
        key.toLowerCase().includes('key') ||
        value.length > 40
      ) {
        redacted[key] = '[REDACTED]';
      } else {
        redacted[key] = value;
      }
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactData(value as Record<string, unknown>);
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

/**
 * Check credentials for a specific CLI
 */
export function checkCredentials(cli: CLIType): CredentialCheck {
  const filePath = getCredentialPath(cli);

  const result: CredentialCheck = {
    cli,
    exists: false,
    valid: false,
    hasAccessToken: false,
    hasRefreshToken: false,
    filePath,
  };

  if (!existsSync(filePath)) {
    return result;
  }

  result.exists = true;

  try {
    const content = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content) as Record<string, unknown>;

    const tokenInfo = extractTokenInfo(cli, data);
    result.hasAccessToken = tokenInfo.hasAccessToken;
    result.hasRefreshToken = tokenInfo.hasRefreshToken;
    result.expiresAt = tokenInfo.expiresAt;

    // Valid if at least access token is present
    result.valid = result.hasAccessToken;

    // Include redacted data for debugging
    result.data = redactData(data);
  } catch (err) {
    result.error = err instanceof Error ? err.message : 'Unknown error';
  }

  return result;
}

/**
 * Clear credentials for a specific CLI
 */
export function clearCredentials(cli: CLIType): { cleared: string[]; errors: string[] } {
  const paths = getConfigPaths(cli);
  const cleared: string[] = [];
  const errors: string[] = [];

  for (const path of paths) {
    if (existsSync(path)) {
      try {
        unlinkSync(path);
        cleared.push(path);
      } catch (err) {
        errors.push(`Failed to remove ${path}: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }
  }

  return { cleared, errors };
}

/**
 * Clear all CLI credentials
 */
export function clearAllCredentials(): Record<CLIType, { cleared: string[]; errors: string[] }> {
  const clis: CLIType[] = ['claude', 'codex', 'gemini', 'cursor', 'opencode', 'droid'];
  const results: Record<string, { cleared: string[]; errors: string[] }> = {};

  for (const cli of clis) {
    results[cli] = clearCredentials(cli);
  }

  return results as Record<CLIType, { cleared: string[]; errors: string[] }>;
}

/**
 * Check all CLI credentials
 */
export function checkAllCredentials(): Record<CLIType, CredentialCheck> {
  const clis: CLIType[] = ['claude', 'codex', 'gemini', 'cursor', 'opencode', 'droid'];
  const results: Record<string, CredentialCheck> = {};

  for (const cli of clis) {
    results[cli] = checkCredentials(cli);
  }

  return results as Record<CLIType, CredentialCheck>;
}
