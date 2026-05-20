import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  chmod: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  default: fsMocks,
  ...fsMocks,
}));

import { ensureAuthenticated, readStoredAuth, refreshStoredAuth } from './auth.js';
import { AUTH_FILE_PATH, LEGACY_AUTH_FILE_PATH } from './types.js';
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
  vi.restoreAllMocks();
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
  fsMocks.chmod.mockReset();
  fsMocks.chmod.mockResolvedValue(undefined);
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

  it('maps the new cloud.json file shape to runtime auth', async () => {
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        apiUrl: 'https://cloud.example',
        cloudToken: 'cloud-token',
        expiresAt: '2026-04-13T12:00:00.000Z',
        userId: 'user_123',
        workspaces: [{ id: 'workspace_123', name: 'Support' }],
      })
    );

    await expect(readStoredAuth({})).resolves.toEqual({
      apiUrl: 'https://cloud.example',
      accessToken: 'cloud-token',
      refreshToken: '',
      accessTokenExpiresAt: '2026-04-13T12:00:00.000Z',
      userId: 'user_123',
      workspaces: [{ id: 'workspace_123', name: 'Support' }],
    });
  });

  it('falls back to the legacy auth file path', async () => {
    fsMocks.readFile
      .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      .mockResolvedValueOnce(JSON.stringify(FILE_AUTH));

    await expect(readStoredAuth({})).resolves.toEqual(FILE_AUTH);
    expect(fsMocks.readFile).toHaveBeenNthCalledWith(1, AUTH_FILE_PATH, 'utf8');
    expect(fsMocks.readFile).toHaveBeenNthCalledWith(2, LEGACY_AUTH_FILE_PATH, 'utf8');
  });

  it('does not silently fall back to the legacy file when the primary file is unreadable (EACCES)', async () => {
    // Anything other than ENOENT — malformed JSON, permission failures —
    // must surface as `null` so the user re-authenticates with a clean
    // file instead of resurrecting stale credentials from the legacy path.
    fsMocks.readFile.mockRejectedValueOnce(
      Object.assign(new Error('EACCES'), { code: 'EACCES' })
    );

    await expect(readStoredAuth({})).resolves.toBeNull();
    expect(fsMocks.readFile).toHaveBeenCalledTimes(1);
    expect(fsMocks.readFile).toHaveBeenCalledWith(AUTH_FILE_PATH, 'utf8');
  });

  it('does not silently fall back when the primary file is malformed JSON', async () => {
    fsMocks.readFile.mockResolvedValueOnce('{ not json');

    await expect(readStoredAuth({})).resolves.toBeNull();
    expect(fsMocks.readFile).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['file://', { apiUrl: 'file:///etc/passwd' }],
    ['javascript:', { apiUrl: 'javascript:alert(1)' }],
    ['malformed', { apiUrl: 'not a url' }],
    ['empty', { apiUrl: '' }],
  ])('rejects auth files whose apiUrl is not http/https (%s)', async (_label, overrides) => {
    // The apiUrl read from cloud.json flows directly into fetch() via
    // buildApiUrl; reject anything that isn't http/https to prevent
    // file:// / javascript: schemes from leaking into outbound network
    // requests (CodeQL: file data in outbound network request).
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        apiUrl: overrides.apiUrl,
        cloudToken: 'cloud-token',
        expiresAt: '2026-04-13T12:00:00.000Z',
      })
    );
    await expect(readStoredAuth({})).resolves.toBeNull();
  });

  it('round-trips the refreshToken from the cloud.json file shape', async () => {
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        apiUrl: 'https://cloud.example',
        cloudToken: 'cloud-token',
        refreshToken: 'disk-refresh-token',
        expiresAt: '2026-04-13T12:00:00.000Z',
        userId: 'user_123',
      })
    );

    await expect(readStoredAuth({})).resolves.toEqual({
      apiUrl: 'https://cloud.example',
      accessToken: 'cloud-token',
      refreshToken: 'disk-refresh-token',
      accessTokenExpiresAt: '2026-04-13T12:00:00.000Z',
      userId: 'user_123',
      workspaces: undefined,
    });
  });

  it('prefers env auth over file auth when both are available', async () => {
    const env = createEnvAuth();
    fsMocks.readFile.mockResolvedValue(JSON.stringify(FILE_AUTH));

    await expect(readStoredAuth(env)).resolves.toEqual(ENV_AUTH);
    expect(fsMocks.readFile).not.toHaveBeenCalled();
  });
});

