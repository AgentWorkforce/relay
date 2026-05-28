import { defaultApiUrl, readStoredAuth, refreshStoredAuth, type StoredAuth } from '@agent-relay/cloud';

/** Gateway connection details discovered from cloud for a workspace. */
export interface GatewayAccess {
  /** Canonical relay workspace id the gateway expects. */
  workspaceId: string;
  /** WebSocket URL of the deployed agent-events gateway. */
  gatewayUrl: string;
  /** Token scoped to the requested provider roots, for the gateway + writes. */
  apiKey: string;
}

/** Options for {@link bootstrapGatewayAccess}. */
export interface BootstrapOptions {
  /** Workspace name or id (passed to cloud's bootstrap endpoint). */
  workspace: string;
  /**
   * Relayfile scopes to mint the token with, e.g.
   * `['relayfile:fs:read:/slack/**', 'relayfile:fs:write:/slack/**']`. These
   * must cover every provider's watch + writeback paths, or the gateway will
   * not surface inbound events / accept reply writes.
   */
  scopes: string[];
  /** Provisioned gateway identity for the token. Defaults to `event-bridge`. */
  agentName?: string;
  /** Cloud API base URL. Defaults to the stored login's apiUrl, then {@link defaultApiUrl}. */
  apiUrl?: string;
  /** Injectable fetch + auth reader for testing. */
  fetchImpl?: typeof fetch;
  readAuth?: typeof readStoredAuth;
  refreshAuth?: typeof refreshStoredAuth;
}

const REFRESH_BEFORE_MS = 60_000;
const DEFAULT_BRIDGE_AGENT = 'event-bridge';

/**
 * Discover gateway access for a workspace by reusing the deployed cloud (runs
 * nothing locally). Two calls with the operator's stored cloud login:
 *
 *   1. `GET /api/v1/workspaces/<ws>/agent-events` → the deployed gateway URL +
 *      canonical workspace id.
 *   2. `POST /api/v1/agents/provision` → a token scoped to `options.scopes`
 *      (the provider roots, e.g. `/slack/**`).
 *
 * The config endpoint's own token is intentionally scoped to `/integrations/**`
 * and would not authorize `/slack/**`, so we provision a correctly-scoped token
 * instead and use the config endpoint only for the URL.
 *
 * @throws if not logged in, or either endpoint rejects the request.
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
  const authHeader = { authorization: `Bearer ${auth.accessToken}` };

  // 1. Gateway URL + canonical workspace id.
  const configUrl = joinUrl(
    apiUrl,
    `/api/v1/workspaces/${encodeURIComponent(options.workspace)}/agent-events`
  );
  const configResponse = await fetchImpl(configUrl, { headers: authHeader });
  await assertOk(configResponse, 'config', configUrl);
  const config = (await configResponse.json().catch(() => null)) as {
    workspaceId?: string;
    gatewayUrl?: string;
  } | null;
  if (!config?.gatewayUrl) {
    throw new Error('Gateway bootstrap response missing gatewayUrl');
  }
  const workspaceId = config.workspaceId ?? options.workspace;

  // 2. Provision a token scoped to the providers' roots (config token is /integrations/** only).
  const provisionUrl = joinUrl(apiUrl, '/api/v1/agents/provision');
  const provisionResponse = await fetchImpl(provisionUrl, {
    method: 'POST',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceId,
      agents: [{ name: options.agentName ?? DEFAULT_BRIDGE_AGENT, scopes: options.scopes }],
    }),
  });
  await assertOk(provisionResponse, 'provision', provisionUrl);
  const provision = (await provisionResponse.json().catch(() => null)) as {
    agents?: Array<{ token?: string }>;
  } | null;
  const apiKey = provision?.agents?.[0]?.token;
  if (!apiKey) {
    throw new Error('Gateway bootstrap provision response missing a token');
  }

  return { workspaceId, gatewayUrl: config.gatewayUrl, apiKey };
}

async function assertOk(response: Response, stage: string, url: string): Promise<void> {
  if (response.ok) {
    return;
  }
  const detail = await response.text().catch(() => '');
  throw new Error(
    `Gateway bootstrap failed (${stage}): ${response.status} ${response.statusText} (${url})${
      detail ? ` — ${detail.slice(0, 200)}` : ''
    }`
  );
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
