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
  /** Named sessions are also stored and selected in the machine-global workspace store. */
  name?: string;
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
  const keepsWorkspace = existing?.workspaceKey === workspaceKey;
  const enrolledNodeId = keepsWorkspace ? existing?.enrolledNodeId : undefined;
  writeProjectWorkspaceKey(projectDataDir, workspaceKey, {
    ...(enrolledNodeId ? { enrolledNodeId } : {}),
  });

  if (name) {
    setWorkspaceKey(name, workspaceKey, options.env);
    switchWorkspace(name, options.env);
  }

  return existing?.enrolledNodeId && !enrolledNodeId
    ? { clearedEnrolledNodeId: existing.enrolledNodeId }
    : {};
}
