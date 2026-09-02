import { getProjectPaths } from '@agent-relay/config';

import {
  projectWorkspaceKeyPath,
  readProjectWorkspaceSession,
  writeProjectWorkspaceKey,
} from './project-workspace-key.js';

/** Outcome of reconciling a fresh enrollment against the project workspace pin. */
export type EnrolledNodePinResult =
  /** No project pin (or no node id to record) — `node up` resolves the enrollment globally. */
  | { status: 'no-pin' }
  /** The pin already names this node. */
  | { status: 'unchanged'; nodeId: string; pinPath: string; workspaceVerified: boolean }
  /** The pin now names this node, so `node up` serves it from this project. */
  | { status: 'linked'; nodeId: string; pinPath: string; workspaceVerified: boolean }
  /** The pin names a different node; it is left untouched for the operator to resolve. */
  | { status: 'conflict'; nodeId: string; pinnedNodeId: string; pinPath: string }
  /** The pin and enrollment name different Relay workspaces; the pin is left untouched. */
  | {
      status: 'workspace-conflict';
      nodeId: string;
      relayWorkspaceId: string;
      pinnedWorkspaceId: string;
      pinPath: string;
    };

export interface LinkEnrolledNodeToProjectPinOptions {
  /** Node id from the enrollment record just persisted. */
  nodeId: string;
  /** Relay workspace id from the enrollment record just persisted. */
  relayWorkspaceId?: string;
  /** Project root whose pin should be reconciled. Defaults to the current project. */
  projectRoot?: string;
  /** Explicit project Relay data directory. Takes precedence over `projectRoot`. */
  projectDataDir?: string;
}

/**
 * Record a freshly enrolled node on the project workspace pin.
 *
 * `relay cloud enroll` writes only `fleet-enrollments.json`, so a repo pinned to
 * a workspace stays pinned with no `enrolledNodeId` — and `relay node up` then
 * ignores the enrollment entirely. Linking the two here closes that gap.
 *
 * An existing, different `enrolledNodeId` is never overwritten: the enrollment
 * token is already redeemed by the time this runs, so silently repointing a pin
 * would trade one invisible mismatch for another. Report it and let the operator
 * choose.
 *
 * @param options - The enrolled node id and the project to reconcile.
 * @returns What happened to the pin.
 */
export function linkEnrolledNodeToProjectPin(
  options: LinkEnrolledNodeToProjectPinOptions
): EnrolledNodePinResult {
  const nodeId = options.nodeId.trim();
  if (!nodeId) {
    return { status: 'no-pin' };
  }

  const dataDir = options.projectDataDir ?? getProjectPaths(options.projectRoot).dataDir;
  const session = readProjectWorkspaceSession(dataDir);
  if (!session) {
    return { status: 'no-pin' };
  }

  const pinPath = projectWorkspaceKeyPath(dataDir);
  const relayWorkspaceId = options.relayWorkspaceId?.trim();
  const pinnedWorkspaceId = session.workspaceId?.trim();
  if (relayWorkspaceId && pinnedWorkspaceId && relayWorkspaceId !== pinnedWorkspaceId) {
    return {
      status: 'workspace-conflict',
      nodeId,
      relayWorkspaceId,
      pinnedWorkspaceId,
      pinPath,
    };
  }
  if (session.enrolledNodeId === nodeId) {
    return { status: 'unchanged', nodeId, pinPath, workspaceVerified: Boolean(pinnedWorkspaceId) };
  }
  if (session.enrolledNodeId) {
    return { status: 'conflict', nodeId, pinnedNodeId: session.enrolledNodeId, pinPath };
  }

  writeProjectWorkspaceKey(dataDir, session.workspaceKey, {
    enrolledNodeId: nodeId,
    ...(pinnedWorkspaceId ? { workspaceId: pinnedWorkspaceId } : {}),
  });
  return { status: 'linked', nodeId, pinPath, workspaceVerified: Boolean(pinnedWorkspaceId) };
}
