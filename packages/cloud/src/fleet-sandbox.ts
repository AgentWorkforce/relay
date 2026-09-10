import { authorizedApiFetch, ensureCloudSession } from './auth.js';
import { redactCredentialValues } from './redact.js';
import { defaultApiUrl } from './types.js';

type JsonRecord = Record<string, unknown>;

const CLOUD_WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOUD_SANDBOX_ID_PATTERN =
  /^sbx_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAYTONA_PROVIDER_SANDBOX_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/**
 * Cloud may hand back the gateway route owned by a provisioned sandbox. This
 * is deliberately an exact-origin allowlist: a route is control-plane input,
 * not a caller-controlled SDK override.
 */
export const CANONICAL_RELAYCAST_ORIGIN = 'https://cast.agentrelay.com';
export const AGENT37_RELAYCAST_ORIGIN = 'https://agent37-cast.agentrelay.com';
const TRUSTED_RELAYCAST_ORIGINS = new Set([CANONICAL_RELAYCAST_ORIGIN, AGENT37_RELAYCAST_ORIGIN]);
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

export type CloudFleetSandboxProviderId =
  | 'daytona'
  | 'e2b'
  | 'vercel'
  | 'freestyle'
  | 'agent37'
  | 'microsandbox';

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

class CloudFleetSandboxIdentityMismatchError extends Error {}

export type EnsureCloudFleetSandboxInput = {
  /** Cloud UUID or unified rw_* workspace id. */
  workspaceId: string;
  /** Caller-declared one-time Cloud identity used to resume a cut-off provision. */
  sandboxId?: string;
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
  providerSandboxId?: string;
  relayWorkspaceId: string;
  /** Closed server-owned Relaycast contract when Cloud returned one. Required for Agent37. */
  relaycastTarget?: CloudFleetRelaycastTarget;
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
  /** Closed server-owned Relaycast contract when Cloud returned one. Required for Agent37. */
  relaycastTarget?: CloudFleetRelaycastTarget;
};

