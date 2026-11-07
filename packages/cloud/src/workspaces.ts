import { authorizedApiFetch, ensureAuthenticated, ensureCloudSession, readStoredAuth } from './auth.js';
import { redactCredentialValues } from './redact.js';
import {
  type ActiveWorkspaceDescriptor,
  type ActiveWorkspaceUrls,
  defaultApiUrl,
  type WorkspaceCreateResponse,
  type WorkspaceJoinResponse,
  type WorkspaceTokenIssueResponse,
  type WorkspaceTokenRecord,
} from './types.js';
import { resolveActiveWorkspaceEntry, setWorkspaceKey } from './workspace-store.js';

type WorkspaceClientOptions = {
  apiUrl?: string;
};

type InteractiveRequestOptions = WorkspaceClientOptions & {
  interactive?: boolean;
  refreshTimeoutMs?: number;
};

/**
 * Stable synthetic agent identity used only to mint a `relaycastApiKey` for an
 * already-owned workspace during self-heal (see `joinWorkspace` / the
 * resolve fallback below) — not a real running agent, so it's fine for this
 * to be shared across a machine's self-heal attempts.
 */
const SELF_HEAL_AGENT_NAME = 'cli-workspace-self-heal';

/**
 * Thrown only for a genuine non-2xx HTTP response from the workspace resolve
 * endpoint itself (e.g. 401/403 on a rotated/invalid key) — distinguishes
 * "the key doesn't resolve" (self-healable) from a transient transport,
 * authentication, or response-schema error (NOT self-healable: minting a new
 * key and overwriting the local store on a network blip or malformed
 * response could churn a perfectly valid key). Only this error type is
 * treated as self-healable in `resolveActiveWorkspace`.
 */
class WorkspaceResolveHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceResolveHttpError';
  }
}

type WorkspaceTokenIssueOptions = WorkspaceClientOptions & {
  name?: string;
};

