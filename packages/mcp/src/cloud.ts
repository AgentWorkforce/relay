/**
 * Cloud Integration for Agent Relay MCP Server
 *
 * This module re-exports all cloud/discovery functionality from
 * @agent-relay/utils, which is the single source of truth for socket
 * discovery, cloud workspace detection, and agent identity discovery.
 *
 * Previously this module contained its own implementation (~520 lines).
 * It has been consolidated into @agent-relay/utils to eliminate code
 * duplication between MCP and SDK packages.
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
