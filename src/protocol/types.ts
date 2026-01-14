/**
 * Agent Relay Protocol Types
 * Version 1.0
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
  | 'SYNC' // legacy alias; prefer SYNC_SNAPSHOT/SYNC_DELTA
  | 'SYNC_SNAPSHOT'
  | 'SYNC_DELTA'
  | 'SUBSCRIBE'
  | 'UNSUBSCRIBE'
  | 'SHADOW_BIND'
  | 'SHADOW_UNBIND'
  | 'LOG' // Agent output for dashboard streaming
  // Channel messaging types
  | 'CHANNEL_JOIN'
  | 'CHANNEL_LEAVE'
  | 'CHANNEL_MESSAGE'
  | 'CHANNEL_INFO'
  | 'CHANNEL_MEMBERS'
  | 'CHANNEL_TYPING'
  // Spawn/release types (daemon-based agent spawning)
  | 'SPAWN'
  | 'SPAWN_RESULT'
  | 'RELEASE'
  | 'RELEASE_RESULT';

export type PayloadKind = 'message' | 'action' | 'state' | 'thinking';

export interface Envelope<T = unknown> {
  v: number;
  type: MessageType;
  id: string;
  ts: number;
  from?: string;
  to?: string | '*';
  topic?: string;
  payload: T;
}

/**
 * Entity type distinguishes between AI agents and human users.
 * - 'agent': AI agent (Claude, GPT, custom agents)
 * - 'user': Human user (via dashboard WebSocket)
 */
export type EntityType = 'agent' | 'user';

// Handshake payloads
export interface HelloPayload {
  agent: string;
  capabilities: {
    ack: boolean;
    resume: boolean;
    max_inflight: number;
    supports_topics: boolean;
  };
  /** Entity type: 'agent' (default) or 'user' for human users */
  entityType?: EntityType;
  /** Optional hint about which CLI the agent is using (claude, codex, gemini, etc.) */
  cli?: string;
  /** Optional program identifier (e.g., 'claude', 'gpt-4o') */
  program?: string;
  /** Optional model identifier (e.g., 'claude-3-opus-2024') */
  model?: string;
  /** Optional task/role description for dashboard/registry */
  task?: string;
  /** Optional working directory hint for registry/dashboard */
  workingDirectory?: string;
  /** Display name for human users */
  displayName?: string;
  /** Avatar URL for human users */
  avatarUrl?: string;
  session?: {
    resume_token?: string;
  };
}

export interface WelcomePayload {
  session_id: string;
  /** Optional - only provided when session resume is implemented */
  resume_token?: string;
  server: {
    max_frame_bytes: number;
    heartbeat_ms: number;
  };
}

// Message payloads
export interface SendPayload {
  kind: PayloadKind;
  body: string;
  data?: Record<string, unknown>;
  /** Optional thread ID for grouping related messages (e.g., "feature-123", "bd-456") */
  thread?: string;
}

export interface SendMeta {
  requires_ack?: boolean;
  ttl_ms?: number;
  importance?: number; // 0-100, 100 is highest
  replyTo?: string;    // Correlation ID for replies
}

export interface DeliveryInfo {
  seq: number;
  session_id: string;
  /** Original 'to' field from SEND (preserved for broadcasts) - '*' indicates broadcast */
  originalTo?: string;
}

// ACK/NACK payloads
export interface AckPayload {
  ack_id: string;
  seq: number;
  cumulative_seq?: number;
  sack?: number[];
}

export interface NackPayload {
  ack_id: string;
  code?: 'BUSY' | 'INVALID' | 'FORBIDDEN' | 'STALE';
  reason?: 'busy' | 'invalid' | 'forbidden'; // legacy
  message?: string;
}

// Backpressure
export interface BusyPayload {
  retry_after_ms: number;
  queue_depth: number;
}

// Ping/Pong
export interface PingPayload {
  nonce: string;
}

export interface PongPayload {
  nonce: string;
}

