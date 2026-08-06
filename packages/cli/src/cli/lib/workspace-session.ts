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

/**
 * Pin a workspace to the current project so later CLI and MCP processes resume
 * the same collaboration session. A named selection also becomes the
 * machine-global active workspace; a bare shared key only changes this project.
 */
export function persistWorkspaceSession(options: PersistWorkspaceSessionOptions): void {
  const workspaceKey = options.workspaceKey.trim();
  if (!workspaceKey) {
    throw new Error('Workspace key is required.');
  }

  const name = options.name === undefined ? undefined : validateWorkspaceSessionName(options.name);

  const projectDataDir = options.projectDataDir ?? getProjectPaths(options.projectRoot).dataDir;
  // The enrolled Fleet node is a property of this machine+project, not of the
  // workspace being selected. Dropping it here silently manufactured the broken
  // state `node up` warns about: a pin with no node id, which makes the next
  // start ignore the enrollment store entirely.
  const enrolledNodeId = readProjectWorkspaceSession(projectDataDir)?.enrolledNodeId;
  writeProjectWorkspaceKey(projectDataDir, workspaceKey, {
    ...(enrolledNodeId ? { enrolledNodeId } : {}),
  });

  if (name) {
    setWorkspaceKey(name, workspaceKey, options.env);
    switchWorkspace(name, options.env);
  }
}
