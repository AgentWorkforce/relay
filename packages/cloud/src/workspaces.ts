import { authorizedApiFetch, ensureAuthenticated } from './auth.js';
import {
  defaultApiUrl,
  type WorkspaceCreateResponse,
  type WorkspaceTokenIssueResponse,
  type WorkspaceTokenRecord,
} from './types.js';

type WorkspaceClientOptions = {
  apiUrl?: string;
};

type WorkspaceTokenIssueOptions = WorkspaceClientOptions & {
  name?: string;
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
