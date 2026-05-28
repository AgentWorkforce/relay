export * from './types.js';

import type { AgentIdentity, AgentIdentityInput, HarnessConfig } from './types.js';

export function defineHarness<TCreateInput = void>(
  config: HarnessConfig<TCreateInput>
): HarnessConfig<TCreateInput> {
  return config;
}

export function normalizeAgentIdentity(input: AgentIdentityInput): AgentIdentity {
  const handle = input.handle ?? formatAgentHandle(input.name);
  return {
    id: input.id ?? handle,
    name: input.name,
    handle,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

export function formatAgentHandle(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '@agent';
  return trimmed.startsWith('@') ? trimmed : `@${trimmed.replace(/\s+/g, '-')}`;
}
