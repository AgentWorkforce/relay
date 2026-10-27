import os from 'node:os';

const HOSTED_DEFAULT_ORIGIN = 'https://cast.agentrelay.com';

/** A token issued by {@link takeOverAgent}. */
export interface AgentTokenGrant {
  id: string;
  name: string;
  token: string;
  /** The old token stays valid until the server's grace window ends. */
  oldTokenGraceRemains?: boolean;
}

interface Envelope<T> {
  ok?: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

async function call<T>(
  fetchFn: typeof fetch,
  baseUrl: string | undefined,
  workspaceKey: string,
  method: 'GET' | 'POST',
  route: string,
  body?: unknown
): Promise<T> {
  const response = await fetchFn(new URL(route, baseUrl ?? HOSTED_DEFAULT_ORIGIN), {
    method,
    headers: {
      authorization: `Bearer ${workspaceKey}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const parsed = (await response.json().catch(() => ({}))) as Envelope<T>;
  if (!response.ok || parsed.ok === false || parsed.data === undefined) {
    const code = parsed.error?.code ?? `http_${response.status}`;
    const message = parsed.error?.message ?? `Relaycast answered ${response.status}.`;
    const error = new Error(`${message} (${code})`) as Error & { code?: string; status?: number };
    error.code = code;
    error.status = response.status;
    throw error;
  }
  return parsed.data;
}

/**
 * The local user for the audit trail. `os.userInfo()` throws when the UID has
 * no passwd entry (common with `docker run --user` and random container UIDs).
 */
function localUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'unknown';
  }
}

/**
 * Issue a fresh token for an existing agent using the workspace key. This is
 * how a lost token is recovered; Relaycast only lets an agent rotate its own
 * token with that token.
 *
 * Each audited takeover issues a new token and keeps only the token it
 * replaced valid, for the server's short grace window (60s in Relaycast).
 * Taking over twice therefore retires the agent's old token at once, while
 * the agent always has a working token: if the first takeover fails nothing
 * changed, and if the second fails the first replacement still works and the
 * old token lapses when its grace window ends.
 *
 * @param options - Workspace key, server and optional fetch implementation.
 * @param name - The existing agent's name.
 * @param reason - Recorded in the server's audit log.
 * @param expectedAgentId - The agent id, when the caller already looked it up.
 * @returns The new token grant; `oldTokenGraceRemains` is set when the old
 *   token could not be retired at once.
 */
export async function takeOverAgent(
  options: { workspaceKey: string; baseUrl?: string; fetch?: typeof fetch },
  name: string,
  reason: string,
  expectedAgentId?: string
): Promise<AgentTokenGrant> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const route = `/v1/agents/${encodeURIComponent(name)}`;
  const agent = expectedAgentId
    ? { id: expectedAgentId }
    : await call<{ id: string }>(fetchFn, options.baseUrl, options.workspaceKey, 'GET', route);
  const actor = `agent-relay-cli:${localUsername()}@${os.hostname()}`;
  const takeover = (why: string) =>
    call<{ agent_id: string; name: string; token: string }>(
      fetchFn,
      options.baseUrl,
      options.workspaceKey,
      'POST',
      `${route}/takeover`,
      {
        expected_agent_id: agent.id,
        actor,
        reason: why,
        session_ref: 'agent-relay-cli',
        node_id: 'agent-relay-cli',
      }
    );
  const first = await takeover(reason);
  try {
    const second = await takeover(`${reason} (retire the previous token)`);
    return { id: second.agent_id, name: second.name, token: second.token };
  } catch {
    return { id: first.agent_id, name: first.name, token: first.token, oldTokenGraceRemains: true };
  }
}

/**
 * Whether a registration failed only because the name is already taken.
 *
 * @param error - The registration failure.
 * @returns `true` for Relaycast's "agent already exists" refusal.
 */
export function isAgentAlreadyExists(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown; status?: unknown };
  return (
    candidate.code === 'agent_already_exists' ||
    (typeof candidate.message === 'string' && /already exists in this workspace/i.test(candidate.message))
  );
}
