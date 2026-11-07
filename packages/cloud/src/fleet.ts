import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultApiUrl } from './types.js';
import { cloudHome } from './worker.js';

/**
 * Credentials returned by the Cloud node-enrollment register endpoint
 * (`/api/v1/fleet/register`). A one-time enrollment token is exchanged for these
 * long-lived node credentials, which then configure the served fleet node.
 *
 * Mirrors the response shape of
 * cloud/packages/web/app/api/v1/fleet/register/route.ts.
 */
export type FleetNodeEnrollment = {
  nodeId: string;
  nodeName: string;
  nodeToken: string;
  relayWorkspaceId: string;
  relaycastUrl: string;
  websocketUrl: string;
};

export type EnrollFleetNodeInput = {
  /** One-time enrollment token minted by Cloud (`ocl_node_enr_...`). */
  enrollmentToken: string;
  /**
   * Cloud enrollment endpoint that redeems the token. Cloud mints this as
   * `https://<origin>/api/v1/fleet/register`.
   */
  enrollmentUrl: string;
  /** Optional node name override; otherwise the enrollment record's name is used. */
  name?: string;
  /** Optional capability override/augment for the registered node. */
  capabilities?: string[];
  /** Optional max-agents override for the registered node. */
  maxAgents?: number;
  /** Optional tags override for the registered node. */
  tags?: string[];
  /** Optional version string reported to Cloud (defaults to host info). */
  version?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

function ensurePlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeEnrollmentUrl(value?: string): string {
  const raw = value?.trim();
  if (!raw) {
    // Fall back to the configured Cloud API origin if the caller omitted a URL.
    return `${defaultApiUrl().replace(/\/+$/, '')}/api/v1/fleet/register`;
  }
  try {
    return new URL(raw).toString();
  } catch {
    throw new Error(`Invalid enrollment URL: ${raw}`);
  }
}

function normalizeStringList(values?: string[]): string[] | undefined {
  if (values === undefined) return undefined;
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return response.json().catch(() => null);
  }
  const text = await response.text().catch(() => '');
  return text ? { error: text } : null;
}

function enrollmentError(response: Response, payload: unknown): Error {
  // Prefer the JSON {error} field. For non-JSON bodies (e.g. an HTML 404 page
  // when the URL is wrong) fall back to the status line rather than dumping the
  // raw markup into the operator's terminal.
  const rawError =
    ensurePlainObject(payload) && typeof payload.error === 'string' ? payload.error.trim() : '';
  const looksLikeMarkup = rawError.startsWith('<') || rawError.length > 200;
  const detail = rawError && !looksLikeMarkup ? rawError : `${response.status} ${response.statusText}`.trim();

  // The register endpoint returns 401 "Invalid enrollment token" for tokens that
  // are expired, already consumed, or never minted. Give the operator a clear,
  // actionable message — enrollment tokens are one-time and short-lived.
  if (response.status === 401 || /invalid enrollment token/i.test(detail)) {
    return new Error(
      'Enrollment token is invalid, expired, or already used. Mint a fresh token from the Cloud "Enroll node" command and retry.'
    );
  }
  if (response.status === 429) {
    return new Error('Enrollment rate limit exceeded; wait a moment and retry.');
  }
  return new Error(`Node enrollment failed: ${detail}`);
}

/**
 * Validate the register endpoint's response carries the credentials we depend
 * on. The required trio (nodeToken/relaycastUrl/relayWorkspaceId) must be present
 * non-empty strings; the optional fields (nodeId/nodeName/websocketUrl), which we
 * fill in with derived defaults below, must be strings when present so a
 * malformed server response is rejected rather than silently coerced.
 */
function isFleetNodeEnrollment(value: unknown): value is Partial<FleetNodeEnrollment> & {
  nodeToken: string;
  relaycastUrl: string;
  relayWorkspaceId: string;
} {
  if (!ensurePlainObject(value)) return false;
  return (
    typeof value.nodeToken === 'string' &&
    value.nodeToken.trim().length > 0 &&
    typeof value.relaycastUrl === 'string' &&
    value.relaycastUrl.trim().length > 0 &&
    typeof value.relayWorkspaceId === 'string' &&
    value.relayWorkspaceId.trim().length > 0 &&
    (value.nodeId === undefined || typeof value.nodeId === 'string') &&
    (value.nodeName === undefined || typeof value.nodeName === 'string') &&
    (value.websocketUrl === undefined || typeof value.websocketUrl === 'string')
  );
}

/**
 * Exchange a one-time fleet-node enrollment token for durable node credentials.
 *
 * Models the worker enrollment exchange (registerCloudWorker in ./worker.ts):
 * a single unauthenticated POST that redeems the token and returns credentials
 * used to serve the node. Unlike worker registration there is no local store —
 * an enrolled node is configured per-invocation from the returned credentials.
 */