export type CloudFleetSandboxProvisioningTimeout = {
  outcome: 'provisioning_timeout';
  cloudWorkspaceId: string;
  sandboxId: string;
  providerSandboxId?: string;
  relayWorkspaceId: string;
  relaycastTarget?: CloudFleetRelaycastTarget;
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

export type CloudFleetRelaycastRoute = 'canonical' | 'agent37-isolated';

export type CloudFleetRelaycastTarget = {
  route: CloudFleetRelaycastRoute;
  baseUrl: string;
  workspaceId: string;
  relaycastApiKey: string;
};

function isObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(payload: JsonRecord, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeRelaycastOrigin(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Cloud fleet sandbox response has an invalid ${field}.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`Cloud fleet sandbox response has an invalid ${field}.`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    !TRUSTED_RELAYCAST_ORIGINS.has(parsed.origin)
  ) {
    throw new Error(`Cloud fleet sandbox response has an untrusted ${field}.`);
  }
  return parsed.origin;
}

/** Validate Cloud's closed Relaycast route, identity, and scoped credential contract. */
export function normalizeRelaycastTarget(value: unknown): CloudFleetRelaycastTarget {
  if (!isObject(value)) {
    throw new Error('Cloud fleet sandbox response is missing relaycastTarget.');
  }
  const route = readString(value, 'route');
  if (route !== 'canonical' && route !== 'agent37-isolated') {
    throw new Error('Cloud fleet sandbox response has an unknown Relaycast route.');
  }
  const baseUrl = normalizeRelaycastOrigin(value.baseUrl, 'relaycastTarget.baseUrl');
  const expectedOrigin = route === 'canonical' ? CANONICAL_RELAYCAST_ORIGIN : AGENT37_RELAYCAST_ORIGIN;
  if (baseUrl !== expectedOrigin) {
    throw new Error('Cloud fleet sandbox response mapped Relaycast route to the wrong origin.');
  }
  const workspaceId = readString(value, 'workspaceId');
  if (!workspaceId) {
    throw new Error('Cloud fleet sandbox response is missing relaycastTarget.workspaceId.');
  }
  const relaycastApiKey = readString(value, 'relaycastApiKey');
  if (!relaycastApiKey || !/^rk_live_[A-Za-z0-9_-]+$/.test(relaycastApiKey)) {
    throw new Error('Cloud fleet sandbox response has an invalid Relaycast API key.');
  }
  return { route, baseUrl, workspaceId, relaycastApiKey };
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

function assertProviderRelaycastTarget(
  providerId: CloudFleetSandboxProviderId | undefined,
  target: CloudFleetRelaycastTarget | undefined
): void {
  if (providerId === 'agent37') {
    if (!target) {
      throw new Error('Cloud fleet sandbox response is missing the Agent37 Relaycast target.');
    }
    if (target.route !== 'agent37-isolated' || target.baseUrl !== AGENT37_RELAYCAST_ORIGIN) {
      throw new Error('Cloud fleet sandbox response mapped Agent37 to a non-isolated Relaycast target.');
    }
    return;
  }
  if (providerId !== undefined && target) {
    if (target.route !== 'canonical' || target.baseUrl !== CANONICAL_RELAYCAST_ORIGIN) {
      throw new Error(
        `Cloud fleet sandbox response mapped ${providerId} to a non-canonical Relaycast target.`
      );
    }
  }
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

function validateSandboxIdentity(input: EnsureCloudFleetSandboxInput): {
  sandboxId?: string;
  name?: string;
} {
  if (input.sandboxId !== undefined && typeof input.sandboxId !== 'string') {
    throw new Error('Cloud fleet sandbox sandboxId must be a string.');
  }
  if (input.name !== undefined && typeof input.name !== 'string') {
    throw new Error('Cloud fleet sandbox name must be a string.');
  }
  const sandboxId = input.sandboxId?.trim();
  const name = input.name?.trim();
  if (input.sandboxId !== undefined && (!sandboxId || !CLOUD_SANDBOX_ID_PATTERN.test(sandboxId))) {
    throw new Error('Cloud fleet sandbox sandboxId must match lowercase sbx_<UUID> using an RFC 4122 UUID.');
  }
  if (sandboxId !== undefined && input.forceProvision !== true) {
    throw new Error('Cloud fleet sandbox sandboxId requires forceProvision: true.');
  }
  if (sandboxId !== undefined && !name) {
    throw new Error('Cloud fleet sandbox sandboxId requires a node name.');
  }

  const longRunning =
    input.workloadProfile === 'long-running-agent' || input.workloadProfile === 'standard-long-running-agent';
  if (longRunning && sandboxId !== undefined) {
    if (input.forceProvision !== true) {
      throw new Error('Long-running Cloud fleet sandbox requests require forceProvision: true.');
    }
    const expectedName = `fleet-sandbox-${sandboxId.slice('sbx_'.length)}`;
    if (name !== expectedName) {
      throw new Error(
        `Long-running Cloud fleet sandbox requests require name '${expectedName}' to preserve the one-to-one sandbox identity.`
      );
    }
  }

  return {
    ...(sandboxId === undefined ? {} : { sandboxId }),
    ...(name === undefined ? {} : { name }),
  };
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

function assertExpectedSandboxIdentity(payload: JsonRecord, expectedSandboxId: string): void {
  const sandboxId = requiredString(payload, 'sandboxId', 'Cloud fleet sandbox');
  if (sandboxId !== expectedSandboxId) {
    throw new CloudFleetSandboxIdentityMismatchError(
      `Cloud returned sandboxId ${sandboxId} instead of requested sandboxId ${expectedSandboxId}.`
    );
  }
}

/** Daytona's control-plane identity and its provider UUID are distinct. */
function normalizeProviderSandboxId(
  payload: JsonRecord,
  providerId: CloudFleetSandboxProviderId | undefined
): string | undefined {
  const providerSandboxId = readString(payload, 'providerSandboxId');
  if (providerId !== 'daytona') return providerSandboxId;
  if (!providerSandboxId || !DAYTONA_PROVIDER_SANDBOX_ID_PATTERN.test(providerSandboxId)) {
    throw new Error('Cloud fleet sandbox response is missing a valid Daytona providerSandboxId.');
  }
  return providerSandboxId;
}

function normalizeEnsureResult(
  payload: unknown,
  cloudWorkspaceId: string,
  expectedSandboxId?: string,
  expectedNodeName?: string,
  requestedProviderId?: CloudFleetSandboxProviderId
): EnsureCloudFleetSandboxResult {
  if (!isObject(payload)) throw new Error('Cloud fleet sandbox response was not valid JSON.');
  // A caller-declared identity is the cleanup authority. Validate it before
  // reading any other response field so malformed and future outcomes cannot
  // make an untrusted public ID eligible for automatic deletion.
  if (expectedSandboxId !== undefined) {
    assertExpectedSandboxIdentity(payload, expectedSandboxId);
  }
  const outcome = readString(payload, 'outcome');
  const nodeName = requiredString(payload, 'nodeName', 'Cloud fleet sandbox');
  if (expectedSandboxId !== undefined && expectedNodeName !== undefined && nodeName !== expectedNodeName) {
    throw new CloudFleetSandboxIdentityMismatchError(
      `Cloud returned nodeName ${nodeName} instead of requested nodeName ${expectedNodeName}.`
    );
  }
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
    const sandboxId = requiredString(payload, 'sandboxId', 'Cloud fleet sandbox');
    const providerSandboxId = normalizeProviderSandboxId(payload, providerId);
    const relayWorkspaceId = requiredString(payload, 'relayWorkspaceId', 'Cloud fleet sandbox');
    const relaycastTarget =
      payload.relaycastTarget === undefined ? undefined : normalizeRelaycastTarget(payload.relaycastTarget);
    if (relaycastTarget !== undefined && relaycastTarget.workspaceId !== relayWorkspaceId) {
      throw new Error('Cloud fleet sandbox response has mismatched Relaycast workspace identities.');
    }
    assertProviderRelaycastTarget(providerId, relaycastTarget);
    return {
      outcome,
      cloudWorkspaceId,
      nodeId: requiredString(payload, 'nodeId', 'Cloud fleet sandbox'),
      nodeName,
      sandboxId,
      ...(providerSandboxId === undefined ? {} : { providerSandboxId }),
      relayWorkspaceId,
      ...(relaycastTarget === undefined ? {} : { relaycastTarget }),
      relayfileMounted: payload.relayfileMounted,
      ...(providerId === undefined ? {} : { providerId }),
      ...(readString(payload, 'relayfileMountPath')
        ? { relayfileMountPath: readString(payload, 'relayfileMountPath') }
        : {}),
    };
  }

  if (outcome === 'reused') {
    const relaycastTarget =
      payload.relaycastTarget === undefined ? undefined : normalizeRelaycastTarget(payload.relaycastTarget);
    assertProviderRelaycastTarget(providerId, relaycastTarget);
    return {
      outcome,
      cloudWorkspaceId,
      nodeId: requiredString(payload, 'nodeId', 'Cloud fleet sandbox'),
      nodeName,
      status: requiredString(payload, 'status', 'Cloud fleet sandbox'),
      activeAgents: readNumber(payload, 'activeAgents') ?? null,
      maxAgents: readNumber(payload, 'maxAgents') ?? null,
      ...(providerId === undefined ? {} : { providerId }),
      ...(relaycastTarget === undefined ? {} : { relaycastTarget }),
    };
  }

  if (outcome === 'provisioning_timeout') {
    const sandboxId = requiredString(payload, 'sandboxId', 'Cloud fleet sandbox');
    const providerSandboxId = normalizeProviderSandboxId(payload, providerId);
    const relayWorkspaceId = requiredString(payload, 'relayWorkspaceId', 'Cloud fleet sandbox');
    const relaycastTarget =
      payload.relaycastTarget === undefined ? undefined : normalizeRelaycastTarget(payload.relaycastTarget);
    if (relaycastTarget !== undefined && relaycastTarget.workspaceId !== relayWorkspaceId) {
      throw new Error('Cloud fleet sandbox response has mismatched Relaycast workspace identities.');
    }
    return {
      outcome,
      cloudWorkspaceId,
      sandboxId,
      ...(providerSandboxId === undefined ? {} : { providerSandboxId }),
      relayWorkspaceId,
      ...(relaycastTarget === undefined ? {} : { relaycastTarget }),
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
  const sandboxIdentity = validateSandboxIdentity(input);
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
          ...(sandboxIdentity.sandboxId === undefined ? {} : { sandboxId: sandboxIdentity.sandboxId }),
          ...(sandboxIdentity.name === undefined ? {} : { name: sandboxIdentity.name }),
          ...(input.maxAgents !== undefined ? { maxAgents: input.maxAgents } : {}),
          ...(input.mountRelayfile !== undefined ? { mountRelayfile: input.mountRelayfile } : {}),
          ...(input.relayfilePaths === undefined ? {} : { relayfilePaths: [...input.relayfilePaths] }),
          ...(input.forceProvision !== undefined ? { forceProvision: input.forceProvision } : {}),
          ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
          ...(input.workloadProfile !== undefined ? { workloadProfile: input.workloadProfile } : {}),
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
        ...(sandboxIdentity.sandboxId === undefined ? {} : { sandboxId: sandboxIdentity.sandboxId }),
        ...(input.name ? { nodeName: input.name } : {}),
        ...(input.providerId ? { providerId: input.providerId } : {}),
        outcomeUnknown: true,
        cause: error,
      }
    );
  }
  const payload = await readJson(response);
  if (!response.ok) {
    const returnedSandboxId = isObject(payload) ? readString(payload, 'sandboxId') : undefined;
    if (
      sandboxIdentity.sandboxId !== undefined &&
      returnedSandboxId !== undefined &&
      returnedSandboxId !== sandboxIdentity.sandboxId
    ) {
      const mismatch = new CloudFleetSandboxIdentityMismatchError(
        `Cloud returned sandboxId ${returnedSandboxId} instead of requested sandboxId ${sandboxIdentity.sandboxId}.`
      );
      throw new CloudFleetSandboxProvisionError(mismatch.message, {
        cloudWorkspaceId: resolved.cloudWorkspaceId,
        ...(sandboxIdentity.name === undefined ? {} : { nodeName: sandboxIdentity.name }),
        ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
        outcomeUnknown: true,
        cause: mismatch,
      });
    }
    const error = endpointError('provision the fleet sandbox', response, payload);
    // Gateway/server failures can arrive after Cloud accepted the ensure
    // request but before it could return an identity. Keep every 5xx failure
    // replayable as an unknown outcome, even for legacy custom-name callers;
    // never copy an unverified response ID into cleanup authority.
    if (response.status >= 500) {
      throw new CloudFleetSandboxProvisionError(error.message, {
        cloudWorkspaceId: resolved.cloudWorkspaceId,
        ...(sandboxIdentity.sandboxId === undefined ? {} : { sandboxId: sandboxIdentity.sandboxId }),
        ...(sandboxIdentity.name === undefined ? {} : { nodeName: sandboxIdentity.name }),
        ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
        outcomeUnknown: true,
        cause: error,
      });
    }
    if (isObject(payload) && readString(payload, 'sandboxId')) {
      throw new CloudFleetSandboxProvisionError(error.message, {
        cloudWorkspaceId: resolved.cloudWorkspaceId,
        ...(sandboxIdentity.sandboxId === undefined ? {} : { sandboxId: sandboxIdentity.sandboxId }),
        ...(sandboxIdentity.name === undefined ? {} : { nodeName: sandboxIdentity.name }),
        ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
        outcomeUnknown: true,
        cause: error,
      });
    }
    throw error;
  }
  try {
    return normalizeEnsureResult(
      payload,
      resolved.cloudWorkspaceId,
      sandboxIdentity.sandboxId,
      sandboxIdentity.name,
      input.providerId
    );
  } catch (error) {
    throw new CloudFleetSandboxProvisionError(
      error instanceof Error ? error.message : 'Cloud fleet sandbox response was invalid.',
      {
        cloudWorkspaceId: resolved.cloudWorkspaceId,
        ...(sandboxIdentity.sandboxId === undefined ? {} : { sandboxId: sandboxIdentity.sandboxId }),
        ...(sandboxIdentity.name === undefined ? {} : { nodeName: sandboxIdentity.name }),
        ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
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
