import os from 'node:os';

const HOSTED_DEFAULT_ORIGIN = 'https://cast.agentrelay.com';

export interface AgentTokenGrant {
  id: string;
  name: string;
  token: string;
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
 * Issue a fresh token for an existing agent using the workspace key: the
 * audited owner takeover, which revokes the agent's previous token. This is
 * how a lost token is recovered; Relaycast only lets an agent rotate its own
 * token with that token.
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
  const actor = `agent-relay-cli:${os.userInfo().username}@${os.hostname()}`;
  const granted = await call<{ agent_id: string; name: string; token: string }>(
    fetchFn,
    options.baseUrl,
    options.workspaceKey,
    'POST',
    `${route}/takeover`,
    {
      expected_agent_id: agent.id,
      actor,
      reason,
      session_ref: 'agent-relay-cli',
      node_id: 'agent-relay-cli',
    }
  );
  return { id: granted.agent_id, name: granted.name, token: granted.token };
}

/** Whether a registration failed only because the name is already taken. */
export function isAgentAlreadyExists(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown; status?: unknown };
  return (
    candidate.code === 'agent_already_exists' ||
    (typeof candidate.message === 'string' && /already exists in this workspace/i.test(candidate.message))
  );
}
