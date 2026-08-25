import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  chmod: vi.fn(),
  rename: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
}));

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(() => ({
    unref: vi.fn(),
  })),
}));

vi.mock('node:fs/promises', () => ({
  default: fsMocks,
  ...fsMocks,
}));

vi.mock('node:child_process', () => ({
  spawn: childProcessMocks.spawn,
}));

import {
  authorizedApiFetch,
  clearStoredAuth,
  ensureAuthenticated,
  ensureCloudSession,
  readStoredAuth,
  refreshStoredAuth,
  refreshStoredCloudIdentity,
  toCloudIdentity,
  writeStoredAuth,
} from './auth.js';
import {
  AUTH_FILE_PATH,
  CloudAuthError,
  type CloudApiKeyAuth,
  type StoredAuth,
  type WhoAmIResponse,
} from './types.js';

const AUTH_LOCK_PATH = `${AUTH_FILE_PATH}.lock`;

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
    ...(next.refreshTokenExpiresAt ? { CLOUD_API_REFRESH_TOKEN_EXPIRES_AT: next.refreshTokenExpiresAt } : {}),
  };
}

// `clearAllMocks` resets call history but leaves `vi.spyOn` spies installed, so
// a test that failed mid-body used to leave `console.log` silenced for every
// later test in this file — silencing output exactly when a failure needs it.
afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();

  // Pin the browser-availability signal. Login now falls back to the device
  // flow on a host that cannot open a browser, so tests that exercise the
  // browser flow must not inherit whether the runner happens to be a headless
  // Linux CI box.
  vi.stubEnv('DISPLAY', ':0');
  vi.stubEnv('SSH_CONNECTION', '');
  vi.stubEnv('SSH_TTY', '');
  vi.stubEnv('SSH_CLIENT', '');

  fsMocks.readFile.mockReset();
  fsMocks.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  fsMocks.writeFile.mockReset();
  fsMocks.writeFile.mockResolvedValue(undefined);
  fsMocks.chmod.mockReset();
  fsMocks.chmod.mockResolvedValue(undefined);
  fsMocks.rename.mockReset();
  fsMocks.rename.mockResolvedValue(undefined);
  fsMocks.mkdir.mockReset();
  fsMocks.mkdir.mockResolvedValue(undefined);
  fsMocks.rm.mockReset();
  fsMocks.rm.mockResolvedValue(undefined);
  fsMocks.stat.mockReset();
  fsMocks.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  childProcessMocks.spawn.mockClear();
});

describe('writeStoredAuth', () => {
  it('atomically writes auth through a pid-scoped sibling temp file', async () => {
    await writeStoredAuth(FILE_AUTH);

    expect(fsMocks.mkdir).toHaveBeenCalledWith(expect.stringContaining('.agentworkforce/relay'), {
      recursive: true,
      mode: 0o700,
    });
    expect(fsMocks.writeFile).toHaveBeenCalledOnce();
    const [temporaryPath, body, writeOptions] = fsMocks.writeFile.mock.calls[0];
    expect(String(temporaryPath)).toContain('.cloud-auth.json.');
    expect(temporaryPath).toContain(`.${process.pid}.`);
    expect(temporaryPath).toMatch(/\.tmp$/);
    expect(body).toBe(`${JSON.stringify(FILE_AUTH, null, 2)}\n`);
    expect(writeOptions).toEqual({
      encoding: 'utf8',
      mode: 0o600,
    });
    expect(fsMocks.chmod).toHaveBeenCalledWith(temporaryPath, 0o600);
    expect(fsMocks.rename).toHaveBeenCalledWith(temporaryPath, AUTH_FILE_PATH);
    expect(fsMocks.writeFile).not.toHaveBeenCalledWith(AUTH_FILE_PATH, expect.anything(), expect.anything());
    expect(fsMocks.rm).toHaveBeenCalledWith(temporaryPath, { force: true });
  });

  it('cleans up the temp file when the atomic rename fails', async () => {
    fsMocks.rename.mockRejectedValueOnce(new Error('rename failed'));

    await expect(writeStoredAuth(FILE_AUTH)).rejects.toThrow('rename failed');

    const temporaryPath = fsMocks.writeFile.mock.calls[0][0];
    expect(fsMocks.rm).toHaveBeenCalledWith(temporaryPath, { force: true });
  });
});

