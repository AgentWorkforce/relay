import { getProjectPaths } from '@agent-relay/config';
import { resolveWorkspaceKeyWithSource } from '@agent-relay/cloud/workspace-key';

import { readProjectWorkspaceSession, writeProjectWorkspaceKey } from './project-workspace-key.js';
import { setWorkspaceKey, switchWorkspace, validateWorkspaceName } from './workspace-store.js';

export interface WorkspaceSessionOptions {
  env?: NodeJS.ProcessEnv;
  projectRoot?: string;
  projectDataDir?: string;
}

export interface PersistWorkspaceSessionOptions extends WorkspaceSessionOptions {
  workspaceKey: string;
  /** Canonical Relaycast workspace id, when the credential issuer supplies it. */
  workspaceId?: string;
  /** Named sessions are also stored and selected in the machine-global workspace store. */
  name?: string;
}

export interface PinProjectWorkspaceSessionOptions extends WorkspaceSessionOptions {
  workspaceKey: string;
}

/** Validate and normalize a workspace session name before local or remote writes. */
export function validateWorkspaceSessionName(name: string): string {
  return validateWorkspaceName(name);
}

/**
 * Resolve the workspace session for this process. Explicit/env selection still
 * wins, then the project pin, then the machine-global active workspace.
 */
export function resolveWorkspaceSessionKey(options: WorkspaceSessionOptions = {}): string | undefined {
  return resolveWorkspaceKeyWithSource(options)?.key;
}

export interface PersistWorkspaceSessionResult {
  /**
   * Enrolled node association dropped because the project moved to a different
   * workspace. Present only when there was one to drop.
   */
  clearedEnrolledNodeId?: string;
}

/**
 * Operator-facing explanation of a dropped enrollment association.
 *
 * Shared by every caller that changes the pin — CLI and MCP alike — so none of
 * them can report success while the clearing goes unmentioned.
 *
 * @param result - What {@link persistWorkspaceSession} reported.
 * @returns The message, or `undefined` when nothing was cleared.
 */
export function describeClearedEnrollment(result: PersistWorkspaceSessionResult): string | undefined {
  if (!result.clearedEnrolledNodeId) {
    return undefined;
  }
  return (
    `Cleared this project's enrolled fleet node (${result.clearedEnrolledNodeId}): it belongs to the ` +
    "workspace you moved away from. Run 'relay cloud enroll' from this project to serve a node in the " +
    'new workspace.'
  );
}

/**
 * Pin a workspace to the current project so later CLI and MCP processes resume
 * the same collaboration session. A named selection also becomes the
 * machine-global active workspace; a bare shared key only changes this project.
 *
 * @returns What the write changed beyond the key itself.
 */
export function persistWorkspaceSession(
  options: PersistWorkspaceSessionOptions
): PersistWorkspaceSessionResult {
  const workspaceKey = options.workspaceKey.trim();
  if (!workspaceKey) {
    throw new Error('Workspace key is required.');
  }

  const name = options.name === undefined ? undefined : validateWorkspaceSessionName(options.name);

  const projectDataDir = options.projectDataDir ?? getProjectPaths(options.projectRoot).dataDir;
  const existing = readProjectWorkspaceSession(projectDataDir);
  // Re-selecting the same workspace must keep the enrolled node: dropping it
  // there manufactured the pin `node up` now warns about, where the next start
  // ignores the enrollment store entirely.
  //
  // Moving to a *different* workspace must not. The enrollment resolves by node
  // id alone, and `node up` applies its credentials without applying the pinned
  // key — so carrying the id across would run the broker in the old workspace
  // while every other command in this project reads the new one. That is the
  // split this whole change exists to remove, and the workspace ids the
  // enrollment store holds cannot be checked against the key the pin holds.
  //
  // This intentionally does NOT delegate to `pinProjectWorkspaceSession`
  // below, which always drops the enrolled-node association — that is correct
  // for an explicit `rebind` but would reintroduce the bug described above
  // for an ordinary switch/join/create that happens to stay on the same key.
  const keepsWorkspace = existing?.workspaceKey === workspaceKey;
  const enrolledNodeId = keepsWorkspace ? existing?.enrolledNodeId : undefined;
  writeProjectWorkspaceKey(projectDataDir, workspaceKey, {
    ...(enrolledNodeId ? { enrolledNodeId } : {}),
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
  });

  if (name) {
    setWorkspaceKey(name, workspaceKey, options.env);
    switchWorkspace(name, options.env);
  }

  return existing?.enrolledNodeId && !enrolledNodeId
    ? { clearedEnrolledNodeId: existing.enrolledNodeId }
    : {};
}

/**
 * Rebind only the current project to a workspace key. This intentionally drops
 * any enrolled-node association: a later `node up` must honor the newly pinned
 * messaging workspace instead of resuming credentials from the old binding.
 */
export function pinProjectWorkspaceSession(options: PinProjectWorkspaceSessionOptions): void {
  const workspaceKey = options.workspaceKey.trim();
  if (!workspaceKey) {
    throw new Error('Workspace key is required.');
  }
  const projectDataDir = options.projectDataDir ?? getProjectPaths(options.projectRoot).dataDir;
  writeProjectWorkspaceKey(projectDataDir, workspaceKey);
}
