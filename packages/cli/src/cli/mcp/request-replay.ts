/**
 * Coalesce a transport replay of one MCP request before it can repeat a
 * state-changing Relay call. A typed JSON-RPC request ID, scoped by MCP
 * session and tool, identifies a logical request; arguments deliberately do
 * not participate so two intentional identical sends remain separate requests.
 */
export class McpRequestReplay {
  private readonly requests = new Map<string, Promise<unknown>>();

  run<T>(tool: string, extra: unknown, operation: () => Promise<T>): Promise<T> {
    const request = extra as { requestId?: unknown; sessionId?: unknown } | undefined;
    const requestId = request?.requestId;
    if (typeof requestId !== 'string' && typeof requestId !== 'number') return operation();

    const key = JSON.stringify([
      typeof request?.sessionId === 'string' ? request.sessionId : '',
      tool,
      typeof requestId,
      requestId,
    ]);
    const existing = this.requests.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const pending = operation();
    this.requests.set(key, pending);
    // Keep a completed receipt long enough for a transport replay, without
    // retaining every request for the lifetime of a long-running MCP server.
    void pending
      .finally(() => {
        const expiry = setTimeout(() => this.requests.delete(key), 5 * 60_000);
        expiry.unref();
      })
      .catch(() => undefined);
    return pending;
  }
}
