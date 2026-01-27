/**
 * Types for Agent Relay Inbox Check Hook
 */

export interface HookInput {
  /** The hook event type */
  hook_event_name?: string;
  /** Working directory */
  workingDirectory?: string;
  /** Session ID */
  session_id?: string;
  /** Stop reason from Claude */
  stop_reason?: string;
}

export interface HookOutput {
  /** Decision: "approve" to allow stop, "block" to continue */
  decision: 'approve' | 'block';
  /** Reason for the decision (shown to Claude if blocked) */
  reason?: string;
}

/**
 * Parsed message from inbox file.
 * Note: This is different from @agent-relay/protocol's InboxMessage
 * which is for daemon communication.
 */
export interface ParsedInboxMessage {
  from: string;
  timestamp: string;
  body: string;
}

export interface InboxConfig {
  /** Base directory for inbox files */
  inboxDir: string;
  /** Agent name (from env var or config) */
  agentName?: string;
}
