/**
 * Agent Relay Protocol Types
 * @agent-relay/sdk
 *
 * These types define the wire protocol for agent-to-agent communication.
 */

export const PROTOCOL_VERSION = 1;

export type MessageType =
  | 'HELLO'
  | 'WELCOME'
  | 'SEND'
  | 'DELIVER'
  | 'ACK'
  | 'NACK'
  | 'PING'
  | 'PONG'
  | 'ERROR'
  | 'BUSY'
  | 'RESUME'
  | 'BYE'
  | 'STATE'
  | 'SYNC'
  | 'SYNC_SNAPSHOT'
  | 'SYNC_DELTA'
  | 'SUBSCRIBE'
  | 'UNSUBSCRIBE'
  | 'SHADOW_BIND'
  | 'SHADOW_UNBIND'
  | 'LOG'
  // Channel messaging types
  | 'CHANNEL_JOIN'
  | 'CHANNEL_LEAVE'
  | 'CHANNEL_MESSAGE'
  | 'CHANNEL_INFO'
  | 'CHANNEL_MEMBERS'
  | 'CHANNEL_TYPING'
  // Spawn/release types
  | 'SPAWN'
  | 'SPAWN_RESULT'
  | 'RELEASE'
  | 'RELEASE_RESULT'
  // Agent lifecycle events
  | 'AGENT_READY'
  // Query types (MCP/client requests)
  | 'STATUS'
  | 'STATUS_RESPONSE'
  | 'INBOX'
  | 'INBOX_RESPONSE'
  | 'LIST_AGENTS'
  | 'LIST_AGENTS_RESPONSE'
  | 'LIST_CONNECTED_AGENTS'
  | 'LIST_CONNECTED_AGENTS_RESPONSE'
  | 'REMOVE_AGENT'
  | 'REMOVE_AGENT_RESPONSE'
  | 'HEALTH'
  | 'HEALTH_RESPONSE'
  | 'METRICS'
  | 'METRICS_RESPONSE'
  // Messages query (for dashboard)
  | 'MESSAGES_QUERY'
  | 'MESSAGES_RESPONSE'
  // Consensus types
  | 'PROPOSAL_CREATE'
  | 'VOTE';

export type PayloadKind = 'message' | 'action' | 'state' | 'thinking';

/**
 * Base envelope structure for all protocol messages.
 */
export interface Envelope<T = unknown> {
  /** Protocol version */
  v: number;
  /** Message type */
  type: MessageType;
  /** Unique message ID */
  id: string;
  /** Timestamp (Unix ms) */
  ts: number;
  /** Sender name */
  from?: string;
  /** Recipient name or '*' for broadcast */
  to?: string | '*';
  /** Topic for pub/sub */
  topic?: string;
  /** Message payload */
  payload: T;
}

/**
 * Entity type distinguishes between AI agents and human users.
 */
export type EntityType = 'agent' | 'user';

// =============================================================================
// Handshake Payloads
// =============================================================================

export interface HelloPayload {
  /** Agent name */
  agent: string;
  /** Client capabilities */
  capabilities: {
    ack: boolean;
    resume: boolean;
    max_inflight: number;
    supports_topics: boolean;
  };
  /** Entity type: 'agent' (default) or 'user' */
  entityType?: EntityType;
  /** CLI identifier (claude, codex, gemini, etc.) */
  cli?: string;
  /** Program identifier */
  program?: string;
  /** Model identifier */
  model?: string;
  /** Task/role description */
  task?: string;
  /** Working directory */
  workingDirectory?: string;
  /** Team name */
  team?: string;
  /** Display name for human users */
  displayName?: string;
  /** Avatar URL for human users */
  avatarUrl?: string;
  /** Session resume info */
  session?: {
    resume_token?: string;
  };
  /**
   * Internal flag to indicate this is a system component (e.g., Dashboard).
   * Allows using reserved names. Should only be set by trusted system components.
   */
  _isSystemComponent?: boolean;
}

