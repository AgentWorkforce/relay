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
 */

import type { AgentRelay } from '@agent-relay/sdk';

import { createWorkspaceRelay } from './sdk-client.js';

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

    let agent: { metadata?: Record<string, unknown> };
    try {
      agent = await relay.agents.get(agentName);
    } catch {
      // 404 from the workspace registry (or any network error) — the agent
      // truly does not exist anywhere, or we can't tell. Original message.
      return null;
    }

    const fleet = (agent.metadata as Record<string, unknown> | undefined)?.fleet;
    const nodeId =
      typeof fleet === 'object' && fleet !== null ? (fleet as Record<string, unknown>).nodeId : undefined;
    if (typeof nodeId !== 'string' || !nodeId) return null;

    // Resolve the node's human-readable name by looking it up in the roster.
    // A failure here is non-fatal — we still emit a hint with the raw ID.
    try {
      const nodes = await relay.nodes.list();
      const node = nodes.find((n) => n.nodeId === nodeId || n.id === nodeId);
      if (node?.name) {
        return `on node '${node.name}'`;
      }
    } catch {
      // Node lookup failed — fall back to the raw ID hint.
    }

    return `on node '${nodeId}'`;
  } catch {
    // Unexpected error in the outer try — never propagate.
    return null;
  }
}
