import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  ensureAuthenticated,
  ensureCloudSession,
  readStoredAuth,
  refreshStoredAuth,
  writeStoredAuth,
} from './auth.js';
import { AUTH_FILE_PATH, CloudAuthError, type StoredAuth } from './types.js';

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();

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
