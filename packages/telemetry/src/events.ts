/**
 * Type-safe telemetry event definitions.
 *
 * Following PostHog naming best practices:
 * - snake_case for events and properties
 * - Present tense verbs (spawn, not spawned)
 * - object_action pattern
 */

/** Source of spawn/release action */
export type ActionSource = 'human_cli' | 'human_dashboard' | 'agent' | 'protocol';

/** Reason for agent release */
export type ReleaseReason = 'explicit' | 'crash' | 'timeout' | 'shutdown';

/**
 * Common properties attached to every event.
 */
export interface CommonProperties {
  /** Agent Relay version */
  agent_relay_version: string;
  /** Operating system (e.g., darwin, linux, win32) */
  os: string;
  /** OS release version */
  os_version: string;
  /** Node.js version (without 'v' prefix) */
  node_version: string;
  /** CPU architecture (e.g., arm64, x64) */
  arch: string;
}

// =============================================================================
// Tier 1: Core Usage Events
// =============================================================================

/**
 * daemon_start - Emitted when the daemon starts.
 * No additional properties beyond common props.
 */
export interface DaemonStartEvent {
  // Common props only
}

/**
 * daemon_stop - Emitted when the daemon stops.
 */
export interface DaemonStopEvent {
  /** How long the daemon was running, in seconds */
  uptime_seconds: number;
  /** Total agents spawned during this session */
  agent_spawn_count: number;
}

/**
 * agent_spawn - Emitted when an agent is created.
 */
export interface AgentSpawnEvent {
  /** CLI type (claude, codex, gemini, etc.) */
  cli: string;
  /** Where the spawn originated */
  spawn_source: ActionSource;
  /** Whether a task was provided */
  has_task: boolean;
  /** Whether this is a shadow agent */
  is_shadow: boolean;
}

/**
 * agent_release - Emitted when an agent is stopped.
 */
export interface AgentReleaseEvent {
  /** CLI type (claude, codex, gemini, etc.) */
  cli: string;
  /** Why the agent was released */
  release_reason: ReleaseReason;
  /** How long the agent was alive, in seconds */
  lifetime_seconds: number;
  /** Where the release originated */
  release_source: ActionSource;
}

/**
 * agent_crash - Emitted when an agent dies unexpectedly.
 */
export interface AgentCrashEvent {
  /** CLI type (claude, codex, gemini, etc.) */
  cli: string;
  /** How long the agent was alive, in seconds */
  lifetime_seconds: number;
  /** Exit code if available */
  exit_code?: number;
}

// =============================================================================
// Tier 2: Engagement Events
// =============================================================================

/**
 * message_send - Emitted when an agent sends a relay message.
 */
export interface MessageSendEvent {
  /** Whether this was a broadcast message */
  is_broadcast: boolean;
  /** Whether this message is part of a thread */
  has_thread: boolean;
}

/**
 * cli_command_run - Emitted when a CLI command is executed.
 */
export interface CliCommandRunEvent {
  /** Name of the command (e.g., 'up', 'spawn', 'who') */
  command_name: string;
}

// =============================================================================
// Event Union Type
// =============================================================================

export type TelemetryEventName =
  | 'daemon_start'
  | 'daemon_stop'
  | 'agent_spawn'
  | 'agent_release'
  | 'agent_crash'
  | 'message_send'
  | 'cli_command_run';

export interface TelemetryEventMap {
  daemon_start: DaemonStartEvent;
  daemon_stop: DaemonStopEvent;
  agent_spawn: AgentSpawnEvent;
  agent_release: AgentReleaseEvent;
  agent_crash: AgentCrashEvent;
  message_send: MessageSendEvent;
  cli_command_run: CliCommandRunEvent;
}
