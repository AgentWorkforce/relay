// Client interface (SDK adapter)
export {
  createRelayClient,
  createRelayClientAdapter,
  type RelayClient,
  type QueryMessage,
  type HealthResponse,
  type MetricsResponse,
  type MessagesResponse,
} from './client-adapter.js';

// Project discovery helper
export { discoverProjectRoot } from './hybrid-client.js';

// Simple programmatic API (no MCP protocol overhead)
export {
  createTools,
  send,
  inbox,
  who,
  type RelayTools,
  type ToolsConfig,
  type Message,
  type Agent,
  type Status,
  type SpawnResult,
} from './simple.js';

// Server
export { createMCPServer, runMCPServer, type MCPServerConfig } from './server.js';

// Tools (for direct usage or custom server implementations)
export {
  relaySendTool,
  relaySendSchema,
  handleRelaySend,
  type RelaySendInput,
  relayInboxTool,
  relayInboxSchema,
  handleRelayInbox,
  type RelayInboxInput,
  relayWhoTool,
  relayWhoSchema,
  handleRelayWho,
  type RelayWhoInput,
  relaySpawnTool,
  relaySpawnSchema,
  handleRelaySpawn,
  type RelaySpawnInput,
  relayReleaseTool,
  relayReleaseSchema,
  handleRelayRelease,
  type RelayReleaseInput,
  relayStatusTool,
  relayStatusSchema,
  handleRelayStatus,
  type RelayStatusInput,
  relayLogsTool,
  relayLogsSchema,
  handleRelayLogs,
  type RelayLogsInput,
  relayMetricsTool,
  relayMetricsSchema,
  handleRelayMetrics,
  type RelayMetricsInput,
  relayHealthTool,
  relayHealthSchema,
  handleRelayHealth,
  type RelayHealthInput,
  relayContinuityTool,
  relayContinuitySchema,
  handleRelayContinuity,
  type RelayContinuityInput,
  // Admin channel operations
  relayAdminChannelJoinTool,
  relayAdminChannelJoinSchema,
  handleRelayAdminChannelJoin,
  type RelayAdminChannelJoinInput,
  relayAdminRemoveMemberTool,
  relayAdminRemoveMemberSchema,
  handleRelayAdminRemoveMember,
  type RelayAdminRemoveMemberInput,
  // Query messages
  relayQueryMessagesTool,
  relayQueryMessagesSchema,
  handleRelayQueryMessages,
  type RelayQueryMessagesInput,
} from './tools/index.js';

// Prompts
export { protocolPrompt, getProtocolPrompt, PROTOCOL_DOCUMENTATION } from './prompts/index.js';

// Resources
export {
  agentsResource,
  getAgentsResource,
  inboxResource,
  getInboxResource,
  projectResource,
  getProjectResource,
} from './resources/index.js';

// Errors
export {
  RelayError,
  DaemonNotRunningError,
  AgentNotFoundError,
  TimeoutError,
  ConnectionError,
  ChannelNotFoundError,
  SpawnError,
} from './errors.js';

// Cloud/Discovery
export {
  discoverSocket,
  discoverAgentName,
  detectCloudWorkspace,
  isCloudWorkspace,
  getCloudSocketPath,
  getConnectionInfo,
  type DiscoveryResult,
  type CloudWorkspace,
  type CloudConnectionInfo,
} from './cloud.js';

// Installation
export {
  installMcpConfig,
  installForEditor,
  install,
  uninstall,
  uninstallFromEditor,
  isInstalledFor,
  detectInstalledEditors,
  getEditorConfig,
  listSupportedEditors,
  getDefaultServerConfig,
  type InstallOptions,
  type InstallResult,
  type EditorConfig,
  type McpServerConfig,
} from './install.js';
