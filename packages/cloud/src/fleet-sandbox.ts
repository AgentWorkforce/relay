import { authorizedApiFetch, ensureCloudSession } from './auth.js';
import { redactCredentialValues } from './redact.js';
import { defaultApiUrl } from './types.js';

type JsonRecord = Record<string, unknown>;

export type EnsureCloudFleetSandboxInput = {
  /** Cloud UUID or unified rw_* workspace id. */
  workspaceId: string;
  name?: string;
  requiredCapability: string;
  maxAgents?: number;
  mountRelayfile?: boolean;
  forceProvision?: boolean;
  waitTimeoutMs?: number;
};

export type CloudFleetSandboxReady = {
  outcome: 'provisioned';
  cloudWorkspaceId: string;
  nodeId: string;
  nodeName: string;
  sandboxId: string;
  relayWorkspaceId: string;
  relayfileMounted: boolean;
  relayfileMountPath?: string;
};

export type CloudFleetSandboxReused = {
  outcome: 'reused';
  cloudWorkspaceId: string;
  nodeId: string;
  nodeName: string;
  status: string;
  activeAgents: number | null;
  maxAgents: number | null;
};

export type CloudFleetSandboxProvisioningTimeout = {
  outcome: 'provisioning_timeout';
  cloudWorkspaceId: string;
  sandboxId: string;
  relayWorkspaceId: string;
  nodeName: string;
  waitedMs: number;
};

export type EnsureCloudFleetSandboxResult =
  | CloudFleetSandboxReady
  | CloudFleetSandboxReused
  | CloudFleetSandboxProvisioningTimeout;

export type DeleteCloudFleetSandboxInput = {
  cloudWorkspaceId: string;
  sandboxId: string;
};

function isObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(payload: JsonRecord, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(payload: JsonRecord, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function endpointError(action: string, response: Response, payload: unknown): Error {
  if (response.status === 401) {
    return new Error(`Cloud login required. Run \`agent-relay cloud login\` and retry ${action}.`);
  }
  if (response.status === 403) {
    return new Error(`Cloud workspace owner or admin access is required to ${action}.`);
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after')?.trim();
    return new Error(
      `Cloud rate limit exceeded while trying to ${action}.${
        retryAfter ? ` Retry after ${retryAfter} seconds.` : ''
      }`
    );
  }
  const detail = isObject(payload)
    ? (readString(payload, 'error') ?? readString(payload, 'message') ?? response.statusText)
    : response.statusText;
  return new Error(
    redactCredentialValues(`Failed to ${action}: ${response.status}${detail ? ` ${detail}` : ''}`)
  );
}

function requiredString(payload: JsonRecord, key: string, context: string): string {
  const value = readString(payload, key);
  if (!value) throw new Error(`${context} response is missing ${key}.`);
  return value;
}

async function resolveCloudWorkspaceId(
  workspaceId: string,
  auth: Awaited<ReturnType<typeof ensureCloudSession>>['auth']
): Promise<{
  cloudWorkspaceId: string;
  auth: Awaited<ReturnType<typeof ensureCloudSession>>['auth'];
}> {
  const { response, auth: activeAuth } = await authorizedApiFetch(
    auth,
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/resolve`,
    { method: 'GET' },
    { interactive: false }
  );
  const payload = await readJson(response);
  if (!response.ok) throw endpointError('resolve the Cloud workspace', response, payload);
  if (!isObject(payload)) throw new Error('Cloud workspace resolver returned an invalid response.');
  return {
    cloudWorkspaceId: requiredString(payload, 'cloudWorkspaceId', 'Cloud workspace resolver'),
    auth: activeAuth,
  };
}

function normalizeEnsureResult(payload: unknown, cloudWorkspaceId: string): EnsureCloudFleetSandboxResult {
  if (!isObject(payload)) throw new Error('Cloud fleet sandbox response was not valid JSON.');
  const outcome = readString(payload, 'outcome');
  const nodeName = requiredString(payload, 'nodeName', 'Cloud fleet sandbox');

  if (outcome === 'provisioned') {
    if (typeof payload.relayfileMounted !== 'boolean') {
      throw new Error('Cloud fleet sandbox response is missing relayfileMounted.');
    }
    return {
      outcome,
      cloudWorkspaceId,
      nodeId: requiredString(payload, 'nodeId', 'Cloud fleet sandbox'),
      nodeName,
      sandboxId: requiredString(payload, 'sandboxId', 'Cloud fleet sandbox'),
      relayWorkspaceId: requiredString(payload, 'relayWorkspaceId', 'Cloud fleet sandbox'),
      relayfileMounted: payload.relayfileMounted,
      ...(readString(payload, 'relayfileMountPath')
        ? { relayfileMountPath: readString(payload, 'relayfileMountPath') }
        : {}),
    };
  }

  if (outcome === 'reused') {
    return {
      outcome,
      cloudWorkspaceId,
      nodeId: requiredString(payload, 'nodeId', 'Cloud fleet sandbox'),
      nodeName,
      status: requiredString(payload, 'status', 'Cloud fleet sandbox'),
      activeAgents: readNumber(payload, 'activeAgents') ?? null,
      maxAgents: readNumber(payload, 'maxAgents') ?? null,
    };
  }

  if (outcome === 'provisioning_timeout') {
    return {
      outcome,
      cloudWorkspaceId,
      sandboxId: requiredString(payload, 'sandboxId', 'Cloud fleet sandbox'),
      relayWorkspaceId: requiredString(payload, 'relayWorkspaceId', 'Cloud fleet sandbox'),
      nodeName,
      waitedMs: readNumber(payload, 'waitedMs') ?? 0,
    };
  }

  throw new Error('Cloud fleet sandbox response has an unknown outcome.');
}

/** Resolve a Relay workspace in Cloud, provision/reuse a node, and wait for readiness. */
export async function ensureCloudFleetSandbox(
  input: EnsureCloudFleetSandboxInput,
  options: { apiUrl?: string } = {}
): Promise<EnsureCloudFleetSandboxResult> {
  const workspaceId = input.workspaceId.trim();
  const requiredCapability = input.requiredCapability.trim();
  if (!workspaceId) throw new Error('A workspace ID is required to provision a fleet sandbox.');
  if (!requiredCapability) throw new Error('A spawn capability is required to provision a fleet sandbox.');

  const session = await ensureCloudSession({
    apiUrl: options.apiUrl || defaultApiUrl(),
    interactive: false,
  });
  const resolved = await resolveCloudWorkspaceId(workspaceId, session.auth);
  const { response } = await authorizedApiFetch(
    resolved.auth,
    '/api/v1/fleet/nodes/sandbox/ensure',
    {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: resolved.cloudWorkspaceId,
        requiredCapability,
        ...(input.name ? { name: input.name } : {}),
        ...(input.maxAgents !== undefined ? { maxAgents: input.maxAgents } : {}),
        ...(input.mountRelayfile !== undefined ? { mountRelayfile: input.mountRelayfile } : {}),
        ...(input.forceProvision !== undefined ? { forceProvision: input.forceProvision } : {}),
        ...(input.waitTimeoutMs !== undefined ? { waitTimeoutMs: input.waitTimeoutMs } : {}),
      }),
    },
    { interactive: false }
  );
  const payload = await readJson(response);
  if (!response.ok) throw endpointError('provision the fleet sandbox', response, payload);
  return normalizeEnsureResult(payload, resolved.cloudWorkspaceId);
}

/** Best-effort-safe deletion for a Cloud-owned Daytona fleet sandbox. */
export async function deleteCloudFleetSandbox(
  input: DeleteCloudFleetSandboxInput,
  options: { apiUrl?: string } = {}
): Promise<void> {
  const cloudWorkspaceId = input.cloudWorkspaceId.trim();
  const sandboxId = input.sandboxId.trim();
  if (!cloudWorkspaceId || !sandboxId) throw new Error('Cloud workspace and sandbox IDs are required.');

  const session = await ensureCloudSession({
    apiUrl: options.apiUrl || defaultApiUrl(),
    interactive: false,
  });
  const { response } = await authorizedApiFetch(
    session.auth,
    `/api/v1/fleet/nodes/sandbox/${encodeURIComponent(sandboxId)}`,
    {
      method: 'DELETE',
      body: JSON.stringify({ workspaceId: cloudWorkspaceId }),
    },
    { interactive: false }
  );
  const payload = await readJson(response);
  if (!response.ok) throw endpointError('delete the fleet sandbox', response, payload);
}
