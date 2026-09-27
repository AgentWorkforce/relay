import type { AgentRelay } from '@agent-relay/sdk';

import { FleetNodeAttachError, validateFleetAttachBaseUrl } from './attach-fleet-node.js';
import { createWorkspaceRelay, resolveWorkspaceTransport } from './sdk-client.js';

/** Resolve a CLI node name to the ID required by the terminal-session route. */
export async function resolveFleetNodeId(
  input: string,
  options: { workspaceKey?: string; baseUrl?: string; env?: NodeJS.ProcessEnv } = {},
  createRelay: (options: {
    workspaceKey: string;
    baseUrl: string;
  }) => Pick<AgentRelay, 'nodes'> = createWorkspaceRelay
): Promise<string> {
  const requested = input.trim().replace(/^#/, '');
  if (!requested) throw new FleetNodeAttachError('Error: --node requires a node name or id.', 'invalid_node');
  // Stable IDs already satisfy the terminal route and do not need a roster request.
  if (/^(?:node[_-]|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$)/i.test(requested)) {
    return requested;
  }
  const transport = resolveWorkspaceTransport(options);
  const baseUrl = validateFleetAttachBaseUrl(transport.baseUrl ?? 'https://cast.agentrelay.com');
  const nodes = await createRelay({ workspaceKey: transport.workspaceKey, baseUrl }).nodes.list();
  // Roster IDs need not use a particular prefix. Prefer an exact ID match
  // over another node's coincidentally identical name.
  if (nodes.some((node) => node.nodeId === requested || node.id === requested)) return requested;
  const matches = nodes.filter((node) => node.name === requested);
  if (matches.length > 1) {
    throw new FleetNodeAttachError(
      `Multiple fleet nodes are named ${JSON.stringify(requested)}. Pass a node ID.`,
      'ambiguous_node'
    );
  }
  if (matches.length === 1) {
    const id = matches[0].nodeId?.trim() || matches[0].id?.trim();
    if (id) return id;
    throw new FleetNodeAttachError(`Fleet node ${JSON.stringify(requested)} has no ID.`, 'invalid_node');
  }
  throw new FleetNodeAttachError(
    `No fleet node named ${JSON.stringify(requested)} was found.`,
    'node_not_found'
  );
}
