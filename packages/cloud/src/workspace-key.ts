// The machine-global store is the last step of the same precedence chain the
// project key participates in, so it belongs on this subpath: startup paths can
// resolve a workspace without pulling in the cloud package's HTTP surface.
export {
  resolveActiveWorkspaceKey,
  workspaceStorePath,
  type WorkspaceStore,
} from './workspace-store.js';

export {
  projectWorkspaceKeyPath,
  readProjectWorkspaceKey,
  readProjectWorkspaceSession,
  resolveWorkspaceKey,
  resolveWorkspaceKeyWithSource,
  writeProjectWorkspaceKey,
  type ProjectWorkspaceSession,
  type ResolveWorkspaceKeyOptions,
  type WorkspaceKeySource,
} from './project-workspace-key.js';
