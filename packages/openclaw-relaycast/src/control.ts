export interface ClawRunnerControlConfig {
  baseUrl: string;
  token: string;
}

export interface SpawnOpenClawInput {
  workspaceId: string;
  name: string;
  role?: string;
  model?: string;
  channels?: string[];
  systemPrompt?: string;
  idempotencyKey?: string;
}

export interface ReleaseOpenClawInput {
  workspaceId: string;
  agentName: string;
  reason?: string;
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function resolveConfig(config?: Partial<ClawRunnerControlConfig>): ClawRunnerControlConfig {
  const baseUrl = (config?.baseUrl ?? process.env.CLAWRUNNER_API_BASE_URL ?? '').trim();
  const token = (config?.token ?? process.env.CLAWRUNNER_AGENT_TOKEN ?? '').trim();

  if (!baseUrl) {
    throw new Error('CLAWRUNNER_API_BASE_URL is required');
  }
  if (!token) {
    throw new Error('CLAWRUNNER_AGENT_TOKEN is required');
  }

  return {
    baseUrl: trimSlash(baseUrl),
    token,
  };
}

async function callApi<T>(
  path: string,
  method: 'GET' | 'POST',
  config?: Partial<ClawRunnerControlConfig>,
  body?: unknown,
): Promise<T> {
  const resolved = resolveConfig(config);
  const response = await fetch(`${resolved.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${resolved.token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const msg = (json && typeof json.error === 'string') ? json.error : `HTTP ${response.status}`;
    throw new Error(`ClawRunner control API error: ${msg}`);
  }
  return json as T;
}

export async function spawnOpenClaw(
  input: SpawnOpenClawInput,
  config?: Partial<ClawRunnerControlConfig>,
): Promise<unknown> {
  return callApi('/api/agents/spawn', 'POST', config, {
    workspaceId: input.workspaceId,
    name: input.name,
    role: input.role,
    model: input.model,
    channels: input.channels,
    systemPrompt: input.systemPrompt,
    idempotencyKey: input.idempotencyKey,
  });
}

export async function listOpenClaws(
  workspaceId: string,
  config?: Partial<ClawRunnerControlConfig>,
): Promise<unknown> {
  const query = new URLSearchParams({ workspaceId }).toString();
  return callApi(`/api/agents?${query}`, 'GET', config);
}

export async function releaseOpenClaw(
  input: ReleaseOpenClawInput,
  config?: Partial<ClawRunnerControlConfig>,
): Promise<unknown> {
  const path = `/api/agents/${encodeURIComponent(input.agentName)}/release`;
  return callApi(path, 'POST', config, {
    workspaceId: input.workspaceId,
    reason: input.reason,
  });
}