describe('readStoredAuth', () => {
  it('returns env-backed auth when all CLOUD_API_* vars are present and valid', async () => {
    const env = createEnvAuth({ refreshTokenExpiresAt: '2026-05-13T12:00:00.000Z' });

    await expect(readStoredAuth(env)).resolves.toEqual({
      ...ENV_AUTH,
      refreshTokenExpiresAt: '2026-05-13T12:00:00.000Z',
    });
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
    ['accessExpiresAt', { accessTokenExpiresAt: 'not-a-date' }],
  ])('falls through to file auth when env %s is malformed', async (_label, override) => {
    const env = createEnvAuth(override);
    fsMocks.readFile.mockResolvedValue(JSON.stringify(FILE_AUTH));

    await expect(readStoredAuth(env)).resolves.toEqual(FILE_AUTH);
    expect(fsMocks.readFile).toHaveBeenCalledOnce();
  });

  it('ignores malformed optional env refresh-token expiry metadata', async () => {
    const env = createEnvAuth({ refreshTokenExpiresAt: 'not-a-date' });
    fsMocks.readFile.mockResolvedValue(JSON.stringify(FILE_AUTH));

    await expect(readStoredAuth(env)).resolves.toEqual(ENV_AUTH);
    expect(fsMocks.readFile).not.toHaveBeenCalled();
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

  it('returns null when canonical auth is absent and never reads the legacy .agent-relay path', async () => {
    fsMocks.readFile.mockImplementation(async (file: string) => {
      if (file === AUTH_FILE_PATH) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      throw new Error(`unexpected file ${file}`);
    });

    await expect(readStoredAuth({})).resolves.toBeNull();

    // The legacy migrate-on-read shim was removed: no read of a ~/.agent-relay
    // path, and no write/rename back into the canonical location.
    const readPaths = fsMocks.readFile.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(readPaths.some((p: string) => p.includes('.agent-relay'))).toBe(false);
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(fsMocks.rename).not.toHaveBeenCalled();
  });
});

describe('ensureAuthenticated', () => {
  function farFutureIso(): string {
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }

  it('uses one non-refreshing Cloud API key without reading stored login state', async () => {
    vi.stubEnv('CLOUD_API_URL', 'https://ci.example/cloud');
    vi.stubEnv('CLOUD_API_KEY', 'ci-api-key');
    fsMocks.readFile.mockResolvedValue(JSON.stringify(FILE_AUTH));

    await expect(ensureAuthenticated('https://default.example/cloud')).resolves.toEqual({
      authMode: 'api-key',
      apiUrl: 'https://ci.example/cloud',
      accessToken: 'ci-api-key',
    });
    expect(fsMocks.readFile).not.toHaveBeenCalled();
  });

  it('fails closed when API-key auth has a malformed Cloud URL', async () => {
    vi.stubEnv('CLOUD_API_URL', 'not-a-url');
    vi.stubEnv('CLOUD_API_KEY', 'ci-api-key');
    fsMocks.readFile.mockResolvedValue(JSON.stringify(FILE_AUTH));

    await expect(ensureAuthenticated('https://default.example/cloud')).rejects.toMatchObject({
      code: 'AUTH_ENV_REPROVISION_REQUIRED',
    });
    expect(fsMocks.readFile).not.toHaveBeenCalled();
  });

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

  it('refreshes stored auth when the refresh token is inside the proactive renewal window', async () => {
    const farFutureAccess = farFutureIso();
    const nearRefreshExpiry = new Date(Date.now() + 60_000).toISOString();
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        apiUrl: 'https://origin.example/cloud',
        accessToken: 'still-valid-access',
        refreshToken: 'stored-refresh',
        accessTokenExpiresAt: farFutureAccess,
        refreshTokenExpiresAt: nearRefreshExpiry,
      })
    );

    const refreshedAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            accessToken: 'fresh-access',
            refreshToken: 'fresh-refresh',
            accessTokenExpiresAt: farFutureIso(),
            refreshTokenExpiresAt: refreshedAt,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await ensureAuthenticated('https://different.example/cloud');

    expect(result.accessToken).toBe('fresh-access');
    expect(result.refreshTokenExpiresAt).toBe(refreshedAt);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('keeps waiting after a stray local callback with an invalid state', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const authPromise = ensureAuthenticated('https://example.com/cloud', { force: true });

    await vi.waitFor(() => {
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Opening browser for cloud login: '));
    });

    const loginLine = logSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.startsWith('Opening browser for cloud login: '));
    expect(loginLine).toBeTruthy();

    const loginUrl = new URL(String(loginLine).slice('Opening browser for cloud login: '.length));
    const callbackUrl = new URL(String(loginUrl.searchParams.get('redirect_uri')));
    const state = loginUrl.searchParams.get('state');
    expect(state).toBeTruthy();

    const strayResponse = await fetch(callbackUrl, { redirect: 'manual' });
    expect(strayResponse.status).toBe(400);
    await expect(strayResponse.text()).resolves.toContain('Ignored invalid CLI login callback');

    const stillWaiting = await Promise.race([
      authPromise.then(
        () => 'resolved',
        () => 'rejected'
      ),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
    ]);
    expect(stillWaiting).toBe('pending');

    callbackUrl.searchParams.set('state', String(state));
    callbackUrl.searchParams.set('access_token', 'access-token');
    callbackUrl.searchParams.set('refresh_token', 'refresh-token');
    callbackUrl.searchParams.set('access_token_expires_at', '2999-01-01T00:00:00.000Z');
    callbackUrl.searchParams.set('refresh_token_expires_at', '2999-04-01T00:00:00.000Z');
    callbackUrl.searchParams.set('api_url', 'https://example.com/cloud');

    const successResponse = await fetch(callbackUrl, { redirect: 'manual' });
    expect(successResponse.status).toBe(302);

    await expect(authPromise).resolves.toEqual({
      apiUrl: 'https://example.com/cloud',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
      refreshTokenExpiresAt: '2999-04-01T00:00:00.000Z',
    });
    expect(fsMocks.writeFile).toHaveBeenCalledOnce();

    logSpy.mockRestore();
  });

  it('falls back to the device flow on a host that cannot open a browser', async () => {
    // barry over ssh: no browser here, so the loopback callback the browser
    // flow depends on is unreachable and would only hang until it timed out.
    vi.stubEnv('SSH_CONNECTION', '10.0.0.2 54321 10.0.0.1 22');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const fetchSpy = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/auth/device/start')) {
        return new Response(
          JSON.stringify({
            device_code: 'cld_dc_test',
            user_code: 'BCDF-GHJK',
            verification_uri: 'https://example.com/cloud/device',
            expires_in: 600,
            // Keep the mandatory pre-poll wait short; pacing itself is
            // covered exhaustively in device-auth.test.ts.
            interval: 1,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/api/v1/auth/device/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'device-access',
            refresh_token: 'device-refresh',
            access_token_expires_at: '2999-01-01T00:00:00.000Z',
            refresh_token_expires_at: '2999-04-01T00:00:00.000Z',
            api_url: 'https://example.com/cloud',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      // whoami, used only to record identity; failing it must not fail login.
      return new Response('{}', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const session = await ensureCloudSession({ apiUrl: 'https://example.com/cloud' });

    expect(session.auth).toMatchObject({
      accessToken: 'device-access',
      refreshToken: 'device-refresh',
      apiUrl: 'https://example.com/cloud',
    });
    // Never tried to launch a browser it does not have.
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
    // Persisted through the normal path, so `cloud session --reveal-token`
    // works afterwards — that is what ai-hist consumes.
    expect(fsMocks.writeFile).toHaveBeenCalled();
    // The user was actually told the code.
    expect(logSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain('BCDF-GHJK');

    logSpy.mockRestore();
  });

  it('points a headless host at --device when it cannot prompt', async () => {
    vi.stubEnv('SSH_CONNECTION', '10.0.0.2 54321 10.0.0.1 22');

    await expect(
      ensureCloudSession({ apiUrl: 'https://example.com/cloud', interactive: false })
    ).rejects.toMatchObject({
      code: 'AUTH_BROWSER_REQUIRED',
      message: 'Cloud login required. Run `agent-relay cloud login --device`.',
    });
  });

  it('fails fast without opening a browser when non-interactive auth needs login', async () => {
    await expect(
      ensureCloudSession({
        apiUrl: 'https://example.com/cloud',
        interactive: false,
      })
    ).rejects.toMatchObject({
      code: 'AUTH_BROWSER_REQUIRED',
    });

    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it('forces 401-triggered client refresh through the file-backed refresh lock', async () => {
    const storedAuth: StoredAuth = {
      apiUrl: 'https://origin.example/cloud',
      accessToken: 'rejected-access',
      refreshToken: 'stored-refresh',
      accessTokenExpiresAt: farFutureIso(),
    };
    const refreshedAuth: StoredAuth = {
      apiUrl: storedAuth.apiUrl,
      accessToken: 'accepted-access',
      refreshToken: 'rotated-refresh',
      accessTokenExpiresAt: farFutureIso(),
    };
    fsMocks.readFile.mockResolvedValue(JSON.stringify(storedAuth));

    const fetchSpy = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const requestUrl = String(input);
      if (requestUrl.includes('/api/v1/auth/token/refresh')) {
        return new Response(JSON.stringify(refreshedAuth), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      const headers = new Headers(init?.headers);
      if (headers.get('authorization') === 'Bearer rejected-access') {
        return new Response(JSON.stringify({ error: 'expired' }), { status: 401 });
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const session = await ensureCloudSession({ apiUrl: 'https://ignored.example/cloud' });
    const response = await session.client.fetch('/api/v1/workflows');

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const refreshCall = fetchSpy.mock.calls.find((call) =>
      String(call[0]).includes('/api/v1/auth/token/refresh')
    );
    expect(refreshCall).toBeTruthy();
    expect(JSON.parse(String((refreshCall?.[1] as RequestInit).body))).toEqual({
      refreshToken: 'stored-refresh',
    });
    expect(fsMocks.mkdir).toHaveBeenCalledWith(AUTH_LOCK_PATH, { mode: 0o700 });
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

  it('preserves refresh token expiry returned by the refresh endpoint', async () => {
    const refreshTokenExpiresAt = '2026-07-13T12:00:00.000Z';
    const auth: StoredAuth = {
      apiUrl: 'https://origin.example/cloud',
      accessToken: 'stale-access',
      refreshToken: 'stored-refresh',
      accessTokenExpiresAt: '2000-01-01T00:00:00.000Z',
    };
    fsMocks.readFile.mockResolvedValue(JSON.stringify(auth));
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              accessToken: 'fresh-access',
              refreshToken: 'fresh-refresh',
              accessTokenExpiresAt: '2026-04-13T13:00:00.000Z',
              refreshTokenExpiresAt,
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }
          )
      )
    );

    await expect(refreshStoredAuth(auth)).resolves.toMatchObject({
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      refreshTokenExpiresAt,
    });
  });

  it('retains existing refresh token expiry when the refresh endpoint omits it', async () => {
    const refreshTokenExpiresAt = '2026-07-13T12:00:00.000Z';
    const auth: StoredAuth = {
      apiUrl: 'https://origin.example/cloud',
      accessToken: 'stale-access',
      refreshToken: 'stored-refresh',
      accessTokenExpiresAt: '2000-01-01T00:00:00.000Z',
      refreshTokenExpiresAt,
    };
    fsMocks.readFile.mockResolvedValue(JSON.stringify(auth));
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              accessToken: 'fresh-access',
              refreshToken: 'fresh-refresh',
              accessTokenExpiresAt: '2026-04-13T13:00:00.000Z',
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }
          )
      )
    );

    await expect(refreshStoredAuth(auth)).resolves.toMatchObject({
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      refreshTokenExpiresAt,
    });
  });

  it('aborts stalled refresh requests and throws a typed timeout error', async () => {
    vi.useFakeTimers();
    const auth: StoredAuth = {
      apiUrl: 'https://origin.example/cloud',
      accessToken: 'stale-access',
      refreshToken: 'stored-refresh',
      accessTokenExpiresAt: '2026-04-13T12:00:00.000Z',
    };
    fsMocks.readFile.mockResolvedValue(JSON.stringify(auth));

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_input: string | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          })
      )
    );

    const refresh = refreshStoredAuth(auth, { refreshTimeoutMs: 25 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);

    const error = await refresh;
    expect(error).toBeInstanceOf(CloudAuthError);
    expect(error).toMatchObject({ code: 'AUTH_REFRESH_TIMEOUT' });

    vi.useRealTimers();
  });

  it('serializes concurrent file-backed refreshes and reuses the rotated token', async () => {
    vi.useFakeTimers();
    const staleAuth: StoredAuth = {
      apiUrl: 'https://origin.example/cloud',
      accessToken: 'stale-access',
      refreshToken: 'stale-refresh',
      accessTokenExpiresAt: '2000-01-01T00:00:00.000Z',
    };
    const freshAuth: StoredAuth = {
      apiUrl: staleAuth.apiUrl,
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
    };
    let canonicalAuth = staleAuth;
    let lockHeld = false;

    fsMocks.readFile.mockImplementation(async (file: string) => {
      if (file === AUTH_FILE_PATH) {
        return JSON.stringify(canonicalAuth);
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    fsMocks.mkdir.mockImplementation(async (file: string) => {
      if (file === AUTH_LOCK_PATH) {
        if (lockHeld) {
          throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        }
        lockHeld = true;
      }
      return undefined;
    });
    fsMocks.stat.mockImplementation(async (file: string) => {
      if (file === AUTH_LOCK_PATH && lockHeld) {
        return { mtimeMs: Date.now() };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    fsMocks.rename.mockImplementation(async (_temporaryPath: string, file: string) => {
      if (file === AUTH_FILE_PATH) {
        canonicalAuth = freshAuth;
      }
    });
    fsMocks.rm.mockImplementation(async (file: string) => {
      if (file === AUTH_LOCK_PATH) {
        lockHeld = false;
      }
      return undefined;
    });

    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify(freshAuth), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchSpy);

    const first = refreshStoredAuth(staleAuth);
    const second = refreshStoredAuth(staleAuth);
    await vi.advanceTimersByTimeAsync(50);

    await expect(first).resolves.toEqual(freshAuth);
    await vi.advanceTimersByTimeAsync(50);
    await expect(second).resolves.toEqual(freshAuth);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body))).toEqual({
      refreshToken: 'stale-refresh',
    });

    vi.useRealTimers();
  });

  it('releases the file-backed refresh lock when refresh throws', async () => {
    const auth: StoredAuth = {
      apiUrl: 'https://origin.example/cloud',
      accessToken: 'stale-access',
      refreshToken: 'stored-refresh',
      accessTokenExpiresAt: '2000-01-01T00:00:00.000Z',
    };
    fsMocks.readFile.mockResolvedValue(JSON.stringify(auth));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('socket closed'), { name: 'NetworkError' });
      })
    );

    await expect(refreshStoredAuth(auth)).rejects.toThrow('socket closed');

    expect(fsMocks.mkdir).toHaveBeenCalledWith(AUTH_LOCK_PATH, { mode: 0o700 });
    expect(fsMocks.rm).toHaveBeenCalledWith(AUTH_LOCK_PATH, { recursive: true, force: true });
  });
});

