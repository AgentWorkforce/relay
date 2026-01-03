import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { CredentialVault } from './index.js';
import type { StoredCredential } from './index.js';

const masterKey = vi.hoisted(() => Buffer.alloc(32, 1).toString('base64'));
const key = (userId: string, provider: string) => `${userId}:${provider}`;

const mockConfig = vi.hoisted(() => ({
  vault: { masterKey },
  providers: {
    anthropic: { clientId: 'anthropic-client' },
    openai: { clientId: 'openai-client' },
    google: { clientId: 'google-client', clientSecret: 'google-secret' },
  },
  github: {
    clientId: 'github-client',
    clientSecret: 'github-secret',
  },
} as any));

const store = vi.hoisted(() => new Map<string, any>());

const dbMock = vi.hoisted(() => ({
  credentials: {
    upsert: vi.fn(async (credential: any) => {
      store.set(key(credential.userId, credential.provider), { ...credential });
    }),
    findByUserAndProvider: vi.fn(async (userId: string, provider: string) => {
      return store.get(key(userId, provider)) || null;
    }),
    findByUserId: vi.fn(async (userId: string) => {
      return Array.from(store.values()).filter((cred) => cred.userId === userId);
    }),
    updateTokens: vi.fn(async (
      userId: string,
      provider: string,
      accessToken: string,
      refreshToken?: string,
      expiresAt?: Date
    ) => {
      const existing = store.get(key(userId, provider));
      if (existing) {
        existing.accessToken = accessToken;
        existing.refreshToken = refreshToken;
        existing.tokenExpiresAt = expiresAt;
      }
    }),
    delete: vi.fn(async (userId: string, provider: string) => {
      store.delete(key(userId, provider));
    }),
  },
}));

