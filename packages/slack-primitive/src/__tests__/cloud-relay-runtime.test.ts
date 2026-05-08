import { describe, expect, it, vi } from 'vitest';

import { SlackCloudRelayClient, type CloudRelayFetch } from '../cloud-relay-runtime.js';
import { SlackPostBackError } from '../types.js';

interface FakeResponseBody {
  status?: number;
  body: unknown;
}

function fakeFetch(responses: FakeResponseBody[]): CloudRelayFetch & { calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> } {
  const calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  let i = 0;
  const fn = (async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses[i] ?? responses[responses.length - 1];
    i += 1;
    const status = next.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      json: async () => next.body,
    };
  }) as CloudRelayFetch;
  (fn as unknown as { calls: typeof calls }).calls = calls;
  return fn as CloudRelayFetch & { calls: typeof calls };
}

const baseConfig = {
  env: {},
  cloudApiToken: 'rk_cli_test',
  cloudApiUrl: 'https://api.example.com',
};

describe('SlackCloudRelayClient', () => {
  it('throws auth_token_missing when CLOUD_API_TOKEN is absent', () => {
    expect(() =>
      new SlackCloudRelayClient({ env: {}, cloudApiUrl: 'https://api.example.com' }, fakeFetch([]))
    ).toThrow('CLOUD_API_TOKEN');
  });

  it('throws auth_token_missing when CLOUD_API_URL is absent', () => {
    expect(() =>
      new SlackCloudRelayClient({ env: {}, cloudApiToken: 'rk_test' }, fakeFetch([]))
    ).toThrow('CLOUD_API_URL');
  });

  it('posts via cloud-relay endpoint with bearer auth', async () => {
    const fetch = fakeFetch([
      { body: { ok: true, ts: '1709876543.123', channel: 'C0123', workspaceId: 'ws_test' } },
    ]);
    const client = new SlackCloudRelayClient(baseConfig, fetch);

    const result = await client.postMessage({
      channel: '#general',
      text: 'PR opened',
      threadTs: '1234.5',
      unfurl: false,
    });

    expect(result).toEqual({
      channel: 'C0123',
      ts: '1709876543.123',
      text: 'PR opened',
      resolvedMentions: [],
      unresolvedMentions: [],
      warnings: [],
    });

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0].url).toBe('https://api.example.com/api/v1/slack/post-message');
    expect(fetch.calls[0].init?.headers).toMatchObject({
      authorization: 'Bearer rk_cli_test',
      'content-type': 'application/json',
    });
    expect(JSON.parse(fetch.calls[0].init?.body ?? '{}')).toEqual({
      channel: '#general',
      text: 'PR opened',
      threadTs: '1234.5',
      unfurlLinks: false,
      unfurlMedia: false,
    });
  });

  it('records mentions as unresolved with a warning', async () => {
    const fetch = fakeFetch([
      { body: { ok: true, ts: '1.0', channel: 'C0123', workspaceId: 'ws_test' } },
    ]);
    const client = new SlackCloudRelayClient(baseConfig, fetch);

    const result = await client.postMessage({
      channel: '#general',
      text: 'cc people',
      mentions: ['@khaliq', 'khaliq@example.com'],
    });

    expect(result.unresolvedMentions).toEqual(['@khaliq', 'khaliq@example.com']);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toMatchObject({ type: 'mention_unresolved' });
  });

  it('throws SlackPostBackError(rate_limited) on rate-limit response', async () => {
    const fetch = fakeFetch([
      {
        status: 429,
        body: { ok: false, code: 'rate_limited', error: 'channel rate limit exceeded', retryAfterMs: 5000 },
      },
    ]);
    const client = new SlackCloudRelayClient(baseConfig, fetch);

    await expect(client.postMessage({ channel: '#general', text: 'hi' })).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('maps cloud not_connected to SlackPostBackError(not_connected)', async () => {
    const fetch = fakeFetch([
      { status: 404, body: { ok: false, code: 'not_connected', error: 'no Slack integration' } },
    ]);
    const client = new SlackCloudRelayClient(baseConfig, fetch);

    await expect(client.postMessage({ channel: '#general', text: 'hi' })).rejects.toMatchObject({
      code: 'not_connected',
    });
  });

  it('maps cloud slack_error to SlackPostBackError(slack_api_error)', async () => {
    const fetch = fakeFetch([
      { body: { ok: false, code: 'slack_error', error: 'channel_not_found' } },
    ]);
    const client = new SlackCloudRelayClient(baseConfig, fetch);

    await expect(client.postMessage({ channel: '#bogus', text: 'hi' })).rejects.toMatchObject({
      code: 'slack_api_error',
    });
  });

  it('throws SlackPostBackError(upstream_error) when fetch rejects', async () => {
    const fetch = (async () => {
      throw new Error('network down');
    }) as unknown as CloudRelayFetch;
    const client = new SlackCloudRelayClient(baseConfig, fetch);

    await expect(client.postMessage({ channel: '#general', text: 'hi' })).rejects.toMatchObject({
      code: 'upstream_error',
    });
  });

  it('rejects resolveUser with unsupported_in_cloud_relay', async () => {
    const client = new SlackCloudRelayClient(baseConfig, fakeFetch([]));
    await expect(client.resolveUser({ mention: '@khaliq' })).rejects.toMatchObject({
      code: 'unsupported_in_cloud_relay',
    });
  });

  it('rejects resolveChannel with unsupported_in_cloud_relay', async () => {
    const client = new SlackCloudRelayClient(baseConfig, fakeFetch([]));
    await expect(client.resolveChannel({ channel: '#general' })).rejects.toMatchObject({
      code: 'unsupported_in_cloud_relay',
    });
  });

  it('reports cloud-relay runtime', async () => {
    const client = new SlackCloudRelayClient(baseConfig, fakeFetch([]));
    expect(client.getRuntime()).toBe('cloud-relay');
    await expect(client.isAuthenticated()).resolves.toBe(true);
  });
});

// Compile-time guards
void SlackPostBackError;
void vi;