// Error
export type ErrorCode = 'BAD_REQUEST' | 'UNAUTHORIZED' | 'NOT_FOUND' | 'INTERNAL' | 'RESUME_TOO_OLD';

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  fatal: boolean;
}

// Resume/Sync
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

// Log payload for agent output streaming
export interface LogPayload {
  /** The log/output data */
  data: string;
  /** Optional timestamp (defaults to envelope ts if not provided) */
  timestamp?: number;
}

// Typed envelope helpers
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
export type SyncEnvelope = Envelope<SyncPayload>;
export type LogEnvelope = Envelope<LogPayload>;

// Shadow agent types
export type SpeakOnTrigger =
  | 'SESSION_END'
  | 'CODE_WRITTEN'
  | 'REVIEW_REQUEST'
  | 'EXPLICIT_ASK'    // Shadow only speaks when explicitly asked
  | 'ALL_MESSAGES';   // Shadow speaks on every message (fully active)

export interface ShadowConfig {
  /** The primary agent this shadow is attached to */
  primaryAgent: string;
  /** When the shadow should speak (default: EXPLICIT_ASK) */
  speakOn: SpeakOnTrigger[];
  /** Whether to receive copies of messages TO the primary (default: true) */
  receiveIncoming?: boolean;
  /** Whether to receive copies of messages FROM the primary (default: true) */
  receiveOutgoing?: boolean;
}

export interface ShadowBindPayload {
  /** The primary agent to shadow */
  primaryAgent: string;
  /** When the shadow should speak (optional, defaults to EXPLICIT_ASK) */
  speakOn?: SpeakOnTrigger[];
  /** Whether to receive incoming messages to primary (default: true) */
  receiveIncoming?: boolean;
  /** Whether to receive outgoing messages from primary (default: true) */
  receiveOutgoing?: boolean;
}

export interface ShadowUnbindPayload {
  /** The primary agent to stop shadowing */
  primaryAgent: string;
}

export type ShadowBindEnvelope = Envelope<ShadowBindPayload>;
export type ShadowUnbindEnvelope = Envelope<ShadowUnbindPayload>;

// Spawn/release payloads
export interface SpawnPayload {
  /** Name for the new agent */
  name: string;
  /** CLI to use (claude, codex, gemini, etc.) */
  cli: string;
  /** Task description for the agent */
  task: string;
  /** Optional team name */
  team?: string;
  /** Working directory for the agent */
  cwd?: string;
  /** Socket path for the spawned agent to connect to */
  socketPath?: string;
  /** Name of the spawning agent (parent) */
  spawnerName?: string;
  /** Whether to run in interactive mode */
  interactive?: boolean;
  /** If set, spawn as a shadow of this agent */
  shadowOf?: string;
  /** Shadow speak-on triggers */
  shadowSpeakOn?: SpeakOnTrigger[];
  /** User ID for cloud persistence */
  userId?: string;
}

export type SpawnPolicyDecision = {
  allowed: boolean;
  reason?: string;
  quotaRemaining?: number;
};

export interface SpawnResultPayload {
  /** Correlation ID - matches the original SPAWN envelope ID */
  replyTo: string;
  /** Whether the spawn succeeded */
  success: boolean;
  /** Name of the spawned agent */
  name: string;
  /** Process ID of the spawned agent (if successful) */
  pid?: number;
  /** Error message (if failed) */
  error?: string;
  /** Policy decision (if spawn was blocked by policy) */
  policyDecision?: SpawnPolicyDecision;
}

export interface ReleasePayload {
  /** Name of the agent to release */
  name: string;
}

export interface ReleaseResultPayload {
  /** Correlation ID - matches the original RELEASE envelope ID */
  replyTo: string;
  /** Whether the release succeeded */
  success: boolean;
  /** Name of the released agent */
  name: string;
  /** Error message (if failed) */
  error?: string;
}

export type SpawnEnvelope = Envelope<SpawnPayload>;
export type SpawnResultEnvelope = Envelope<SpawnResultPayload>;
export type ReleaseEnvelope = Envelope<ReleasePayload>;
export type ReleaseResultEnvelope = Envelope<ReleaseResultPayload>;
