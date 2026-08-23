export type LiveTeleportWorkspaceSource = {
  kind: 'relayfile-checkpoint-seal';
  receipt: Record<string, unknown>;
};

export type LiveTeleportPrewarmInput = {
  sessionId: string;
  generation: number;
  workspaceRoot: string;
  idempotencyKey: string;
  signal?: AbortSignal;
};

export type LiveTeleportPrewarm = {
  prewarmId: string;
  generation: number;
  status: 'warming' | 'ready';
};

export type LiveTeleportAcquireInput = LiveTeleportPrewarmInput & {
  threadId: string;
  source: LiveTeleportWorkspaceSource;
  prewarmId?: string;
};

export type LiveTeleportConvergenceWatermark = {
  cursor: string;
  manifestSha256: string;
  files: number;
  bytes: number;
  conflictArtifacts: string[];
  conflictDigest: string;
};

export type LiveTeleportConvergenceProof = {
  verdict: 'converged';
  source: LiveTeleportConvergenceWatermark & { sealedAt: string };
  destination: LiveTeleportConvergenceWatermark & {
    pendingWriteback: 0;
    hasPendingWriteback: false;
    outboxNeedsAttention: false;
    ephemeralPaths: [];
  };
};

export type LiveTeleportEnvironment = {
  sessionId: string;
  generation: number;
  environmentId: string;
  /** Relative, provider-neutral path returned by Cloud. */
  connectPath: string;
  /** Derived locally from the constructor-pinned Cloud gateway origin. */
  execServerUrl: string;
  workspaceCwd: string;
  expiresAt: string;
  convergence: LiveTeleportConvergenceProof;
};

export type LiveTeleportRevokeInput = {
  sessionId: string;
  generation: number;
  idempotencyKey: string;
  signal?: AbortSignal;
};

export type LiveTeleportStatusInput = {
  sessionId: string;
  generation: number;
  prewarmId?: string;
  signal?: AbortSignal;
};

export type LiveTeleportLifecycleStatus = {
  sessionId: string;
  generation: number;
  status: 'warming' | 'ready' | 'failed' | 'revoked' | 'expired';
  prewarmId?: string;
  retryAfterMs?: number;
  expiresAt?: string;
};

export type LiveTeleportRevocation = LiveTeleportLifecycleStatus & {
  status: 'revoked' | 'expired';
};

export interface LiveTeleportCloudClient {
  prewarm(input: LiveTeleportPrewarmInput): Promise<LiveTeleportPrewarm>;
  status(input: LiveTeleportStatusInput): Promise<LiveTeleportLifecycleStatus>;
  acquire(input: LiveTeleportAcquireInput): Promise<LiveTeleportEnvironment>;
  revoke(input: LiveTeleportRevokeInput): Promise<LiveTeleportRevocation>;
}

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

const FORBIDDEN_PROVIDER_FIELD =
  /(?:provider.*(?:url|token|credential)|trafficAccessToken|signedPreviewUrl)/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertNoProviderSecrets(value: unknown, path = 'response'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoProviderSecrets(entry, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;

  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_PROVIDER_FIELD.test(key)) {
      throw new Error(`Cloud live-teleport response exposed forbidden provider field ${path}.${key}.`);
    }
    assertNoProviderSecrets(entry, `${path}.${key}`);
  }
}

async function readPayload(response: Response): Promise<unknown> {
  const payload = (await response.json().catch(() => null)) as unknown;
  assertNoProviderSecrets(payload);
  if (!response.ok) {
    // Cloud error prose can accidentally interpolate an opaque ticket or
    // provider URL. Only a short machine code is safe to relay to callers.
    const detail =
      isObject(payload) && typeof payload.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(payload.code)
        ? payload.code
        : response.statusText;
    throw new Error(`Cloud live-teleport request failed (${response.status}): ${detail || 'unknown error'}`);
  }
  return payload;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Cloud live-teleport response is missing ${field}.`);
  }
  return value.trim();
}

function requiredGeneration(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error('Cloud live-teleport response has an invalid generation.');
  }
  return Number(value);
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  return requiredNonNegativeInteger(value, field);
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Cloud live-teleport convergence proof has an invalid ${field}.`);
  }
  return Number(value);
}

function requiredStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Cloud live-teleport convergence proof has an invalid ${field}.`);
  }
  return value as string[];
}

function requiredDigest(value: unknown, field: string): string {
  const digest = requiredString(value, field);
  if (!/^[a-f0-9]{64}$/i.test(digest)) {
    throw new Error(`Cloud live-teleport convergence proof has an invalid ${field}.`);
  }
  return digest.toLowerCase();
}

function requiredWatermark(value: unknown, field: string): LiveTeleportConvergenceWatermark {
  if (!isObject(value)) throw new Error(`Cloud live-teleport convergence proof is missing ${field}.`);
  return {
    cursor: requiredString(value.cursor, `${field}.cursor`),
    manifestSha256: requiredDigest(value.manifestSha256, `${field}.manifestSha256`),
    files: requiredNonNegativeInteger(value.files, `${field}.files`),
    bytes: requiredNonNegativeInteger(value.bytes, `${field}.bytes`),
    conflictArtifacts: requiredStringArray(value.conflictArtifacts, `${field}.conflictArtifacts`),
    conflictDigest: requiredDigest(value.conflictDigest, `${field}.conflictDigest`),
  };
}

function parseCounter(value: string): { prefix: string; ordinal: number } | null {
  const match = /^([A-Za-z][A-Za-z0-9]*_)?(\d+)$/.exec(value);
  if (!match) return null;
  const ordinal = Number.parseInt(match[2]!, 10);
  return Number.isSafeInteger(ordinal) ? { prefix: match[1] ?? '', ordinal } : null;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function requiredConvergenceProof(value: unknown): LiveTeleportConvergenceProof {
  if (!isObject(value) || value.verdict !== 'converged') {
    throw new Error('Cloud live-teleport acquire did not return a converged hash/cursor proof.');
  }
  const source = requiredWatermark(value.source, 'source');
  const destination = requiredWatermark(value.destination, 'destination');
  const sourceObject = value.source as Record<string, unknown>;
  const destinationObject = value.destination as Record<string, unknown>;
  const sealedAt = requiredString(sourceObject.sealedAt, 'source.sealedAt');
  if (Number.isNaN(Date.parse(sealedAt))) {
    throw new Error('Cloud live-teleport convergence proof has an invalid source.sealedAt.');
  }
  const sourceCursor = parseCounter(source.cursor);
  const destinationCursor = parseCounter(destination.cursor);
  const sameCursorNamespace =
    sourceCursor && destinationCursor && sourceCursor.prefix === destinationCursor.prefix;
  const hashesMatch =
    source.manifestSha256 === destination.manifestSha256 &&
    source.files === destination.files &&
    source.bytes === destination.bytes &&
    sameStrings([...source.conflictArtifacts].sort(), [...destination.conflictArtifacts].sort()) &&
    source.conflictDigest === destination.conflictDigest;
  const outboxHealthy =
    destinationObject.pendingWriteback === 0 &&
    destinationObject.hasPendingWriteback === false &&
    destinationObject.outboxNeedsAttention === false &&
    Array.isArray(destinationObject.ephemeralPaths) &&
    destinationObject.ephemeralPaths.length === 0;
  if (
    !sameCursorNamespace ||
    destinationCursor.ordinal < sourceCursor.ordinal ||
    !hashesMatch ||
    !outboxHealthy
  ) {
    throw new Error('Cloud live-teleport acquire returned a non-converged hash/cursor proof.');
  }
  return {
    verdict: 'converged',
    source: { ...source, sealedAt },
    destination: {
      ...destination,
      pendingWriteback: 0,
      hasPendingWriteback: false,
      outboxNeedsAttention: false,
      ephemeralPaths: [],
    },
  };
}

/**
 * Provider-neutral Cloud control-plane client. The only execution address Relay
 * accepts is Cloud's short-lived WSS bridge; raw provider URLs and credentials
 * are rejected even if a buggy server includes them in an otherwise-valid body.
 */
export class CloudLiveTeleportClient implements LiveTeleportCloudClient {
  private readonly gatewayOrigin: URL;

  constructor(
    private readonly fetcher: Fetcher,
    gatewayOrigin: string
  ) {
    let parsed: URL;
    try {
      parsed = new URL(gatewayOrigin);
    } catch {
      throw new Error('Cloud live-teleport requires a valid pinned gateway origin.');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Cloud live-teleport gateway origin must use HTTP or HTTPS.');
    }
    if (parsed.username || parsed.password) {
      throw new Error('Cloud live-teleport gateway origin must not contain credentials.');
    }
    this.gatewayOrigin = new URL(parsed.origin);
  }

  async prewarm(input: LiveTeleportPrewarmInput): Promise<LiveTeleportPrewarm> {
    const { signal, ...request } = input;
    const response = await this.fetcher('/api/v1/live-teleports/prewarm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
    const payload = await readPayload(response);
    if (!isObject(payload)) throw new Error('Cloud live-teleport prewarm returned an invalid response.');

    const status = payload.status;
    if (status !== 'warming' && status !== 'ready') {
      throw new Error('Cloud live-teleport prewarm returned an invalid status.');
    }
    return {
      prewarmId: requiredString(payload.prewarmId, 'prewarmId'),
      generation: requiredGeneration(payload.generation),
      status,
    };
  }

  async status(input: LiveTeleportStatusInput): Promise<LiveTeleportLifecycleStatus> {
    const { signal, ...request } = input;
    const response = await this.fetcher('/api/v1/live-teleports/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
    const payload = await readPayload(response);
    if (!isObject(payload)) throw new Error('Cloud live-teleport status returned an invalid response.');
    return this.parseLifecycleStatus(payload);
  }

  async acquire(input: LiveTeleportAcquireInput): Promise<LiveTeleportEnvironment> {
    const { signal, ...request } = input;
    const response = await this.fetcher('/api/v1/live-teleports/acquire', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
    const payload = await readPayload(response);
    if (!isObject(payload)) throw new Error('Cloud live-teleport acquire returned an invalid response.');

    if ('execServerUrl' in payload) {
      throw new Error('Cloud live-teleport acquire must not return an arbitrary execServerUrl.');
    }
    const connectPath = this.requiredConnectPath(payload.connectPath);
    const execServerUrl = this.execServerUrl(connectPath);

    const expiresAt = requiredString(payload.expiresAt, 'expiresAt');
    if (Number.isNaN(Date.parse(expiresAt))) {
      throw new Error('Cloud live-teleport acquire returned an invalid expiresAt.');
    }

    return {
      sessionId: requiredString(payload.sessionId, 'sessionId'),
      generation: requiredGeneration(payload.generation),
      environmentId: requiredString(payload.environmentId, 'environmentId'),
      connectPath,
      execServerUrl,
      workspaceCwd: requiredString(payload.workspaceCwd, 'workspaceCwd'),
      expiresAt,
      convergence: requiredConvergenceProof(payload.convergence),
    };
  }

  async revoke(input: LiveTeleportRevokeInput): Promise<LiveTeleportRevocation> {
    const { signal, ...request } = input;
    const response = await this.fetcher('/api/v1/live-teleports/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
    const payload = await readPayload(response);
    if (!isObject(payload)) throw new Error('Cloud live-teleport revoke returned an invalid response.');
    const status = this.parseLifecycleStatus(payload);
    if (status.status !== 'revoked' && status.status !== 'expired') {
      throw new Error('Cloud live-teleport revoke was not confirmed.');
    }
    return { ...status, status: status.status };
  }

  private parseLifecycleStatus(payload: Record<string, unknown>): LiveTeleportLifecycleStatus {
    const status = payload.status;
    if (
      status !== 'warming' &&
      status !== 'ready' &&
      status !== 'failed' &&
      status !== 'revoked' &&
      status !== 'expired'
    ) {
      throw new Error('Cloud live-teleport status returned an invalid lifecycle state.');
    }
    const expiresAt =
      payload.expiresAt === undefined ? undefined : requiredString(payload.expiresAt, 'expiresAt');
    if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
      throw new Error('Cloud live-teleport status returned an invalid expiresAt.');
    }
    return {
      sessionId: requiredString(payload.sessionId, 'sessionId'),
      generation: requiredGeneration(payload.generation),
      status,
      ...(payload.prewarmId === undefined
        ? {}
        : { prewarmId: requiredString(payload.prewarmId, 'prewarmId') }),
      ...(payload.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: optionalNonNegativeInteger(payload.retryAfterMs, 'retryAfterMs')! }),
      ...(expiresAt ? { expiresAt } : {}),
    };
  }

  private requiredConnectPath(value: unknown): string {
    const connectPath = requiredString(value, 'connectPath');
    if (
      !connectPath.startsWith('/api/v1/live-teleports/connect/') ||
      connectPath.startsWith('//') ||
      connectPath.includes('\\') ||
      connectPath.includes('#')
    ) {
      throw new Error('Cloud live-teleport acquire returned an invalid connectPath.');
    }
    const parsed = new URL(connectPath, this.gatewayOrigin);
    if (
      parsed.origin !== this.gatewayOrigin.origin ||
      !parsed.pathname.startsWith('/api/v1/live-teleports/connect/')
    ) {
      throw new Error('Cloud live-teleport acquire returned a cross-origin connectPath.');
    }
    return `${parsed.pathname}${parsed.search}`;
  }

  private execServerUrl(connectPath: string): string {
    const url = new URL(connectPath, this.gatewayOrigin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }
}
