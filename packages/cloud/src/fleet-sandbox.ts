import { authorizedApiFetch, ensureCloudSession } from './auth.js';
import { redactCredentialValues } from './redact.js';
import { defaultApiUrl } from './types.js';

type JsonRecord = Record<string, unknown>;

const CLOUD_WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_RESOLUTION_TIMEOUT_MS = 120_000;
// Mounted provisioning can spend up to 240s completing the initial Relayfile
// sync, then up to 90s waiting for the enrolled node to report ready. Leave a
// bounded margin for Daytona creation and credential setup so the client does
// not abandon a successful server-side request without receiving its sandbox
// identity (which prevents the CLI from cleaning it up safely).
const DEFAULT_ENSURE_TIMEOUT_MS = 480_000;
const DEFAULT_DELETE_TIMEOUT_MS = 30_000;

export type CloudFleetSandboxRequestOptions = {
  apiUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type CloudFleetSandboxProviderId = 'daytona' | 'e2b';

/**
 * Carries every safe identifier Cloud returned when provisioning failed after
 * the request may have created a billable sandbox.
 */
export class CloudFleetSandboxProvisionError extends Error {
  readonly cloudWorkspaceId?: string;
  readonly sandboxId?: string;
  readonly nodeName?: string;
  readonly providerId?: CloudFleetSandboxProviderId;
  readonly outcomeUnknown: boolean;

  constructor(
    message: string,
    identity: {
      cloudWorkspaceId?: string;
      sandboxId?: string;
      nodeName?: string;
      providerId?: CloudFleetSandboxProviderId;
      outcomeUnknown?: boolean;
      cause?: unknown;
    } = {}
  ) {
    super(message, identity.cause === undefined ? undefined : { cause: identity.cause });
    this.name = 'CloudFleetSandboxProvisionError';
    this.cloudWorkspaceId = identity.cloudWorkspaceId;
    this.sandboxId = identity.sandboxId;
    this.nodeName = identity.nodeName;
    this.providerId = identity.providerId;
    this.outcomeUnknown = identity.outcomeUnknown === true;
  }
}

export type EnsureCloudFleetSandboxInput = {
  /** Cloud UUID or unified rw_* workspace id. */
  workspaceId: string;
  name?: string;
  requiredCapability: string;
  maxAgents?: number;
  mountRelayfile?: boolean;
  /**
   * Relayfile directory subtrees to materialize in the sandbox. Each path
   * must use the explicit `/path/**` subtree form accepted by Cloud.
   */
  relayfilePaths?: readonly string[];
  forceProvision?: boolean;
  /** Constrain provisioning to a provider that Cloud has enabled for routing. */
  providerId?: CloudFleetSandboxProviderId;
  /** Provider-neutral semantics; Cloud owns the provider decision. */
  workloadProfile?: CloudFleetSandboxWorkloadProfile;
  waitTimeoutMs?: number;
  /**
   * Repositories to clone into `/srv/agent-workforce/<name>` inside the
   * provisioned sandbox. Each entry is a bare `owner/name`; cloud validates
   * the shape on the wire before the sandbox script ever sees it.
   *
   * Required for the factory-cloud dispatch path so its worker_cwd
   * (`/srv/agent-workforce/<repo>`) is resolvable on the JIT node. Cloud
   * PR #3212 implements the ensure-side; this helper just plumbs it through.
   */
  repos?: readonly string[];
};

export type CloudFleetSandboxWorkloadProfile =
  | 'standard'
  | 'long-running-agent'
  | 'standard-long-running-agent';
export type CloudFleetSandboxProviderId =
  | 'daytona'
  | 'e2b'
  | 'vercel'
  | 'freestyle'
  | 'agent37'
  | 'microsandbox';

const CLOUD_FLEET_SANDBOX_PROVIDER_IDS: readonly CloudFleetSandboxProviderId[] = [
  'daytona',
  'e2b',
  'vercel',
  'freestyle',
  'agent37',
  'microsandbox',
];

export type CloudFleetSandboxReady = {
  outcome: 'provisioned';
  cloudWorkspaceId: string;
  nodeId: string;
  nodeName: string;
  sandboxId: string;
  relayWorkspaceId: string;
  relayfileMounted: boolean;
  relayfileMountPath?: string;
  providerId?: CloudFleetSandboxProviderId;
};

export type CloudFleetSandboxReused = {
  outcome: 'reused';
  cloudWorkspaceId: string;
  nodeId: string;
  nodeName: string;
  status: string;
  activeAgents: number | null;
  maxAgents: number | null;
  providerId?: CloudFleetSandboxProviderId;
};

export type CloudFleetSandboxProvisioningTimeout = {
  outcome: 'provisioning_timeout';
  cloudWorkspaceId: string;
  sandboxId: string;
  relayWorkspaceId: string;
  nodeName: string;
  waitedMs: number;
  providerId?: CloudFleetSandboxProviderId;
};

export type EnsureCloudFleetSandboxResult =
  | CloudFleetSandboxReady
  | CloudFleetSandboxReused
  | CloudFleetSandboxProvisioningTimeout;

export type DeleteCloudFleetSandboxInput = {
  cloudWorkspaceId: string;
  sandboxId: string;
  providerId?: CloudFleetSandboxProviderId;
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

function requiredNumber(payload: JsonRecord, key: string, context: string): number {
  const value = readNumber(payload, key);
  if (value === undefined) throw new Error(`${context} response is missing ${key}.`);
  return value;
}

function boundedSignal(options: CloudFleetSandboxRequestOptions, defaultTimeoutMs: number): AbortSignal {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Cloud fleet sandbox request timeout must be a positive number of milliseconds.');
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
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
  auth: Awaited<ReturnType<typeof ensureCloudSession>>['auth'],
  signal: AbortSignal
): Promise<{
  cloudWorkspaceId: string;
  auth: Awaited<ReturnType<typeof ensureCloudSession>>['auth'];
}> {
  const { response, auth: activeAuth } = await authorizedApiFetch(
    auth,
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/resolve`,
    { method: 'GET', signal },
    { interactive: false }
  );
  const payload = await readJson(response);
  if (!response.ok) throw endpointError('resolve the Cloud workspace', response, payload);
  if (!isObject(payload)) throw new Error('Cloud workspace resolver returned an invalid response.');
  const cloudWorkspaceId = requiredString(payload, 'cloudWorkspaceId', 'Cloud workspace resolver');
  if (!CLOUD_WORKSPACE_ID_PATTERN.test(cloudWorkspaceId)) {
    throw new Error('Cloud workspace resolver returned an invalid cloudWorkspaceId.');
  }
  return {
    cloudWorkspaceId,
    auth: activeAuth,
  };
}

function readProviderId(
  payload: JsonRecord,
  exactProviderRequested: boolean
): CloudFleetSandboxProviderId | undefined {
  const value = readString(payload, 'providerId');
  if (value === undefined) return undefined;
  if (CLOUD_FLEET_SANDBOX_PROVIDER_IDS.includes(value as CloudFleetSandboxProviderId)) {
    return value as CloudFleetSandboxProviderId;
  }
  if (exactProviderRequested) {
    throw new Error('Cloud fleet sandbox response has an unknown providerId.');
  }
  return undefined;
}

function cleanupProviderId(
  payload: JsonRecord,
  requestedProviderId?: CloudFleetSandboxProviderId
): CloudFleetSandboxProviderId | undefined {
  const payloadProviderId = readString(payload, 'providerId');
  return payloadProviderId && CLOUD_FLEET_SANDBOX_PROVIDER_IDS.includes(
    payloadProviderId as CloudFleetSandboxProviderId
  )
    ? payloadProviderId as CloudFleetSandboxProviderId
    : requestedProviderId;
}

function normalizeEnsureResult(
  payload: unknown,
  cloudWorkspaceId: string,
  requestedProviderId?: CloudFleetSandboxProviderId
): EnsureCloudFleetSandboxResult {
  if (!isObject(payload)) throw new Error('Cloud fleet sandbox response was not valid JSON.');
  const outcome = readString(payload, 'outcome');
  const nodeName = requiredString(payload, 'nodeName', 'Cloud fleet sandbox');
  const providerId = readProviderId(payload, requestedProviderId !== undefined);
  if (requestedProviderId !== undefined && providerId !== requestedProviderId) {
    throw new Error(
      providerId === undefined
        ? `Cloud did not prove requested provider ${requestedProviderId}.`
        : `Cloud returned provider ${providerId} instead of requested provider ${requestedProviderId}.`
    );
  }

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
      ...(providerId === undefined ? {} : { providerId }),
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
      ...(providerId === undefined ? {} : { providerId }),
    };
  }

  if (outcome === 'provisioning_timeout') {
    return {
      outcome,
      cloudWorkspaceId,
      sandboxId: requiredString(payload, 'sandboxId', 'Cloud fleet sandbox'),
      relayWorkspaceId: requiredString(payload, 'relayWorkspaceId', 'Cloud fleet sandbox'),
      nodeName,
      waitedMs: requiredNumber(payload, 'waitedMs', 'Cloud fleet sandbox'),
      ...(providerId === undefined ? {} : { providerId }),
    };
  }

  throw new Error('Cloud fleet sandbox response has an unknown outcome.');
}

/** Resolve a Relay workspace in Cloud, provision/reuse a node, and wait for readiness. */
export async function ensureCloudFleetSandbox(
  input: EnsureCloudFleetSandboxInput,
  options: CloudFleetSandboxRequestOptions = {}
): Promise<EnsureCloudFleetSandboxResult> {
  const workspaceId = input.workspaceId.trim();
  const requiredCapability = input.requiredCapability.trim();
  if (!workspaceId) throw new Error('A workspace ID is required to provision a fleet sandbox.');
  if (!requiredCapability) throw new Error('A spawn capability is required to provision a fleet sandbox.');
  if (input.relayfilePaths !== undefined && input.relayfilePaths.length === 0) {
    throw new Error('At least one Relayfile subtree path is required when relayfilePaths is provided.');
  }

  const session = await ensureCloudSession({
    apiUrl: options.apiUrl || defaultApiUrl(),
    interactive: false,
  });
  const resolutionSignal = boundedSignal(options, DEFAULT_RESOLUTION_TIMEOUT_MS);
  const resolved = await resolveCloudWorkspaceId(workspaceId, session.auth, resolutionSignal);
  const signal = boundedSignal(options, DEFAULT_ENSURE_TIMEOUT_MS);
  let response: Response;
  try {
    ({ response } = await authorizedApiFetch(
      resolved.auth,
      '/api/v1/fleet/nodes/sandbox/ensure',
      {
        method: 'POST',
        signal,
        body: JSON.stringify({
          workspaceId: resolved.cloudWorkspaceId,
          requiredCapability,
          ...(input.name ? { name: input.name } : {}),
          ...(input.maxAgents !== undefined ? { maxAgents: input.maxAgents } : {}),
          ...(input.mountRelayfile !== undefined ? { mountRelayfile: input.mountRelayfile } : {}),
          ...(input.relayfilePaths === undefined ? {} : { relayfilePaths: [...input.relayfilePaths] }),
          ...(input.forceProvision !== undefined ? { forceProvision: input.forceProvision } : {}),
          ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
          ...(input.workloadProfile !== undefined
            ? { workloadProfile: input.workloadProfile }
            : {}),
          ...(input.waitTimeoutMs !== undefined ? { waitTimeoutMs: input.waitTimeoutMs } : {}),
          ...(input.repos !== undefined && input.repos.length > 0 ? { repos: [...input.repos] } : {}),
        }),
      },
      { interactive: false }
    ));
  } catch (error) {
    throw new CloudFleetSandboxProvisionError(
      redactCredentialValues(
        `Cloud fleet sandbox request ended without a complete response: ${
          error instanceof Error ? error.message : String(error)
        }`
      ),
      {
        cloudWorkspaceId: resolved.cloudWorkspaceId,
        ...(input.name ? { nodeName: input.name } : {}),
        ...(input.providerId ? { providerId: input.providerId } : {}),
        outcomeUnknown: true,
        cause: error,
      }
    );
  }
  const payload = await readJson(response);
  if (!response.ok) {
    const error = endpointError('provision the fleet sandbox', response, payload);
    if (isObject(payload) && readString(payload, 'sandboxId')) {
      const providerId = cleanupProviderId(payload, input.providerId);
      throw new CloudFleetSandboxProvisionError(error.message, {
        cloudWorkspaceId: resolved.cloudWorkspaceId,
        sandboxId: readString(payload, 'sandboxId'),
        nodeName: readString(payload, 'nodeName') ?? input.name,
        ...(providerId === undefined ? {} : { providerId }),
        cause: error,
      });
    }
    throw error;
  }
  try {
    return normalizeEnsureResult(payload, resolved.cloudWorkspaceId, input.providerId);
  } catch (error) {
    const providerId = isObject(payload) ? cleanupProviderId(payload, input.providerId) : input.providerId;
    throw new CloudFleetSandboxProvisionError(
      error instanceof Error ? error.message : 'Cloud fleet sandbox response was invalid.',
      {
        cloudWorkspaceId: resolved.cloudWorkspaceId,
        ...(isObject(payload) && readString(payload, 'sandboxId')
          ? { sandboxId: readString(payload, 'sandboxId') }
          : {}),
        ...(isObject(payload) && (readString(payload, 'nodeName') ?? input.name)
          ? { nodeName: readString(payload, 'nodeName') ?? input.name }
          : {}),
        ...(providerId === undefined ? {} : { providerId }),
        outcomeUnknown: true,
        cause: error,
      }
    );
  }
}

/** Best-effort-safe deletion for a Cloud-owned fleet sandbox. */
export async function deleteCloudFleetSandbox(
  input: DeleteCloudFleetSandboxInput,
  options: CloudFleetSandboxRequestOptions = {}
): Promise<void> {
  const cloudWorkspaceId = input.cloudWorkspaceId.trim();
  const sandboxId = input.sandboxId.trim();
  if (!cloudWorkspaceId || !sandboxId) throw new Error('Cloud workspace and sandbox IDs are required.');

  const session = await ensureCloudSession({
    apiUrl: options.apiUrl || defaultApiUrl(),
    interactive: false,
  });
  const signal = boundedSignal(options, DEFAULT_DELETE_TIMEOUT_MS);
  const { response } = await authorizedApiFetch(
    session.auth,
    `/api/v1/fleet/nodes/sandbox/${encodeURIComponent(sandboxId)}`,
    {
      method: 'DELETE',
      signal,
      body: JSON.stringify({
        workspaceId: cloudWorkspaceId,
        ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
      }),
    },
    { interactive: false }
  );
  const payload = await readJson(response);
  if (!response.ok) throw endpointError('delete the fleet sandbox', response, payload);
}