export interface WelcomePayload {
  /** Session ID assigned by server */
  session_id: string;
  /** Token for session resume */
  resume_token?: string;
  /** Server configuration */
  server: {
    max_frame_bytes: number;
    heartbeat_ms: number;
  };
}

// =============================================================================
// Message Payloads
// =============================================================================

export interface SendPayload {
  /** Message type */
  kind: PayloadKind;
  /** Message body */
  body: string;
  /** Optional structured data */
  data?: Record<string, unknown>;
  /** Thread ID for grouping related messages */
  thread?: string;
}

export interface SyncMeta {
  /** Correlation ID for matching responses */
  correlationId: string;
  /** Timeout for blocking sends (ms) */
  timeoutMs?: number;
  /** Whether sender should block awaiting ACK */
  blocking: boolean;
}

export interface SendMeta {
  requires_ack?: boolean;
  ttl_ms?: number;
  /** Importance level (0-100, higher = more important) */
  importance?: number;
  /** Correlation ID for replies */
  replyTo?: string;
  /** Sync metadata for blocking sends */
  sync?: SyncMeta;
}

export interface DeliveryInfo {
  /** Delivery sequence number */
  seq: number;
  /** Session ID */
  session_id: string;
  /** Original 'to' field ('*' indicates broadcast) */
  originalTo?: string;
}

// =============================================================================
// ACK/NACK Payloads
// =============================================================================

export interface AckPayload {
  /** ID of the message being acknowledged */
  ack_id: string;
  /** Sequence number */
  seq: number;
  /** Cumulative acknowledgment */
  cumulative_seq?: number;
  /** Selective acknowledgments */
  sack?: number[];
  /**
   * Correlation ID for matching ACK to original blocking SEND.
   * Set by daemon when forwarding ACK back to the sender.
   */
  correlationId?: string;
  /**
   * Response status for sync messaging.
   * Common values: 'OK', 'ERROR', 'ACCEPTED', 'REJECTED'.
   * Allows richer status codes than a simple boolean.
   */
  response?: string;
  /**
   * Optional structured response data.
   * Can contain any additional information the responder wants to include.
   */
  responseData?: unknown;
}

export interface NackPayload {
  /** ID of the message being rejected */
  ack_id: string;
  /** Rejection code */
  code?: 'BUSY' | 'INVALID' | 'FORBIDDEN' | 'STALE';
  /** Legacy reason field */
  reason?: 'busy' | 'invalid' | 'forbidden';
  /** Human-readable message */
  message?: string;
}

// =============================================================================
// Control Payloads
// =============================================================================

export interface BusyPayload {
  /** Time before retry (ms) */
  retry_after_ms: number;
  /** Current queue depth */
  queue_depth: number;
}

export interface PingPayload {
  nonce: string;
}

export interface PongPayload {
  nonce: string;
}

export type ErrorCode = 'BAD_REQUEST' | 'UNAUTHORIZED' | 'NOT_FOUND' | 'INTERNAL' | 'RESUME_TOO_OLD' | 'DUPLICATE_CONNECTION' | 'TIMEOUT';

export interface ErrorPayload {
  /** Error code */
  code: ErrorCode;
  /** Error message */
  message: string;
  /** Whether the error is fatal (connection should be closed) */
  fatal: boolean;
}

export interface LogPayload {
  /** Log/output data */
  data: string;
  /** Timestamp (defaults to envelope ts) */
  timestamp?: number;
}

// =============================================================================
// Sync/Resume Types
// =============================================================================

export interface SyncStream {
  topic: string;
  peer: string;
  last_seq: number;
  server_last_seq?: number;
}

export interface SyncPayload {
  session_id: string;
  streams: SyncStream[];
}

// =============================================================================
// Channel Types
// =============================================================================

/**
 * Attachment metadata for messages.
 */
