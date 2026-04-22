import { afterEach, describe, expect, it, vi } from 'vitest';

import { mintProxyToken } from '../jwt.js';
import { MeteringCollector } from '../metering.js';
import { createCredentialProxyApp } from '../router.js';
import type { CredentialStore } from '../router.js';

const proxySecret = 'proxy-secret';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function createCredentialStore(): CredentialStore {
  return {
    resolve: vi.fn(async () => 'mock-provider-key'),
  };
}

async function createProxyToken(overrides: Partial<Parameters<typeof mintProxyToken>[0]> = {}) {
  return mintProxyToken(
    {
      sub: 'workspace-1',
      aud: 'relay-llm-proxy',
      provider: 'openai',
      credentialId: 'cred-openai',
      ...overrides,
    },
    proxySecret
  );
}

describe('credential proxy router integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 for the health check', async () => {
    const app = createCredentialProxyApp({
      jwtSecret: proxySecret,
      credentialStore: createCredentialStore(),
    });

    const response = await app.request('http://localhost/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
    });
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('returns 401 when the request is missing a JWT', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const app = createCredentialProxyApp({
      jwtSecret: proxySecret,
      credentialStore: createCredentialStore(),
    });

    const response = await app.request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: 'missing_authorization',
      error: 'Missing bearer token',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 401 when the JWT is expired', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const app = createCredentialProxyApp({
      jwtSecret: proxySecret,
      credentialStore: createCredentialStore(),
    });
    const token = await createProxyToken({
      exp: Math.floor(Date.now() / 1000) - 60,
    });

    const response = await app.request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: 'token_expired',
      error: 'Token expired',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 200 with the upstream body for a valid JWT and mocked provider', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.openai.com/v1/chat/completions');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toBeInstanceOf(Headers);
      expect((init?.headers as Headers).get('authorization')).toBe('Bearer mock-provider-key');

      return new Response(
        JSON.stringify({
          id: 'chatcmpl_123',
          object: 'chat.completion',
          model: 'gpt-4o-mini',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Hello back',
              },
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 8,
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const metering = new MeteringCollector();
    const app = createCredentialProxyApp({
      jwtSecret: proxySecret,
      metering,
      credentialStore: createCredentialStore(),
    });
    const token = await createProxyToken();

    const response = await app.request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: 'chatcmpl_123',
      object: 'chat.completion',
      model: 'gpt-4o-mini',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello back',
          },
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 8,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(metering.getTotalUsage()).toEqual({
      inputTokens: 12,
      outputTokens: 8,
      requests: 1,
    });
  });

  it('forwards streaming chunks correctly', async () => {
    let releaseFinalChunk: (() => void) | undefined;
    const finalChunkReleased = new Promise<void>((resolve) => {
      releaseFinalChunk = resolve;
    });

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });

      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n'));
            await finalChunkReleased;
            controller.enqueue(
              encoder.encode(
                'data: {"model":"gpt-4o-mini","usage":{"prompt_tokens":9,"completion_tokens":4}}\n\n'
              )
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          },
        }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = createCredentialProxyApp({
      jwtSecret: proxySecret,
      metering: new MeteringCollector(),
      credentialStore: createCredentialStore(),
    });
    const token = await createProxyToken();

    const response = await app.request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const firstChunk = await reader!.read();
    expect(firstChunk.done).toBe(false);
    expect(decoder.decode(firstChunk.value)).toContain('"hel"');

    releaseFinalChunk?.();

    let streamedBody = decoder.decode(firstChunk.value);
    while (true) {
      const chunk = await reader!.read();
      if (chunk.done) {
        break;
      }

      streamedBody += decoder.decode(chunk.value);
    }

    expect(streamedBody).toContain('"prompt_tokens":9');
    expect(streamedBody).toContain('[DONE]');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('records metering only after the streaming response completes', async () => {
    const metering = new MeteringCollector();
    let releaseFinalChunk: (() => void) | undefined;
    const finalChunkReleased = new Promise<void>((resolve) => {
      releaseFinalChunk = resolve;
    });

    const fetchMock = vi.fn(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n'));
            await finalChunkReleased;
            controller.enqueue(
              encoder.encode(
                'data: {"model":"gpt-4o-mini","usage":{"prompt_tokens":11,"completion_tokens":6}}\n\n'
              )
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
          },
        }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = createCredentialProxyApp({
      jwtSecret: proxySecret,
      metering,
      credentialStore: createCredentialStore(),
    });
    const token = await createProxyToken();

    const response = await app.request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    });

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const firstChunk = await reader!.read();
    expect(firstChunk.done).toBe(false);
    expect(metering.getTotalUsage()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      requests: 0,
    });

    releaseFinalChunk?.();

    while (true) {
      const chunk = await reader!.read();
      if (chunk.done) {
        break;
      }
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(metering.getTotalUsage()).toEqual({
      inputTokens: 11,
      outputTokens: 6,
      requests: 1,
    });
  });

  it('blocks requests that are already over budget', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const metering = new MeteringCollector();
    metering.record({
      requestId: 'req-existing',
      workspaceId: 'workspace-1',
      provider: 'openai',
      credentialId: 'cred-openai',
      endpoint: '/v1/chat/completions',
      model: 'gpt-4o-mini',
      inputTokens: 15,
      outputTokens: 10,
      totalTokens: 25,
      timestamp: '2026-04-10T18:00:00.000Z',
      durationMs: 25,
    });

    const app = createCredentialProxyApp({
      jwtSecret: proxySecret,
      metering,
      credentialStore: createCredentialStore(),
    });
    const token = await createProxyToken({
      budget: 20,
    });

    const response = await app.request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      code: 'budget_exceeded',
      error: 'Token budget exceeded',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(metering.getTotalUsage()).toEqual({
      inputTokens: 15,
      outputTokens: 10,
      requests: 1,
    });
  });
});
