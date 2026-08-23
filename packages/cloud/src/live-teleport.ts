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

export type LiveTeleportDestinationVerification = {
  version: 1;
  kind: 'relayfile-destination-verification';
  verificationId: string;
  workspaceId: string;
  localRoot: string;
  remoteRoot: '/';
  sessionId: string;
  generation: number;
  status: 'converged';
  observed: {
    digest: string;
    workspaceRevision: string;
    eventCursor: string;
  };
  health: {
    pendingWriteback: 0;
    conflicts: 0;
    outboxPending: 0;
    outboxNeedsAttention: false;
  };
  verifiedAt: string;
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
  connectExpiresAt: string;
  leaseExpiresAt: string;
  verification: LiveTeleportDestinationVerification;
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
  status: 'warming' | 'ready' | 'verifying' | 'active' | 'cleanup_pending' | 'failed' | 'revoked' | 'expired';
  prewarmId?: string;
  retryAfterMs?: number;
  expiresAt?: string;
  /** Exact Cloud-authoritative lease deadline, present for active status. */
  leaseExpiresAt?: string;
};

export type LiveTeleportRevocation = LiveTeleportLifecycleStatus & {
  status: 'revoked' | 'expired';
};

export interface LiveTeleportCloudClient {
  prewarm(input: LiveTeleportPrewarmInput): Promise<LiveTeleportPrewarm>;
  status(input: LiveTeleportStatusInput): Promise<LiveTeleportLifecycleStatus>;
  acquire(input: LiveTeleportAcquireInput): Promise<LiveTeleportEnvironment>;
  revoke(input: LiveTeleportRevokeInput): Promise<LiveTeleportLifecycleStatus>;
}

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

const FORBIDDEN_PROVIDER_FIELD =
  /(?:provider.*(?:url|token|credential)|trafficAccessToken|signedPreviewUrl|sealToken|^ticket$)/i;
const MAX_ACQUIRE_ATTEMPTS = 120;
const MAX_ACQUIRE_RETRY_AFTER_MS = 1_000;
/** Remote turns can wait up to 30m for completion; Cloud reserves another 10m for fencing. */
export const LIVE_TELEPORT_MIN_TURN_LEASE_MS = 40 * 60_000;

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

async function fetchAcquireSafely(fetcher: Fetcher, path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetcher(path, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    // A transport adapter can include the serialized request body in its
    // diagnostic. Acquire carries the one-use seal token, so never relay that
    // arbitrary prose to callers.
    throw new Error('Cloud live-teleport acquire transport failed.');
  }
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

function requiredDigest(value: unknown, field: string): string {
  const digest = requiredString(value, field);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`Cloud live-teleport verification has an invalid ${field}.`);
  }
  return digest;
}

function requiredRelayfilePosition(value: unknown, field: string, prefix: 'rev' | 'evt'): string {
  const position = requiredString(value, field);
  if (!new RegExp(`^(?:0|${prefix}_[0-9]+)$`).test(position)) {
    throw new Error(`Cloud live-teleport verification has an invalid ${field}.`);
  }
  return position;
}