export interface MessageAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size?: number;
  url?: string;
  data?: string; // Base64 for inline
}

/**
 * Payload for CHANNEL_JOIN message.
 */
export interface ChannelJoinPayload {
  /** Channel to join (e.g., '#general') */
  channel: string;
  /** Display name for the channel member list */
  displayName?: string;
  /** Avatar URL */
  avatarUrl?: string;
  /** Member name to add (for admin operations) */
  member?: string;
}

/**
 * Payload for CHANNEL_LEAVE message.
 */
export interface ChannelLeavePayload {
  /** Channel to leave */
  channel: string;
  /** Reason for leaving */
  reason?: string;
  /** Member name to remove (for admin operations) */
  member?: string;
}

/**
 * Payload for CHANNEL_MESSAGE.
 */
export interface ChannelMessagePayload {
  /** Target channel */
  channel: string;
  /** Message content */
  body: string;
  /** Thread ID for threaded replies */
  thread?: string;
  /** Mentioned usernames/agent names */
  mentions?: string[];
  /** File attachments */
  attachments?: MessageAttachment[];
  /** Optional structured data */
  data?: Record<string, unknown>;
}

// =============================================================================
// Shadow Agent Types
// =============================================================================

export type SpeakOnTrigger =
  | 'SESSION_END'
  | 'CODE_WRITTEN'
  | 'REVIEW_REQUEST'
  | 'EXPLICIT_ASK'
  | 'ALL_MESSAGES';

export interface ShadowConfig {
  /** Primary agent this shadow is attached to */
  primaryAgent: string;
  /** When the shadow should speak */
  speakOn: SpeakOnTrigger[];
  /** Receive messages TO the primary */
  receiveIncoming?: boolean;
  /** Receive messages FROM the primary */
  receiveOutgoing?: boolean;
}

export interface ShadowBindPayload {
  primaryAgent: string;
  speakOn?: SpeakOnTrigger[];
  receiveIncoming?: boolean;
  receiveOutgoing?: boolean;
}

export interface ShadowUnbindPayload {
  primaryAgent: string;
}

// =============================================================================
// Spawn/Release Types
// =============================================================================

export interface SpawnPayload {
  /** Name for the new agent */
  name: string;
  /** CLI to use (claude, codex, gemini, etc.) */
  cli: string;
  /** Task description */
  task: string;
  /** Team name */
  team?: string;
  /** Working directory */
  cwd?: string;
  /** Model override (alternative to cli:model format) */
  model?: string;
  /** Socket path for the spawned agent */
  socketPath?: string;
  /** Parent agent name */
  spawnerName?: string;
  /** Interactive mode */
  interactive?: boolean;
  /** Shadow execution mode (subagent = no extra process) */
  shadowMode?: 'subagent' | 'process';
  /** Spawn as shadow of this agent */
  shadowOf?: string;
  /** Shadow agent profile to use (for subagent mode) */
  shadowAgent?: string;
  /** When to trigger the shadow (for subagent mode) */
  shadowTriggers?: SpeakOnTrigger[];
  /** Shadow speak-on triggers */
  shadowSpeakOn?: SpeakOnTrigger[];
  /** User ID for cloud persistence */
  userId?: string;
  /** Include ACK/DONE workflow conventions in agent instructions (default: false) */
  includeWorkflowConventions?: boolean;
}

export interface SpawnPolicyDecision {
  allowed: boolean;
  reason?: string;
  quotaRemaining?: number;
}

export interface SpawnResultPayload {
  /** Correlation ID (matches original SPAWN envelope ID) */
  replyTo: string;
  /** Whether spawn succeeded */
  success: boolean;
  /** Spawned agent name */
  name: string;
  /** Process ID (if successful) */
  pid?: number;
  /** Error message (if failed) */
  error?: string;
  /** Policy decision (if blocked) */
  policyDecision?: SpawnPolicyDecision;
}