describe('authorizedApiFetch telemetry headers', () => {
  const telemetryEnvKeys = [
    'AGENT_RELAY_DISTINCT_ID',
    'AGENT_RELAY_MACHINE_ID',
    'AGENT_RELAY_USER_ID',
    'AGENT_RELAY_ORG_ID',
    'AGENT_RELAY_ORG_SLUG',
    'AGENT_RELAY_ORCHESTRATOR_HARNESS',
    'AGENT_RELAY_TELEMETRY_CLIENT',
    'AGENT_RELAY_CLI_VERSION',
    'AGENT_RELAY_SDK_VERSION',
    'AGENT_RELAY_TELEMETRY_DISABLED',
    'DO_NOT_TRACK',
  ] as const;

  function clearTelemetryEnv(): void {
    for (const key of telemetryEnvKeys) {
      delete process.env[key];
    }
  }

  it('adds Agent Relay identity and origin headers when the CLI provides a telemetry distinct id', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const previousEnv = { ...process.env };
    clearTelemetryEnv();
    process.env.AGENT_RELAY_DISTINCT_ID = 'abc123def4567890';
    process.env.AGENT_RELAY_ORCHESTRATOR_HARNESS = 'Codex';
    process.env.AGENT_RELAY_TELEMETRY_CLIENT = 'agent-relay';
    process.env.AGENT_RELAY_CLI_VERSION = '7.1.1';

    try {
      await authorizedApiFetch(
        {
          apiUrl: 'https://api.example.test',
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
        },
        '/api/v1/workflows/run',
        {
          method: 'POST',
          headers: { Accept: 'application/json' },
        }
      );
    } finally {
      process.env = previousEnv;
    }

    expect(fetchSpy).toHaveBeenCalledOnce();
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('authorization')).toBe('Bearer access-token');
    expect(headers.get('x-agent-relay-distinct-id')).toBe('abc123def4567890');
    expect(headers.get('x-relaycast-harness')).toBe('Codex');
    expect(headers.get('x-relaycast-origin-client')).toBe('agent-relay');
    expect(headers.get('x-relaycast-origin-version')).toBe('7.1.1');
  });

  it('omits telemetry headers when no distinct id is provided', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const previousEnv = { ...process.env };
    clearTelemetryEnv();

    try {
      await authorizedApiFetch(
        {
          apiUrl: 'https://api.example.test',
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
        },
        '/api/v1/workflows/run',
        { method: 'POST' }
      );
    } finally {
      process.env = previousEnv;
    }

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('x-agent-relay-distinct-id')).toBeNull();
    expect(headers.get('x-relaycast-harness')).toBeNull();
  });
});

