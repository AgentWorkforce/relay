import { createHash } from 'node:crypto';

const REPLAY_SCOPE = Symbol('agentRelay.replayScope');

/**
 * Tag a Relay client with the replay scope of the agent token it acts with.
 * The token decides both the acting identity and the workspace a write reaches,
 * so a key reused after either changes cannot replay another context's
 * receipt. Only a SHA-256 digest is kept, in a non-enumerable property.
 */
export function withReplayScope<T extends object>(client: T, agentToken: string): T {
  Object.defineProperty(client, REPLAY_SCOPE, {
    value: createHash('sha256').update(agentToken).digest('hex'),
    enumerable: false,
  });
  return client;
}

/** The replay scope a client was tagged with, or '' for an untagged client. */
export function replayScopeOf(client: object): string {
  const scope = (client as { [REPLAY_SCOPE]?: unknown })[REPLAY_SCOPE];
  return typeof scope === 'string' ? scope : '';
}

/**
 * Coalesce a transport replay of one MCP request before it can repeat a
 * state-changing Relay call. A typed JSON-RPC request ID, scoped by MCP
 * session, acting identity and tool, identifies only an in-flight logical request because
 * JSON-RPC permits IDs to be reused after a response. Clients that need to
 * retry after a lost response provide an explicit idempotency key; that key
 * retains the completed result briefly. Arguments deliberately do not
 * participate, so intentional identical sends remain separate requests.
 */
const RETAIN_COMPLETED_MS = 5 * 60 * 1000;

export class McpRequestReplay {
  /** `expiresAt` is set once a keyed request settles; expiry is checked lazily, never by a timer. */
  private readonly requests = new Map<string, { pending: Promise<unknown>; expiresAt?: number }>();

  run<T>(
    tool: string,
    extra: unknown,
    idempotencyKey: string | undefined,
    operation: () => Promise<T>,
    scope = ''
  ): Promise<T> {
    const request = extra as { requestId?: unknown; sessionId?: unknown } | undefined;
    const requestId = request?.requestId;
    const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : '';
    const hasIdempotencyKey = idempotencyKey !== undefined;
    if (!hasIdempotencyKey && typeof requestId !== 'string' && typeof requestId !== 'number') {
      return operation();
    }

    const key = JSON.stringify([
      sessionId,
      scope,
      tool,
      hasIdempotencyKey ? 'idempotency' : typeof requestId,
      hasIdempotencyKey ? idempotencyKey : requestId,
    ]);
    this.pruneExpired();
    const existing = this.requests.get(key);
    if (existing) return existing.pending as Promise<T>;

    const pending = operation();
    const entry: { pending: Promise<unknown>; expiresAt?: number } = { pending };
    this.requests.set(key, entry);
    // JSON-RPC permits an ID to be reused after its response. Only a client
    // supplied idempotency key can safely keep a completed result for a retry.
    void pending.then(
      () => {
        if (hasIdempotencyKey) entry.expiresAt = Date.now() + RETAIN_COMPLETED_MS;
        else this.requests.delete(key);
      },
      () => this.requests.delete(key)
    );
    return pending;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.requests) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) this.requests.delete(key);
    }
  }
}
