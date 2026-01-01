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
  | 'LOG'; // Agent output for dashboard streaming

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

// Handshake payloads
export interface HelloPayload {
  agent: string;
  capabilities: {
    ack: boolean;
    resume: boolean;
    max_inflight: number;
    supports_topics: boolean;
  };
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
