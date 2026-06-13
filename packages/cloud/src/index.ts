export {
  readStoredAuth,
  writeStoredAuth,
  clearStoredAuth,
  refreshStoredAuth,
  ensureAuthenticated,
  ensureCloudSession,
  authorizedApiFetch,
} from './auth.js';

export {
  CloudApiClient,
  buildApiUrl,
  type CloudApiClientOptions,
  type CloudApiClientSnapshot,
} from './api-client.js';

export {
  runWorkflow,
  scheduleWorkflow,
  listWorkflowSchedules,
  getRunStatus,
  getRunLogs,
  cancelWorkflow,
  syncWorkflowPatch,
  resolveWorkflowInput,
  inferWorkflowFileType,
  shouldSyncCodeByDefault,
} from './workflows.js';

export {
  connectProvider,
  getProviderHelpText,
  normalizeProvider,
  type ConnectProviderIo,
  type ConnectProviderOptions,
  type ConnectProviderResult,
} from './connect.js';

export { createWorkspace, issueWorkspaceToken, resolveActiveWorkspace } from './workspaces.js';

export {
  activeWorkspaceKey,
  readWorkspaceStore,
  resolveActiveWorkspaceKey,
  setActiveWorkspace,
  setWorkspaceKey,
  switchWorkspace,
  validateWorkspaceName,
  workspaceStorePath,
  writeWorkspaceStore,
  type WorkspaceStore,
} from './workspace-store.js';

export {
  deployProactiveAgent,
  listProactiveAgents,
  inspectProactiveAgent,
  undeployProactiveAgent,
  createWorkspaceSecret,
  getWorkspaceSecret,
  deleteWorkspaceSecret,
} from './proactive-runtime.js';

export {
  runInteractiveSession,
  formatShellInvocation,
  wrapWithLaunchCheckpoint,
  type SshConnectionInfo,
  type InteractiveSessionOptions,
  type InteractiveSessionResult,
} from './lib/ssh-interactive.js';

export {
  loadSSH2,
  createAskpassScript,
  buildSystemSshArgs,
  DEFAULT_SSH_RUNTIME,
  type AuthSshRuntime,
} from './lib/ssh-runtime.js';

// Cross-product identity, permissions, tokens, and audit primitives.
export * from './permissions.js';
export * from './provisioning-types.js';
export {
  defaultPermissionsForPreset,
  expandPreset,
  globsToScopes,
  compileAgentPermissions,
  mergeAcl,
  resolveAgentPermissions,
  compileAgentScopes,
  mergePermissionSources,
  expandAccessPreset,
  globToScopes,
} from './compiler.js';
export {
  DEFAULT_WORKFLOW_TOKEN_TTL_SECONDS,
  DEFAULT_ADMIN_AGENT_NAME,
  DEFAULT_ADMIN_SCOPES,
  mintAgentToken,
  type TokenClaims,
} from './token.js';
export {
  createLocalJwks,
  createLocalJwksKeyPair,
  exportPrivateKeyPem,
  importPrivateKeyPem,
  RELAYAUTH_JWKS_URL_ENV,
  RELAYAUTH_JWT_KID_ENV,
  RELAYAUTH_JWT_PRIVATE_KEY_PEM_ENV,
  type LocalJwks,
  type LocalJwksKeyPair,
  type LocalJwksSigningKey,
} from './local-jwks.js';
export { PermissionAuditLog, getDefaultPermissionAuditPath } from './audit.js';

export {
  type StoredAuth,
  CloudAuthError,
  type CloudAuthErrorCode,
  type CloudSession,
  type CloudSessionOptions,
  type WhoAmIResponse,
  type AuthSessionResponse,
  type ActiveWorkspaceDescriptor,
  type ActiveWorkspaceUrls,
  type WorkspaceCreateResponse,
  type WorkspaceTokenIssueResponse,
  type WorkspaceTokenRecord,
  type ProactiveDeploymentResponse,
  type ProactiveAgentRecord,
  type WorkspaceSecretRecord,
  type WorkflowFileType,
  type RunWorkflowResponse,
  type WorkflowSchedule,
  type ScheduleWorkflowOptions,
  type WorkflowLogsResponse,
  type SyncPatchResponse,
  SUPPORTED_PROVIDERS,
  REFRESH_WINDOW_MS,
  DEFAULT_REFRESH_TIMEOUT_MS,
  AUTH_FILE_PATH,
  LEGACY_AUTH_FILE_PATH,
  defaultApiUrl,
  isSupportedProvider,
} from './types.js';
