/**
 * Best-effort workspace registry lookup for improving "no agent named X"
 * error messages across attach-style verbs (view, drive, passthrough).
 *
 * When a local broker returns 404 for an agent name, that agent may still be
 * registered workspace-wide on a different fleet node. This helper probes the
 * workspace registry and returns a human-readable placement description so
 * attach verbs can emit:
 *
 *   Error: agent 'X' is registered on node 'finn-mini'; cross-node attach is
 *   not yet supported — run `agent-relay node agent attach X` on that machine
 *
 * instead of the indistinguishable "no agent named 'X'" a local-only lookup
 * produces.
 *
 * All errors are silently swallowed — the caller always falls back to the
 * original message on any failure (no credentials, network error, etc.).
 *
 * **Workspace-binding caveat:** This helper probes the workspace resolved from
 * ambient environment variables (the same workspace `agent-relay agent list`
 * uses). When attach is directed at a broker in a different workspace (via
 * `--broker-url` / `--api-key`), the workspace this lookup targets may differ
 * from the one the 404 came from. A same-named agent in the ambient workspace
 * can produce a false-positive cross-node hint, or a genuinely remote agent
 * (known only in the target broker's workspace) can be missed. For Phase 1
 * this is acceptable — the hint is informational only and cannot change attach
 * semantics. Phase 2's `--node` flag will make node resolution explicit.
 */

import type { AgentRelay } from '@agent-relay/sdk';

import { createWorkspaceRelay } from './sdk-client.js';
import { readRemoteLiveAgents } from './fleet-live-agents.js';

/**
 * Injectable factory — lets callers (and tests) substitute a workspace
 * client without hitting the network.
 */
export type CreateRelayFn = () => AgentRelay;

/**
 * Try to find where `agentName` is registered in the workspace and return a
 * human-readable description of its fleet placement, e.g.
 * `"on node 'finn-mini'"`. Returns `null` when:
 *
 * - The agent is not in the workspace registry (it truly doesn't exist).
 * - The agent is in the registry but has no fleet placement.
 * - Workspace credentials are not available in the environment.
 * - Any network or parse error occurs.
 *
 * This function is designed to be called on the error path only — it always
 * resolves, never rejects.
 */
export async function resolveFleetHint(
  agentName: string,
  createRelay: CreateRelayFn = createWorkspaceRelay
): Promise<string | null> {
  try {
    let relay: AgentRelay;
    try {
      relay = createRelay();
    } catch {
      // No workspace credentials in env — fall back to original message.
      return null;
    }

    let agent: { metadata?: Record<string, unknown> } | null = null;
    try {
      agent = await relay.agents.get(agentName);
    } catch {
      // Not in the workspace agent registry (404), or we could not reach it.
      // This is the COMMON case for the agents this hint exists to describe:
      // a broker-spawned worker on a fleet node is not a workspace-registered
      // agent at all, so this lookup 404s for exactly the names an operator
      // most often mistypes into a cross-node attach. Fall through to the
      // roster scan below rather than giving up here (relay#1597).
    }

    const fleet = (agent?.metadata as Record<string, unknown> | undefined)?.fleet;
    const nodeId =
      typeof fleet === 'object' && fleet !== null ? (fleet as Record<string, unknown>).nodeId : undefined;

    // Resolve the node's human-readable name by looking it up in the roster.
    // The same call also answers placement for a worker the agent registry
    // does not know about: every node advertises the set of workers it is
    // currently running on its heartbeat, so one `nodes.list()` covers both
    // paths with no extra round-trip.
    try {
      const nodes = await relay.nodes.list();
      if (typeof nodeId === 'string' && nodeId) {
        const node = nodes.find((n) => n.nodeId === nodeId || n.id === nodeId);
        if (node?.name) return `on node '${node.name}'`;
        // Registry knew the placement but the roster could not name the node.
        return `on node '${nodeId}'`;
      }
      for (const node of nodes) {
        if (!readRemoteLiveAgents(node).agents.some((live) => live.name === agentName)) continue;
        const label = node.name ?? node.nodeId ?? node.id;
        // A node with no usable identifier is worse than no hint: "on node
        // 'undefined'" tells the operator nothing and looks like a bug.
        if (typeof label === 'string' && label) return `on node '${label}'`;
      }
    } catch {
      // Roster lookup failed — fall back to whatever the registry gave us.
    }

    if (typeof nodeId === 'string' && nodeId) return `on node '${nodeId}'`;
    return null;
  } catch {
    // Unexpected error in the outer try — never propagate.
    return null;
  }
}