vi.mock('../config.js', () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock('../db/index.js', () => ({
  db: dbMock,
}));

const originalFetch = global.fetch;

describe('CredentialVault', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    mockConfig.vault.masterKey = masterKey;
    global.fetch = originalFetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('throws when master key is not 32 bytes', () => {
    mockConfig.vault.masterKey = Buffer.alloc(16, 1).toString('base64');

    expect(() => new CredentialVault()).toThrow(
      'Vault master key must be 32 bytes (base64 encoded)'
    );
  });

  it('encrypts stored tokens and decrypts on retrieval', async () => {
    const vault = new CredentialVault();
    const tokenExpiresAt = new Date('2025-01-01T00:00:00Z');
    const credential: StoredCredential = {
      userId: 'user-1',
      provider: 'openai',
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
      tokenExpiresAt,
      scopes: ['scope1', 'scope2'],
      providerAccountId: 'acct-1',
      providerAccountEmail: 'user@example.com',
    };

    await vault.storeCredential(credential);

    const stored = store.get(key('user-1', 'openai'));
    expect(stored.accessToken).not.toBe(credential.accessToken);
    expect(stored.refreshToken).not.toBe(credential.refreshToken);

    const result = await vault.getCredential('user-1', 'openai');
    expect(result).toEqual({
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
      tokenExpiresAt,
      scopes: ['scope1', 'scope2'],
      providerAccountId: 'acct-1',
      providerAccountEmail: 'user@example.com',
    });
  });

  it('returns null when credential does not exist', async () => {
    const vault = new CredentialVault();

    const result = await vault.getCredential('missing', 'openai');

    expect(result).toBeNull();
  });

  it('returns decrypted credential map for a user', async () => {
    const vault = new CredentialVault();
    await vault.storeCredential({
      userId: 'user-1',
      provider: 'openai',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    });
    await vault.storeCredential({
      userId: 'user-1',
      provider: 'google',
      accessToken: 'g-access',
      refreshToken: 'g-refresh',
      scopes: ['email'],
    });

    const credentials = await vault.getUserCredentials('user-1');

    expect(credentials.size).toBe(2);
    expect(credentials.get('openai')?.accessToken).toBe('access-1');
    expect(credentials.get('google')?.refreshToken).toBe('g-refresh');
    expect(credentials.get('google')?.scopes).toEqual(['email']);
  });

  it('updates tokens with encryption', async () => {
    const vault = new CredentialVault();
    await vault.storeCredential({
      userId: 'user-1',
      provider: 'openai',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
    });

    const newExpiry = new Date(Date.now() + 60 * 60 * 1000);
    await vault.updateTokens('user-1', 'openai', 'new-access', 'new-refresh', newExpiry);

    const stored = store.get(key('user-1', 'openai'));
    expect(stored.accessToken).not.toBe('new-access');
    expect(stored.refreshToken).not.toBe('new-refresh');

    const decrypted = await vault.getCredential('user-1', 'openai');
    expect(decrypted?.accessToken).toBe('new-access');
    expect(decrypted?.refreshToken).toBe('new-refresh');
    expect(decrypted?.tokenExpiresAt?.getTime()).toBeCloseTo(newExpiry.getTime());
  });

  it('deletes credentials for a provider', async () => {
    const vault = new CredentialVault();
    await vault.storeCredential({
      userId: 'user-1',
      provider: 'openai',
      accessToken: 'to-delete',
    });

    await vault.deleteCredential('user-1', 'openai');

    expect(await vault.getCredential('user-1', 'openai')).toBeNull();
    expect(dbMock.credentials.delete).toHaveBeenCalledWith('user-1', 'openai');
  });

  it('checks refresh necessity based on expiry time', async () => {
    const vault = new CredentialVault();
    const soon = new Date(Date.now() + 4 * 60 * 1000);
    const later = new Date(Date.now() + 10 * 60 * 1000);

    await vault.storeCredential({
      userId: 'user-1',
      provider: 'openai',
      accessToken: 'token',
      tokenExpiresAt: soon,
    });
    await vault.storeCredential({
      userId: 'user-2',
      provider: 'openai',
      accessToken: 'token',
      tokenExpiresAt: later,
    });

    expect(await vault.needsRefresh('user-1', 'openai')).toBe(true);
    expect(await vault.needsRefresh('user-2', 'openai')).toBe(false);
    expect(await vault.needsRefresh('missing', 'openai')).toBe(false);
  });

  it('returns false when refresh token is missing', async () => {
    const vault = new CredentialVault();
    await vault.storeCredential({
      userId: 'user-1',
      provider: 'openai',
      accessToken: 'token',
    });

    const refreshed = await vault.refreshToken('user-1', 'openai');

    expect(refreshed).toBe(false);
  });

  it('returns false for unknown providers', async () => {
    const vault = new CredentialVault();
    await vault.storeCredential({
      userId: 'user-1',
      provider: 'unknown',
      accessToken: 'token',
      refreshToken: 'refresh-token',
    });

    const refreshed = await vault.refreshToken('user-1', 'unknown');

    expect(refreshed).toBe(false);
  });

  it('refreshes tokens via provider endpoint and updates stored values', async () => {
    const vault = new CredentialVault();
    await vault.storeCredential({
      userId: 'user-1',
      provider: 'openai',
      accessToken: 'old-access',
      refreshToken: 'refresh-token',
    });

    const mockResponse = {
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 120,
      }),
    };
    const mockFetch = vi.fn().mockResolvedValue(mockResponse as any);
    global.fetch = mockFetch as any;

    const refreshed = await vault.refreshToken('user-1', 'openai');

    expect(refreshed).toBe(true);
    const body = mockFetch.mock.calls[0][1]?.body as URLSearchParams;
    expect(body.get('refresh_token')).toBe('refresh-token');
    expect(body.get('client_id')).toBe('openai-client');

    const updated = await vault.getCredential('user-1', 'openai');
    expect(updated?.accessToken).toBe('new-access');
    expect(updated?.refreshToken).toBe('new-refresh');
    expect(updated?.tokenExpiresAt).toBeInstanceOf(Date);
  });

  it('handles refresh failures without throwing', async () => {
    const vault = new CredentialVault();
    await vault.storeCredential({
      userId: 'user-1',
      provider: 'openai',
      accessToken: 'old-access',
      refreshToken: 'refresh-token',
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      text: async () => 'bad request',
    } as any);
    global.fetch = mockFetch as any;

    const refreshed = await vault.refreshToken('user-1', 'openai');

    expect(refreshed).toBe(false);
    const stillStored = await vault.getCredential('user-1', 'openai');
    expect(stillStored?.accessToken).toBe('old-access');
  });
});
