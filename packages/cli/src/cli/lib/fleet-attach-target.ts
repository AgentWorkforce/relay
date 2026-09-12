import type { AgentRelay, RelayNode } from '@agent-relay/sdk';

import { describeError } from './describe-error.js';
import { isAvailableFleetNode, readRemoteLiveAgents } from './fleet-live-agents.js';
import { createWorkspaceRelay, resolveWorkspaceSelection, resolveWorkspaceTransport } from './sdk-client.js';

export interface FleetAttachTarget {
  node: string;
  baseUrl?: string;
}

export interface FleetAttachResolution {
  target?: FleetAttachTarget;
  error?: string;
}

export type CreateFleetRelay = () => AgentRelay;
export type ResolveFleetTransport = () => { baseUrl?: string };
export type ResolveFleetSelection = typeof resolveWorkspaceSelection;

/** Resolve a unique live fleet node for an agent name without exposing credentials. */
export async function resolveFleetAttachTarget(
  agentName: string,
  createRelay: CreateFleetRelay = createWorkspaceRelay,
  resolveTransport: ResolveFleetTransport = resolveWorkspaceTransport,
  readSelection: ResolveFleetSelection = resolveWorkspaceSelection
): Promise<FleetAttachResolution> {
  let selection: ReturnType<ResolveFleetSelection>;
  try {
    selection = readSelection();
  } catch (error) {
    return {
      error:
        `Fleet attach routing could not read the persisted workspace session for '${agentName}'. ` +
        `Pass --node explicitly or repair the project session. (${describeError(error)})`,
    };
  }
  const knownRemoteSession = Boolean(selection?.relaycastRoute && selection.relaycastBaseUrl);
  try {
    const relay = createRelay();
    const nodes = await relay.nodes.list();
    const matches = nodes.filter(
      (node) =>
        isAvailableFleetNode(node) &&
        readRemoteLiveAgents(node).agents.some((agent) => agent.name === agentName)
    );
    if (matches.length === 0) {
      return knownRemoteSession
        ? { error: `Agent '${agentName}' has no live Fleet placement on the persisted remote session.` }
        : {};
    }
    if (matches.length > 1) {
      const labels = matches.map(nodeLabel).filter(Boolean).join(', ');
      return {
        error: `Agent '${agentName}' is running on multiple fleet nodes (${labels}). Pass --node to choose one.`,
      };
    }
    const node = matches[0];
    const label = nodeLabel(node);
    if (!label) return { error: `Agent '${agentName}' is on a fleet node without a usable node identity.` };
    const transport = resolveTransport();
    return { target: { node: label, ...(transport.baseUrl ? { baseUrl: transport.baseUrl } : {}) } };
  } catch (error) {
    // Automatic routing is opportunistic. A missing credential or unavailable
    // control plane must preserve the established local attach error path.
    return knownRemoteSession
      ? {
          error:
            `The persisted remote Fleet session could not resolve '${agentName}'. ` +
            `Check fleet liveness or pass --node explicitly. (${describeError(error)})`,
        }
      : {};
  }
}

function nodeLabel(node: RelayNode): string | undefined {
  return [node.name, node.nodeId, node.id].find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0
  );
}
