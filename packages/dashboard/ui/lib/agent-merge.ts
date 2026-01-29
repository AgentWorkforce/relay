import type { Agent } from '../types';

export interface MergeAgentsInput {
  agents?: Agent[];
  users?: Agent[];
  localAgents?: Agent[];
}

export function mergeAgentsForDashboard({
  agents = [],
  users = [],
  localAgents = [],
}: MergeAgentsInput): Agent[] {
  const merged = [...agents, ...users, ...localAgents]
    .filter((agent) => agent.name.toLowerCase() !== 'dashboard');
  const byName = new Map<string, Agent>();

  for (const agent of merged) {
    const key = agent.name.toLowerCase();
    const existing = byName.get(key);
    // Prefer non-local agents when names collide to avoid cloud agents showing as local.
    if (existing) {
      const keepNonLocal = !existing.isLocal && agent.isLocal;
      byName.set(key, {
        ...existing,
        ...agent,
        isLocal: keepNonLocal ? false : Boolean(agent.isLocal),
      });
    } else {
      byName.set(key, agent);
    }
  }

  return Array.from(byName.values());
}
