import { authorizedApiFetch, ensureAuthenticated } from './auth.js';
import {
  defaultApiUrl,
  type ProactiveAgentRecord,
  type ProactiveDeploymentResponse,
  type WorkspaceSecretRecord,
} from './types.js';

type ClientOptions = {
  apiUrl?: string;
};

type DeployOptions = ClientOptions & {
  name?: string;
  watch?: boolean;
};

type DeployInput = {
  entrypoint: string;
  source: string;
};

type SecretOptions = ClientOptions & {
  workspace: string;
};

type JsonRecord = Record<string, unknown>;

function isObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(payload: JsonRecord, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
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

function isUnsupported(response: Response): boolean {
  return response.status === 404 || response.status === 405 || response.status === 501;
}

async function tryRequest(
  method: 'GET' | 'POST' | 'DELETE',
  endpoint: string,
  options: ClientOptions,
  body?: Record<string, unknown>
): Promise<{ response: Response; payload: unknown }> {
  const apiUrl = options.apiUrl || defaultApiUrl();
  const auth = await ensureAuthenticated(apiUrl);
  const { response } = await authorizedApiFetch(auth, endpoint, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  return {
    response,
    payload: await readJson(response),
  };
}

function normalizeDeploymentResponse(payload: unknown): ProactiveDeploymentResponse {
  if (!isObject(payload)) {
    throw new Error('Deployment response was not valid JSON.');
  }

  return {
    ...(readString(payload, 'deploymentId') ? { deploymentId: readString(payload, 'deploymentId') } : {}),
    ...(readString(payload, 'agentId') ? { agentId: readString(payload, 'agentId') } : {}),
    ...(readString(payload, 'workspaceId') ? { workspaceId: readString(payload, 'workspaceId') } : {}),
    ...(readString(payload, 'status') ? { status: readString(payload, 'status') } : {}),
    ...(readString(payload, 'dashboardUrl') ? { dashboardUrl: readString(payload, 'dashboardUrl') } : {}),
    ...(readString(payload, 'logsUrl') ? { logsUrl: readString(payload, 'logsUrl') } : {}),
    ...payload,
  };
}

function normalizeAgentRecord(payload: unknown): ProactiveAgentRecord {
  if (!isObject(payload)) {
    throw new Error('Agent record was not valid JSON.');
  }

  const id =
    readString(payload, 'id') ??
    readString(payload, 'agentId') ??
    readString(payload, 'name') ??
    readString(payload, 'displayName');
  if (!id) {
    throw new Error('Agent record is missing id.');
  }

  return {
    id,
    ...(readString(payload, 'name') ? { name: readString(payload, 'name') } : {}),
    ...(readString(payload, 'displayName') ? { displayName: readString(payload, 'displayName') } : {}),
    ...(readString(payload, 'harness') ? { harness: readString(payload, 'harness') } : {}),
    ...(readString(payload, 'defaultModel') ? { defaultModel: readString(payload, 'defaultModel') } : {}),
    ...(readString(payload, 'status') ? { status: readString(payload, 'status') } : {}),
    ...(typeof payload.credentialStoredAt === 'string' || payload.credentialStoredAt === null
      ? { credentialStoredAt: payload.credentialStoredAt as string | null }
      : {}),
    ...(typeof payload.lastAuthenticatedAt === 'string' || payload.lastAuthenticatedAt === null
      ? { lastAuthenticatedAt: payload.lastAuthenticatedAt as string | null }
      : {}),
    ...(typeof payload.lastUsedAt === 'string' || payload.lastUsedAt === null
      ? { lastUsedAt: payload.lastUsedAt as string | null }
      : {}),
    ...(typeof payload.lastError === 'string' || payload.lastError === null
      ? { lastError: payload.lastError as string | null }
      : {}),
    ...(readString(payload, 'createdAt') ? { createdAt: readString(payload, 'createdAt') } : {}),
    ...(readString(payload, 'updatedAt') ? { updatedAt: readString(payload, 'updatedAt') } : {}),
    ...payload,
  };
}

function normalizeAgentList(payload: unknown): ProactiveAgentRecord[] {
  if (Array.isArray(payload)) {
    return payload.map((entry) => normalizeAgentRecord(entry));
  }

  if (isObject(payload) && Array.isArray(payload.agents)) {
    return payload.agents.map((entry) => normalizeAgentRecord(entry));
  }

  throw new Error('Agent list response did not include an agents array.');
}

function normalizeSecretRecord(payload: unknown, fallbackName?: string): WorkspaceSecretRecord {
  if (!isObject(payload)) {
    throw new Error('Secret response was not valid JSON.');
  }

  const name =
    readString(payload, 'name') ??
    readString(payload, 'secretName') ??
    readString(payload, 'key') ??
    fallbackName;
  if (!name) {
    throw new Error('Secret response is missing name.');
  }

  return {
    name,
    ...(readString(payload, 'value') ? { value: readString(payload, 'value') } : {}),
    ...(readString(payload, 'maskedValue') ? { maskedValue: readString(payload, 'maskedValue') } : {}),
    ...(readString(payload, 'createdAt') ? { createdAt: readString(payload, 'createdAt') } : {}),
    ...(readString(payload, 'updatedAt') ? { updatedAt: readString(payload, 'updatedAt') } : {}),
    ...payload,
  };
}

export async function deployProactiveAgent(
  input: DeployInput,
  options: DeployOptions = {}
): Promise<ProactiveDeploymentResponse> {
  const entrypoint = input.entrypoint.trim();
  if (!entrypoint) {
    throw new Error('Entrypoint is required.');
  }
  if (!input.source.trim()) {
    throw new Error('Entrypoint source is required.');
  }

  const endpoints = [
    '/api/v1/agents/deploy',
    '/api/v1/proactive/agents/deploy',
    '/api/v1/proactive-runtime/deploy',
  ];
  const body = {
    entrypoint,
    source: input.source,
    ...(options.name?.trim() ? { name: options.name.trim() } : {}),
    ...(options.watch ? { watch: true } : {}),
  };
  let lastUnsupported: Error | null = null;

  for (const endpoint of endpoints) {
    const { response, payload } = await tryRequest('POST', endpoint, options, body);
    if (isUnsupported(response)) {
      lastUnsupported = buildEndpointError('Deploy', endpoint, response, payload);
      continue;
    }
    if (!response.ok) {
      throw buildEndpointError('Deploy', endpoint, response, payload);
    }
    return normalizeDeploymentResponse(payload);
  }

  throw lastUnsupported ?? new Error('Deploy is not supported by the configured cloud API.');
}

export async function listProactiveAgents(options: ClientOptions = {}): Promise<ProactiveAgentRecord[]> {
  const endpoints = ['/api/v1/cloud-agents', '/api/v1/agents'];
  let lastUnsupported: Error | null = null;

  for (const endpoint of endpoints) {
    const { response, payload } = await tryRequest('GET', endpoint, options);
    if (isUnsupported(response)) {
      lastUnsupported = buildEndpointError('Agent list', endpoint, response, payload);
      continue;
    }
    if (!response.ok) {
      throw buildEndpointError('Agent list', endpoint, response, payload);
    }
    return normalizeAgentList(payload);
  }

  throw lastUnsupported ?? new Error('Agent listing is not supported by the configured cloud API.');
}

export async function inspectProactiveAgent(
  agentId: string,
  options: ClientOptions = {}
): Promise<ProactiveAgentRecord> {
  const trimmed = agentId.trim();
  if (!trimmed) {
    throw new Error('Agent id is required.');
  }

  const encoded = encodeURIComponent(trimmed);
  const endpoints = [`/api/v1/cloud-agents/${encoded}`, `/api/v1/agents/${encoded}`];
  let lastUnsupported: Error | null = null;

  for (const endpoint of endpoints) {
    const { response, payload } = await tryRequest('GET', endpoint, options);
    if (isUnsupported(response)) {
      lastUnsupported = buildEndpointError('Agent inspect', endpoint, response, payload);
      continue;
    }
    if (response.status === 404) {
      break;
    }
    if (!response.ok) {
      throw buildEndpointError('Agent inspect', endpoint, response, payload);
    }
    return normalizeAgentRecord(payload);
  }

  const agents = await listProactiveAgents(options);
  const matched = agents.find(
    (agent) => agent.id === trimmed || agent.name === trimmed || agent.displayName === trimmed
  );
  if (matched) {
    return matched;
  }

  if (lastUnsupported) {
    throw lastUnsupported;
  }
  throw new Error(`Agent "${trimmed}" not found.`);
}

export async function undeployProactiveAgent(
  agentId: string,
  options: ClientOptions = {}
): Promise<ProactiveAgentRecord> {
  const trimmed = agentId.trim();
  if (!trimmed) {
    throw new Error('Agent id is required.');
  }

  const encoded = encodeURIComponent(trimmed);
  const endpoints = [`/api/v1/cloud-agents/${encoded}`, `/api/v1/agents/${encoded}`];
  let lastUnsupported: Error | null = null;

  for (const endpoint of endpoints) {
    const { response, payload } = await tryRequest('DELETE', endpoint, options);
    if (isUnsupported(response)) {
      lastUnsupported = buildEndpointError('Agent undeploy', endpoint, response, payload);
      continue;
    }
    if (!response.ok) {
      throw buildEndpointError('Agent undeploy', endpoint, response, payload);
    }

    if (payload === null) {
      return { id: trimmed, status: 'deleted' };
    }

    return normalizeAgentRecord(isObject(payload) ? payload : { id: trimmed, status: 'deleted' });
  }

  throw lastUnsupported ?? new Error('Agent undeploy is not supported by the configured cloud API.');
}

export async function createWorkspaceSecret(
  name: string,
  value: string,
  options: SecretOptions
): Promise<WorkspaceSecretRecord> {
  const secretName = name.trim();
  const workspace = options.workspace.trim();
  if (!workspace) {
    throw new Error('Workspace is required.');
  }
  if (!secretName) {
    throw new Error('Secret name is required.');
  }

  const encodedWorkspace = encodeURIComponent(workspace);
  const endpoints = [
    `/api/v1/workspaces/${encodedWorkspace}/secrets`,
    `/api/v1/workspaces/${encodedWorkspace}/secret`,
    `/api/v1/relayauth/workspaces/${encodedWorkspace}/secrets`,
  ];
  const body = { name: secretName, value };
  let lastUnsupported: Error | null = null;

  for (const endpoint of endpoints) {
    const { response, payload } = await tryRequest('POST', endpoint, options, body);
    if (isUnsupported(response)) {
      lastUnsupported = buildEndpointError('Secret create', endpoint, response, payload);
      continue;
    }
    if (!response.ok) {
      throw buildEndpointError('Secret create', endpoint, response, payload);
    }
    return normalizeSecretRecord(payload, secretName);
  }

  throw lastUnsupported ?? new Error('Secret creation is not supported by the configured cloud API.');
}

export async function getWorkspaceSecret(
  name: string,
  options: SecretOptions
): Promise<WorkspaceSecretRecord> {
  const secretName = name.trim();
  const workspace = options.workspace.trim();
  if (!workspace) {
    throw new Error('Workspace is required.');
  }
  if (!secretName) {
    throw new Error('Secret name is required.');
  }

  const encodedWorkspace = encodeURIComponent(workspace);
  const encodedName = encodeURIComponent(secretName);
  const endpoints = [
    `/api/v1/workspaces/${encodedWorkspace}/secrets/${encodedName}`,
    `/api/v1/workspaces/${encodedWorkspace}/secret/${encodedName}`,
    `/api/v1/relayauth/workspaces/${encodedWorkspace}/secrets/${encodedName}`,
  ];
  let lastUnsupported: Error | null = null;

  for (const endpoint of endpoints) {
    const { response, payload } = await tryRequest('GET', endpoint, options);
    if (isUnsupported(response)) {
      lastUnsupported = buildEndpointError('Secret get', endpoint, response, payload);
      continue;
    }
    if (!response.ok) {
      throw buildEndpointError('Secret get', endpoint, response, payload);
    }
    return normalizeSecretRecord(payload, secretName);
  }

  throw lastUnsupported ?? new Error('Secret retrieval is not supported by the configured cloud API.');
}

export async function deleteWorkspaceSecret(
  name: string,
  options: SecretOptions
): Promise<WorkspaceSecretRecord> {
  const secretName = name.trim();
  const workspace = options.workspace.trim();
  if (!workspace) {
    throw new Error('Workspace is required.');
  }
  if (!secretName) {
    throw new Error('Secret name is required.');
  }

  const encodedWorkspace = encodeURIComponent(workspace);
  const encodedName = encodeURIComponent(secretName);
  const endpoints = [
    `/api/v1/workspaces/${encodedWorkspace}/secrets/${encodedName}`,
    `/api/v1/workspaces/${encodedWorkspace}/secret/${encodedName}`,
    `/api/v1/relayauth/workspaces/${encodedWorkspace}/secrets/${encodedName}`,
  ];
  let lastUnsupported: Error | null = null;

  for (const endpoint of endpoints) {
    const { response, payload } = await tryRequest('DELETE', endpoint, options);
    if (isUnsupported(response)) {
      lastUnsupported = buildEndpointError('Secret delete', endpoint, response, payload);
      continue;
    }
    if (!response.ok) {
      throw buildEndpointError('Secret delete', endpoint, response, payload);
    }
    return normalizeSecretRecord(
      isObject(payload) ? payload : { name: secretName, status: 'deleted' },
      secretName
    );
  }

  throw lastUnsupported ?? new Error('Secret deletion is not supported by the configured cloud API.');
}
