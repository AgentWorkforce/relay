export {
  readStoredAuth,
  writeStoredAuth,
  clearStoredAuth,
  refreshStoredAuth,
  refreshStoredCloudIdentity,
  hasCurrentStoredCloudIdentity,
  toCloudIdentity,
  ensureAuthenticated,
  ensureCloudSession,
  authorizedApiFetch,
  loginWithDevice,
} from './auth.js';

export {
  isHeadlessEnvironment,
  startDeviceAuthorization,
  pollForDeviceToken,
  runDeviceAuthorizationFlow,
  formatDeviceInstructions,
  type DeviceAuthorization,
  type DeviceFlowHooks,
} from './device-auth.js';

export {
  IDENTITY_ENV_KEYS,
  IDENTITY_FILE_PATH,
  identityFilePath,
  readStoredIdentity,
  readStoredIdentitySync,
  writeStoredIdentity,
  clearStoredIdentity,
  resolveCloudIdentity,
  normalizeCloudIdentity,
  cloudIdentityEnv,
  cloudIdentityFingerprint,
  type CloudIdentity,
} from './identity.js';

export {
  buildAgentRelayTelemetryHeaders,
  appendAgentRelayTelemetryHeaders,
  AGENT_RELAY_DISTINCT_ID_HEADER,
  AGENT_RELAY_USER_ID_HEADER,
  AGENT_RELAY_ORG_ID_HEADER,
  AGENT_RELAY_ORG_SLUG_HEADER,
} from './telemetry-headers.js';

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
export { redactCredentialValues } from './redact.js';

export {
  acknowledgeCloudWorkerAssignment,
  cloudWorkerStateDir,
  cloudWorkerStorePath,
  downloadCloudWorkerAssignmentStorage,
  headCloudWorkerAssignmentStorage,
  readCloudWorkerStore,
  registerCloudWorker,
  reportCloudWorkerAssignmentStatus,
  resolveCloudWorkerRecord,
  resolveWorkerWorkflowPayload,
  runCloudWorkerLoop,
  sendCloudWorkerHeartbeat,
  streamCloudWorkerQueue,
  upsertCloudWorkerRecord,
  writeCloudWorkerStore,
  type CloudWorkerLoopOptions,
  type CloudWorkerRecord,
  type CloudWorkerStore,
  type ExecuteWorkerAssignment,
  type WorkAssignmentRecord,
  type WorkerFileType,
  type WorkerQueueEvent,
  type WorkerStatusDetail,
  type WorkerWorkflowPayload,
  type WorkerWorkflowRef,
} from './worker.js';

export {
  enrollFleetNode,
  fleetNodeEnrollmentStorePath,
  readFleetNodeEnrollmentStore,
  writeFleetNodeEnrollmentStore,
  upsertFleetNodeEnrollment,
  resolveActiveFleetNodeEnrollment,
  type EnrollFleetNodeInput,
  type FleetNodeEnrollment,
  type FleetNodeEnrollmentRecord,
  type FleetNodeEnrollmentStore,
} from './fleet.js';

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
  projectWorkspaceKeyPath,
  readProjectWorkspaceKey,
  readProjectWorkspaceSession,
  resolveActiveWorkspaceSelection,
  resolveWorkspaceKey,
  resolveWorkspaceKeyWithSource,
  resolveWorkspaceSelection,
  writeProjectWorkspaceKey,
  type ProjectWorkspaceSession,
  type ResolveWorkspaceKeyOptions,
  type WorkspaceKeyFileSystem,
  type WorkspaceKeySource,
  type WorkspaceSelection,
} from './project-workspace-key.js';

export {
  describeDataPlaneConvergence,
  formatDataPlaneDivergence,
  type DataPlaneConvergence,
  type DataPlaneWorkspaceIds,
} from './workspace-convergence.js';

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
  REFRESH_TOKEN_WINDOW_MS,
  DEFAULT_REFRESH_TIMEOUT_MS,
  AUTH_FILE_PATH,
  defaultApiUrl,
  isSupportedProvider,
} from './types.js';
