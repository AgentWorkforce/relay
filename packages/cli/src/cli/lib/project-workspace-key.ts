// Compatibility re-export for existing CLI-local imports. The public cloud
// package owns this contract so SDK consumers and the CLI cannot drift.
export {
  projectWorkspaceKeyPath,
  readProjectWorkspaceKey,
  readProjectWorkspaceSession,
  resolveActiveWorkspaceSelection,
  resolveWorkspaceSelection,
  writeProjectWorkspaceKey,
  type ProjectWorkspaceSession,
  type WorkspaceKeyFileSystem,
  type WorkspaceSelection,
} from '@agent-relay/cloud/workspace-key';