describe('ensureAuthenticated', () => {
  function farFutureIso(): string {
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }

  it('returns stored file auth even when apiUrl differs from defaultApiUrl', async () => {
    // Regression: previously, any host mismatch between the CLI's default
    // apiUrl and the stored apiUrl forced a browser login on every cloud
    // command. Stored auth is now authoritative on its own host.
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        apiUrl: 'https://origin.example/cloud',
        accessToken: 'stored-access',
        refreshToken: 'stored-refresh',
        accessTokenExpiresAt: farFutureIso(),
      })
    );

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await ensureAuthenticated('https://different.example/cloud');

    expect(result.apiUrl).toBe('https://origin.example/cloud');
    expect(result.accessToken).toBe('stored-access');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns stored auth unchanged when not near expiry', async () => {
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        apiUrl: 'https://example.com/cloud',
        accessToken: 'stored-access',
        refreshToken: 'stored-refresh',
        accessTokenExpiresAt: farFutureIso(),
      })
    );

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await ensureAuthenticated('https://example.com/cloud');

    expect(result.accessToken).toBe('stored-access');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes stored auth against the stored host when near expiry', async () => {
    const nearExpiry = new Date(Date.now() + 30_000).toISOString();
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        apiUrl: 'https://origin.example/cloud',
        accessToken: 'stale-access',
        refreshToken: 'stored-refresh',
        accessTokenExpiresAt: nearExpiry,
      })
    );

    const fetchSpy = vi.fn(
      async (input: string | URL) =>
        new Response(
          JSON.stringify({
            accessToken: 'fresh-access',
            refreshToken: 'fresh-refresh',
            accessTokenExpiresAt: farFutureIso(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await ensureAuthenticated('https://different.example/cloud');

    expect(result.apiUrl).toBe('https://origin.example/cloud');
    expect(result.accessToken).toBe('fresh-access');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchSpy.mock.calls[0][0]);
    expect(calledUrl).toContain('origin.example');
  });

  it('logs in with a one-time code poll and writes the new cloud config path', async () => {
    fsMocks.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubEnv('AGENT_RELAY_NO_BROWSER', '1');

    const fetchSpy = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/v1/auth/cli-login/poll');
      expect(url.searchParams.get('code')).toMatch(/^c_[A-Za-z0-9_-]+$/);

      return new Response(
        JSON.stringify({
          cloudToken: 'cloud-token-test',
          userId: 'user_123',
          workspaces: [{ id: 'workspace_123', name: 'Support' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await ensureAuthenticated('https://cloud.test', { force: true });

    expect(result).toEqual({
      apiUrl: 'https://cloud.test',
      accessToken: 'cloud-token-test',
      refreshToken: '',
      accessTokenExpiresAt: expect.any(String),
      userId: 'user_123',
      workspaces: [{ id: 'workspace_123', name: 'Support' }],
    });
    expect(consoleLog).toHaveBeenCalledWith(expect.stringMatching(/^Opening browser for cloud login: /));
    expect(fsMocks.mkdir).toHaveBeenCalledWith(expect.stringContaining('.config/agent-relay'), {
      recursive: true,
      mode: 0o700,
    });
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      AUTH_FILE_PATH,
      expect.stringContaining('"cloudToken": "cloud-token-test"'),
      {
        encoding: 'utf8',
        mode: 0o600,
      }
    );
    // writeFile's `mode` only applies on file creation; the explicit chmod
    // after the write tightens permissions on pre-existing files. See
    // packages/cloud/src/auth.ts writeStoredAuth().
    expect(fsMocks.chmod).toHaveBeenCalledWith(AUTH_FILE_PATH, 0o600);

    consoleLog.mockRestore();
  });

  it('persists the refreshToken in the cloud.json file when one is returned by the poll', async () => {
    fsMocks.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.stubEnv('AGENT_RELAY_NO_BROWSER', '1');

    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            cloudToken: 'cloud-token-test',
            refreshToken: 'fresh-refresh-token',
            accessTokenExpiresAt: '2026-05-13T12:00:00.000Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await ensureAuthenticated('https://cloud.test', { force: true });

    expect(result.refreshToken).toBe('fresh-refresh-token');
    const writeCall = fsMocks.writeFile.mock.calls.find((call) => call[0] === AUTH_FILE_PATH);
    expect(writeCall).toBeDefined();
    const written = writeCall ? String(writeCall[1]) : '';
    expect(written).toContain('"refreshToken": "fresh-refresh-token"');
  });
});

describe('AUTH_FILE_PATH (XDG_CONFIG_HOME resolution)', () => {
  // AUTH_FILE_PATH is computed once at module load time. We use vi.resetModules
  // + dynamic import to observe how it resolves under different env values
  // without polluting the rest of the test suite.
  async function importAuthFilePath(env: NodeJS.ProcessEnv): Promise<string> {
    vi.resetModules();
    const previous = { ...process.env };
    // Clear potentially conflicting keys before applying the test env.
    delete process.env.XDG_CONFIG_HOME;
    Object.assign(process.env, env);
    try {
      const mod = await import('./types.js');
      return mod.AUTH_FILE_PATH;
    } finally {
      // Restore the original env exactly so subsequent tests are unaffected.
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  }

  it('uses XDG_CONFIG_HOME when it is an absolute path', async () => {
    const home = await importAuthFilePath({ XDG_CONFIG_HOME: '/var/tmp/xdg' });
    expect(home.startsWith('/var/tmp/xdg/agent-relay/')).toBe(true);
  });

  it('ignores XDG_CONFIG_HOME when it is a relative path and falls back to ~/.config', async () => {
    // Per the XDG Base Directory spec, a relative XDG_CONFIG_HOME is invalid;
    // writing auth tokens to e.g. `./agent-relay/cloud.json` relative to the
    // CWD is dangerous (the file lands in whatever directory the CLI was
    // launched from). Confirm we ignore it and fall back to ~/.config.
    const home = await importAuthFilePath({ XDG_CONFIG_HOME: 'relative/dir' });
    expect(home.startsWith('relative/dir')).toBe(false);
    expect(home).toContain('.config/agent-relay/');
  });

  it('ignores XDG_CONFIG_HOME when it is empty whitespace', async () => {
    const home = await importAuthFilePath({ XDG_CONFIG_HOME: '   ' });
    expect(home).toContain('.config/agent-relay/');
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
