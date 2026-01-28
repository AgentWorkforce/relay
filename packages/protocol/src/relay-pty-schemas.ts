/**
 * Relay PTY Protocol Schemas
 *
 * This file documents the data formats used in the relay-pty message flow:
 *
 * 1. Agent → File (outbox)     : RelayFileFormat
 * 2. relay-pty → Orchestrator  : ParsedRelayCommand (JSON on stderr)
 * 3. Orchestrator → Socket     : InjectRequest (JSON)
 * 4. Socket → Agent PTY        : Plain text injection
 */

// =============================================================================
// STEP 1: Agent writes to outbox file
// =============================================================================

/**
 * File format that agents write to the relay outbox.
 *
 * Default path: /tmp/relay-outbox/$AGENT_RELAY_NAME/<filename>
 * Workspace path: /tmp/relay/{workspaceId}/outbox/{agentName}/<filename>
 *
 * Note: In workspace deployments, the default path is symlinked to the
 * workspace path, so agents can use the simple path while maintaining
 * workspace isolation.
 *
 * Header-based format (preferred over JSON):
 * - Headers are key: value pairs, one per line
 * - Blank line separates headers from body
 * - Body is free-form text (no escaping needed)
 *
 * @example Message
 * ```
 * TO: Bob
 * THREAD: feature-123
 *
 * Hello Bob, can you review PR #42?
 * ```
 *
 * @example Blocking Message (sync)
 * ```
 * TO: Bob
 * AWAIT: 30s
 *
 * Your turn. Play a card.
 * ```
 *
 * @example Spawn
 * ```
 * KIND: spawn
 * NAME: ReviewerAgent
 * CLI: claude
 *
 * You are a code reviewer.
 * Review the changes in src/auth/*.ts
 * ```
 *
 * @example Release
 * ```
 * KIND: release
 * NAME: ReviewerAgent
 * ```
 *
 * @example Continuity Save
 * ```
 * KIND: continuity
 * ACTION: save
 *
 * Current task: Implementing user auth
 * Completed: Database schema, API endpoints
 * In progress: Frontend components
 * ```
 *
 * @example Continuity Load
 * ```
 * KIND: continuity
 * ACTION: load
 * ```
 *
 * @example Continuity Uncertain
 * ```
 * KIND: continuity
 * ACTION: uncertain
 *
 * API rate limit handling unclear
 * ```
 */
export interface RelayFileFormat {
  // === Headers (case-insensitive) ===

  /** Target agent name, "*" for broadcast, or "#channel" */
  TO?: string;

  /** Message type: "message" (default), "spawn", "release", or "continuity" */
  KIND?: 'message' | 'spawn' | 'release' | 'continuity';

  /** Action for continuity commands: "save", "load", or "uncertain" */
  ACTION?: 'save' | 'load' | 'uncertain';

  /** Agent name (required for spawn/release) */
  NAME?: string;

  /** CLI to use for spawning (required for spawn) */
  CLI?: string;

  /** Thread identifier for grouping related messages */
  THREAD?: string;

  /**
   * Blocking/await timeout for sync messaging.
   * Formats: "30s" (seconds), "1m" (minutes), "1h" (hours), "30000" (ms), "true" (default timeout)
   * When present, the sender blocks until recipient ACKs or timeout.
   */
  AWAIT?: string;

  // === Body (after blank line) ===

  /** Message content or task description (for spawn) */
  body?: string;
}

// =============================================================================
// STEP 2: relay-pty emits JSON to stderr (captured by orchestrator)
// =============================================================================

/**
 * JSON format emitted by relay-pty to stderr when it detects a relay command.
 * The orchestrator parses this to route messages.
 *
 * @example
 * ```json
 * {
 *   "type": "relay_command",
 *   "kind": "message",
 *   "from": "Alice",
 *   "to": "Bob",
 *   "body": "Hello!",
 *   "raw": "->relay-file:msg-001"
 * }
 * ```
 */