export async function enrollFleetNode(input: EnrollFleetNodeInput): Promise<FleetNodeEnrollment> {
  const fetcher = input.fetchImpl ?? fetch;
  const enrollmentToken = input.enrollmentToken.trim();
  if (!enrollmentToken) {
    throw new Error('An enrollment token is required to enroll a fleet node.');
  }
  const url = normalizeEnrollmentUrl(input.enrollmentUrl);
  const capabilities = normalizeStringList(input.capabilities);
  const tags = normalizeStringList(input.tags);
  const name = input.name?.trim();

  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enrollmentToken,
      ...(name ? { name } : {}),
      ...(capabilities !== undefined ? { capabilities } : {}),
      ...(input.maxAgents !== undefined ? { maxAgents: input.maxAgents } : {}),
      ...(tags !== undefined ? { tags } : {}),
      version: input.version?.trim() || `relay-cli/${os.platform()}-${os.arch()}`,
    }),
    signal: input.signal,
  });

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw enrollmentError(response, payload);
  }
  if (!isFleetNodeEnrollment(payload)) {
    throw new Error('Node enrollment response is missing node credentials.');
  }
  return {
    nodeId: typeof payload.nodeId === 'string' ? payload.nodeId : '',
    nodeName: typeof payload.nodeName === 'string' ? payload.nodeName : (name ?? ''),
    nodeToken: payload.nodeToken.trim(),
    relayWorkspaceId: payload.relayWorkspaceId,
    relaycastUrl: payload.relaycastUrl.replace(/\/+$/, ''),
    websocketUrl:
      typeof payload.websocketUrl === 'string' && payload.websocketUrl.trim()
        ? payload.websocketUrl.trim()
        : `${payload.relaycastUrl.replace(/\/+$/, '')}/v1/node/ws`,
  };
}

// ── Durable node-enrollment persistence ──────────────────────────────────────
// A CLI-owned JSON store that records enrolled fleet-node credentials, mirroring
// the cloud-workers.json store in ./worker.ts. Unlike worker registration, an
// enrolled node has no server-side session to reconcile; the store simply lets
// the CLI re-serve a previously enrolled node without re-running enrollment.

/**
 * A persisted fleet-node enrollment: the enrollment credentials plus the local
 * timestamp at which they were recorded.
 */
export type FleetNodeEnrollmentRecord = FleetNodeEnrollment & {
  /** ISO 8601 timestamp of when the enrollment was persisted locally. */
  enrolledAt: string;
};

/**
 * On-disk shape of the fleet-node enrollment store. `nodes` is keyed by
 * `${relaycastUrl}#${relayWorkspaceId}`; `active` maps a relaycast base-url key
 * to the node key most recently enrolled for that base URL.
 */
export type FleetNodeEnrollmentStore = {
  version: 1;
  active: Record<string, string>;
  nodes: Record<string, FleetNodeEnrollmentRecord>;
};

function normalizeStoreBaseUrl(value: string): string {
  // Trim trailing slashes with a loop rather than a `/\/+$/` regex — CodeQL
  // flags that pattern as polynomial on adversarial many-slash inputs.
  let normalized = value.trim();
  while (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function fleetNodeEnrollmentKey(relaycastUrl: string, relayWorkspaceId: string): string {
  return `${normalizeStoreBaseUrl(relaycastUrl)}#${relayWorkspaceId.trim()}`;
}

function fleetNodeActiveBaseKey(relaycastUrl: string): string {
  return normalizeStoreBaseUrl(relaycastUrl);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Structural guard for a persisted enrollment record. Malformed entries are
 * dropped so a corrupt store reads as empty rather than throwing.
 */
function isFleetNodeEnrollmentRecord(value: unknown): value is FleetNodeEnrollmentRecord {
  if (!ensurePlainObject(value)) return false;
  return (
    typeof value.nodeId === 'string' &&
    typeof value.nodeName === 'string' &&
    typeof value.nodeToken === 'string' &&
    typeof value.relayWorkspaceId === 'string' &&
    typeof value.relaycastUrl === 'string' &&
    typeof value.websocketUrl === 'string' &&
    typeof value.enrolledAt === 'string'
  );
}

/**
 * Absolute path to the fleet-node enrollment store.
 * @param env - Process environment (for `AGENT_RELAY_HOME` override).
 */
export function fleetNodeEnrollmentStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cloudHome(env), 'fleet-enrollments.json');
}

/**
 * Read the fleet-node enrollment store. A missing or malformed file reads as an
 * empty store.
 * @param env - Process environment (for `AGENT_RELAY_HOME` override).
 */
export function readFleetNodeEnrollmentStore(env: NodeJS.ProcessEnv = process.env): FleetNodeEnrollmentStore {
  const file = fleetNodeEnrollmentStorePath(env);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    if (!ensurePlainObject(parsed)) {
      return { version: 1, active: {}, nodes: {} };
    }
    const nodes: Record<string, FleetNodeEnrollmentRecord> = {};
    const rawNodes = ensurePlainObject(parsed.nodes) ? parsed.nodes : {};
    for (const [key, value] of Object.entries(rawNodes)) {
      if (isFleetNodeEnrollmentRecord(value)) {
        nodes[key] = value;
      }
    }
    const active: Record<string, string> = {};
    const rawActive = ensurePlainObject(parsed.active) ? parsed.active : {};
    for (const [key, value] of Object.entries(rawActive)) {
      if (typeof value === 'string') {
        active[key] = value;
      }
    }
    return { version: 1, active, nodes };
  } catch (error) {
    // A missing file reads as an empty store. Malformed JSON does NOT: an
    // upsert over a silently-emptied store would erase every stored
    // enrollment, so corruption must surface loudly instead (matches the
    // cloud-workers.json store in ./worker.ts).
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { version: 1, active: {}, nodes: {} };
    }
    if (error instanceof SyntaxError) {
      throw new Error(
        `Fleet enrollment store at ${file} is corrupt (${error.message}). ` +
          'Repair or remove the file, then re-enroll if records are lost.'
      );
    }
    throw error;
  }
}

