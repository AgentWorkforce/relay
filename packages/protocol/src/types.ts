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
  | 'RELEASE_RESULT';

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
  /** Display name for human users */
  displayName?: string;
  /** Avatar URL for human users */
  avatarUrl?: string;
  /** Session resume info */
  session?: {
    resume_token?: string;
  };
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

export type ErrorCode = 'BAD_REQUEST' | 'UNAUTHORIZED' | 'NOT_FOUND' | 'INTERNAL' | 'RESUME_TOO_OLD';

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
  /** Socket path for the spawned agent */
  socketPath?: string;
  /** Parent agent name */
  spawnerName?: string;
  /** Interactive mode */
  interactive?: boolean;
  /** Spawn as shadow of this agent */
  shadowOf?: string;
  /** Shadow speak-on triggers */
  shadowSpeakOn?: SpeakOnTrigger[];
  /** User ID for cloud persistence */
  userId?: string;
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
export type ChannelJoinEnvelope = Envelope<ChannelJoinPayload>;
export type ChannelLeaveEnvelope = Envelope<ChannelLeavePayload>;
export type ChannelMessageEnvelope = Envelope<ChannelMessagePayload>;
