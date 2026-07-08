import path from 'node:path';

import { AgentRelay } from '@agent-relay/sdk';
import type { FleetNodeDefinition, FleetTriggerSyncClient } from '@agent-relay/fleet';
import { defineDefaultLocalNode } from '@agent-relay/fleet';

import type { CoreProjectPaths, CoreTeamsConfig } from '../commands/core.js';

/** Absolute path to the diagnostic status file a served node writes. */
export function fleetStatusPath(paths: CoreProjectPaths): string {
  return path.join(paths.dataDir, 'fleet-node.json');
}

/**
 * Build the implicit local fleet node definition that `relay node up` serves
 * alongside the broker when no explicit config file is discovered.
 */
export function createImplicitLocalFleetNode(input: {
  paths: CoreProjectPaths;
  teamsConfig?: CoreTeamsConfig | null;
  name?: string;
  maxAgents?: number;
}): FleetNodeDefinition {
  return defineDefaultLocalNode({
    name: input.name ?? (path.basename(input.paths.projectRoot) || 'local-node'),
    ...(input.maxAgents !== undefined ? { maxAgents: input.maxAgents } : {}),
    teams: input.teamsConfig ?? null,
  });
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
