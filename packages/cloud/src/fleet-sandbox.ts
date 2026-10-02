import { authorizedApiFetch, ensureCloudSession } from './auth.js';
import { redactCredentialValues } from './redact.js';
import { CloudAuthError, defaultApiUrl } from './types.js';

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
const DEFAULT_ASYNC_PREPARATION_TIMEOUT_MS = 35 * 60_000;
const ASYNC_PREPARATION_REQUEST_TIMEOUT_MS = 110_000;
const DEFAULT_ASYNC_PREPARATION_POLL_INTERVAL_MS = 1_000;
const DEFAULT_DELETE_TIMEOUT_MS = 30_000;
const DEFAULT_RELAYFILE_REPOSITORY_MATERIALIZE_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_RELAYFILE_REPOSITORY_POLL_INTERVAL_MS = 2_000;
const MAX_TIMER_MS = 2_147_483_647;
const LIVE_RELAYFILE_SOURCE_PROFILE = 'complete-v1' as const;

export type CloudFleetSandboxRequestOptions = {
  apiUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Receives safe durable phase changes while an async-v1 sandbox is prepared. */
  onPreparationProgress?: (progress: CloudFleetSandboxPreparationProgress) => void;
  preparationPollIntervalMs?: number;
};

export type CloudFleetSandboxPreparationProgress = {
  sandboxId: string;
  state: 'pending' | 'ready' | 'terminal' | 'cleanup_pending';
  phase: string;
  generation: number;
};

export type MaterializeCloudRelayfileRepositoryInput = {
  /** Cloud UUID or unified rw_* workspace id. */
  workspaceId: string;
  /** Canonical GitHub owner/name identity. */
  repository: string;
  /** Exact reachable commit to seed into Relayfile. */
  revision: string;
};

export type CloudRelayfileRepositoryMaterialization = {
  cloudWorkspaceId: string;
  repository: string;
  revision: string;
  filesWritten: number;
  sourceProfile: typeof LIVE_RELAYFILE_SOURCE_PROFILE;
  contentRoot: string;
  sentinelPath: string;
};

export type CloudRelayfileRepositoryMaterializeOptions = CloudFleetSandboxRequestOptions & {
  pollIntervalMs?: number;
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
  /** A 2xx response proved this exact caller-owned sandbox was provisioned. */
  readonly confirmedProvisioned: boolean;
  readonly outcomeUnknown: boolean;

  constructor(
    message: string,
    identity: {
      cloudWorkspaceId?: string;
      sandboxId?: string;
      nodeName?: string;
      providerId?: CloudFleetSandboxProviderId;
      confirmedProvisioned?: boolean;
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
    this.confirmedProvisioned = identity.confirmedProvisioned === true;
    this.outcomeUnknown = !this.confirmedProvisioned && identity.outcomeUnknown === true;
  }
}

class CloudFleetSandboxIdentityMismatchError extends Error {}

export type EnsureCloudFleetSandboxInput = {
  /** Cloud UUID or unified rw_* workspace id. */
  workspaceId: string;
  /** Opt in to Cloud's durable, poll-driven Agent37 preparation contract. */
  preparationMode?: 'async-v1';
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
  /** Exact lowercase HEAD attestation expected for each requested repository. */
  repoRevisions?: Readonly<Record<string, string>>;
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

type CloudFleetSandboxReadyBase = {
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
  /** Repository HEADs verified by Cloud for this sandbox. */
  repoRevisions?: Readonly<Record<string, string>>;
};

/** Daytona responses always carry the independently attested provider UUID. */
export type CloudFleetSandboxReady =
  | (CloudFleetSandboxReadyBase & {
      providerId: 'daytona';
      providerSandboxId: string;
    })
  | (CloudFleetSandboxReadyBase & {
      providerId?: Exclude<CloudFleetSandboxProviderId, 'daytona'>;
    });

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
  /** Repository HEADs verified by Cloud for this sandbox. */
  repoRevisions?: Readonly<Record<string, string>>;
};

type CloudFleetSandboxProvisioningTimeoutBase = {
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

/** Daytona timeout responses also prove the provider UUID before they are surfaced. */
export type CloudFleetSandboxProvisioningTimeout =
  | (CloudFleetSandboxProvisioningTimeoutBase & {
      providerId: 'daytona';
      providerSandboxId: string;
    })
  | (CloudFleetSandboxProvisioningTimeoutBase & {
      providerId?: Exclude<CloudFleetSandboxProviderId, 'daytona'>;
    });

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
  const timeoutMs = normalizeTimerMs(
    options.timeoutMs ?? defaultTimeoutMs,
    false,
    'Cloud fleet request timeout'
  );
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
}

function normalizeTimerMs(value: number, allowZero: boolean, label: string): number {
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(
      `${label} must be a finite ${allowZero ? 'non-negative' : 'positive'} number of milliseconds.`
    );
  }
  return value === 0 ? 0 : Math.min(MAX_TIMER_MS, Math.max(1, Math.floor(value)));
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

function retryAfterDelayMs(response: Response): number | null {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_TIMER_MS, Math.max(0, Math.ceil(seconds * 1000)));
  }
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return null;
  return Math.min(MAX_TIMER_MS, Math.max(0, retryAt - Date.now()));
}

