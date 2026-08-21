/**
 * Live-agent placement decoded from a fleet node's heartbeat.
 *
 * Each node advertises the broker-owned set of worker names it is currently
 * running as a `relay:live-agents:v1` capability on its roster record, so
 * `nodes.list()` alone answers "which node is agent X on?" — no per-node
 * round-trip. `fleet agent list` renders it; `fleet-hint` uses it to name the
 * node in a cross-node attach error.
 *
 * Lives in `lib/` rather than in the `fleet agent` command because two
 * different surfaces consume it and an error path must not import a command
 * module to read it.
 */

import type { RelayNode } from '@agent-relay/sdk';

export interface RemoteLiveAgent {
  name: string;
}

export const LIVE_AGENT_CAPABILITY_NAME = 'relay:live-agents:v1';

export interface RemoteLiveAgentRead {
  supported: boolean;
  agents: RemoteLiveAgent[];
  warning?: string;
}

/** Decode the broker-owned WorkerName set carried by a node heartbeat. */
export function readRemoteLiveAgents(node: RelayNode): RemoteLiveAgentRead {
  let supported = false;
  let malformed = 0;
  const names = new Set<string>();
  for (const capability of node.capabilities) {
    if (capability.name !== LIVE_AGENT_CAPABILITY_NAME) continue;
    supported = true;
    const rawNames = capability.metadata?.names;
    if (!Array.isArray(rawNames)) {
      malformed += 1;
      continue;
    }
    for (const rawName of rawNames) {
      if (typeof rawName !== 'string' || !rawName || names.has(rawName)) {
        malformed += 1;
        continue;
      }
      names.add(rawName);
    }
  }
  return {
    supported,
    agents: Array.from(names, (name) => ({ name })).sort((a, b) => a.name.localeCompare(b.name)),
    ...(malformed > 0
      ? {
          warning: `${malformed} malformed or duplicate live-agent heartbeat capabilit${malformed === 1 ? 'y' : 'ies'}`,
        }
      : {}),
  };
}
