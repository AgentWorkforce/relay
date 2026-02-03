/**
 * Socket Discovery & Cloud Workspace Detection
 *
 * Re-exports all discovery functionality from @agent-relay/utils,
 * which is the single source of truth. This module exists so SDK
 * consumers can import discovery from either '@agent-relay/sdk'
 * or '@agent-relay/sdk/discovery'.
 */

export {
  // Types
  type CloudWorkspace,
  type DiscoveryResult,
  type CloudConnectionOptions,
  type CloudConnectionInfo,

  // Cloud workspace detection
  detectCloudWorkspace,
  isCloudWorkspace,

  // Socket discovery
  getCloudSocketPath,
  getCloudOutboxPath,
  discoverSocket,

  // Cloud API helpers
  cloudApiRequest,
  getWorkspaceStatus,

  // Connection factory
  getConnectionInfo,

  // Debug helpers
  getCloudEnvironmentSummary,

  // Agent identity
  discoverAgentName,
} from '@agent-relay/utils/discovery';
