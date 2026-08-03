/**
 * Observer dashboard URL construction, shared by the `observer` command group
 * and the `get_observer_url` MCP tool so both produce identical links.
 *
 * The credential rides in the `?key=` query string because that is what the
 * observer dashboard reads. That is precisely why the value must always be a
 * scoped, read-only `ot_live_` token and never a workspace key: query strings
 * land in browser history, referrer headers, and proxy logs.
 */

/** Where the hosted observer dashboard lives. */
export const DEFAULT_OBSERVER_URL = 'https://agentrelay.com/observer';

/** Default token lifetime for a link meant to be pasted into chat. */
export const DEFAULT_OBSERVER_EXPIRES = '24h';

/**
 * Resolve the observer dashboard base URL: explicit flag, then
 * `RELAY_OBSERVER_URL` (for self-hosted or staging dashboards), then the
 * hosted default.
 *
 * @param explicit - Value passed on the command line, if any
 * @param env - Environment to read `RELAY_OBSERVER_URL` from
 * @returns A validated absolute URL
 */
export function resolveObserverBaseUrl(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string {
  const value = explicit?.trim() || env.RELAY_OBSERVER_URL?.trim() || DEFAULT_OBSERVER_URL;
  try {
    // Fail here rather than emitting a malformed link the caller only discovers
    // after pasting it somewhere public.
    new URL(value);
  } catch {
    throw new Error(`Invalid observer URL: ${value}`);
  }
  return value;
}

/**
 * Build the observer URL for a token.
 *
 * @param baseUrl - Observer dashboard base URL
 * @param token - Scoped `ot_live_` observer token
 * @returns The full observer URL
 */
export function observerUrl(baseUrl: string, token: string): string {
  if (!token.startsWith('ot_live_')) {
    // A workspace key in this position would be an administrative credential in
    // a shareable URL — the exact failure this command exists to prevent.
    throw new Error('Observer URLs require a scoped observer token (ot_live_...).');
  }
  const url = new URL(baseUrl);
  url.searchParams.set('key', token);
  return url.toString();
}
