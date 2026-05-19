/**
 * Global fetch interceptor that stamps `X-Relaycast-Harness` on every
 * outgoing request to a relaycast host.
 *
 * Why a global interceptor:
 *   The `@relaycast/sdk` HTTP client builds its own header set internally
 *   (Authorization + the three `X-Relaycast-Origin-*` fields) and doesn't
 *   expose a hook for adding arbitrary headers. Rather than fork the SDK
 *   or duplicate every API surface, we patch `globalThis.fetch` to merge
 *   in our header on requests to relaycast hosts.
 *
 *   The patch is host-scoped and additive: requests to non-relaycast hosts
 *   pass through unchanged, and any existing `X-Relaycast-Harness` value
 *   the caller provided wins. We install at most once per process.
 *
 *   The relaycast server side (parallel PR) reads this header and stamps
 *   it on every server-side event.
 */

import { detectHarness } from '@agent-relay/telemetry';

const RELAYCAST_HARNESS_HEADER = 'X-Relaycast-Harness';

/** Hosts we tag with the harness header — keep the surface small. */
const RELAYCAST_HOST_RE = /(?:^|\.)relaycast\.dev$/i;

let installed = false;

function isRelaycastUrl(url: string | URL | Request): boolean {
  try {
    let urlStr: string;
    if (url instanceof URL) {
      urlStr = url.toString();
    } else if (typeof url === 'string') {
      urlStr = url;
    } else if (typeof Request !== 'undefined' && url instanceof Request) {
      urlStr = url.url;
    } else {
      return false;
    }
    // Support both absolute URLs and URLs without a scheme.
    const parsed = new URL(urlStr);
    return RELAYCAST_HOST_RE.test(parsed.hostname);
  } catch {
    return false;
  }
}

function mergeHeaders(
  existing: ConstructorParameters<typeof Headers>[0] | undefined,
  harness: string
): Headers {
  const headers = new Headers(existing ?? undefined);
  // Don't overwrite a caller-provided value — they may have a legitimate
  // reason to override (e.g. tests, proxies).
  if (!headers.has(RELAYCAST_HARNESS_HEADER)) {
    headers.set(RELAYCAST_HARNESS_HEADER, harness);
  }
  return headers;
}

/**
 * Install the global fetch interceptor. Safe to call multiple times — only
 * the first call takes effect. No-op if `globalThis.fetch` isn't available
 * (very old Node, or an environment that's stubbed it out).
 */
export function installRelaycastFetchInterceptor(): void {
  if (installed) return;
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== 'function') return;

  installed = true;
  const harness = detectHarness();

  const patched: typeof fetch = async (input, init) => {
    // Fast path: not a relaycast URL — skip header merge entirely.
    if (!isRelaycastUrl(input)) {
      return originalFetch(input, init);
    }

    // Two shapes to handle: `Request` instances carry their own headers,
    // and the `init.headers` overlay.
    if (typeof Request !== 'undefined' && input instanceof Request) {
      const merged = mergeHeaders(input.headers, harness);
      // Build a new Request with merged headers; the caller's `init`
      // overlay still applies.
      const overlayHeaders = init?.headers ? mergeHeaders(init.headers, harness) : merged;
      return originalFetch(new Request(input, { ...init, headers: overlayHeaders }));
    }

    const headers = mergeHeaders(init?.headers, harness);
    return originalFetch(input, { ...(init ?? {}), headers });
  };

  globalThis.fetch = patched;
}

/** Reset state for tests. Production code should never need this. */
export function resetRelaycastFetchInterceptorForTests(): void {
  installed = false;
}
