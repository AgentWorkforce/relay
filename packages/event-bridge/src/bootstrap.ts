import { defaultApiUrl, readStoredAuth, refreshStoredAuth, type StoredAuth } from '@agent-relay/cloud';

/** Gateway connection details discovered from cloud for a workspace. */
export interface GatewayAccess {
  /** Canonical relay workspace id the gateway expects. */
  workspaceId: string;
  /** WebSocket URL of the deployed agent-events gateway. */
  gatewayUrl: string;
  /** Scoped token for the gateway + relayfile writes. */
  apiKey: string;
}

/** Options for {@link bootstrapGatewayAccess}. */
export interface BootstrapOptions {
  /** Workspace name or id (passed to cloud's bootstrap endpoint). */
  workspace: string;
  /** Cloud API base URL. Defaults to the stored login's apiUrl, then {@link defaultApiUrl}. */
  apiUrl?: string;
  /** Injectable fetch + auth reader for testing. */
  fetchImpl?: typeof fetch;
  readAuth?: typeof readStoredAuth;
  refreshAuth?: typeof refreshStoredAuth;
}

const REFRESH_BEFORE_MS = 60_000;

/**
 * Discover the agent-events gateway URL and a scoped token for a workspace by
 * calling cloud's bootstrap endpoint with the operator's stored cloud login —
 * the same path cloud's own hosted agents use. Reuses the deployed cloud; runs
 * nothing locally.
 *
 * @throws if not logged in, or the endpoint rejects the request.
 */
export async function bootstrapGatewayAccess(options: BootstrapOptions): Promise<GatewayAccess> {
  const readAuth = options.readAuth ?? readStoredAuth;
  const refreshAuth = options.refreshAuth ?? refreshStoredAuth;
  const fetchImpl = options.fetchImpl ?? fetch;

  const stored = await readAuth();
  if (!stored) {
    throw new Error(
      'Not logged in to Agent Relay Cloud. Run `agent-relay login` (or set CLOUD_API_* env vars) first.'
    );
  }

  const auth = (await maybeRefresh(stored, refreshAuth)) ?? stored;
  const apiUrl = options.apiUrl ?? auth.apiUrl ?? defaultApiUrl();
  const endpoint = joinUrl(
    apiUrl,
    `/api/v1/workspaces/${encodeURIComponent(options.workspace)}/agent-events`
  );

  const response = await fetchImpl(endpoint, {
    headers: { authorization: `Bearer ${auth.accessToken}` },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Gateway bootstrap failed: ${response.status} ${response.statusText} (${endpoint})${
        detail ? ` — ${detail.slice(0, 200)}` : ''
      }`
    );
  }

  const body = (await response.json().catch(() => null)) as {
    workspaceId?: string;
    gatewayUrl?: string;
    apiKey?: string;
  } | null;
  if (!body?.gatewayUrl || !body.apiKey) {
    throw new Error('Gateway bootstrap response missing gatewayUrl/apiKey');
  }

  return {
    workspaceId: body.workspaceId ?? options.workspace,
    gatewayUrl: body.gatewayUrl,
    apiKey: body.apiKey,
  };
}

async function maybeRefresh(
  auth: StoredAuth,
  refreshAuth: typeof refreshStoredAuth
): Promise<StoredAuth | null> {
  const expiresAt = Date.parse(auth.accessTokenExpiresAt);
  if (Number.isNaN(expiresAt) || expiresAt - Date.now() > REFRESH_BEFORE_MS) {
    return auth;
  }
  try {
    return await refreshAuth(auth);
  } catch {
    // Fall back to the existing token; a 401 from the endpoint will guide the user.
    return auth;
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}
