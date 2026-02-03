/**
 * Types for the ACP Bridge
 * @agent-relay/acp-bridge
 */

/**
 * Configuration for the ACP Bridge
 */
export interface ACPBridgeConfig {
  /** Agent name to use when connecting to relay daemon */
  agentName: string;
  /** Path to relay daemon socket */
  socketPath?: string;
  /** Whether to enable debug logging */
  debug?: boolean;
  /** Agent capabilities to advertise */
  capabilities?: AgentCapabilities;
}

/**
 * Agent capabilities advertised to ACP clients
 */
export interface AgentCapabilities {
  /** Whether agent supports loading previous sessions */
  supportsSessionLoading?: boolean;
  /** Whether agent supports audio input */
  supportsAudio?: boolean;
  /** Whether agent supports image input */
  supportsImages?: boolean;
  /** Available agent modes */
  modes?: AgentMode[];
}

/**
 * Agent operating mode
 */
export interface AgentMode {
  /** Mode identifier */
  slug: string;
  /** Human-readable name */
  name: string;
  /** Description of what this mode does */
  description?: string;
}

/**
 * Session state tracked by the bridge
 */
export interface SessionState {
  /** Unique session identifier */
  id: string;
  /** When the session was created */
  createdAt: Date;
  /** Current operating mode */
  mode?: string;
  /** Message history */
  messages: SessionMessage[];
  /** Whether a prompt is currently being processed */
  isProcessing: boolean;
  /** Abort controller for current operation */
  abortController?: AbortController;
}

/**
 * A message in the session history
 */
export interface SessionMessage {
  /** Message role */
  role: 'user' | 'assistant';
  /** Message content */
  content: string;
  /** Timestamp */
  timestamp: Date;
  /** Source agent (for assistant messages) */
  fromAgent?: string;
}

/**
 * Relay message received from the daemon
 */
export interface RelayMessage {
  /** Message ID */
  id: string;
  /** Sender name */
  from: string;
  /** Message body */
  body: string;
  /** Optional thread ID */
  thread?: string;
  /** Timestamp */
  timestamp: number;
  /** Additional metadata (e.g., for system messages) */
  data?: RelayMessageData;
}

/**
 * Metadata for relay messages (e.g., crash notifications)
 */
export interface RelayMessageData {
  /** Whether this is a system message */
  isSystemMessage?: boolean;
  /** Type of crash (if applicable) */
  crashType?: 'unexpected_exit' | 'oom' | 'timeout' | string;
  /** Name of the agent that crashed */
  agentName?: string;
  /** Exit code */
  exitCode?: number;
  /** Signal that caused the exit */
  signal?: string;
  /** Additional arbitrary data */
  [key: string]: unknown;
}

/**
 * Result of bridging a prompt to relay agents
 */
export interface BridgePromptResult {
  /** Whether the operation completed successfully */
  success: boolean;
  /** Stop reason */
  stopReason: 'end_turn' | 'cancelled' | 'error';
  /** Response messages from agents */
  responses: RelayMessage[];
  /** Error message if failed */
  error?: string;
}

/**
 * Event emitted by the bridge
 */
export type BridgeEvent =
  | { type: 'connected' }
  | { type: 'disconnected'; reason?: string }
  | { type: 'message'; message: RelayMessage }
  | { type: 'agent_joined'; agent: string }
  | { type: 'agent_left'; agent: string }
  | { type: 'error'; error: Error };

/**
 * Listener for bridge events
 */
export type BridgeEventListener = (event: BridgeEvent) => void;
