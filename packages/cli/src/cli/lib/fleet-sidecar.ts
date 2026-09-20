import { AgentRelay } from '@agent-relay/sdk';
import { MAX_FLEET_NODE_AGENTS, type FleetTriggerSyncClient } from '@agent-relay/fleet';

import type { CoreTeamsConfig } from '../commands/core.js';

/**
 * The harnesses a `node up` broker advertises `spawn:<harness>` capacity for:
 * a built-in default set, the project's teams.json clis, and any `spawn:<harness>`
 * definitions in a discovered node config. The CLI passes this to the broker via
 * `AGENT_RELAY_NODE_HARNESSES` so its capacity manifest covers everything the
 * project can spawn.
 */
// Mirrors the broker's built-in default (crates/broker init `DEFAULT_NODE_HARNESSES`);
// the CLI overrides `AGENT_RELAY_NODE_HARNESSES`, so omitting one would drop the
// broker's default capacity for it.
const DEFAULT_HARNESSES = ['claude', 'codex', 'gemini', 'opencode', 'muse', 'devin'] as const;

/**
 * The minimum a node config has to expose to contribute to the broker's
 * advertised capacity: its capability names plus its agent cap. A full
 * {@link FleetNodeDefinition} satisfies this, and so does the descriptor
 * reported by a node definition served out-of-process (which the CLI never
 * loads in-process, so it has capability names but no handlers).
 */
export type NodeCapacitySource = {
  capabilities: Readonly<Record<string, unknown>>;
  maxAgents?: number;
};

export function nodeCapacityHarnesses(
  teamsConfig: CoreTeamsConfig | null,
  definition?: NodeCapacitySource
): string[] {
  const harnesses = new Set<string>(DEFAULT_HARNESSES);
  for (const agent of teamsConfig?.agents ?? []) {
    const cli = agent.cli?.trim();
    if (cli) {
      harnesses.add(cli);
    }
  }
  for (const name of Object.keys(definition?.capabilities ?? {})) {
    if (name.startsWith('spawn:')) {
      const harness = name.slice('spawn:'.length).trim();
      if (harness) {
        harnesses.add(harness);
      }
    }
  }
  return [...harnesses];
}

/**
 * Resolve the `AGENT_RELAY_NODE_HARNESSES` CSV the broker registers its capacity
 * from. A pre-set value is the operator's authoritative declaration of the node's
 * real capacity and is returned verbatim; otherwise it is computed from the project
 * via {@link nodeCapacityHarnesses}.
 */
export function resolveNodeCapacityHarnesses(
  preset: string | undefined,
  teamsConfig: CoreTeamsConfig | null,
  definition?: NodeCapacitySource
): string {
  const trimmed = preset?.trim();
  if (trimmed) {
    return trimmed;
  }
  return nodeCapacityHarnesses(teamsConfig, definition).join(',');
}

/**
 * Resolve the `AGENT_RELAY_NODE_MAX_AGENTS` value the broker registers its
 * provider-level agent capacity from. A pre-set value is the operator's
 * authoritative declaration of the node's real capacity and is returned
 * verbatim; otherwise the node definition's `maxAgents` wins. Returns
 * `undefined` when neither declares a cap — or when the declared cap is
 * outside the shared range the broker can parse — so the broker keeps its
 * historically unbounded capacity instead of reporting a number it would
 * silently normalize to unlimited.
 */
export function resolveNodeMaxAgents(
  preset: string | undefined,
  definition?: NodeCapacitySource
): string | undefined {
  const trimmed = preset?.trim();
  if (trimmed) {
    return trimmed;
  }
  const maxAgents = definition?.maxAgents;
  if (
    typeof maxAgents === 'number' &&
    Number.isInteger(maxAgents) &&
    maxAgents > 0 &&
    maxAgents <= MAX_FLEET_NODE_AGENTS
  ) {
    return String(maxAgents);
  }
  return undefined;
}

/**
 * Adapt the relay SDK triggers API to the fleet {@link FleetTriggerSyncClient}
 * contract so a served node can reconcile its declared triggers. The fleet
 * package never constructs a relay client itself (avoids a circular dependency),
 * so the CLI supplies this near-passthrough adapter.
 */
export function createTriggerSyncClient({
  workspaceKey,
  baseUrl,
}: {
  workspaceKey: string;
  baseUrl?: string;
}): FleetTriggerSyncClient {
  const relay = new AgentRelay({ workspaceKey, ...(baseUrl ? { baseUrl } : {}) });
  return {
    list: () => relay.triggers.list(),
    create: (input) => relay.triggers.create(input),
    update: (id, input) => relay.triggers.update(id, input),
    delete: (id) => relay.triggers.delete(id),
  };
}
