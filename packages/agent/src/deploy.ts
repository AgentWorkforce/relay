import type { AgentEvent } from '@agent-relay/events';

import type {
  AgentPolicy,
  AgentProviderConfig,
  Context,
  DeployHandle,
  HostedAgentDefinition,
  HostedAgentStatus,
  ScheduleSpec,
} from './types.js';

const DEFAULT_RELAY_DEPLOY_URL = 'https://api.relaycast.dev';

interface DeployAgentResponse {
  agentId: string;
  deployId: string;
}

/**
 * Deploys a hosted agent definition to the managed runtime control plane.
 */
export async function deployAgent(definition: HostedAgentDefinition): Promise<DeployHandle> {
  assertHostedDefinition(definition);

  const apiKey = resolveHostedApiKey();
  const payload = serializeHostedDefinition(definition);
  const response = await hostedRequest(apiKey, 'POST', '/v1/hosted-agents/deployments', payload);
  const created = normalizeDeployAgentResponse(response);

  return {
    agentId: created.agentId,
    deployId: created.deployId,
    status: async () =>
      normalizeHostedAgentStatus(
        await hostedRequest(
          apiKey,
          'GET',
          `/v1/hosted-agents/deployments/${encodeURIComponent(created.deployId)}`
        ),
        created
      ),
    undeploy: async () => {
      await hostedRequest(
        apiKey,
        'DELETE',
        `/v1/hosted-agents/deployments/${encodeURIComponent(created.deployId)}`
      );
    },
  };
}

function assertHostedDefinition(definition: HostedAgentDefinition): void {
  if (!definition.name.trim()) {
    throw new Error('deployAgent.name is required');
  }
  if (!definition.workspace.trim()) {
    throw new Error('deployAgent.workspace is required');
  }
  if (!definition.model.trim()) {
    throw new Error('deployAgent.model is required');
  }
  if (!definition.instructions.trim()) {
    throw new Error('deployAgent.instructions is required');
  }
  assertProvider(definition.provider);

  if (definition.watch !== undefined) {
    const watch = normalizeWatch(definition.watch);
    if (watch.length === 0) {
      throw new Error('deployAgent.watch must include at least one non-empty glob');
    }
  }

  if (definition.inbox !== undefined) {
    const inbox = normalizeInbox(definition.inbox);
    if (inbox.length === 0) {
      throw new Error('deployAgent.inbox must include at least one non-empty inbox target');
    }
  }
}

function assertProvider(provider: AgentProviderConfig): void {
  if (!provider || (provider.mode !== 'managed' && provider.mode !== 'byok')) {
    throw new Error('deployAgent.provider.mode must be "managed" or "byok"');
  }
  if (provider.mode === 'byok' && !provider.secretRef?.trim()) {
    throw new Error('deployAgent.provider.secretRef is required when provider.mode is byok');
  }
}

function resolveHostedApiKey(): string {
  const apiKey = process.env.RELAY_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('RELAY_API_KEY is required');
  }
  return apiKey;
}

function resolveHostedDeployUrl(): string {
  return (
    process.env.RELAY_HOSTED_AGENTS_URL?.trim() ||
    process.env.RELAY_API_URL?.trim() ||
    process.env.RELAY_BASE_URL?.trim() ||
    process.env.RELAYCAST_URL?.trim() ||
    DEFAULT_RELAY_DEPLOY_URL
  );
}

async function hostedRequest(
  apiKey: string,
  method: 'POST' | 'GET' | 'DELETE',
  path: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(new URL(path, resolveHostedDeployUrl()), {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(
      `hosted agent request failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`
    );
  }

  if (response.status === 204) {
    return null;
  }

  return await response.json().catch(() => null);
}

async function readErrorDetail(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof payload?.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }
  if (typeof payload?.error === 'string' && payload.error.trim()) {
    return payload.error.trim();
  }
  return '';
}

