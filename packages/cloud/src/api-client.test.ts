import { describe, expect, it, vi } from 'vitest';

import { CloudApiClient } from './api-client.js';
import { CloudAuthError } from './types.js';

describe('CloudApiClient', () => {
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