function requiredExactTimestamp(value: unknown, field: string): string {
  const timestamp = requiredString(value, field);
  const milliseconds = Date.parse(timestamp);
  if (Number.isNaN(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    throw new Error(`Cloud live-teleport response has an invalid ${field}.`);
  }
  return timestamp;
}

type LiveTeleportReceiptBinding = {
  workspaceId: string;
  remoteRoot: '/';
  sessionId: string;
  generation: number;
  digest: string;
  workspaceRevision: string;
  eventCursor: string;
};

function requiredReceiptBinding(source: LiveTeleportWorkspaceSource): LiveTeleportReceiptBinding {
  if (source.kind !== 'relayfile-checkpoint-seal' || !isObject(source.receipt)) {
    throw new Error('Cloud live-teleport acquire requires a Relayfile checkpoint receipt.');
  }
  const receipt = source.receipt;
  // Validate the capability without ever retaining it in verification output or
  // interpolating it into an error.
  requiredString(receipt.sealToken, 'source.receipt.sealToken');
  if (requiredString(receipt.root, 'source.receipt.root') !== '/') {
    throw new Error('Cloud live-teleport acquire requires logical Relayfile root /.');
  }
  return {
    workspaceId: requiredString(receipt.workspaceId, 'source.receipt.workspaceId'),
    remoteRoot: '/',
    sessionId: requiredString(receipt.sessionId, 'source.receipt.sessionId'),
    generation: requiredGeneration(receipt.generation),
    digest: requiredDigest(receipt.digest, 'source.receipt.digest'),
    workspaceRevision: requiredRelayfilePosition(
      receipt.workspaceRevision,
      'source.receipt.workspaceRevision',
      'rev'
    ),
    eventCursor: requiredRelayfilePosition(receipt.eventCursor, 'source.receipt.eventCursor', 'evt'),
  };
}

function requiredVerification(
  value: unknown,
  expected: LiveTeleportReceiptBinding
): LiveTeleportDestinationVerification {
  if (!isObject(value) || !isObject(value.observed) || !isObject(value.health)) {
    throw new Error('Cloud live-teleport acquire did not return Relayfile destination verification.');
  }
  const verifiedAt = requiredString(value.verifiedAt, 'verification.verifiedAt');
  const workspaceId = requiredString(value.workspaceId, 'verification.workspaceId');
  const digest = requiredDigest(value.observed.digest, 'verification.observed.digest');
  const workspaceRevision = requiredRelayfilePosition(
    value.observed.workspaceRevision,
    'verification.observed.workspaceRevision',
    'rev'
  );
  const eventCursor = requiredRelayfilePosition(
    value.observed.eventCursor,
    'verification.observed.eventCursor',
    'evt'
  );
  if (
    value.version !== 1 ||
    value.kind !== 'relayfile-destination-verification' ||
    value.status !== 'converged' ||
    workspaceId !== expected.workspaceId ||
    value.remoteRoot !== expected.remoteRoot ||
    value.sessionId !== expected.sessionId ||
    value.generation !== expected.generation ||
    digest !== expected.digest ||
    workspaceRevision !== expected.workspaceRevision ||
    eventCursor !== expected.eventCursor ||
    value.health.pendingWriteback !== 0 ||
    value.health.conflicts !== 0 ||
    value.health.outboxPending !== 0 ||
    value.health.outboxNeedsAttention !== false ||
    Number.isNaN(Date.parse(verifiedAt))
  ) {
    throw new Error('Cloud live-teleport acquire returned a mismatched Relayfile verification.');
  }
  return {
    version: 1,
    kind: 'relayfile-destination-verification',
    verificationId: requiredString(value.verificationId, 'verification.verificationId'),
    workspaceId,
    localRoot: requiredString(value.localRoot, 'verification.localRoot'),
    remoteRoot: '/',
    sessionId: expected.sessionId,
    generation: expected.generation,
    status: 'converged',
    observed: {
      digest,
      workspaceRevision,
      eventCursor,
    },
    health: {
      pendingWriteback: 0,
      conflicts: 0,
      outboxPending: 0,
      outboxNeedsAttention: false,
    },
    verifiedAt,
  };
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
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
    const loopback =
      parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === 'localhost';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      throw new Error('Cloud live-teleport gateway origin must use HTTPS (HTTP is loopback-only).');
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
    const receiptBinding = requiredReceiptBinding(input.source);
    if (receiptBinding.sessionId !== input.sessionId || receiptBinding.generation !== input.generation) {
      throw new Error('Cloud live-teleport acquire received a stale or cross-session checkpoint receipt.');
    }
    let payload: unknown;
    let stillVerifying = false;
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      const response = await fetchAcquireSafely(this.fetcher, '/api/v1/live-teleports/acquire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal,
      });
      payload = await readPayload(response);
      if (response.status !== 202) {
        stillVerifying = false;
        break;
      }
      stillVerifying = true;
      if (!isObject(payload) || payload.status !== 'verifying') {
        throw new Error('Cloud live-teleport acquire returned an invalid pending response.');
      }
      await wait(
        Math.min(
          optionalNonNegativeInteger(payload.retryAfterMs, 'retryAfterMs') ?? 500,
          MAX_ACQUIRE_RETRY_AFTER_MS
        ),
        signal
      );
    }
    if (stillVerifying) {
      throw new Error('Cloud live-teleport acquire exceeded the bounded verification poll limit.');
    }
    if (!isObject(payload)) throw new Error('Cloud live-teleport acquire returned an invalid response.');

    if ('execServerUrl' in payload) {
      throw new Error('Cloud live-teleport acquire must not return an arbitrary execServerUrl.');
    }
    const connectPath = this.requiredConnectPath(payload.connectPath);
    const execServerUrl = this.execServerUrl(connectPath);

    const sessionId = requiredString(payload.sessionId, 'sessionId');
    const generation = requiredGeneration(payload.generation);
    const threadId = requiredString(payload.threadId, 'threadId');
    const connectExpiresAt = requiredString(payload.connectExpiresAt, 'connectExpiresAt');
    const leaseExpiresAt = requiredString(payload.leaseExpiresAt, 'leaseExpiresAt');
    if (
      payload.status !== 'active' ||
      sessionId !== input.sessionId ||
      generation !== input.generation ||
      threadId !== input.threadId ||
      Number.isNaN(Date.parse(connectExpiresAt)) ||
      Number.isNaN(Date.parse(leaseExpiresAt)) ||
      Date.parse(leaseExpiresAt) <= Date.parse(connectExpiresAt)
    ) {
      throw new Error('Cloud live-teleport acquire returned invalid active lifecycle metadata.');
    }

    return {
      sessionId,
      generation,
      environmentId: requiredString(payload.environmentId, 'environmentId'),
      connectPath,
      execServerUrl,
      workspaceCwd: requiredString(payload.workspaceCwd, 'workspaceCwd'),
      connectExpiresAt,
      leaseExpiresAt,
      verification: requiredVerification(payload.verification, receiptBinding),
    };
  }

  async revoke(input: LiveTeleportRevokeInput): Promise<LiveTeleportLifecycleStatus> {
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
    if (status.sessionId !== input.sessionId || status.generation !== input.generation) {
      throw new Error('Cloud live-teleport revoke returned a stale or cross-session lifecycle identity.');
    }
    if (status.status !== 'cleanup_pending' && status.status !== 'revoked' && status.status !== 'expired') {
      throw new Error('Cloud live-teleport revoke was not confirmed.');
    }
    return status;
  }

  private parseLifecycleStatus(payload: Record<string, unknown>): LiveTeleportLifecycleStatus {
    const status = payload.status;
    if (
      status !== 'warming' &&
      status !== 'ready' &&
      status !== 'verifying' &&
      status !== 'active' &&
      status !== 'cleanup_pending' &&
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
    const leaseExpiresAt =
      payload.leaseExpiresAt === undefined
        ? undefined
        : requiredExactTimestamp(payload.leaseExpiresAt, 'leaseExpiresAt');
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
      ...(leaseExpiresAt ? { leaseExpiresAt } : {}),
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
