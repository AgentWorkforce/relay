// Compatibility re-export for existing CLI-local imports. The public cloud
// package owns this contract so SDK consumers and the CLI cannot drift.
export {
  projectWorkspaceKeyPath,
  readProjectWorkspaceKey,
  readProjectWorkspaceSession,
  writeProjectWorkspaceKey,
  type ProjectWorkspaceSession,
} from '@agent-relay/cloud/workspace-key';