describe('authorizedApiFetch re-login', () => {
  it('returns a Cloud 401 for API-key auth without refresh or interactive login', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchSpy);

    const auth: CloudApiKeyAuth = {
      authMode: 'api-key',
      apiUrl: 'https://api.example.test',
      accessToken: 'ci-api-key',
    };
    const result = await authorizedApiFetch(auth, '/api/v1/workflows/run', { method: 'POST' });

    expect(result.response.status).toBe(401);
    expect(result.auth).toBe(auth);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it('re-authenticates a headless host through the device flow, not the browser', async () => {
    // The steady state this feature exists for: barry logged in once over ssh
    // with `--device`, and now a request 401s with a refresh token the server
    // will not renew. Sending that host to the browser flow would park it on a
    // loopback callback nobody can ever complete.
    vi.stubEnv('SSH_CONNECTION', '10.0.0.2 54321 10.0.0.1 22');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    let protectedCalls = 0;
    const fetchSpy = vi.fn(async (input: string | URL) => {
      const url = String(input);

      if (url.includes('/api/v1/auth/token/refresh')) {
        // Refresh token revoked/rotated away — the branch that falls through
        // to an interactive login.
        return new Response('{}', { status: 401 });
      }
      if (url.includes('/api/v1/auth/device/start')) {
        return new Response(
          JSON.stringify({
            device_code: 'cld_dc_reauth',
            user_code: 'MNPQ-RSTV',
            verification_uri: 'https://api.example.test/cloud/device',
            expires_in: 600,
            interval: 1,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/api/v1/auth/device/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'reauth-access',
            refresh_token: 'reauth-refresh',
            access_token_expires_at: '2999-01-01T00:00:00.000Z',
            api_url: 'https://api.example.test',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/api/v1/auth/whoami')) {
        return new Response('{}', { status: 500 });
      }

      protectedCalls += 1;
      // First attempt is unauthorized; the retry after re-login succeeds.
      return protectedCalls === 1
        ? new Response('{}', { status: 401 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { response, auth } = await authorizedApiFetch(
      {
        apiUrl: 'https://api.example.test',
        accessToken: 'stale-access',
        refreshToken: 'stale-refresh',
        accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
      },
      '/api/v1/workflows/run',
      { method: 'POST' }
    );

    expect(response.status).toBe(200);
    expect(auth).toMatchObject({ accessToken: 'reauth-access', refreshToken: 'reauth-refresh' });

    const requested = fetchSpy.mock.calls.map((call) => String(call[0]));
    expect(requested.some((url) => url.includes('/api/v1/auth/device/start'))).toBe(true);
    // The browser flow is what this fix routes around: no browser launch, and
    // the retried request carries the token the device flow just issued.
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
    const retryInit = fetchSpy.mock.calls.at(-1)?.[1] as RequestInit;
    expect(new Headers(retryInit.headers).get('authorization')).toBe('Bearer reauth-access');

    logSpy.mockRestore();
  });

  it('returns the caller cancellation instead of starting a device login', async () => {
    // Routing re-auth through the device flow made cancellation matter more:
    // the device grant blocks for minutes, so an aborted request that starts a
    // login leaves a cancelled CLI or workflow waiting on authorization nobody
    // asked for. The abort must win before any flow begins.
    vi.stubEnv('SSH_CONNECTION', '10.0.0.2 54321 10.0.0.1 22');
    const controller = new AbortController();

    const fetchSpy = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/auth/device/')) {
        throw new Error('a cancelled request must not start the device flow');
      }
      if (url.includes('/api/v1/auth/token/refresh')) {
        // Abort while the refresh is in flight, then fail it: this is the
        // exact interleaving where the old code fell through to a login.
        controller.abort();
        return new Response('{}', { status: 401 });
      }
      return new Response('{}', { status: 401 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      authorizedApiFetch(
        {
          apiUrl: 'https://api.example.test',
          accessToken: 'stale-access',
          refreshToken: 'stale-refresh',
          accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
        },
        '/api/v1/workflows/run',
        { method: 'POST', signal: controller.signal }
      )
    ).rejects.toThrow();

    const requested = fetchSpy.mock.calls.map((call) => String(call[0]));
    expect(requested.some((url) => url.includes('/api/v1/auth/device/start'))).toBe(false);
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it('still uses the browser flow on a host that has one', async () => {
    // The selector only changes which flow a headless host gets. Everywhere
    // else the browser flow stays the default, and it must still complete.
    const realFetch = globalThis.fetch;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    let protectedCalls = 0;
    const fetchSpy = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/auth/token/refresh')) {
        return new Response('{}', { status: 401 });
      }
      if (url.includes('/api/v1/auth/device/')) {
        throw new Error('device flow must not run on a host with a browser');
      }
      if (url.includes('/api/v1/auth/whoami')) {
        return new Response('{}', { status: 500 });
      }
      protectedCalls += 1;
      return protectedCalls === 1
        ? new Response('{}', { status: 401 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const pending = authorizedApiFetch(
      {
        apiUrl: 'https://api.example.test',
        accessToken: 'stale-access',
        refreshToken: 'stale-refresh',
        accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
      },
      '/api/v1/workflows/run',
      { method: 'POST' }
    );

    await vi.waitFor(() => {
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Opening browser for cloud login: '));
    });

    // Drive the loopback callback to completion so the login server closes
    // instead of outliving the test.
    const loginLine = logSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.startsWith('Opening browser for cloud login: '));
    const loginUrl = new URL(String(loginLine).slice('Opening browser for cloud login: '.length));
    const callbackUrl = new URL(String(loginUrl.searchParams.get('redirect_uri')));
    callbackUrl.searchParams.set('state', String(loginUrl.searchParams.get('state')));
    callbackUrl.searchParams.set('access_token', 'browser-access');
    callbackUrl.searchParams.set('refresh_token', 'browser-refresh');
    callbackUrl.searchParams.set('access_token_expires_at', '2999-01-01T00:00:00.000Z');
    callbackUrl.searchParams.set('api_url', 'https://api.example.test');
    await realFetch(callbackUrl, { redirect: 'manual' });

    const { auth } = await pending;
    expect(auth).toMatchObject({ accessToken: 'browser-access' });
    expect(childProcessMocks.spawn).toHaveBeenCalled();

    logSpy.mockRestore();
  });
});

describe('cloud identity capture', () => {
  const WHOAMI_URL = 'https://api.example.test/api/v1/auth/whoami';

  const AUTH: StoredAuth = {
    apiUrl: 'https://api.example.test',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
  };

  const WHOAMI_PAYLOAD = {
    authenticated: true,
    source: 'token',
    subjectType: 'user',
    scopes: [],
    user: { id: 'usr_abc123', email: 'will@agentrelay.com', name: 'Will', avatarUrl: null },
    currentOrganization: {
      id: 'org_xyz789',
      slug: 'agentworkforce',
      name: 'Agent Workforce',
      role: 'owner',
      status: 'active',
    },
    currentWorkspace: {
      id: 'ws_123',
      organization_id: 'org_xyz789',
      slug: 'default',
      name: 'Default',
    },
  } satisfies WhoAmIResponse;

  it('maps a whoami payload onto the identity contract', () => {
    expect(toCloudIdentity(WHOAMI_PAYLOAD, AUTH.apiUrl)).toMatchObject({
      userId: 'usr_abc123',
      email: 'will@agentrelay.com',
      name: 'Will',
      organizationId: 'org_xyz789',
      organizationSlug: 'agentworkforce',
      organizationName: 'Agent Workforce',
      organizationRole: 'owner',
      workspaceId: 'ws_123',
      apiUrl: AUTH.apiUrl,
    });
  });

  it('tolerates a user with no active workspace or organization', () => {
    const identity = toCloudIdentity(
      { ...WHOAMI_PAYLOAD, currentOrganization: null, currentWorkspace: null },
      AUTH.apiUrl
    );

    expect(identity).toMatchObject({ userId: 'usr_abc123' });
    expect(identity?.organizationId).toBeUndefined();
    expect(identity?.workspaceId).toBeUndefined();
  });

  it('returns null when the payload carries no user id', () => {
    expect(
      toCloudIdentity({ ...WHOAMI_PAYLOAD, user: { ...WHOAMI_PAYLOAD.user, id: '' } }, AUTH.apiUrl)
    ).toBeNull();
  });

  it('resolves and persists identity from whoami', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(WHOAMI_PAYLOAD), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const identity = await refreshStoredCloudIdentity(AUTH);

    expect(String(fetchSpy.mock.calls[0][0])).toBe(WHOAMI_URL);
    expect(identity?.userId).toBe('usr_abc123');
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('cloud-identity.json'),
      expect.stringContaining('usr_abc123'),
      { mode: 0o600 }
    );
  });

  it('returns null and persists nothing when whoami fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 }))
    );

    expect(await refreshStoredCloudIdentity(AUTH)).toBeNull();
    expect(fsMocks.writeFile).not.toHaveBeenCalledWith(
      expect.stringContaining('cloud-identity.json'),
      expect.anything(),
      expect.anything()
    );
  });

  it('never throws when the network is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );

    await expect(refreshStoredCloudIdentity(AUTH)).resolves.toBeNull();
  });

  it('clearing auth also clears the cached identity', async () => {
    await clearStoredAuth();

    expect(fsMocks.rm).toHaveBeenCalledWith(AUTH_FILE_PATH, { force: true });
    expect(fsMocks.rm).toHaveBeenCalledWith(expect.stringContaining('cloud-identity.json'), { force: true });
  });
});