export interface ReleasePayload {
  /** Agent name to release */
  name: string;
  /** Reason for releasing the agent */
  reason?: string;
}

export interface ReleaseResultPayload {
  /** Correlation ID */
  replyTo: string;
  /** Whether release succeeded */
  success: boolean;
  /** Released agent name */
  name: string;
  /** Error message (if failed) */
  error?: string;
}

// =============================================================================
// Agent Lifecycle Event Types
// =============================================================================

/**
 * Payload for AGENT_READY message.
 * Broadcast by daemon when an agent completes connection (HELLO/WELCOME handshake).
 * Subscribers can use this to know when a spawned agent is ready to receive messages.
 */
export interface AgentReadyPayload {
  /** Name of the agent that is now ready */
  name: string;
  /** CLI identifier (claude, codex, gemini, etc.) */
  cli?: string;
  /** Task description */
  task?: string;
  /** Timestamp when the agent connected */
  connectedAt: number;
}

// =============================================================================
// Typed Envelope Helpers
// =============================================================================

export type HelloEnvelope = Envelope<HelloPayload>;
export type WelcomeEnvelope = Envelope<WelcomePayload>;
export type SendEnvelope = Envelope<SendPayload> & { payload_meta?: SendMeta };
export type DeliverEnvelope = Envelope<SendPayload> & { delivery: DeliveryInfo; payload_meta?: SendMeta };
export type AckEnvelope = Envelope<AckPayload>;
export type NackEnvelope = Envelope<NackPayload>;
export type PingEnvelope = Envelope<PingPayload>;
export type PongEnvelope = Envelope<PongPayload>;
export type ErrorEnvelope = Envelope<ErrorPayload>;
export type BusyEnvelope = Envelope<BusyPayload>;
export type LogEnvelope = Envelope<LogPayload>;
export type ShadowBindEnvelope = Envelope<ShadowBindPayload>;
export type ShadowUnbindEnvelope = Envelope<ShadowUnbindPayload>;
export type SyncEnvelope = Envelope<SyncPayload>;
export type SpawnEnvelope = Envelope<SpawnPayload>;
export type SpawnResultEnvelope = Envelope<SpawnResultPayload>;
export type ReleaseEnvelope = Envelope<ReleasePayload>;
export type ReleaseResultEnvelope = Envelope<ReleaseResultPayload>;
export type AgentReadyEnvelope = Envelope<AgentReadyPayload>;
export type ChannelJoinEnvelope = Envelope<ChannelJoinPayload>;
export type ChannelLeaveEnvelope = Envelope<ChannelLeavePayload>;
export type ChannelMessageEnvelope = Envelope<ChannelMessagePayload>;

// =============================================================================
// Query Types (MCP/Client Requests)
// =============================================================================

/**
 * Payload for STATUS request.
 */
export interface StatusPayload {
  // Empty payload - just requests daemon status
}

/**
 * Payload for STATUS_RESPONSE.
 */
export interface StatusResponsePayload {
  /** Daemon version */
  version?: string;
  /** Uptime in milliseconds */
  uptime?: number;
  /** Whether cloud sync is connected */
  cloudConnected?: boolean;
  /** Number of connected agents */
  agentCount?: number;
  /** Storage health information */
  storage?: {
    persistent: boolean;
    driver: 'sqlite' | 'jsonl' | 'memory';
    canWrite: boolean;
    canRead: boolean;
    error?: string;
  };
}

/**
 * Payload for INBOX request.
 */
export interface InboxPayload {
  /** Agent name to get inbox for */
  agent: string;
  /** Maximum number of messages to return */
  limit?: number;
  /** Only return unread messages */
  unreadOnly?: boolean;
  /** Filter by sender */
  from?: string;
  /** Filter by channel */
  channel?: string;
}

/**
 * Payload for INBOX_RESPONSE.
 */
export interface InboxResponsePayload {
  /** Messages in the inbox */
  messages: Array<{
    id: string;
    from: string;
    body: string;
    channel?: string;
    thread?: string;
    timestamp: number;
  }>;
}

