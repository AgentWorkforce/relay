import os from 'node:os';

import { defaultApiUrl } from './types.js';

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

function isFleetNodeEnrollment(value: unknown): value is FleetNodeEnrollment {
  if (!ensurePlainObject(value)) return false;
  return (
    typeof value.nodeToken === 'string' &&
    value.nodeToken.trim().length > 0 &&
    typeof value.relaycastUrl === 'string' &&
    value.relaycastUrl.trim().length > 0 &&
    typeof value.relayWorkspaceId === 'string'
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
