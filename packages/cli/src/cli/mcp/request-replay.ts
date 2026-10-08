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
export class McpRequestReplay {
  private readonly requests = new Map<string, Promise<unknown>>();

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
    const existing = this.requests.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const pending = operation();
    this.requests.set(key, pending);
    // JSON-RPC permits an ID to be reused after its response. Only a client
    // supplied idempotency key can safely keep a completed result for a retry.
    void pending.then(
      () => this.clearAfterSettlement(key, hasIdempotencyKey),
      () => this.requests.delete(key)
    );
    return pending;
  }

  private clearAfterSettlement(key: string, retainCompletedResult: boolean): void {
    if (!retainCompletedResult) {
      this.requests.delete(key);
      return;
    }

    const cleanup = setTimeout(() => this.requests.delete(key), 5 * 60 * 1000);
    cleanup.unref();
  }
}