export interface ParsedRelayCommand {
  /** Always "relay_command" */
  type: 'relay_command';

  /** Command type */
  kind: 'message' | 'spawn' | 'release';

  /** Sender agent name */
  from: string;

  /** Target agent name (or "spawn"/"release" for those commands) */
  to: string;

  /** Message body or task description */
  body: string;

  /** Original raw text that was parsed */
  raw: string;

  /** Thread identifier (optional) */
  thread?: string;

  /** Sync metadata for blocking messages (when AWAIT header present) */
  sync?: {
    /** Whether this is a blocking send */
    blocking: boolean;
    /** Timeout in milliseconds (undefined means use default) */
    timeout_ms?: number;
  };

  /** For spawn: agent name to spawn */
  spawn_name?: string;

  /** For spawn: CLI to use */
  spawn_cli?: string;

  /** For spawn: task description */
  spawn_task?: string;

  /** For release: agent name to release */
  release_name?: string;
}

/**
 * JSON format emitted by relay-pty to stderr for continuity commands.
 *
 * This is separate from ParsedRelayCommand because continuity commands
 * are handled differently - they go to ContinuityManager instead of
 * being routed to other agents.
 *
 * @example Save
 * ```json
 * {
 *   "type": "continuity",
 *   "action": "save",
 *   "content": "Current task: Implementing auth\nCompleted: Setup"
 * }
 * ```
 *
 * @example Load
 * ```json
 * {
 *   "type": "continuity",
 *   "action": "load",
 *   "content": ""
 * }
 * ```
 *
 * @example Uncertain
 * ```json
 * {
 *   "type": "continuity",
 *   "action": "uncertain",
 *   "content": "API rate limit handling unclear"
 * }
 * ```
 */
export interface ContinuityCommandOutput {
  /** Always "continuity" */
  type: 'continuity';

  /** Action to perform */
  action: 'save' | 'load' | 'uncertain';

  /** Content: state for save, item for uncertain, empty for load */
  content: string;
}

// =============================================================================
// STEP 3: Orchestrator sends to relay-pty socket for injection
// =============================================================================

/**
 * JSON format sent to the relay-pty Unix socket for message injection.
 * Socket path: /tmp/relay-pty-{agentName}.sock
 *
 * @example
 * ```json
 * {
 *   "type": "inject",
 *   "id": "msg-abc123",
 *   "from": "Alice",
 *   "body": "Hello Bob!",
 *   "priority": 0
 * }
 * ```
 */
export type InjectRequest =
  | {
      type: 'inject';
      /** Unique message ID for tracking */
      id: string;
      /** Sender name (shown as "Relay message from {from}") */
      from: string;
      /** Message body to inject */
      body: string;
      /** Priority (lower = higher priority, default 0) */
      priority?: number;
    }
  | {
      type: 'status';
    }
  | {
      type: 'shutdown';
    }
  | {
      /** Send just Enter key (for stuck input recovery) */
      type: 'send_enter';
      /** Message ID this is for (for tracking) */
      id: string;
    };

/**
 * Response from relay-pty socket
 */
export type InjectResponse =
  | {
      type: 'inject_result';
      /** Message ID this response is for */
      id: string;
      /** Status of the injection */
      status: 'queued' | 'injecting' | 'delivered' | 'failed';
      /** Unix timestamp in milliseconds */
      timestamp: number;
      /** Optional error message */
      error?: string;
    }
  | {
      type: 'status';
      /** Whether agent appears idle (ready for injection) */
      agent_idle: boolean;
      /** Number of messages in queue */
      queue_length: number;
      /** Cursor position [x, y] */
      cursor_position?: [number, number];
      /** Milliseconds since last output */
      last_output_ms: number;
    }
  | {
      type: 'backpressure';
      /** Current queue length */
      queue_length: number;
      /** Whether new messages are accepted */
      accept: boolean;
    }
  | {
      type: 'shutdown_ack';
    }
  | {
      type: 'error';
      /** Error message */
      message: string;
    }
  | {
      /** SendEnter result (for stuck input recovery) */
      type: 'send_enter_result';
      /** Message ID this is for */
      id: string;
      /** Whether Enter was sent successfully */
      success: boolean;
      /** Unix timestamp in milliseconds */
      timestamp: number;
    };

