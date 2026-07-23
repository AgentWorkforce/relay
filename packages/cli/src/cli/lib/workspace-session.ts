import { getProjectPaths } from '@agent-relay/config';
import { resolveWorkspaceKeyWithSource } from '@agent-relay/cloud/workspace-key';

import { writeProjectWorkspaceKey } from './project-workspace-key.js';
import { setWorkspaceKey, switchWorkspace } from './workspace-store.js';

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

  const name = options.name?.trim();
  if (options.name !== undefined && !name) {
    throw new Error('Workspace name is required.');
  }

  const projectDataDir = options.projectDataDir ?? getProjectPaths(options.projectRoot).dataDir;
  writeProjectWorkspaceKey(projectDataDir, workspaceKey);

  if (name) {
    setWorkspaceKey(name, workspaceKey, options.env);
    switchWorkspace(name, options.env);
  }
}