function serializeHostedDefinition(definition: HostedAgentDefinition): Record<string, unknown> {
  return {
    name: definition.name.trim(),
    workspace: definition.workspace.trim(),
    model: definition.model.trim(),
    instructions: definition.instructions.trim(),
    ...(definition.schedule !== undefined ? { schedule: normalizeSchedules(definition.schedule) } : {}),
    ...(definition.watch !== undefined ? { watch: normalizeWatch(definition.watch) } : {}),
    ...(definition.inbox !== undefined ? { inbox: normalizeInbox(definition.inbox) } : {}),
    ...(definition.policy ? { policy: serializePolicy(definition.policy) } : {}),
    provider: serializeProvider(definition.provider),
    runtime: definition.onEvent
      ? {
          mode: 'custom',
          onEventSource: definition.onEvent.toString(),
        }
      : {
          mode: 'default',
        },
  };
}

function serializePolicy(policy: AgentPolicy): Record<string, unknown> {
  return {
    mode: policy.mode,
    ...(policy.approvals ? { approvals: [...policy.approvals] } : {}),
  };
}

function serializeProvider(provider: AgentProviderConfig): Record<string, unknown> {
  return {
    mode: provider.mode,
    ...(provider.secretRef?.trim() ? { secretRef: provider.secretRef.trim() } : {}),
  };
}

function normalizeSchedules(
  schedule: ScheduleSpec | ScheduleSpec[]
): Array<string | { cron: string; tz?: string } | { at: string }> {
  const entries = Array.isArray(schedule) ? schedule : [schedule];
  return entries.map((entry) => {
    if (typeof entry === 'string') {
      return entry.trim();
    }
    if ('cron' in entry) {
      return entry.tz ? { cron: entry.cron, tz: entry.tz } : { cron: entry.cron };
    }
    return {
      at: entry.at instanceof Date ? entry.at.toISOString() : entry.at,
    };
  });
}

function normalizeWatch(watch: string | string[]): string[] {
  return (Array.isArray(watch) ? watch : [watch])
    .map((entry) => {
      if (typeof entry !== 'string') {
        throw new Error('deployAgent.watch must be a string or string[] of globs');
      }
      return entry.trim();
    })
    .filter(Boolean);
}

function normalizeInbox(inbox: string | string[]): string[] {
  return (Array.isArray(inbox) ? inbox : [inbox])
    .map((entry) => {
      if (typeof entry !== 'string') {
        throw new Error('deployAgent.inbox must be a string or string[] of inbox targets');
      }
      const trimmed = entry.trim();
      if (!trimmed) {
        return '';
      }
      if (trimmed.startsWith('#') || trimmed.startsWith('@')) {
        return trimmed;
      }
      return `#${trimmed}`;
    })
    .filter(Boolean);
}

function normalizeDeployAgentResponse(value: unknown): DeployAgentResponse {
  if (!value || typeof value !== 'object') {
    throw new Error('hosted deploy response was missing agent and deployment identifiers');
  }

  const record = value as Record<string, unknown>;
  const agentId = firstString(record, ['agentId', 'agent_id']);
  const deployId = firstString(record, ['deployId', 'deploy_id', 'id']);

  if (!agentId || !deployId) {
    throw new Error('hosted deploy response was missing agentId or deployId');
  }

  return { agentId, deployId };
}

function normalizeHostedAgentStatus(value: unknown, fallback: DeployAgentResponse): HostedAgentStatus {
  if (!value || typeof value !== 'object') {
    return {
      agentId: fallback.agentId,
      deployId: fallback.deployId,
      state: 'unknown',
    };
  }

  const record = value as Record<string, unknown>;
  const state = firstString(record, ['state', 'status', 'phase']) ?? 'unknown';

  return {
    ...record,
    agentId: firstString(record, ['agentId', 'agent_id']) ?? fallback.agentId,
    deployId: firstString(record, ['deployId', 'deploy_id', 'id']) ?? fallback.deployId,
    state,
  };
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
