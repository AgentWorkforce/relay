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
// Tier 3: Dashboard Events
// =============================================================================

/**
 * dashboard_page_view - Emitted when a dashboard page is viewed.
 */
export interface DashboardPageViewEvent {
  /** Page path (e.g., '/', '/metrics', '/login') */
  page_path: string;
  /** Page title */
  page_title?: string;
  /** Whether the dashboard is in cloud mode */
  is_cloud_mode: boolean;
}

/**
 * dashboard_user_action - Emitted when a user performs a key action in the dashboard.
 */
export interface DashboardUserActionEvent {
  /** Action identifier (e.g., 'spawn_agent', 'send_message', 'open_command_palette') */
  action: string;
  /** Category of the action */
  category: 'agent' | 'message' | 'navigation' | 'settings' | 'workspace';
  /** Optional additional detail */
  detail?: string;
}

/**
 * dashboard_form_submit - Emitted when a form is submitted in the dashboard.
 */
export interface DashboardFormSubmitEvent {
  /** Form identifier (e.g., 'spawn_modal', 'login', 'create_workspace') */
  form_name: string;
  /** Whether the submission succeeded */
  success: boolean;
}

/**
 * dashboard_session_start - Emitted when a dashboard session begins.
 */
export interface DashboardSessionStartEvent {
  /** Whether the dashboard is in cloud mode */
  is_cloud_mode: boolean;
  /** Browser user agent */
  user_agent?: string;
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
  | 'cli_command_run'
  | 'dashboard_page_view'
  | 'dashboard_user_action'
  | 'dashboard_form_submit'
  | 'dashboard_session_start';

export interface TelemetryEventMap {
  daemon_start: DaemonStartEvent;
  daemon_stop: DaemonStopEvent;
  agent_spawn: AgentSpawnEvent;
  agent_release: AgentReleaseEvent;
  agent_crash: AgentCrashEvent;
  message_send: MessageSendEvent;
  cli_command_run: CliCommandRunEvent;
  dashboard_page_view: DashboardPageViewEvent;
  dashboard_user_action: DashboardUserActionEvent;
  dashboard_form_submit: DashboardFormSubmitEvent;
  dashboard_session_start: DashboardSessionStartEvent;
}
