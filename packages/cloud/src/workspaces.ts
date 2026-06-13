import { authorizedApiFetch, ensureAuthenticated } from './auth.js';
import {
  type ActiveWorkspaceDescriptor,
  type ActiveWorkspaceUrls,
  defaultApiUrl,
  type WorkspaceCreateResponse,
  type WorkspaceTokenIssueResponse,
  type WorkspaceTokenRecord,
} from './types.js';
import { resolveActiveWorkspaceKey } from './workspace-store.js';

type WorkspaceClientOptions = {
  apiUrl?: string;
};

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

  return new Error(`${action} failed at ${endpoint}: ${response.status} ${detail}`.trim());
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
  options: WorkspaceClientOptions
): Promise<{ response: Response; payload: unknown }> {
  const apiUrl = options.apiUrl || defaultApiUrl();
  const auth = await ensureAuthenticated(apiUrl);
  const { response } = await authorizedApiFetch(auth, endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
  });

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

export async function resolveActiveWorkspace(
  options: ResolveActiveWorkspaceOptions = {}
): Promise<ActiveWorkspaceDescriptor> {
  const key = resolveActiveWorkspaceKey(options.env);
  if (!key) {
    throw new Error(
      'No active Agent Relay workspace found. Run `agent-relay workspace set_key <name> <key>` or `agent-relay workspace join <name> <key>`.'
    );
  }

  const encodedKey = encodeURIComponent(key);
  const endpoints = [
    `/api/v1/workspaces/${encodedKey}/resolve`,
    `/api/v1/workspaces/resolve?key=${encodedKey}`,
    `/api/v1/workspaces/active?key=${encodedKey}`,
  ];
  let lastUnsupported: Error | null = null;

  for (const endpoint of endpoints) {
    const { response, payload, apiUrl } = await tryGetJson(endpoint, {
      apiUrl: options.apiUrl,
      interactive: options.interactive ?? false,
      refreshTimeoutMs: options.refreshTimeoutMs,
    });

    if (response.status === 404 || response.status === 405) {
      lastUnsupported = buildEndpointError('Workspace resolve', endpoint, response, payload);
      continue;
    }

    if (!response.ok) {
      throw buildEndpointError('Workspace resolve', endpoint, response, payload);
    }

    return normalizeActiveWorkspaceDescriptor(payload, key, apiUrl);
  }

  throw lastUnsupported ?? new Error('Workspace resolution is not supported by the configured cloud API.');
}
