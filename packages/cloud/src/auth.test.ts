import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  default: fsMocks,
  ...fsMocks,
}));

import { readStoredAuth, refreshStoredAuth } from './auth.js';
import type { StoredAuth } from './types.js';

const FILE_AUTH: StoredAuth = {
  apiUrl: 'https://file.example/cloud',
  accessToken: 'file-access-token',
  refreshToken: 'file-refresh-token',
  accessTokenExpiresAt: '2026-04-13T12:00:00.000Z',
};

const ENV_AUTH: StoredAuth = {
  apiUrl: 'https://env.example/cloud',
  accessToken: 'env-access-token',
  refreshToken: 'env-refresh-token',
  accessTokenExpiresAt: '2026-04-13T12:00:00.000Z',
};

function createEnvAuth(overrides: Partial<StoredAuth> = {}): NodeJS.ProcessEnv {
  const next = { ...ENV_AUTH, ...overrides };

  return {
    CLOUD_API_URL: next.apiUrl,
    CLOUD_API_ACCESS_TOKEN: next.accessToken,
    CLOUD_API_REFRESH_TOKEN: next.refreshToken,
    CLOUD_API_ACCESS_TOKEN_EXPIRES_AT: next.accessTokenExpiresAt,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();

  fsMocks.readFile.mockReset();
  fsMocks.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  fsMocks.writeFile.mockReset();
  fsMocks.writeFile.mockResolvedValue(undefined);
  fsMocks.mkdir.mockReset();
  fsMocks.mkdir.mockResolvedValue(undefined);
  fsMocks.rm.mockReset();
  fsMocks.rm.mockResolvedValue(undefined);
});

describe('readStoredAuth', () => {
  it('returns env-backed auth when all CLOUD_API_* vars are present and valid', async () => {
    const env = createEnvAuth();

    await expect(readStoredAuth(env)).resolves.toEqual(ENV_AUTH);
    expect(fsMocks.readFile).not.toHaveBeenCalled();
  });

  it('falls through to file auth when one env var is missing', async () => {
    const env = {
      CLOUD_API_URL: ENV_AUTH.apiUrl,
      CLOUD_API_ACCESS_TOKEN: ENV_AUTH.accessToken,
      CLOUD_API_ACCESS_TOKEN_EXPIRES_AT: ENV_AUTH.accessTokenExpiresAt,
    };
    fsMocks.readFile.mockResolvedValue(JSON.stringify(FILE_AUTH));

    await expect(readStoredAuth(env)).resolves.toEqual(FILE_AUTH);
    expect(fsMocks.readFile).toHaveBeenCalledOnce();
  });

  it.each([
    ['apiUrl', { apiUrl: 'not-a-url' }],
    ['expiresAt', { accessTokenExpiresAt: 'not-a-date' }],
  ])('falls through to file auth when env %s is malformed', async (_label, override) => {
    const env = createEnvAuth(override);
    fsMocks.readFile.mockResolvedValue(JSON.stringify(FILE_AUTH));

    await expect(readStoredAuth(env)).resolves.toEqual(FILE_AUTH);
    expect(fsMocks.readFile).toHaveBeenCalledOnce();
  });

  it('returns file auth when env is absent', async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify(FILE_AUTH));

    await expect(readStoredAuth({})).resolves.toEqual(FILE_AUTH);
    expect(fsMocks.readFile).toHaveBeenCalledOnce();
  });

  it('prefers env auth over file auth when both are available', async () => {
    const env = createEnvAuth();
    fsMocks.readFile.mockResolvedValue(JSON.stringify(FILE_AUTH));

    await expect(readStoredAuth(env)).resolves.toEqual(ENV_AUTH);
    expect(fsMocks.readFile).not.toHaveBeenCalled();
  });
});

describe('refreshStoredAuth', () => {
  it('refreshes env-backed auth in memory only without touching the auth file', async () => {
    const env = createEnvAuth();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              accessToken: 'env-access-token-next',
              refreshToken: 'env-refresh-token-next',
              accessTokenExpiresAt: '2026-04-13T13:00:00.000Z',
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }
          )
      )
    );

    const auth = await readStoredAuth(env);
    expect(auth).not.toBeNull();

    const refreshed = await refreshStoredAuth(auth as StoredAuth);

    expect(refreshed).toEqual({
      apiUrl: ENV_AUTH.apiUrl,
      accessToken: 'env-access-token-next',
      refreshToken: 'env-refresh-token-next',
      accessTokenExpiresAt: '2026-04-13T13:00:00.000Z',
    });
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(fsMocks.mkdir).not.toHaveBeenCalled();
  });
});
