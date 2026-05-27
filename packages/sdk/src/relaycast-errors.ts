/**
 * Detectors for relaycast `agent_token_invalid` responses.
 *
 * Mirrors the recovery contract introduced in relaycast PR #137. The MCP
 * server (and any SDK consumer) uses these helpers to recognise when a
 * Relaycast agent token has been invalidated mid-session so the stale
 * credential can be cleared and the caller pointed at a fresh
 * `register_agent` call.
 *
 * Detection is intentionally structural: the upstream `@relaycast/sdk`
 * RelayError surfaces a `code` field once PR #137 ships, but until then
 * (and as a defensive fallback) the status + message pair is enough to
 * identify an invalid agent token.
 */

export const INVALID_AGENT_TOKEN_CODE = 'agent_token_invalid';
export const INVALID_AGENT_TOKEN_MESSAGE = 'Invalid agent token';

interface MaybeError {
  code?: unknown;
  statusCode?: unknown;
  status?: unknown;
  message?: unknown;
  body?: unknown;
  cause?: unknown;
}

function normalizeCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

function readStatus(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readBodyError(body: unknown): { code?: string; message?: string } | null {
  if (!body || typeof body !== 'object') return null;
  const root = body as { error?: unknown; code?: unknown; message?: unknown };
  const errorField = root.error;
  if (errorField && typeof errorField === 'object') {
    const e = errorField as { code?: unknown; message?: unknown };
    return {
      code: typeof e.code === 'string' ? e.code : undefined,
      message: typeof e.message === 'string' ? e.message : undefined,
    };
  }
  return {
    code: typeof root.code === 'string' ? root.code : undefined,
    message: typeof root.message === 'string' ? root.message : undefined,
  };
}

/**
 * True when `error` looks like an invalid-agent-token response from
 * Relaycast. Recognises both the typed `agent_token_invalid` code (PR #137)
 * and the legacy status-401 + "Invalid agent token" message pair.
 *
 * The optional `visited` set guards against cyclic `cause` graphs
 * (`a.cause = b; b.cause = a`) — a `WeakSet` so we don't leak references.
 */
export function isInvalidAgentTokenError(error: unknown, visited: WeakSet<object> = new WeakSet()): boolean {
  if (!error || typeof error !== 'object') return false;
  if (visited.has(error as object)) return false;
  visited.add(error as object);
  const err = error as MaybeError;

  if (normalizeCode(err.code) === INVALID_AGENT_TOKEN_CODE) return true;

  const bodyError = readBodyError(err.body);
  if (bodyError && normalizeCode(bodyError.code) === INVALID_AGENT_TOKEN_CODE) return true;

  const status = readStatus(err.statusCode) ?? readStatus(err.status);
  const message =
    (typeof err.message === 'string' ? err.message.trim() : '') || (bodyError?.message?.trim() ?? '');
  if (status === 401 && message === INVALID_AGENT_TOKEN_MESSAGE) return true;

  if (err.cause) {
    return isInvalidAgentTokenError(err.cause, visited);
  }
  return false;
}

interface MaybeToolResult {
  content?: unknown;
  isError?: unknown;
  structuredContent?: unknown;
}

/**
 * True when a tool result swallowed an invalid-token error into its
 * content array (the pattern the relaycast MCP server uses when an upstream
 * call returns `Invalid agent token` in a 401 body).
 */
export function isInvalidAgentTokenToolResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as MaybeToolResult;
  if (!Array.isArray(r.content)) return false;
  return r.content.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const e = entry as { type?: unknown; text?: unknown };
    if (e.type !== 'text' || typeof e.text !== 'string') return false;
    return e.text.trim() === INVALID_AGENT_TOKEN_MESSAGE;
  });
}

/**
 * Human-readable guidance returned to the MCP client after invalidating a
 * stale agent token. Matches the wording surfaced by the relaycast MCP
 * server so prompts that key on this string keep working across both
 * implementations.
 */
export function agentTokenRecoveryMessage(): string {
  return [
    `${INVALID_AGENT_TOKEN_CODE}: The selected Relaycast agent token is no longer valid.`,
    'The stale token was cleared from this MCP session.',
    'Call the "register_agent" tool with the configured agent name to obtain a fresh token, then retry the failed operation.',
  ].join(' ');
}