function requiredString(payload: JsonRecord, key: string, context: string): string {
  const value = readString(payload, key);
  if (!value) throw new Error(`${context} response is missing ${key}.`);
  return value;
}

const REPOSITORY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const REPOSITORY_REVISION_PATTERN = /^[0-9a-f]{40}$/;

function validateRequestedRepos(repos: readonly string[] | undefined): void {
  if (repos === undefined || repos.length === 0) return;
  if (repos.length > 16) {
    throw new Error('Cloud fleet sandbox requests may include at most 16 repositories.');
  }
  const seen = new Set<string>();
  const seenCheckoutNames = new Set<string>();
  for (const repo of repos) {
    const normalizedRepo = repo.toLowerCase();
    if (seen.has(normalizedRepo)) {
      throw new Error('Cloud fleet sandbox repositories must not contain duplicates.');
    }
    seen.add(normalizedRepo);
    const slash = repo.lastIndexOf('/');
    const checkoutName = (slash === -1 ? repo : repo.slice(slash + 1)).toLowerCase();
    if (seenCheckoutNames.has(checkoutName)) {
      throw new Error('Cloud fleet sandbox repositories must have unique checkout names.');
    }
    seenCheckoutNames.add(checkoutName);
  }
}

function validateRepoRevisions(
  repos: readonly string[] | undefined,
  repoRevisions: Readonly<Record<string, string>> | undefined
): Record<string, string> | undefined {
  if (repoRevisions === undefined) return undefined;
  const entries = Object.entries(repoRevisions);
  const allowedRepos = new Set(repos ?? []);
  if (
    entries.length === 0 ||
    entries.length > 16 ||
    repos === undefined ||
    repos.length > 16 ||
    repos.length !== allowedRepos.size ||
    entries.length !== allowedRepos.size
  ) {
    throw new Error(
      'Cloud fleet sandbox revisions must cover every requested repository exactly once (maximum 16).'
    );
  }
  for (const [repo, revision] of entries) {
    if (!REPOSITORY_KEY_PATTERN.test(repo) || repo.includes('..')) {
      throw new Error(`Cloud fleet sandbox repository key '${repo}' must use owner/name form.`);
    }
    if (!allowedRepos.has(repo)) {
      throw new Error(`Cloud fleet sandbox repository revision '${repo}' is not present in repos.`);
    }
    if (!REPOSITORY_REVISION_PATTERN.test(revision)) {
      throw new Error(
        `Cloud fleet sandbox revision for '${repo}' must be exactly 40 lowercase hexadecimal characters.`
      );
    }
  }
  return Object.fromEntries(entries);
}

function parseRepositoryIdentity(repository: string): { owner: string; repo: string } {
  const normalized = repository.trim();
  if (!REPOSITORY_KEY_PATTERN.test(normalized) || normalized.includes('..')) {
    throw new Error('Cloud Relayfile repository must use GitHub owner/name form.');
  }
  const [owner, repo] = normalized.split('/');
  return { owner: owner!, repo: repo! };
}

