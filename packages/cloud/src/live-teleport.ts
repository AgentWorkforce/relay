export type LiveTeleportWorkspaceSource =
  | {
      kind: 'relayfile-mount';
      mountStatePath: string;
    }
  | {
      kind: 'verified-convergence-receipt';
      receipt: string;
    };

export type LiveTeleportPrewarmInput = {
  sessionId: string;
  generation: number;
  workspaceRoot: string;
  source: LiveTeleportWorkspaceSource;
  idempotencyKey: string;
};

export type LiveTeleportPrewarm = {
  prewarmId: string;
  generation: number;
  status: 'warming' | 'ready';
};

export type LiveTeleportAcquireInput = LiveTeleportPrewarmInput & {
  threadId: string;
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
  execServerUrl: string;
  workspaceCwd: string;
  expiresAt: string;
  convergence: LiveTeleportConvergenceProof;
};

export type LiveTeleportRevokeInput = {
  sessionId: string;
  generation: number;
  idempotencyKey: string;
};

export interface LiveTeleportCloudClient {
  prewarm(input: LiveTeleportPrewarmInput): Promise<LiveTeleportPrewarm>;
  acquire(input: LiveTeleportAcquireInput): Promise<LiveTeleportEnvironment>;
  revoke(input: LiveTeleportRevokeInput): Promise<void>;
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
  constructor(private readonly fetcher: Fetcher) {}

  async prewarm(input: LiveTeleportPrewarmInput): Promise<LiveTeleportPrewarm> {
    const response = await this.fetcher('/api/v1/live-teleports/prewarm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
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

  async acquire(input: LiveTeleportAcquireInput): Promise<LiveTeleportEnvironment> {
    const response = await this.fetcher('/api/v1/live-teleports/acquire', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await readPayload(response);
    if (!isObject(payload)) throw new Error('Cloud live-teleport acquire returned an invalid response.');

    const execServerUrl = requiredString(payload.execServerUrl, 'execServerUrl');
    let parsed: URL;
    try {
      parsed = new URL(execServerUrl);
    } catch {
      throw new Error('Cloud live-teleport acquire returned an invalid execServerUrl.');
    }
    if (parsed.protocol !== 'wss:') {
      throw new Error('Cloud live-teleport acquire must return a Cloud WSS bridge URL.');
    }

    const expiresAt = requiredString(payload.expiresAt, 'expiresAt');
    if (Number.isNaN(Date.parse(expiresAt))) {
      throw new Error('Cloud live-teleport acquire returned an invalid expiresAt.');
    }

    return {
      sessionId: requiredString(payload.sessionId, 'sessionId'),
      generation: requiredGeneration(payload.generation),
      environmentId: requiredString(payload.environmentId, 'environmentId'),
      execServerUrl,
      workspaceCwd: requiredString(payload.workspaceCwd, 'workspaceCwd'),
      expiresAt,
      convergence: requiredConvergenceProof(payload.convergence),
    };
  }

  async revoke(input: LiveTeleportRevokeInput): Promise<void> {
    const response = await this.fetcher('/api/v1/live-teleports/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    await readPayload(response);
  }
}