type ResolveActiveWorkspaceOptions = WorkspaceClientOptions & {
  interactive?: boolean;
  refreshTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

type JsonRecord = Record<string, unknown>;

function isObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readString(payload: JsonRecord, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringAny(payload: JsonRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readString(payload, key);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function readBoolean(payload: JsonRecord, key: string): boolean | undefined {
  const value = payload[key];
  return typeof value === 'boolean' ? value : undefined;
}

function buildEndpointError(action: string, endpoint: string, response: Response, payload: unknown): Error {
  const detail = isObject(payload)
    ? (readString(payload, 'error') ??
      readString(payload, 'message') ??
      readString(payload, 'detail') ??
      response.statusText)
    : response.statusText;

  return new Error(
    redactCredentialValues(`${action} failed at ${endpoint}: ${response.status} ${detail}`.trim())
  );
}

function normalizeWorkspaceCreateResponse(payload: unknown): WorkspaceCreateResponse {
  if (!isObject(payload)) {
    throw new Error('Workspace create response was not valid JSON.');
  }

  const workspaceId = readString(payload, 'workspaceId') ?? readString(payload, 'id');
  if (!workspaceId) {
    throw new Error('Workspace create response is missing workspaceId.');
  }

  return {
    workspaceId,
    ...(readString(payload, 'name') ? { name: readString(payload, 'name') } : {}),
    ...(readString(payload, 'relaycastApiKey')
      ? { relaycastApiKey: readString(payload, 'relaycastApiKey') }
      : {}),
    ...(readString(payload, 'relayfileUrl') ? { relayfileUrl: readString(payload, 'relayfileUrl') } : {}),
    ...(readString(payload, 'relaycronUrl') ? { relaycronUrl: readString(payload, 'relaycronUrl') } : {}),
    ...(readString(payload, 'relaycastUrl') ? { relaycastUrl: readString(payload, 'relaycastUrl') } : {}),
    ...(readString(payload, 'relayauthUrl') ? { relayauthUrl: readString(payload, 'relayauthUrl') } : {}),
    ...(readString(payload, 'joinCommand') ? { joinCommand: readString(payload, 'joinCommand') } : {}),
    ...(readString(payload, 'createdAt') ? { createdAt: readString(payload, 'createdAt') } : {}),
  };
}

function normalizeWorkspaceTokenRecord(
  payload: unknown,
  fallbackWorkspaceId: string
): WorkspaceTokenRecord | undefined {
  if (!isObject(payload)) {
    return undefined;
  }

  const workspaceId = readString(payload, 'workspaceId') ?? fallbackWorkspaceId;
  const kind = readString(payload, 'kind') ?? 'workspace_token';
  const prefix = readString(payload, 'prefix');
  const id = readString(payload, 'id');
  const name = readString(payload, 'name');
  const createdAt = readString(payload, 'createdAt');
  const updatedAt = readString(payload, 'updatedAt');

  return {
    workspaceId,
    kind,
    ...(prefix ? { prefix } : {}),
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function normalizeWorkspaceTokenIssueResponse(
  payload: unknown,
  fallbackWorkspaceId: string
): WorkspaceTokenIssueResponse {
  if (!isObject(payload)) {
    throw new Error('Workspace token response was not valid JSON.');
  }

  const key = readString(payload, 'key') ?? readString(payload, 'token');
  if (!key) {
    throw new Error('Workspace token response is missing key.');
  }

  const workspaceToken = normalizeWorkspaceTokenRecord(payload.workspaceToken, fallbackWorkspaceId);
  return {
    key,
    ...(workspaceToken ? { workspaceToken } : {}),
  };
}

function readUrls(payload: JsonRecord): ActiveWorkspaceUrls {
  const rawUrls = payload.urls;
  const urls: ActiveWorkspaceUrls = {};

  if (isObject(rawUrls)) {
    for (const [key, value] of Object.entries(rawUrls)) {
      if (typeof value === 'string' && value.trim()) {
        urls[key] = value.trim();
      }
    }
  }

  for (const key of ['relayfileUrl', 'relaycronUrl', 'relaycastUrl', 'relayauthUrl']) {
    const value = readString(payload, key);
    if (value) {
      urls[key] = value;
    }
  }

  return urls;
}

function normalizeActiveWorkspaceDescriptor(
  payload: unknown,
  fallbackKey: string,
  apiUrl: string
): ActiveWorkspaceDescriptor {
  if (!isObject(payload)) {
    throw new Error('Active workspace response was not valid JSON.');
  }

  const workspace = isObject(payload.workspace) ? payload.workspace : payload;
  const key = readStringAny(workspace, ['key', 'workspaceKey', 'relaycastApiKey']) ?? fallbackKey;
  const cloudWorkspaceId = readStringAny(workspace, ['cloudWorkspaceId', 'workspaceId', 'id']);
  const relaycastWorkspaceId = readStringAny(workspace, ['relaycastWorkspaceId']);
  const relayfileWorkspaceId = readStringAny(workspace, ['relayfileWorkspaceId']);
  const relayauthWorkspaceId = readStringAny(workspace, ['relayauthWorkspaceId']);

  if (!cloudWorkspaceId) {
    throw new Error('Active workspace response is missing cloudWorkspaceId.');
  }
  if (!relaycastWorkspaceId) {
    throw new Error('Active workspace response is missing relaycastWorkspaceId.');
  }
  if (!relayfileWorkspaceId) {
    throw new Error('Active workspace response is missing relayfileWorkspaceId.');
  }
  if (!relayauthWorkspaceId) {
    throw new Error('Active workspace response is missing relayauthWorkspaceId.');
  }

  return {
    ...(readString(workspace, 'name') ? { name: readString(workspace, 'name') } : {}),
    key,
    cloudWorkspaceId,
    relaycastWorkspaceId,
    ...(readString(workspace, 'relaycastApiKey')
      ? {
          relaycastApiKey: readString(workspace, 'relaycastApiKey'),
        }
      : {}),
    relayfileWorkspaceId,
    relayauthWorkspaceId,
    ...(readStringAny(workspace, ['organizationId', 'organization_id'])
      ? {
          organizationId: readStringAny(workspace, ['organizationId', 'organization_id']),
        }
      : {}),
    ...(readString(workspace, 'slug') ? { slug: readString(workspace, 'slug') } : {}),
    urls: readUrls(workspace),
    apiUrl,
    ...(readBoolean(workspace, 'provisioned') !== undefined
      ? {
          provisioned: readBoolean(workspace, 'provisioned'),
        }
      : {}),
  };
}

async function tryPostJson(
  endpoint: string,
  body: Record<string, unknown>,
  options: InteractiveRequestOptions
): Promise<{ response: Response; payload: unknown }> {
  const apiUrl = options.apiUrl || defaultApiUrl();
  const auth = await ensureAuthenticated(apiUrl, {
    interactive: options.interactive,
    refreshTimeoutMs: options.refreshTimeoutMs,
  });
  const { response } = await authorizedApiFetch(
    auth,
    endpoint,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
    {
      interactive: options.interactive,
      refreshTimeoutMs: options.refreshTimeoutMs,
    }
  );

  return {
    response,
    payload: await readJson(response),
  };
}

async function tryGetJson(
  endpoint: string,
  options: WorkspaceClientOptions & { refreshTimeoutMs?: number; interactive?: boolean }
): Promise<{ response: Response; payload: unknown; apiUrl: string }> {
  const apiUrl = options.apiUrl || defaultApiUrl();
  const auth = await ensureAuthenticated(apiUrl, {
    interactive: options.interactive,
    refreshTimeoutMs: options.refreshTimeoutMs,
  });
  const { response } = await authorizedApiFetch(
    auth,
    endpoint,
    {
      method: 'GET',
    },
    {
      interactive: options.interactive,
      refreshTimeoutMs: options.refreshTimeoutMs,
    }
  );

  return {
    response,
    payload: await readJson(response),
    apiUrl: auth.apiUrl,
  };
}

export async function createWorkspace(
  name: string,
  options: WorkspaceClientOptions = {}
): Promise<WorkspaceCreateResponse> {
  const requestedName = name.trim();
  if (!requestedName) {
    throw new Error('Workspace name is required.');
  }

  const body = {
    name: requestedName,
    workspaceId: requestedName,
  };

  const endpoints = ['/api/v1/workspaces/create', '/api/v1/workspaces'];
  let lastUnsupported: Error | null = null;

  for (const endpoint of endpoints) {
    const { response, payload } = await tryPostJson(endpoint, body, options);

    if (response.status === 404 || response.status === 405) {
      lastUnsupported = buildEndpointError('Workspace create', endpoint, response, payload);
      continue;
    }

    if (!response.ok) {
      throw buildEndpointError('Workspace create', endpoint, response, payload);
    }

    return normalizeWorkspaceCreateResponse(payload);
  }

  throw lastUnsupported ?? new Error('Workspace create is not supported by the configured cloud API.');
}

export async function issueWorkspaceToken(
  workspace: string,
  options: WorkspaceTokenIssueOptions = {}
): Promise<WorkspaceTokenIssueResponse> {
  const workspaceId = workspace.trim();
  if (!workspaceId) {
    throw new Error('Workspace is required.');
  }

  const body = {
    workspaceId,
    name: options.name?.trim() || `workspace:${workspaceId}`,
  };

  const encodedWorkspaceId = encodeURIComponent(workspaceId);
  const endpoints = [
    `/api/v1/workspaces/${encodedWorkspaceId}/tokens/workspace`,
    `/api/v1/workspaces/${encodedWorkspaceId}/workspace-token`,
    `/api/v1/workspaces/${encodedWorkspaceId}/token`,
  ];
  let lastUnsupported: Error | null = null;

  for (const endpoint of endpoints) {
    const { response, payload } = await tryPostJson(endpoint, body, options);

    if (response.status === 404 || response.status === 405) {
      lastUnsupported = buildEndpointError('Workspace token issue', endpoint, response, payload);
      continue;
    }

    if (!response.ok) {
      throw buildEndpointError('Workspace token issue', endpoint, response, payload);
    }

    return normalizeWorkspaceTokenIssueResponse(payload, workspaceId);
  }

  throw (
    lastUnsupported ?? new Error('Workspace token issuance is not supported by the configured cloud API.')
  );
}

function assertWorkspaceResolverTransport(apiUrl: string): void {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error('Project workspace resolution requires a valid Cloud API URL.');
  }
  if (url.username || url.password || url.protocol !== 'https:') {
    throw new Error('Project workspace resolution requires HTTPS.');
  }
}

/** Resolve a selected project pin without exposing its key in URLs or changing the active workspace. */
export async function resolveWorkspaceByKey(
  workspaceKey: string,
  options: ResolveActiveWorkspaceOptions = {}
): Promise<ActiveWorkspaceDescriptor> {
  const key = workspaceKey.trim();
  if (!/^(rk_live_|ar_ws_)[A-Za-z0-9_-]{1,512}$/.test(key))
    throw new Error('A valid workspace key is required.');
  const env = options.env ?? process.env;
  const apiUrl = options.apiUrl || defaultApiUrl(env);
  assertWorkspaceResolverTransport(apiUrl);
  // Stored sessions keep their own API host; validate it before a refresh can
  // send credentials, even when the requested/default host is secure.
  const stored = await readStoredAuth(env);
  if (stored) assertWorkspaceResolverTransport(stored.apiUrl);
  const { auth } = await ensureCloudSession({
    apiUrl,
    interactive: false,
    refreshTimeoutMs: options.refreshTimeoutMs,
    env,
    validateApiUrl: assertWorkspaceResolverTransport,
  });
  assertWorkspaceResolverTransport(auth.apiUrl);
  const endpoint = '/api/v1/workspaces/current/resolve';
  const { response } = await authorizedApiFetch(
    auth,
    endpoint,
    {
      method: 'POST',
      redirect: 'error',
      body: JSON.stringify({ workspaceKey: key }),
      signal: AbortSignal.timeout(options.refreshTimeoutMs ?? 30_000),
    },
    {
      interactive: false,
      env,
      validateApiUrl: assertWorkspaceResolverTransport,
    }
  );
  const payload = await readJson(response);
  if (!response.ok) throw buildEndpointError('Project workspace resolve', endpoint, response, payload);
  // Unlike the legacy active-workspace resolver, this endpoint is an
  // attestation for a specific project pin. A response that omits the echoed
  // key must fail closed rather than being filled in from the request.
  const resolved = normalizeActiveWorkspaceDescriptor(payload, '', auth.apiUrl);
  if (resolved.key !== key)
    throw new Error('Cloud resolved a different workspace credential than the selected project pin.');
  return resolved;
}

type ResolveDescriptorResult =
  { descriptor: ActiveWorkspaceDescriptor } | { lastUnsupported: Error | null; sawMethodNotAllowed: boolean };

async function resolveWorkspaceDescriptor(
  key: string,
  options: ResolveActiveWorkspaceOptions
): Promise<ResolveDescriptorResult> {
  const encodedKey = encodeURIComponent(key);
  const endpoints = [
    `/api/v1/workspaces/${encodedKey}/resolve`,
    `/api/v1/workspaces/resolve?key=${encodedKey}`,
    `/api/v1/workspaces/active?key=${encodedKey}`,
  ];
  let lastUnsupported: Error | null = null;
  let sawMethodNotAllowed = false;

  for (const endpoint of endpoints) {
    const { response, payload, apiUrl } = await tryGetJson(endpoint, {
      apiUrl: options.apiUrl,
      interactive: options.interactive ?? false,
      refreshTimeoutMs: options.refreshTimeoutMs,
    });

    if (response.status === 404 || response.status === 405) {
      sawMethodNotAllowed ||= response.status === 405;
      lastUnsupported = buildEndpointError('Workspace resolve', endpoint, response, payload);
      continue;
    }

    if (!response.ok) {
      throw new WorkspaceResolveHttpError(
        buildEndpointError('Workspace resolve', endpoint, response, payload).message
      );
    }

    return { descriptor: normalizeActiveWorkspaceDescriptor(payload, key, apiUrl) };
  }

  return { lastUnsupported, sawMethodNotAllowed };
}

/**
 * Join a workspace the caller already owns/belongs to (by its canonical Cloud
 * workspace id) via the session-authenticated `/join` endpoint, returning a
 * fresh `relaycastApiKey` for that SAME workspace. Unlike `createWorkspace`,
 * this never mints a new workspace — see AgentWorkforce/relay#1260.
 */
export async function joinWorkspace(
  workspaceId: string,
  options: InteractiveRequestOptions = {}
): Promise<WorkspaceJoinResponse> {
  const trimmedId = workspaceId.trim();
  if (!trimmedId) {
    throw new Error('Workspace id is required.');
  }

  const endpoint = `/api/v1/workspaces/${encodeURIComponent(trimmedId)}/join`;
  const { response, payload } = await tryPostJson(endpoint, { agentName: SELF_HEAL_AGENT_NAME }, options);

  if (!response.ok) {
    throw buildEndpointError('Workspace join', endpoint, response, payload);
  }
  if (!isObject(payload)) {
    throw new Error('Workspace join response was not valid JSON.');
  }

  const relaycastApiKey = readString(payload, 'relaycastApiKey');
  if (!relaycastApiKey) {
    throw new Error('Workspace join response is missing relaycastApiKey.');
  }

  return {
    workspaceId: readString(payload, 'workspaceId') ?? trimmedId,
    relaycastApiKey,
  };
}

export async function resolveActiveWorkspace(
  options: ResolveActiveWorkspaceOptions = {}
): Promise<ActiveWorkspaceDescriptor> {
  const active = resolveActiveWorkspaceEntry(options.env);
  if (!active) {
    throw new Error(
      'No active Agent Relay workspace found. Run `agent-relay workspace set_key <name> <key>` or `agent-relay workspace join <name> <key>`.'
    );
  }
  const { name, entry } = active;

  // A non-404/405 HTTP failure from the resolve endpoint itself (e.g. 401/403
  // from a rotated/invalid key) throws a WorkspaceResolveHttpError out of
  // resolveWorkspaceDescriptor instead of returning `{ lastUnsupported }` —
  // catch ONLY that typed error and fold it into the same shape so self-heal
  // below still gets a chance. Any other error (network/transport failure,
  // ensureAuthenticated/session failure, malformed-response schema error from
  // normalizeActiveWorkspaceDescriptor) is NOT a "this key doesn't resolve"
  // signal — rethrow it unchanged so a transient blip can't mint a new key
  // and overwrite a perfectly valid one.
  const primary = await resolveWorkspaceDescriptor(entry.key, options).catch(
    (err: unknown): ResolveDescriptorResult => {
      if (err instanceof WorkspaceResolveHttpError) {
        return { lastUnsupported: err, sawMethodNotAllowed: false };
      }
      throw err;
    }
  );
  if ('descriptor' in primary) {
    // Opportunistically cache the resolved cloud workspace id (if new/changed)
    // so a future rotated/orphaned key can self-heal below without the caller
    // ever having to remember or re-supply it.
    if (
      primary.descriptor.cloudWorkspaceId &&
      primary.descriptor.cloudWorkspaceId !== entry.cloudWorkspaceId
    ) {
      setWorkspaceKey(name, entry.key, options.env, primary.descriptor.cloudWorkspaceId);
    }
    return primary.descriptor;
  }

  // Self-heal: the stored key no longer resolves (rotated server-side, or
  // orphaned by the AgentWorkforce/relay#1260 `workspace create` bug), but this
  // alias previously resolved to a known Cloud workspace id. Re-mint a working
  // key for that SAME workspace via the session-authenticated join endpoint
  // (this never creates a new workspace) and retry once. Best-effort: any
  // failure here (no session, no longer a member, etc.) falls through to the
  // original resolve error so the failure mode is unchanged from before.
  // A 405 says the configured API has a different shape, not that this key
  // stopped resolving, so it is no reason to re-mint and overwrite the key.
  if (entry.cloudWorkspaceId && !primary.sawMethodNotAllowed) {
    try {
      const joined = await joinWorkspace(entry.cloudWorkspaceId, {
        apiUrl: options.apiUrl,
        interactive: options.interactive ?? false,
        refreshTimeoutMs: options.refreshTimeoutMs,
      });
      setWorkspaceKey(name, joined.relaycastApiKey, options.env, joined.workspaceId);
      const healed = await resolveWorkspaceDescriptor(joined.relaycastApiKey, options);
      if ('descriptor' in healed) {
        return healed.descriptor;
      }
    } catch {
      // fall through
    }
  }

  // Self-heal did not apply or did not help: report the original failure.
  // A non-404 HTTP error is rethrown as-is; the 404/405 diagnosis below is
  // unchanged from before self-heal existed.
  const { lastUnsupported, sawMethodNotAllowed } = primary;
  if (lastUnsupported instanceof WorkspaceResolveHttpError) {
    throw lastUnsupported;
  }
  if (!lastUnsupported) {
    throw new Error('Workspace resolution is not supported by the configured cloud API.');
  }
  if (sawMethodNotAllowed) {
    // A 405 is an API-shape signal, not evidence about the workspace — don't
    // steer the user toward a provisioning diagnosis that may be wrong.
    throw lastUnsupported;
  }
  throw new Error(
    `${lastUnsupported.message} — the active workspace has no record on the cloud API; a messaging-only workspace (minted by \`node up\` without cloud provisioning) resolves only through Relaycast.`
  );
}