function expectedRelayfileRepositoryPaths(
  owner: string,
  repo: string
): {
  contentRoot: string;
  sentinelPath: string;
} {
  const root = `/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return {
    contentRoot: `${root}/contents`,
    sentinelPath: `${root}/.relayfile/clone.json`,
  };
}

function waitForDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function readRepoRevisions(payload: JsonRecord): Record<string, string> | undefined {
  const value = payload.repoRevisions;
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error('Cloud fleet sandbox response has invalid repoRevisions.');
  const revisions: Record<string, string> = {};
  for (const [repo, revision] of Object.entries(value)) {
    if (
      !REPOSITORY_KEY_PATTERN.test(repo) ||
      repo.includes('..') ||
      typeof revision !== 'string' ||
      !REPOSITORY_REVISION_PATTERN.test(revision)
    ) {
      throw new Error('Cloud fleet sandbox response has invalid repoRevisions.');
    }
    revisions[repo] = revision;
  }
  return revisions;
}

function assertRepoRevisions(
  payload: JsonRecord,
  expected: Readonly<Record<string, string>> | undefined
): Record<string, string> | undefined {
  const actual = readRepoRevisions(payload);
  if (expected === undefined) return actual;
  if (
    actual === undefined ||
    Object.keys(actual).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([repo, revision]) => actual[repo] !== revision)
  ) {
    throw new Error(
      'Cloud did not echo the requested repository revisions; update Cloud before using --sandbox with a pinned checkout.'
    );
  }
  return actual;
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

/**
 * A malformed success response can still leave a billable sandbox behind. It
 * is safe to delete only when the response itself confirms the exact
 * caller-checkpointed identity; never promote a returned or ambient identity
 * to cleanup authority.
 */
function confirmsProvisionedSandboxIdentity(
  payload: unknown,
  expectedSandboxId: string | undefined,
  expectedNodeName: string | undefined,
  requestedProviderId: CloudFleetSandboxProviderId | undefined
): boolean {
  if (!isObject(payload) || expectedSandboxId === undefined || requestedProviderId !== 'daytona')
    return false;
  // A timeout is also a response from an accepted provision request. When it
  // echoes the exact caller-checkpointed public identity, Cloud can safely
  // delete that one sandbox even if the provider UUID is malformed or absent.
  if (!['provisioned', 'provisioning_timeout'].includes(readString(payload, 'outcome') ?? '')) return false;
  if (readString(payload, 'sandboxId') !== expectedSandboxId) return false;
  if (expectedNodeName !== undefined && readString(payload, 'nodeName') !== expectedNodeName) return false;
  return readString(payload, 'providerId') === requestedProviderId;
}

function confirmsAsyncPreparedSandboxIdentity(
  payload: unknown,
  expectedSandboxId: string,
  expectedNodeName: string | undefined,
  requestedProviderId: CloudFleetSandboxProviderId | undefined
): boolean {
  if (!isObject(payload) || requestedProviderId === undefined) return false;
  if (readString(payload, 'outcome') !== 'provisioned') return false;
  if (readString(payload, 'sandboxId') !== expectedSandboxId) return false;
  if (expectedNodeName !== undefined && readString(payload, 'nodeName') !== expectedNodeName) return false;
  return readString(payload, 'providerId') === requestedProviderId;
}

function normalizeEnsureResult(
  payload: unknown,
  cloudWorkspaceId: string,
  expectedSandboxId?: string,
  expectedNodeName?: string,
  requestedProviderId?: CloudFleetSandboxProviderId,
  expectedRepoRevisions?: Readonly<Record<string, string>>
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
    const repoRevisions = assertRepoRevisions(payload, expectedRepoRevisions);
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
      ...(repoRevisions === undefined ? {} : { repoRevisions }),
      ...(readString(payload, 'relayfileMountPath')
        ? { relayfileMountPath: readString(payload, 'relayfileMountPath') }
        : {}),
    } as CloudFleetSandboxReady;
  }

  if (outcome === 'reused') {
    const relaycastTarget =
      payload.relaycastTarget === undefined ? undefined : normalizeRelaycastTarget(payload.relaycastTarget);
    assertProviderRelaycastTarget(providerId, relaycastTarget);
    const repoRevisions = assertRepoRevisions(payload, expectedRepoRevisions);
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
      ...(repoRevisions === undefined ? {} : { repoRevisions }),
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
    } as CloudFleetSandboxProvisioningTimeout;
  }

  throw new Error('Cloud fleet sandbox response has an unknown outcome.');
}

const ASYNC_PREPARATION_STATES = new Set(['pending', 'ready', 'terminal', 'cleanup_pending']);
const ASYNC_PREPARATION_PHASES = new Set([
  'provider_allocation',
  'agent_relay_cli_bootstrap',
  'relayfile_mount_bootstrap',
  'spawn_cli_bootstrap',
  'repo_clone',
  'finalize',
  'broker_visible',
  'cleanup',
]);

type AsyncPreparationEnvelope = CloudFleetSandboxPreparationProgress & {
  result?: JsonRecord;
  failure?: { code: string; error: string; phase: string; causeDetail?: string };
};

function readAsyncPreparationEnvelope(
  payload: unknown,
  expectedSandboxId: string
): AsyncPreparationEnvelope | null {
  if (!isObject(payload) || payload.mode !== 'async-v1' || payload.version !== 1) return null;
  const sandboxId = readString(payload, 'sandboxId');
  if (sandboxId !== expectedSandboxId) {
    throw new CloudFleetSandboxIdentityMismatchError(
      `Cloud returned sandboxId ${sandboxId ?? 'missing'} instead of requested sandboxId ${expectedSandboxId}.`
    );
  }
  const state = readString(payload, 'state');
  const phase = readString(payload, 'phase');
  const generation = readNumber(payload, 'generation');
  if (
    !state ||
    !ASYNC_PREPARATION_STATES.has(state) ||
    !phase ||
    !ASYNC_PREPARATION_PHASES.has(phase) ||
    generation === undefined ||
    !Number.isSafeInteger(generation) ||
    generation < 0
  ) {
    throw new Error('Cloud fleet sandbox preparation response was invalid.');
  }
  const envelope: AsyncPreparationEnvelope = {
    sandboxId,
    state: state as AsyncPreparationEnvelope['state'],
    phase,
    generation,
  };
  if (payload.result !== undefined) {
    if (!isObject(payload.result)) {
      throw new Error('Cloud fleet sandbox preparation result was invalid.');
    }
    envelope.result = payload.result;
  }
  if (payload.failure !== undefined) {
    if (!isObject(payload.failure)) {
      throw new Error('Cloud fleet sandbox preparation failure was invalid.');
    }
    const code = readString(payload.failure, 'code');
    const error = readString(payload.failure, 'error');
    const failurePhase = readString(payload.failure, 'phase');
    const causeDetail = readString(payload.failure, 'causeDetail');
    if (!code || !error || !failurePhase) {
      throw new Error('Cloud fleet sandbox preparation failure was invalid.');
    }
    envelope.failure = {
      code,
      error,
      phase: failurePhase,
      ...(causeDetail === undefined ? {} : { causeDetail }),
    };
  }
  return envelope;
}

function asyncPreparationRequestSignal(overall: AbortSignal): AbortSignal {
  return AbortSignal.any([overall, AbortSignal.timeout(ASYNC_PREPARATION_REQUEST_TIMEOUT_MS)]);
}

/**
 * Materialize one exact GitHub revision into the selected workspace's live
 * Relayfile tree and wait until the decoded working-tree mount can consume it.
 *
 * Cloud owns GitHub credential selection. The CLI sends only owner/name and
 * the exact pushed SHA; provider credentials never cross this boundary.
 */
export async function materializeCloudRelayfileRepository(
  input: MaterializeCloudRelayfileRepositoryInput,
  options: CloudRelayfileRepositoryMaterializeOptions = {}
): Promise<CloudRelayfileRepositoryMaterialization> {
  const workspaceId = input.workspaceId.trim();
  if (!workspaceId) throw new Error('A workspace ID is required to materialize a Relayfile repository.');
  const { owner, repo } = parseRepositoryIdentity(input.repository);
  const revision = input.revision.trim().toLowerCase();
  if (!REPOSITORY_REVISION_PATTERN.test(revision)) {
    throw new Error('Cloud Relayfile repository revision must be exactly 40 hexadecimal characters.');
  }
  const pollIntervalMs = normalizeTimerMs(
    options.pollIntervalMs ?? DEFAULT_RELAYFILE_REPOSITORY_POLL_INTERVAL_MS,
    false,
    'Cloud Relayfile repository poll interval'
  );

  const session = await ensureCloudSession({
    apiUrl: options.apiUrl || defaultApiUrl(),
    interactive: false,
  });
  const resolutionSignal = boundedSignal(options, DEFAULT_RESOLUTION_TIMEOUT_MS);
  const resolved = await resolveCloudWorkspaceId(workspaceId, session.auth, resolutionSignal);
  const signal = boundedSignal(options, DEFAULT_RELAYFILE_REPOSITORY_MATERIALIZE_TIMEOUT_MS);
  let activeAuth = resolved.auth;

  const requestResult = await authorizedApiFetch(
    activeAuth,
    '/api/v1/github/clone/request',
    {
      method: 'POST',
      signal,
      body: JSON.stringify({
        workspaceId: resolved.cloudWorkspaceId,
        owner,
        repo,
        ref: revision,
        mode: 'full',
        sourceProfile: LIVE_RELAYFILE_SOURCE_PROFILE,
      }),
    },
    { interactive: false }
  );
  activeAuth = requestResult.auth;
  const requestPayload = await readJson(requestResult.response);
  if (!requestResult.response.ok) {
    throw endpointError('materialize the repository into Relayfile', requestResult.response, requestPayload);
  }
  if (!isObject(requestPayload)) {
    throw new Error('Cloud Relayfile repository materializer returned an invalid response.');
  }
  const jobId = requiredString(requestPayload, 'jobId', 'Cloud Relayfile repository materializer');
  const expectedPaths = expectedRelayfileRepositoryPaths(owner, repo);

  for (;;) {
    const statusResult = await authorizedApiFetch(
      activeAuth,
      `/api/v1/github/clone/status/${encodeURIComponent(jobId)}`,
      { method: 'GET', signal },
      { interactive: false }
    );
    activeAuth = statusResult.auth;
    const statusPayload = await readJson(statusResult.response);
    if (!statusResult.response.ok) {
      throw endpointError(
        'read Relayfile repository materialization status',
        statusResult.response,
        statusPayload
      );
    }
    if (!isObject(statusPayload) || !isObject(statusPayload.job)) {
      throw new Error('Cloud Relayfile repository materialization status was invalid.');
    }
    const job = statusPayload.job;
    const status = readString(job, 'status');
    if (status === 'failed') {
      const detail = readString(job, 'lastError');
      throw new Error(
        redactCredentialValues(
          `Cloud could not materialize ${owner}/${repo} at ${revision} into Relayfile${
            detail ? `: ${detail}.` : '.'
          } Verify that this exact commit is pushed to GitHub and that the pinned workspace's GitHub connection can read the repository, then retry.`
        )
      );
    }
    if (status === 'completed') {
      const jobOwner = readString(job, 'owner');
      const jobRepo = readString(job, 'repo');
      const jobRef = readString(job, 'ref');
      const headSha = readString(job, 'headSha')?.toLowerCase();
      const filesWritten = readNumber(job, 'filesWritten');
      const sourceProfile = readString(job, 'sourceProfile');
      const materialization = job.materialization;
      if (
        jobOwner !== owner ||
        jobRepo !== repo ||
        jobRef?.toLowerCase() !== revision ||
        headSha !== revision ||
        filesWritten === undefined ||
        !Number.isSafeInteger(filesWritten) ||
        filesWritten < 0 ||
        sourceProfile !== LIVE_RELAYFILE_SOURCE_PROFILE ||
        !isObject(materialization) ||
        readString(materialization, 'mode') !== 'relayfile_export' ||
        readString(materialization, 'sourceProfile') !== LIVE_RELAYFILE_SOURCE_PROFILE ||
        readNumber(materialization, 'filesExpected') !== filesWritten ||
        readString(materialization, 'headSha')?.toLowerCase() !== revision ||
        readString(materialization, 'contentRoot') !== expectedPaths.contentRoot ||
        readString(materialization, 'sentinelPath') !== expectedPaths.sentinelPath
      ) {
        throw new Error(
          `Cloud did not prove a live Relayfile working tree for ${owner}/${repo} at ${revision}.`
        );
      }
      return {
        cloudWorkspaceId: resolved.cloudWorkspaceId,
        repository: `${owner}/${repo}`,
        revision,
        filesWritten,
        sourceProfile: LIVE_RELAYFILE_SOURCE_PROFILE,
        ...expectedPaths,
      };
    }
    if (status !== 'queued' && status !== 'running' && status !== 'retrying') {
      throw new Error('Cloud Relayfile repository materialization reported an unknown status.');
    }
    await waitForDelay(pollIntervalMs, signal);
  }
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
  validateRequestedRepos(input.repos);
  const repoRevisions = validateRepoRevisions(input.repos, input.repoRevisions);
  const asyncPreparation = input.preparationMode === 'async-v1';
  if (asyncPreparation && sandboxIdentity.sandboxId === undefined) {
    throw new Error('Async Cloud fleet preparation requires a caller-declared sandboxId.');
  }
  // Async-v1 is the replay-safe Agent37 contract. Make the implicit default
  // explicit on the wire and in cleanup proof so a malformed ready result can
  // never lose the provider identity merely because the CLI omitted --provider.
  const requestedProviderId = asyncPreparation ? (input.providerId ?? 'agent37') : input.providerId;
  const preparationPollIntervalMs = normalizeTimerMs(
    options.preparationPollIntervalMs ?? DEFAULT_ASYNC_PREPARATION_POLL_INTERVAL_MS,
    false,
    'Cloud fleet preparation poll interval'
  );

  const session = await ensureCloudSession({
    apiUrl: options.apiUrl || defaultApiUrl(),
    interactive: false,
  });
  const resolutionSignal = boundedSignal(options, DEFAULT_RESOLUTION_TIMEOUT_MS);
  const resolved = await resolveCloudWorkspaceId(workspaceId, session.auth, resolutionSignal);
  const signal = boundedSignal(
    options,
    asyncPreparation ? DEFAULT_ASYNC_PREPARATION_TIMEOUT_MS : DEFAULT_ENSURE_TIMEOUT_MS
  );
  let activeAuth = resolved.auth;
  const ensureBody = JSON.stringify({
    workspaceId: resolved.cloudWorkspaceId,
    requiredCapability,
    ...(asyncPreparation ? { preparationMode: 'async-v1' } : {}),
    ...(sandboxIdentity.sandboxId === undefined ? {} : { sandboxId: sandboxIdentity.sandboxId }),
    ...(sandboxIdentity.name === undefined ? {} : { name: sandboxIdentity.name }),
    ...(input.maxAgents !== undefined ? { maxAgents: input.maxAgents } : {}),
    ...(input.mountRelayfile !== undefined ? { mountRelayfile: input.mountRelayfile } : {}),
    ...(input.relayfilePaths === undefined ? {} : { relayfilePaths: [...input.relayfilePaths] }),
    ...(input.forceProvision !== undefined ? { forceProvision: input.forceProvision } : {}),
    ...(requestedProviderId !== undefined ? { providerId: requestedProviderId } : {}),
    ...(input.workloadProfile !== undefined ? { workloadProfile: input.workloadProfile } : {}),
    ...(input.waitTimeoutMs !== undefined ? { waitTimeoutMs: input.waitTimeoutMs } : {}),
    ...(input.repos !== undefined && input.repos.length > 0 ? { repos: [...input.repos] } : {}),
    ...(repoRevisions === undefined ? {} : { repoRevisions }),
  });

  let sawAcceptedPreparation = false;
  let lastProgressSignature: string | undefined;
  const consumePreparation = (payload: unknown): EnsureCloudFleetSandboxResult | null => {
    const envelope = readAsyncPreparationEnvelope(payload, sandboxIdentity.sandboxId!);
    if (!envelope) return null;
    sawAcceptedPreparation = true;
    const signature = `${envelope.state}:${envelope.phase}:${envelope.generation}`;
    if (signature !== lastProgressSignature) {
      options.onPreparationProgress?.({
        sandboxId: envelope.sandboxId,
        state: envelope.state,
        phase: envelope.phase,
        generation: envelope.generation,
      });
      lastProgressSignature = signature;
    }
    if (envelope.state === 'ready') {
      try {
        if (!envelope.result) {
          throw new Error('Cloud fleet sandbox preparation completed without a result.');
        }
        return normalizeEnsureResult(
          envelope.result,
          resolved.cloudWorkspaceId,
          sandboxIdentity.sandboxId!,
          sandboxIdentity.name,
          requestedProviderId,
          repoRevisions
        );
      } catch (error) {
        const confirmedProvisioned = confirmsAsyncPreparedSandboxIdentity(
          envelope.result,
          sandboxIdentity.sandboxId!,
          sandboxIdentity.name,
          requestedProviderId
        );
        throw new CloudFleetSandboxProvisionError(
          error instanceof Error ? error.message : 'Cloud fleet sandbox preparation result was invalid.',
          {
            cloudWorkspaceId: resolved.cloudWorkspaceId,
            sandboxId: sandboxIdentity.sandboxId,
            ...(sandboxIdentity.name === undefined ? {} : { nodeName: sandboxIdentity.name }),
            ...(requestedProviderId === undefined ? {} : { providerId: requestedProviderId }),
            ...(confirmedProvisioned ? { confirmedProvisioned: true } : { outcomeUnknown: true }),
            cause: error,
          }
        );
      }
    }
    if (envelope.state === 'terminal') {
      const failure = envelope.failure;
      throw new CloudFleetSandboxProvisionError(
        redactCredentialValues(
          failure
            ? `Cloud fleet sandbox preparation failed during ${failure.phase}: ${failure.error}`
            : 'Cloud fleet sandbox preparation failed.'
        ),
        {
          cloudWorkspaceId: resolved.cloudWorkspaceId,
          sandboxId: sandboxIdentity.sandboxId,
          ...(sandboxIdentity.name === undefined ? {} : { nodeName: sandboxIdentity.name }),
          ...(requestedProviderId === undefined ? {} : { providerId: requestedProviderId }),
          confirmedProvisioned: true,
        }
      );
    }
    return null;
  };

  const pollPreparation = async (initialPayload?: unknown): Promise<EnsureCloudFleetSandboxResult> => {
    const unconfirmedDeadline = Date.now() + ASYNC_PREPARATION_REQUEST_TIMEOUT_MS;
    let payload = initialPayload;
    let method: 'GET' | 'POST' = initialPayload === undefined ? 'GET' : 'POST';
    let nextPollDelayMs: number | null = null;
    for (;;) {
      if (payload !== undefined) {
        const ready = consumePreparation(payload);
        if (ready) return ready;
      }
      if (!sawAcceptedPreparation && Date.now() >= unconfirmedDeadline) {
        throw new Error('Cloud fleet sandbox preparation was not accepted before the status deadline.');
      }
      const requestedDelayMs = nextPollDelayMs ?? preparationPollIntervalMs;
      nextPollDelayMs = null;
      const delayMs = sawAcceptedPreparation
        ? requestedDelayMs
        : Math.min(requestedDelayMs, Math.max(0, unconfirmedDeadline - Date.now()));
      await waitForDelay(delayMs, signal);
      // Do not start another full request after the short lost-ensure
      // reconciliation window. A long configured poll interval must not turn
      // the 110-second uncertainty bound into a 220-second network attempt.
      if (!sawAcceptedPreparation && Date.now() >= unconfirmedDeadline) {
        throw new Error('Cloud fleet sandbox preparation was not accepted before the status deadline.');
      }
      const path = `/api/v1/fleet/nodes/sandbox/${encodeURIComponent(
        sandboxIdentity.sandboxId!
      )}/preparation${
        method === 'GET' ? `?workspaceId=${encodeURIComponent(resolved.cloudWorkspaceId)}` : ''
      }`;
      let pollResponse: Response;
      try {
        const polled = await authorizedApiFetch(
          activeAuth,
          path,
          {
            method,
            signal: asyncPreparationRequestSignal(signal),
            ...(method === 'POST'
              ? { body: JSON.stringify({ workspaceId: resolved.cloudWorkspaceId }) }
              : {}),
          },
          { interactive: false }
        );
        activeAuth = polled.auth;
        pollResponse = polled.response;
      } catch (fetchError) {
        if (signal.aborted) throw signal.reason ?? fetchError;
        const errorName = fetchError instanceof Error ? fetchError.name : '';
        if (
          !(fetchError instanceof TypeError) &&
          errorName !== 'TimeoutError' &&
          errorName !== 'AbortError'
        ) {
          throw fetchError;
        }
        if (!sawAcceptedPreparation && Date.now() >= unconfirmedDeadline) {
          throw fetchError;
        }
        // A lost advance response is not replayed. Read durable status first;
        // only a confirmed pending record permits a later advance.
        method = 'GET';
        payload = undefined;
        continue;
      }
      payload = await readJson(pollResponse);
      const envelope = readAsyncPreparationEnvelope(payload, sandboxIdentity.sandboxId!);
      if (envelope) {
        const ready = consumePreparation(payload);
        if (ready) return ready;
        // Cleanup is owned by Cloud. Keep observing it until Cloud publishes a
        // terminal result; advancing here could race the reaper or restart work
        // on a sandbox that is already being destroyed.
        method = envelope.state === 'cleanup_pending' ? 'GET' : 'POST';
        payload = undefined;
        continue;
      }
      if (
        method === 'GET' &&
        pollResponse.status === 404 &&
        !sawAcceptedPreparation &&
        Date.now() < unconfirmedDeadline
      ) {
        payload = undefined;
        continue;
      }
      if (!pollResponse.ok) {
        if (
          (pollResponse.status >= 500 || pollResponse.status === 429) &&
          (sawAcceptedPreparation || Date.now() < unconfirmedDeadline)
        ) {
          if (pollResponse.status === 429) {
            nextPollDelayMs = retryAfterDelayMs(pollResponse) ?? preparationPollIntervalMs;
          }
          method = 'GET';
          payload = undefined;
          continue;
        }
        throw endpointError('read fleet sandbox preparation status', pollResponse, payload);
      }
      throw new Error('Cloud fleet sandbox preparation response was invalid.');
    }
  };

  let response: Response;
  try {
    const ensured = await authorizedApiFetch(
      activeAuth,
      '/api/v1/fleet/nodes/sandbox/ensure',
      {
        method: 'POST',
        signal: asyncPreparation ? asyncPreparationRequestSignal(signal) : signal,
        body: ensureBody,
      },
      { interactive: false }
    );
    activeAuth = ensured.auth;
    response = ensured.response;
  } catch (error) {
    if (asyncPreparation) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      if (error instanceof CloudAuthError) throw error;
      const errorName = error instanceof Error ? error.name : '';
      const retryableTransport =
        error instanceof TypeError || errorName === 'TimeoutError' || errorName === 'AbortError';
      if (!retryableTransport && !signal.aborted) throw error;
      try {
        return await pollPreparation();
      } catch (pollError) {
        if (pollError instanceof CloudFleetSandboxProvisionError) throw pollError;
        if (pollError instanceof CloudAuthError) throw pollError;
        if (options.signal?.aborted) throw options.signal.reason ?? pollError;
        throw new CloudFleetSandboxProvisionError(
          redactCredentialValues(
            `Cloud fleet sandbox preparation status could not be confirmed: ${
              pollError instanceof Error ? pollError.message : String(pollError)
            }`
          ),
          {
            cloudWorkspaceId: resolved.cloudWorkspaceId,
            sandboxId: sandboxIdentity.sandboxId,
            ...(sandboxIdentity.name === undefined ? {} : { nodeName: sandboxIdentity.name }),
            ...(requestedProviderId === undefined ? {} : { providerId: requestedProviderId }),
            ...(sawAcceptedPreparation ? { confirmedProvisioned: true } : { outcomeUnknown: true }),
            cause: pollError,
          }
        );
      }
    }
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
  if (asyncPreparation) {
    let envelope: AsyncPreparationEnvelope | null;
    try {
      envelope = readAsyncPreparationEnvelope(payload, sandboxIdentity.sandboxId!);
    } catch (error) {
      // A mismatched public identity is neither a truncated response nor an
      // ambiguous gateway failure. Polling the caller-declared identity would
      // hide the diagnostic and could point cleanup at the wrong sandbox.
      if (error instanceof CloudFleetSandboxIdentityMismatchError) throw error;
      envelope = null;
    }
    if (envelope) {
      const ready = consumePreparation(payload);
      if (ready) return ready;
      try {
        return await pollPreparation();
      } catch (pollError) {
        if (pollError instanceof CloudFleetSandboxProvisionError) throw pollError;
        if (pollError instanceof CloudAuthError) throw pollError;
        if (options.signal?.aborted) throw options.signal.reason ?? pollError;
        throw new CloudFleetSandboxProvisionError(
          redactCredentialValues(
            `Cloud fleet sandbox preparation did not complete: ${
              pollError instanceof Error ? pollError.message : String(pollError)
            }`
          ),
          {
            cloudWorkspaceId: resolved.cloudWorkspaceId,
            sandboxId: sandboxIdentity.sandboxId,
            ...(sandboxIdentity.name === undefined ? {} : { nodeName: sandboxIdentity.name }),
            ...(requestedProviderId === undefined ? {} : { providerId: requestedProviderId }),
            confirmedProvisioned: true,
            cause: pollError,
          }
        );
      }
    }
    // A successful/accepted response can still lose or truncate its body after
    // Cloud durably recorded the preparation. Reconcile every non-envelope
    // async response through the declared sandbox's status endpoint instead of
    // falling through to legacy response parsing or replaying ensure.
    if (response.ok || response.status >= 500) {
      try {
        return await pollPreparation();
      } catch (pollError) {
        if (pollError instanceof CloudFleetSandboxProvisionError) throw pollError;
        if (pollError instanceof CloudAuthError) throw pollError;
        if (options.signal?.aborted) throw options.signal.reason ?? pollError;
        throw new CloudFleetSandboxProvisionError(
          redactCredentialValues(
            `Cloud fleet sandbox preparation status could not be confirmed: ${
              pollError instanceof Error ? pollError.message : String(pollError)
            }`
          ),
          {
            cloudWorkspaceId: resolved.cloudWorkspaceId,
            sandboxId: sandboxIdentity.sandboxId,
            ...(sandboxIdentity.name === undefined ? {} : { nodeName: sandboxIdentity.name }),
            ...(requestedProviderId === undefined ? {} : { providerId: requestedProviderId }),
            ...(sawAcceptedPreparation ? { confirmedProvisioned: true } : { outcomeUnknown: true }),
            cause: pollError,
          }
        );
      }
    }
  }
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
        ...(requestedProviderId === undefined ? {} : { providerId: requestedProviderId }),
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
        ...(requestedProviderId === undefined ? {} : { providerId: requestedProviderId }),
        outcomeUnknown: true,
        cause: error,
      });
    }
    if (isObject(payload) && readString(payload, 'sandboxId')) {
      throw new CloudFleetSandboxProvisionError(error.message, {
        cloudWorkspaceId: resolved.cloudWorkspaceId,
        ...(sandboxIdentity.sandboxId === undefined ? {} : { sandboxId: sandboxIdentity.sandboxId }),
        ...(sandboxIdentity.name === undefined ? {} : { nodeName: sandboxIdentity.name }),
        ...(requestedProviderId === undefined ? {} : { providerId: requestedProviderId }),
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
      requestedProviderId,
      repoRevisions
    );
  } catch (error) {
    const confirmedProvisioned = confirmsProvisionedSandboxIdentity(
      payload,
      sandboxIdentity.sandboxId,
      sandboxIdentity.name,
      requestedProviderId
    );
    throw new CloudFleetSandboxProvisionError(
      error instanceof Error ? error.message : 'Cloud fleet sandbox response was invalid.',
      {
        cloudWorkspaceId: resolved.cloudWorkspaceId,
        ...(sandboxIdentity.sandboxId === undefined ? {} : { sandboxId: sandboxIdentity.sandboxId }),
        ...(sandboxIdentity.name === undefined ? {} : { nodeName: sandboxIdentity.name }),
        ...(requestedProviderId === undefined ? {} : { providerId: requestedProviderId }),
        ...(confirmedProvisioned ? { confirmedProvisioned: true } : { outcomeUnknown: true }),
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
