/**
 * SSH Security Utilities
 *
 * Provides secure SSH password derivation for workspace containers.
 * Uses a deterministic approach based on workspace ID + secret salt,
 * ensuring each workspace has a unique password without storage.
 */

import * as crypto from 'crypto';

const DEFAULT_SALT = 'default-salt-change-in-prod';

/**
 * Derive a unique SSH password for a workspace.
 *
 * Uses SHA-256 hash of (workspaceId + salt) to generate a deterministic
 * but unique password for each workspace. This approach:
 * - Ensures each workspace has a unique password
 * - Requires no database storage
 * - Produces consistent results across cloud server and container
 *
 * SECURITY: Set SSH_PASSWORD_SALT environment variable in production!
 * The default salt is insecure and should never be used in production.
 *
 * @param workspaceId - The workspace UUID
 * @returns A 24-character hex password (96 bits of entropy)
 */
export function deriveSshPassword(workspaceId: string): string {
  const salt = process.env.SSH_PASSWORD_SALT;

  // Warn if using default salt in production
  if (!salt) {
    const isProduction = process.env.NODE_ENV === 'production' || process.env.FLY_APP_NAME;
    if (isProduction) {
      console.warn(
        '[SECURITY WARNING] SSH_PASSWORD_SALT is not set! ' +
        'Using default salt is INSECURE in production. ' +
        'Set SSH_PASSWORD_SALT to a random 32+ character secret.'
      );
    }
  }

  const effectiveSalt = salt || DEFAULT_SALT;

  return crypto
    .createHash('sha256')
    .update(`${workspaceId}:${effectiveSalt}`)
    .digest('hex')
    .substring(0, 24); // 24 hex chars = 96 bits of entropy
}

/**
 * Validate that SSH security is properly configured.
 * Call this at server startup to catch configuration issues early.
 *
 * @returns true if properly configured, false otherwise
 */
export function validateSshSecurityConfig(): boolean {
  const salt = process.env.SSH_PASSWORD_SALT;
  const isProduction = process.env.NODE_ENV === 'production' || process.env.FLY_APP_NAME;

  if (isProduction && !salt) {
    console.error(
      '[SECURITY ERROR] SSH_PASSWORD_SALT must be set in production! ' +
      'Generate one with: openssl rand -hex 32'
    );
    return false;
  }

  if (salt && salt.length < 16) {
    console.warn(
      '[SECURITY WARNING] SSH_PASSWORD_SALT should be at least 16 characters. ' +
      'Current length: ' + salt.length
    );
  }

  return true;
}
