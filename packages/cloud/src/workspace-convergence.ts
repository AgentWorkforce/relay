/**
 * The data-plane workspace-identity invariant.
 *
 * A workspace is only durable if Relaycast, Relayfile, and RelayAuth all resolve
 * it to the SAME data-plane workspace id. When they diverge, each plane keeps
 * its own view of who is a member, so a node restart can re-register an agent
 * against a different plane and hand it a new address — the exact failure this
 * check exists to make visible before it happens.
 *
 * The Cloud workspace id is deliberately excluded: it is the control-plane
 * record that *points at* the data plane, and it legitimately uses a different
 * id space (a UUID rather than an `rw_` identity).
 */

import type { ActiveWorkspaceDescriptor } from './types.js';

/** The three data planes that must agree on one workspace identity. */
export interface DataPlaneWorkspaceIds {
  relaycast: string;
  relayfile: string;
  relayauth: string;
}

export interface DataPlaneConvergence {
  /** True when all three planes report one identical workspace id. */
  unified: boolean;
  /** The single shared data-plane id. Present only when `unified`. */
  workspaceId?: string;
  /** Per-plane ids, always present so a divergence report names the culprits. */
  planes: DataPlaneWorkspaceIds;
  /** Plane names that disagree with the majority/first id. Empty when unified. */
  divergent: Array<keyof DataPlaneWorkspaceIds>;
}

/**
 * Describe whether a resolved workspace satisfies the data-plane identity
 * invariant. Pure and side-effect free: callers decide whether a divergence is
 * a warning or a hard failure.
 */
export function describeDataPlaneConvergence(
  workspace: Pick<
    ActiveWorkspaceDescriptor,
    'relaycastWorkspaceId' | 'relayfileWorkspaceId' | 'relayauthWorkspaceId'
  >
): DataPlaneConvergence {
  const planes: DataPlaneWorkspaceIds = {
    relaycast: workspace.relaycastWorkspaceId,
    relayfile: workspace.relayfileWorkspaceId,
    relayauth: workspace.relayauthWorkspaceId,
  };

  const entries = Object.entries(planes) as Array<[keyof DataPlaneWorkspaceIds, string]>;
  const [, reference] = entries[0]!;
  const divergent = entries.filter(([, id]) => id !== reference).map(([plane]) => plane);

  return divergent.length === 0
    ? { unified: true, workspaceId: reference, planes, divergent: [] }
    : { unified: false, planes, divergent };
}

/**
 * Human-readable one-liner naming which planes disagree. Contains no secrets —
 * workspace ids are identifiers, not credentials.
 */
export function formatDataPlaneDivergence(convergence: DataPlaneConvergence): string {
  const detail = (Object.entries(convergence.planes) as Array<[string, string]>)
    .map(([plane, id]) => `${plane}=${id}`)
    .join(', ');
  return (
    'Workspace identity is not durable: Relaycast, Relayfile, and RelayAuth resolve ' +
    `to different data-plane workspaces (${detail}). Agents re-registering after a ` +
    'node restart may be issued a new address.'
  );
}
