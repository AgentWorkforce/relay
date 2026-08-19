import { AgentRelay } from '@agent-relay/sdk';
import { nodeRepoKeys, type FleetTriggerSyncClient } from '@agent-relay/fleet';

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
const DEFAULT_HARNESSES = ['claude', 'codex', 'gemini', 'opencode'] as const;

/**
 * The minimum a node config has to expose to contribute `spawn:<harness>`
 * capacity: its capability names. A full {@link FleetNodeDefinition} satisfies
 * this, and so does the descriptor reported by a node definition served
 * out-of-process (which the CLI never loads in-process, so it has capability
 * names but no handlers).
 */
export type NodeCapacitySource = { capabilities: Readonly<Record<string, unknown>> };

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

/** Env var carrying the node's placement-safe repository keys to the broker. */
export const NODE_REPO_KEYS_ENV = 'AGENT_RELAY_NODE_REPO_KEYS';

/**
 * The minimum a node config has to expose to advertise repository placement
 * keys. A full {@link FleetNodeDefinition} satisfies this, and so does the
 * descriptor reported by a node definition served out-of-process.
 */
export type NodeRepoKeySource = { repoPaths?: Readonly<Record<string, string>> };

/**
 * Resolve the `AGENT_RELAY_NODE_REPO_KEYS` CSV the native broker registers
 * `repo_keys` (and the matching `repo:<owner/name>` tags) from.
 *
 * Only the map's KEYS travel: the absolute checkout paths stay node-local, so
 * the Fleet wire never carries a filesystem layout.
 *
 * Presence is the signal, mirroring `nodeRegistrationTags`:
 * - no `repoPaths` in the definition -> `undefined`, and the broker leaves its
 *   registration tags/`repo_keys` exactly as before (backward compatible).
 * - `repoPaths` present -> the sorted keys, possibly the empty string, which
 *   authoritatively clears stale repository advertisements on the control plane.
 *
 * A pre-set value is the operator's authoritative declaration and wins verbatim.
 * Unlike {@link resolveNodeCapacityHarnesses}, an explicitly EMPTY preset is
 * honored rather than treated as unset: it is how an operator clears a
 * configured node's stale advertisements, so falling through to the definition
 * there would silently re-publish the keys they just cleared.
 */
export function resolveNodeRepoKeys(
  preset: string | undefined,
  definition?: NodeRepoKeySource
): string | undefined {
  if (preset !== undefined) {
    return preset.trim();
  }
  if (!definition || definition.repoPaths === undefined) {
    return undefined;
  }
  return nodeRepoKeys(definition).join(',');
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
