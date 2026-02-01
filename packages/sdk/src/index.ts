/**
 * @agent-relay/sdk
 *
 * Lightweight SDK for agent-to-agent communication via Agent Relay.
 *
 * ## Quick Start (Standalone - No Setup Required)
 *
 * ```typescript
 * import { createRelay } from '@agent-relay/sdk';
 *
 * const relay = await createRelay();
 * const alice = await relay.client('Alice');
 * const bob = await relay.client('Bob');
 *
 * bob.onMessage = (from, { body }) => console.log(`${from}: ${body}`);
 * alice.sendMessage('Bob', 'Hello!');
 * ```
 *
 * ## With External Daemon
 *
 * ```typescript
 * import { RelayClient } from '@agent-relay/sdk';
 *
 * const client = new RelayClient({ agentName: 'MyAgent' });
 * await client.connect();
 * ```
 *
 * ## Browser Usage (WebSocket)
 *
 * ```typescript
 * import { BrowserRelayClient } from '@agent-relay/sdk';
 *
 * const client = new BrowserRelayClient({
 *   agentName: 'BrowserAgent',
 *   transport: { wsUrl: 'wss://relay.example.com/ws' },
 * });
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

// Browser-compatible client (WebSocket)
export {
  BrowserRelayClient,
  type BrowserClientState,
  type BrowserClientConfig,
  type BrowserRequestOptions,
  type BrowserRequestResponse,
} from './browser-client.js';

// Transport abstractions
export {
  // Types
  type Transport,
  type TransportConfig,
  type TransportEvents,
  type TransportState,
  type TransportFactory,
  // Socket transport (Node.js)
  SocketTransport,
  createSocketTransport,
  type SocketTransportConfig,
  // WebSocket transport (Browser + Node.js)
  WebSocketTransport,
  createWebSocketTransport,
  socketPathToWsUrl,
  type WebSocketTransportConfig,
  // Auto-detection
  createAutoTransport,
  type AutoTransportOptions,
  detectEnvironment,
  type EnvironmentInfo,
  isBrowser,
  isNode,
} from './transports/index.js';

// Standalone relay (in-process daemon for simple use cases)
export {
  createRelay,
  createPair,
  type Relay,
  type RelayConfig,
} from './standalone.js';

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
