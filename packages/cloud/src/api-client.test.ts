import { describe, expect, it, vi } from 'vitest';

import { CloudApiClient } from './api-client.js';
import { CloudAuthError } from './types.js';

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
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/v1/auth/token/refresh');
    expect(client.snapshot()).toMatchObject({
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      refreshTokenExpiresAt: '2999-04-01T00:00:00.000Z',
    });
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
