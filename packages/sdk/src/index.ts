/**
 * @agent-relay/sdk
 *
 * Lightweight SDK for agent-to-agent communication via Agent Relay.
 *
 * ## Quick Start
 *
 * ```typescript
 * import { RelayClient } from '@agent-relay/sdk';
 *
 * const client = new RelayClient({ agentName: 'MyAgent' });
 * await client.connect();
 * ```
 */

// Main client (Node.js, Unix sockets)
export {
  RelayClient,
  type ClientState,
  type ClientConfig,
  type SyncOptions,
  type RequestOptions,
  type RequestResponse,
  type SpawnResult,
} from './client.js';

// Protocol types (re-export for convenience)
export {
  PROTOCOL_VERSION,
  type MessageType,
  type PayloadKind,
  type Envelope,
  type EntityType,
  type SendPayload,
  type SendMeta,
  type SyncMeta,
  type DeliveryInfo,
  type AckPayload,
  type ErrorCode,
  type ErrorPayload,
  type SpeakOnTrigger,
  type ShadowConfig,
  // Spawn/release types
  type SpawnPayload,
  type SpawnResultPayload,
  type ReleasePayload,
  type ReleaseResultPayload,
  // Agent lifecycle types
  type AgentReadyPayload,
  // Channel types
  type ChannelMessagePayload,
  type ChannelJoinPayload,
  type ChannelLeavePayload,
  type MessageAttachment,
  // Query/response types
  type StatusResponsePayload,
  type InboxMessage,
  type MessagesResponsePayload,
  type AgentInfo,
  type HealthResponsePayload,
  type CrashRecord,
  type AlertRecord,
  type MetricsResponsePayload,
  type AgentMetrics,
  // Consensus types
  type ConsensusType,
  type VoteValue,
  type ProposalStatus,
  type CreateProposalOptions,
  type VoteOptions,
} from './protocol/index.js';

// Framing utilities
export {
  encodeFrame,
  encodeFrameLegacy,
  FrameParser,
  MAX_FRAME_BYTES,
} from './protocol/index.js';

// Log utilities (file-based, doesn't require connection)
export {
  getLogs,
  listLoggedAgents,
  type GetLogsOptions,
  type LogsResult,
} from './logs.js';

// Discovery (socket discovery, cloud workspace detection, agent identity)
export {
  discoverSocket,
  discoverAgentName,
  detectCloudWorkspace,
  isCloudWorkspace,
  getCloudSocketPath,
  getCloudOutboxPath,
  getConnectionInfo,
  getCloudEnvironmentSummary,
  cloudApiRequest,
  getWorkspaceStatus,
  type DiscoveryResult,
  type CloudWorkspace,
  type CloudConnectionOptions,
  type CloudConnectionInfo,
} from './discovery.js';

// Error types
export {
  RelayError,
  DaemonNotRunningError,
  AgentNotFoundError,
  TimeoutError,
  ConnectionError,
  ChannelNotFoundError,
  SpawnError,
} from './errors.js';
