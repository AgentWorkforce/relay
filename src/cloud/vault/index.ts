/**
 * Agent Relay Cloud - Credential Vault
 *
 * Secure storage for OAuth tokens with AES-256-GCM encryption.
 */

import * as crypto from 'crypto';
import { getConfig } from '../config.js';
import { db } from '../db/index.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export interface StoredCredential {
  userId: string;
  provider: string;
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: Date;
  scopes?: string[];
  providerAccountId?: string;
  providerAccountEmail?: string;
}

export interface DecryptedCredential {
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: Date;
  scopes?: string[];
  providerAccountId?: string;
  providerAccountEmail?: string;
}

export class CredentialVault {
  private masterKey: Buffer;

  constructor() {
    const config = getConfig();
    this.masterKey = Buffer.from(config.vault.masterKey, 'base64');

    if (this.masterKey.length !== 32) {
      throw new Error('Vault master key must be 32 bytes (base64 encoded)');
    }
  }

  /**
   * Encrypt a string value
   */
  private encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.masterKey, iv);

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    // Format: base64(iv + authTag + ciphertext)
    const combined = Buffer.concat([iv, authTag, encrypted]);
    return combined.toString('base64');
  }

  /**
   * Decrypt a string value
   */
  private decrypt(ciphertext: string): string {
    const combined = Buffer.from(ciphertext, 'base64');

    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, this.masterKey, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  /**
   * Store encrypted credential
   */
  async storeCredential(credential: StoredCredential): Promise<void> {
    const encryptedAccessToken = this.encrypt(credential.accessToken);
    const encryptedRefreshToken = credential.refreshToken
      ? this.encrypt(credential.refreshToken)
      : undefined;

    await db.credentials.upsert({
      userId: credential.userId,
      provider: credential.provider,
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      tokenExpiresAt: credential.tokenExpiresAt,
      scopes: credential.scopes,
      providerAccountId: credential.providerAccountId,
      providerAccountEmail: credential.providerAccountEmail,
    });
  }

  /**
   * Retrieve and decrypt credential
   */
  async getCredential(userId: string, provider: string): Promise<DecryptedCredential | null> {
    const credential = await db.credentials.findByUserAndProvider(userId, provider);
    if (!credential) {
      return null;
    }

    return {
      accessToken: this.decrypt(credential.accessToken),
      refreshToken: credential.refreshToken
        ? this.decrypt(credential.refreshToken)
        : undefined,
      tokenExpiresAt: credential.tokenExpiresAt ?? undefined,
      scopes: credential.scopes ?? undefined,
      providerAccountId: credential.providerAccountId ?? undefined,
      providerAccountEmail: credential.providerAccountEmail ?? undefined,
    };
  }

  /**
   * Get all credentials for a user (decrypted)
   */
  async getUserCredentials(userId: string): Promise<Map<string, DecryptedCredential>> {
    const credentials = await db.credentials.findByUserId(userId);
    const result = new Map<string, DecryptedCredential>();

    for (const cred of credentials) {
      result.set(cred.provider, {
        accessToken: this.decrypt(cred.accessToken),
        refreshToken: cred.refreshToken
          ? this.decrypt(cred.refreshToken)
          : undefined,
        tokenExpiresAt: cred.tokenExpiresAt ?? undefined,
        scopes: cred.scopes ?? undefined,
        providerAccountId: cred.providerAccountId ?? undefined,
        providerAccountEmail: cred.providerAccountEmail ?? undefined,
      });
    }

    return result;
  }

  /**
   * Update tokens (e.g., after refresh)
   */
  async updateTokens(
    userId: string,
    provider: string,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: Date
  ): Promise<void> {
    const encryptedAccessToken = this.encrypt(accessToken);
    const encryptedRefreshToken = refreshToken
      ? this.encrypt(refreshToken)
      : undefined;

    await db.credentials.updateTokens(
      userId,
      provider,
      encryptedAccessToken,
      encryptedRefreshToken,
      expiresAt
    );
  }

  /**
   * Delete credential
   */
  async deleteCredential(userId: string, provider: string): Promise<void> {
    await db.credentials.delete(userId, provider);
  }

  /**
   * Check if credential needs refresh (within 5 minutes of expiry)
   */
  async needsRefresh(userId: string, provider: string): Promise<boolean> {
    const credential = await db.credentials.findByUserAndProvider(userId, provider);
    if (!credential || !credential.tokenExpiresAt) {
      return false;
    }

    const fiveMinutes = 5 * 60 * 1000;
    return Date.now() > credential.tokenExpiresAt.getTime() - fiveMinutes;
  }

  /**
   * Refresh OAuth token for a provider
   */
  async refreshToken(userId: string, provider: string): Promise<boolean> {
    const credential = await this.getCredential(userId, provider);
    if (!credential?.refreshToken) {
      return false;
    }

    // Provider-specific refresh endpoints
    const refreshEndpoints: Record<string, string> = {
      anthropic: 'https://api.anthropic.com/oauth/token',
      openai: 'https://auth.openai.com/oauth/token',
      google: 'https://oauth2.googleapis.com/token',
      github: 'https://github.com/login/oauth/access_token',
    };

    const endpoint = refreshEndpoints[provider];
    if (!endpoint) {
      console.error(`Unknown provider for refresh: ${provider}`);
      return false;
    }

    try {
      const config = getConfig();
      const providerConfig = config.providers[provider as keyof typeof config.providers];

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: credential.refreshToken,
          client_id: (providerConfig as any)?.clientId || config.github.clientId,
          ...(provider === 'google' && {
            client_secret: (providerConfig as any)?.clientSecret,
          }),
          ...(provider === 'github' && {
            client_secret: config.github.clientSecret,
          }),
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`Token refresh failed for ${provider}:`, error);
        return false;
      }

      const data = await response.json() as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
      };

      await this.updateTokens(
        userId,
        provider,
        data.access_token,
        data.refresh_token,
        data.expires_in
          ? new Date(Date.now() + data.expires_in * 1000)
          : undefined
      );

      return true;
    } catch (error) {
      console.error(`Error refreshing token for ${provider}:`, error);
      return false;
    }
  }
}

// Singleton instance
let _vault: CredentialVault | null = null;

export function getVault(): CredentialVault {
  if (!_vault) {
    _vault = new CredentialVault();
  }
  return _vault;
}

export const vault = {
  get instance() {
    return getVault();
  },
  storeCredential: (cred: StoredCredential) => getVault().storeCredential(cred),
  getCredential: (userId: string, provider: string) =>
    getVault().getCredential(userId, provider),
  getUserCredentials: (userId: string) => getVault().getUserCredentials(userId),
  updateTokens: (
    userId: string,
    provider: string,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: Date
  ) => getVault().updateTokens(userId, provider, accessToken, refreshToken, expiresAt),
  deleteCredential: (userId: string, provider: string) =>
    getVault().deleteCredential(userId, provider),
  needsRefresh: (userId: string, provider: string) =>
    getVault().needsRefresh(userId, provider),
  refreshToken: (userId: string, provider: string) =>
    getVault().refreshToken(userId, provider),
};

// Generate a new master key (for setup)
export function generateMasterKey(): string {
  return crypto.randomBytes(32).toString('base64');
}