/**
 * Payload for MESSAGES_QUERY request.
 * Used by dashboard to query all messages (not filtered by recipient).
 */
export interface MessagesQueryPayload {
  /** Maximum number of messages to return */
  limit?: number;
  /** Only return messages after this timestamp (Unix ms) */
  sinceTs?: number;
  /** Filter by sender */
  from?: string;
  /** Filter by recipient */
  to?: string;
  /** Filter by thread ID */
  thread?: string;
  /** Sort order */
  order?: 'asc' | 'desc';
}

/**
 * Payload for MESSAGES_RESPONSE.
 */
export interface MessagesResponsePayload {
  /** Messages matching the query */
  messages: Array<{
    id: string;
    from: string;
    to: string;
    body: string;
    channel?: string;
    thread?: string;
    timestamp: number;
    status?: string;
    isBroadcast?: boolean;
    replyCount?: number;
    data?: Record<string, unknown>;
  }>;
}

/**
 * Payload for LIST_AGENTS request.
 */
export interface ListAgentsPayload {
  /** Include idle agents */
  includeIdle?: boolean;
  /** Filter by project */
  project?: string;
}

/**
 * Payload for LIST_AGENTS_RESPONSE.
 */
export interface ListAgentsResponsePayload {
  /** List of agents */
  agents: Array<{
    name: string;
    cli?: string;
    idle?: boolean;
    parent?: string;
    team?: string;
    pid?: number;
  }>;
}

/**
 * Payload for LIST_CONNECTED_AGENTS request.
 * Returns only currently connected agents (not historical/registered agents).
 */
export interface ListConnectedAgentsPayload {
  /** Filter by project */
  project?: string;
}

/**
 * Payload for LIST_CONNECTED_AGENTS_RESPONSE.
 */
export interface ListConnectedAgentsResponsePayload {
  /** List of currently connected agents */
  agents: Array<{
    name: string;
    cli?: string;
    idle?: boolean;
    parent?: string;
    team?: string;
    pid?: number;
  }>;
}

/**
 * Payload for REMOVE_AGENT request.
 * Removes an agent from the registry (sessions, agents.json).
 */
export interface RemoveAgentPayload {
  /** Agent name to remove */
  name: string;
  /** If true, also removes all messages from/to this agent */
  removeMessages?: boolean;
}

/**
 * Payload for REMOVE_AGENT_RESPONSE.
 */
export interface RemoveAgentResponsePayload {
  /** Whether the operation succeeded */
  success: boolean;
  /** Whether an agent was actually removed */
  removed: boolean;
  /** Human-readable message */
  message?: string;
}

export type StatusEnvelope = Envelope<StatusPayload>;
export type StatusResponseEnvelope = Envelope<StatusResponsePayload>;
export type InboxEnvelope = Envelope<InboxPayload>;
export type InboxResponseEnvelope = Envelope<InboxResponsePayload>;
export type MessagesQueryEnvelope = Envelope<MessagesQueryPayload>;
export type MessagesResponseEnvelope = Envelope<MessagesResponsePayload>;
export type ListAgentsEnvelope = Envelope<ListAgentsPayload>;
export type ListAgentsResponseEnvelope = Envelope<ListAgentsResponsePayload>;
export type ListConnectedAgentsEnvelope = Envelope<ListConnectedAgentsPayload>;
export type ListConnectedAgentsResponseEnvelope = Envelope<ListConnectedAgentsResponsePayload>;
export type RemoveAgentEnvelope = Envelope<RemoveAgentPayload>;
export type RemoveAgentResponseEnvelope = Envelope<RemoveAgentResponsePayload>;

/**
 * Payload for HEALTH request.
 */
export interface HealthPayload {
  /** Include crash history */
  includeCrashes?: boolean;
  /** Include alerts */
  includeAlerts?: boolean;
}