// =============================================================================
// STEP 4: What gets injected into the agent's terminal
// =============================================================================

/**
 * The final format injected into the recipient agent's PTY as plain text.
 * NOT JSON - this is human-readable text that appears in the agent's terminal.
 *
 * Format: "Relay message from {sender} [{shortId}]: {body}"
 *
 * @example First attempt
 * ```
 * Relay message from Alice [abc1234]: Hello Bob, can you review PR #42?
 * ```
 *
 * @example Retry (1st retry)
 * ```
 * [RETRY] Relay message from Alice [abc1234]: Hello Bob, can you review PR #42?
 * ```
 *
 * @example Urgent (2+ retries)
 * ```
 * [URGENT - PLEASE ACKNOWLEDGE] Relay message from Alice [abc1234]: Hello Bob!
 * ```
 */
export type InjectedMessageFormat = string;

// =============================================================================
// Complete Flow Diagram
// =============================================================================

/**
 * ```
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │                        COMPLETE MESSAGE FLOW                                 │
 * │                                                                              │
 * │  STEP 1: Agent writes file                                                   │
 * │  ┌──────────────────────────────────────────────────────────────────────┐   │
 * │  │ cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/msg-001 << 'EOF'           │   │
 * │  │ TO: Bob                                                               │   │
 * │  │ THREAD: feature-123                                                   │   │
 * │  │                                                                       │   │
 * │  │ Hello Bob, can you review PR #42?                                     │   │
 * │  │ EOF                                                                   │   │
 * │  └──────────────────────────────────────────────────────────────────────┘   │
 * │                              │                                               │
 * │                              ▼                                               │
 * │  STEP 2: Agent outputs trigger                                               │
 * │  ┌──────────────────────────────────────────────────────────────────────┐   │
 * │  │ ->relay-file:msg-001                                                  │   │
 * │  └──────────────────────────────────────────────────────────────────────┘   │
 * │                              │                                               │
 * │                              ▼                                               │
 * │  STEP 3: relay-pty reads file, emits JSON to stderr                          │
 * │  ┌──────────────────────────────────────────────────────────────────────┐   │
 * │  │ {"type":"relay_command","kind":"message","from":"Alice",             │   │
 * │  │  "to":"Bob","body":"Hello Bob, can you review PR #42?",              │   │
 * │  │  "thread":"feature-123","raw":"->relay-file:msg-001"}                │   │
 * │  └──────────────────────────────────────────────────────────────────────┘   │
 * │                              │                                               │
 * │                              ▼                                               │
 * │  STEP 4: Orchestrator routes to Bob's relay-pty socket                       │
 * │  ┌──────────────────────────────────────────────────────────────────────┐   │
 * │  │ {"type":"inject","id":"msg-abc123","from":"Alice",                   │   │
 * │  │  "body":"Hello Bob, can you review PR #42?","priority":0}            │   │
 * │  └──────────────────────────────────────────────────────────────────────┘   │
 * │                              │                                               │
 * │                              ▼                                               │
 * │  STEP 5: Bob's relay-pty injects plain text into PTY                         │
 * │  ┌──────────────────────────────────────────────────────────────────────┐   │
 * │  │ Relay message from Alice [abc1234]: Hello Bob, can you review PR #42?│   │
 * │  └──────────────────────────────────────────────────────────────────────┘   │
 * │                                                                              │
 * └─────────────────────────────────────────────────────────────────────────────┘
 * ```
 */