/**
 * Persist the fleet-node enrollment store with owner-only permissions.
 * @param store - The store to write.
 * @param env - Process environment (for `AGENT_RELAY_HOME` override).
 */
export function writeFleetNodeEnrollmentStore(
  store: FleetNodeEnrollmentStore,
  env: NodeJS.ProcessEnv = process.env
): void {
  const file = fleetNodeEnrollmentStorePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Write-then-rename so a crash mid-write can never leave a torn (corrupt)
  // store behind — these records hold one-time-redeemable node credentials.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/**
 * Insert or replace an enrollment record and mark it active for its base URL.
 * @param record - The enrollment record to persist.
 * @param env - Process environment (for `AGENT_RELAY_HOME` override).
 * @returns The updated store.
 */
export function upsertFleetNodeEnrollment(
  record: FleetNodeEnrollmentRecord,
  env: NodeJS.ProcessEnv = process.env
): FleetNodeEnrollmentStore {
  const store = readFleetNodeEnrollmentStore(env);
  const key = fleetNodeEnrollmentKey(record.relaycastUrl, record.relayWorkspaceId);
  store.nodes[key] = record;
  store.active[fleetNodeActiveBaseKey(record.relaycastUrl)] = key;
  writeFleetNodeEnrollmentStore(store, env);
  return store;
}

/**
 * Resolve a stored enrollment, optionally narrowed by base URL, workspace,
 * and/or node identity.
 *
 * @param input - Optional `baseUrl`/`workspaceId` selectors and env override.
 * @returns The matching record, or `undefined` when none match.
 * @throws When multiple records match and the selectors do not disambiguate.
 */
export function resolveActiveFleetNodeEnrollment(
  input: { baseUrl?: string; workspaceId?: string; nodeId?: string; env?: NodeJS.ProcessEnv } = {}
): FleetNodeEnrollmentRecord | undefined {
  const store = readFleetNodeEnrollmentStore(input.env);
  const baseUrl = input.baseUrl ? normalizeStoreBaseUrl(input.baseUrl) : undefined;
  const workspaceId = input.workspaceId?.trim() || undefined;
  const nodeId = input.nodeId?.trim() || undefined;

  if (baseUrl && workspaceId) {
    const record = store.nodes[fleetNodeEnrollmentKey(baseUrl, workspaceId)];
    return record && (nodeId === undefined || record.nodeId.trim() === nodeId) ? record : undefined;
  }

  const records = Object.values(store.nodes);
  const matches = records.filter(
    (record) =>
      (baseUrl === undefined || normalizeStoreBaseUrl(record.relaycastUrl) === baseUrl) &&
      (workspaceId === undefined || record.relayWorkspaceId.trim() === workspaceId) &&
      (nodeId === undefined || record.nodeId.trim() === nodeId)
  );
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length === 1) {
    return matches[0];
  }

  // Multiple candidates: fall back to the active pointer when a base URL narrows
  // the set to a single most-recent enrollment.
  if (baseUrl) {
    const activeKey = store.active[fleetNodeActiveBaseKey(baseUrl)];
    const active = activeKey ? store.nodes[activeKey] : undefined;
    if (active && matches.includes(active)) {
      return active;
    }
  }

  const candidates = matches.map((record) => `${record.relaycastUrl}#${record.relayWorkspaceId}`).join(', ');
  throw new Error(
    `Multiple fleet node enrollments match; pass baseUrl and workspaceId to disambiguate. Candidates: ${candidates}.`
  );
}
