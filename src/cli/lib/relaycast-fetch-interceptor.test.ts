/**
 * Tests for the global relaycast fetch interceptor.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installRelaycastFetchInterceptor,
  resetRelaycastFetchInterceptorForTests,
} from './relaycast-fetch-interceptor.js';
import { resetHarnessCacheForTests, HARNESS_ENV_VAR } from '@agent-relay/telemetry';

describe('installRelaycastFetchInterceptor', () => {
  const originalFetch = globalThis.fetch;
  const originalHarness = process.env[HARNESS_ENV_VAR];

  beforeEach(() => {
    resetRelaycastFetchInterceptorForTests();
    resetHarnessCacheForTests();
    process.env[HARNESS_ENV_VAR] = 'claude-code';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetRelaycastFetchInterceptorForTests();
    resetHarnessCacheForTests();
    if (originalHarness === undefined) {
      delete process.env[HARNESS_ENV_VAR];
    } else {
      process.env[HARNESS_ENV_VAR] = originalHarness;
    }
  });

  it('adds X-Relaycast-Harness header on requests to relaycast.dev', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    installRelaycastFetchInterceptor();

    await globalThis.fetch('https://api.relaycast.dev/v1/agents');

    const call = mockFetch.mock.calls[0];
    const init = call[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers ?? undefined);
    expect(headers.get('X-Relaycast-Harness')).toBe('claude-code');
  });

  it('does not add header on requests to non-relaycast hosts', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    installRelaycastFetchInterceptor();

    await globalThis.fetch('https://example.com/api');

    const call = mockFetch.mock.calls[0];
    const init = call[1] as RequestInit | undefined;
    if (init?.headers) {
      const headers = new Headers(init.headers);
      expect(headers.get('X-Relaycast-Harness')).toBeNull();
    }
  });

  it('preserves caller-provided X-Relaycast-Harness header', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    installRelaycastFetchInterceptor();

    await globalThis.fetch('https://api.relaycast.dev/v1/agents', {
      headers: { 'X-Relaycast-Harness': 'caller-override' },
    });

    const init = mockFetch.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers ?? undefined);
    expect(headers.get('X-Relaycast-Harness')).toBe('caller-override');
  });

  it('is idempotent — second install is a no-op', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    installRelaycastFetchInterceptor();
    const patchedOnce = globalThis.fetch;
    installRelaycastFetchInterceptor();
    expect(globalThis.fetch).toBe(patchedOnce);
  });

  it('handles Request objects as input', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    installRelaycastFetchInterceptor();

    const req = new Request('https://api.relaycast.dev/v1/agents');
    await globalThis.fetch(req);

    // The patched fetch reconstructs a Request — verify the call shape is
    // still a Request and carries the header.
    const callArg = mockFetch.mock.calls[0][0] as Request;
    expect(callArg).toBeInstanceOf(Request);
    expect(callArg.headers.get('X-Relaycast-Harness')).toBe('claude-code');
  });
});
