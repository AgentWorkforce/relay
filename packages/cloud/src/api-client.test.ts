import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApiUrl, CloudApiClient, validateCloudApiUrl, WorkflowApiKeyClient } from './api-client.js';
import { CloudAuthError } from './types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WorkflowApiKeyClient', () => {
  it('uses one API key at the explicit URL and returns a 401 without retrying', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchSpy);

    const client = WorkflowApiKeyClient.fromEnv('https://explicit.example/cloud', {
      CLOUD_API_URL: 'https://ignored.example/cloud',
      CLOUD_API_KEY: 'ci-api-key',
    });
    expect(client).not.toBeNull();

    const response = await client!.fetch('/api/v1/workflows/run', { method: 'POST' });

    expect(response.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://explicit.example/cloud/api/v1/workflows/run');
    const headers = new Headers(fetchSpy.mock.calls[0][1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer ci-api-key');
    expect(fetchSpy.mock.calls[0][1]?.redirect).toBe('error');
  });

  it('fails closed when the API key has a malformed Cloud URL', () => {
    expect(() =>
      WorkflowApiKeyClient.fromEnv('not-a-url', {
        CLOUD_API_KEY: 'ci-api-key',
      })
    ).toThrowError(expect.objectContaining({ code: 'AUTH_ENV_REPROVISION_REQUIRED' }));
  });

  it('rejects insecure, credential-bearing, and cross-origin Cloud URLs', () => {
    expect(() => validateCloudApiUrl('http://cloud.example.test')).toThrow(/HTTPS/);
    expect(() => validateCloudApiUrl('https://user:secret@cloud.example.test')).toThrow(/credentials/);
    expect(() => buildApiUrl('https://cloud.example.test', 'https://attacker.example/path')).toThrow(
      /configured HTTPS origin/
    );
    expect(() =>
      WorkflowApiKeyClient.fromEnv('http://cloud.example.test', { CLOUD_API_KEY: 'ci-api-key' })
    ).toThrowError(expect.objectContaining({ code: 'AUTH_ENV_REPROVISION_REQUIRED' }));
  });
});

describe('CloudApiClient', () => {
  it('refreshes before an otherwise-valid session reaches refresh-token expiry', async () => {
    const fetchSpy = vi.fn(async (input: string | URL) => {
      if (String(input).includes('/api/v1/auth/token/refresh')) {
        return new Response(
          JSON.stringify({
            accessToken: 'fresh-access',
            refreshToken: 'fresh-refresh',
            accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
            refreshTokenExpiresAt: '2999-04-01T00:00:00.000Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new CloudApiClient({
      apiUrl: 'https://cloud.example.test',
      accessToken: 'still-valid-access',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
      refreshTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const response = await client.fetch('/api/v1/workflows');

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.every((call) => call[1]?.redirect === 'error')).toBe(true);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/v1/auth/token/refresh');
    expect(client.snapshot()).toMatchObject({
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      refreshTokenExpiresAt: '2999-04-01T00:00:00.000Z',
    });
  });

  it('uses a refreshed API URL for retried and subsequent requests', async () => {
    const fetchSpy = vi.fn(async (input: string | URL) => {
      const url = String(input);

      if (url === 'https://old.example.test/api/v1/workflows') {
        return new Response(JSON.stringify({ error: 'expired' }), { status: 401 });
      }

      if (url === 'https://old.example.test/api/v1/auth/token/refresh') {
        return new Response(
          JSON.stringify({
            apiUrl: 'https://new.example.test',
            accessToken: 'fresh-access',
            refreshToken: 'fresh-refresh',
            accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url === 'https://new.example.test/api/v1/workflows') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response(JSON.stringify({ error: url }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new CloudApiClient({
      apiUrl: 'https://old.example.test',
      accessToken: 'stale-access',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
      refreshTokenExpiresAt: '2999-04-01T00:00:00.000Z',
    });

    const response = await client.fetch('/api/v1/workflows');

    expect(response.status).toBe(200);
    expect(fetchSpy.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://old.example.test/api/v1/workflows',
      'https://old.example.test/api/v1/auth/token/refresh',
      'https://new.example.test/api/v1/workflows',
    ]);
    expect(fetchSpy.mock.calls.every((call) => call[1]?.redirect === 'error')).toBe(true);
    expect(client.snapshot()).toMatchObject({
      apiUrl: 'https://new.example.test',
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      refreshTokenExpiresAt: '2999-04-01T00:00:00.000Z',
    });
  });

  it('rejects an insecure refreshed API URL before retrying with the bearer token', async () => {
    const fetchSpy = vi.fn(async (input: string | URL) => {
      if (String(input).endsWith('/api/v1/workflows')) {
        return new Response('{}', { status: 401 });
      }
      return new Response(
        JSON.stringify({
          apiUrl: 'http://attacker.example.test',
          accessToken: 'fresh-access',
          refreshToken: 'fresh-refresh',
          accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchSpy);
    const client = new CloudApiClient({
      apiUrl: 'https://cloud.example.test',
      accessToken: 'stale-access',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
    });

    await expect(client.fetch('/api/v1/workflows')).rejects.toThrow(/HTTPS/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('aborts stalled token refresh before issuing an API request', async () => {
    vi.useFakeTimers();
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

    const client = new CloudApiClient({
      apiUrl: 'https://cloud.example.test',
      accessToken: 'stale-access',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: '2000-01-01T00:00:00.000Z',
      refreshTimeoutMs: 25,
    });

    const request = client.fetch('/api/v1/workflows').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);

    const error = await request;
    expect(error).toBeInstanceOf(CloudAuthError);
    expect(error).toMatchObject({ code: 'AUTH_REFRESH_TIMEOUT' });

    vi.useRealTimers();
  });
});
