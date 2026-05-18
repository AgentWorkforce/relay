import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentRelayProtocolError, BrokerTransport } from '../transport.js';

const TEST_BASE_URL = 'http://127.0.0.1:3888';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BrokerTransport.request', () => {
  it('returns undefined for empty successful responses', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const transport = new BrokerTransport({ baseUrl: TEST_BASE_URL, fetch: fetchMock as typeof fetch });

    await expect(transport.request<void>('/empty')).resolves.toBeUndefined();
  });

  it('returns undefined for content-length zero successful responses', async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 200, headers: { 'content-length': '0' } })
    );
    const transport = new BrokerTransport({ baseUrl: TEST_BASE_URL, fetch: fetchMock as typeof fetch });

    await expect(transport.request<void>('/empty')).resolves.toBeUndefined();
  });

  it('keeps invalid_response for non-empty malformed JSON responses', async () => {
    const fetchMock = vi.fn(
      async () => new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const transport = new BrokerTransport({ baseUrl: TEST_BASE_URL, fetch: fetchMock as typeof fetch });

    await expect(transport.request('/bad-json')).rejects.toMatchObject<Partial<AgentRelayProtocolError>>({
      code: 'invalid_response',
      status: 200,
    });
  });

  it('replaces differently-cased API key headers instead of duplicating them', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const transport = new BrokerTransport({
      baseUrl: TEST_BASE_URL,
      apiKey: 'configured-key',
      fetch: fetchMock as typeof fetch,
    });

    await transport.request('/headers', { headers: { 'x-api-key': 'caller-key' } });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual({ 'X-API-Key': 'configured-key' });
  });
});