/**
 * Payload for HEALTH_RESPONSE.
 */
export interface HealthResponsePayload {
  healthScore: number;
  summary: string;
  issues: Array<{ severity: string; message: string }>;
  recommendations: string[];
  crashes: Array<{
    id: string;
    agentName: string;
    crashedAt: string;
    likelyCause: string;
    summary?: string;
  }>;
  alerts: Array<{
    id: string;
    agentName: string;
    alertType: string;
    message: string;
    createdAt: string;
  }>;
  stats: {
    totalCrashes24h: number;
    totalAlerts24h: number;
    agentCount: number;
  };
}

/**
 * Payload for METRICS request.
 */
export interface MetricsPayload {
  /** Filter to specific agent */
  agent?: string;
}

/**
 * Payload for METRICS_RESPONSE.
 */
export interface MetricsResponsePayload {
  agents: Array<{
    name: string;
    pid?: number;
    status: string;
    rssBytes?: number;
    cpuPercent?: number;
    trend?: string;
    alertLevel?: string;
    highWatermark?: number;
    uptimeMs?: number;
  }>;
  system: {
    totalMemory: number;
    freeMemory: number;
    heapUsed: number;
  };
}

export type HealthEnvelope = Envelope<HealthPayload>;
export type HealthResponseEnvelope = Envelope<HealthResponsePayload>;
export type MetricsEnvelope = Envelope<MetricsPayload>;
export type MetricsResponseEnvelope = Envelope<MetricsResponsePayload>;

// =============================================================================
// Consensus Types
// =============================================================================

export type ConsensusType =
  | 'majority'      // >50% agree
  | 'supermajority' // >=threshold agree (default 2/3)
  | 'unanimous'     // 100% agree
  | 'weighted'      // Weighted by role
  | 'quorum';       // Minimum participation + majority

export type VoteValue = 'approve' | 'reject' | 'abstain';

export type ProposalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'cancelled';

/**
 * Options for creating a consensus proposal.
 */
export interface CreateProposalOptions {
  /** Proposal title */
  title: string;
  /** Detailed description */
  description: string;
  /** Agents allowed to vote */
  participants: string[];
  /** Consensus type (default: majority) */
  consensusType?: ConsensusType;
  /** Timeout in milliseconds (default: 5 minutes) */
  timeoutMs?: number;
  /** Minimum votes required (for quorum type) */
  quorum?: number;
  /** Threshold for supermajority (0-1, default 0.67) */
  threshold?: number;
}

/**
 * Options for voting on a proposal.
 */
export interface VoteOptions {
  /** Proposal ID to vote on */
  proposalId: string;
  /** Vote value */
  value: VoteValue;
  /** Optional reason for the vote */
  reason?: string;
}

// =============================================================================
// Named Record Types (for reusability)
// =============================================================================

/**
 * A stored message in the inbox.
 */
export interface InboxMessage {
  id: string;
  from: string;
  body: string;
  channel?: string;
  thread?: string;
  timestamp: number;
}

/**
 * Agent info returned by LIST_AGENTS.
 */
export interface AgentInfo {
  name: string;
  cli?: string;
  idle?: boolean;
  parent?: string;
  task?: string;
  team?: string;
  pid?: number;
  connectedAt?: number;
}

/**
 * A crash record.
 */
export interface CrashRecord {
  id: string;
  agentName: string;
  crashedAt: string;
  likelyCause: string;
  summary?: string;
}

/**
 * An alert record.
 */
export interface AlertRecord {
  id: string;
  agentName: string;
  alertType: string;
  message: string;
  createdAt: string;
}

/**
 * Metrics for a single agent.
 */
export interface AgentMetrics {
  name: string;
  pid?: number;
  status: string;
  rssBytes?: number;
  cpuPercent?: number;
  trend?: string;
  alertLevel?: string;
  highWatermark?: number;
  uptimeMs?: number;
}
