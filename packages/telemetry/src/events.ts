/**
 * Type-safe telemetry event definitions.
 *
 * Following PostHog naming best practices:
 * - snake_case for events and properties
 * - Present tense verbs (spawn, not spawned)
 * - object_action pattern
 *
 * Privacy rules for authors:
 * - Never capture argument values (file paths, run IDs, task text, tokens, URLs).
 * - Flag NAMES are fine; flag VALUES are not.
 * - When an event can fail, prefer `error_class` over `error_message` so we
 *   don't leak user content or paths. `error_class` is typically the Error
 *   constructor name (`errorClassName(err)`), but it may also be a stable
 *   synthetic category tag at non-throw failure sites — for example,
 *   `'WorkflowNotCompleted'` when a workflow returns `status !== 'completed'`
 *   without throwing. Stick to PascalCase tags so real Error names and
 *   synthetic categories share one namespace.
 */

/** Source of spawn/release action */
export type ActionSource = 'human_cli' | 'human_dashboard' | 'agent' | 'protocol';

/**
 * Reason for agent release.
 *
 * This is a loose `string` on purpose — the broker emits both product-level
 * reasons (`'explicit' | 'crash' | 'timeout' | 'shutdown'`) and broker-local
 * categories that describe *how* the release arrived (`'ws_command'`,
 * `'relaycast_release'`, etc.). Keeping the type open lets the schema stay
 * honest about what actually shows up in PostHog without forcing every new
 * broker category to be a breaking TS change.
 *
 * Known values (non-exhaustive):
 *   - Canonical: `'explicit'`, `'crash'`, `'timeout'`, `'shutdown'`
 *   - Broker-local: `'ws_command'`, `'relaycast_release'`
 */
export type ReleaseReason = string;

/**
 * Common properties attached to every event.
 *
 * Version identification:
 *   - `cli_version` — version of the `agent-relay` CLI, when the event was
 *     emitted from the CLI process
 *   - `sdk_version` — version of `@agent-relay/sdk` resolved/bundled with the
 *     emitter. Populated when the CLI or broker can discover it.
 *   - `broker_version` — version of the Rust broker binary. Populated when
 *     emitted from the broker, or when the CLI is propagating broker info.
 *   - `agent_relay_version` — kept for backward compatibility with existing
 *     PostHog dashboards. Mirrors whichever component actually emitted the
 *     event: `cli_version` on CLI-originated events, `broker_version` on
 *     broker-originated events.
 */
export interface CommonProperties {
  /** Back-compat alias — same value as the emitter's primary version. */
  agent_relay_version: string;
  /** `agent-relay` CLI version, if known to the emitter. */
  cli_version?: string;
  /** `@agent-relay/sdk` version, if resolvable. */
  sdk_version?: string;
  /** `agent-relay-broker` Rust binary version, if known. */
  broker_version?: string;
  /** Operating system (e.g., darwin, linux, win32) */
  os: string;
  /**
   * OS release version (e.g. `uname -r` output on unix).
   * Optional — the broker omits this when detection fails on unusual
   * platforms, and callers should treat its absence as "unknown".
   */
  os_version?: string;
  /** Node.js version (without 'v' prefix). Absent on broker-originated events. */
  node_version?: string;
  /** CPU architecture (e.g., arm64, x64) */
  arch: string;
}

// =============================================================================
// Tier 1: Core Usage Events (broker/agent lifecycle)
// =============================================================================

/**
 * broker_start - Emitted when the broker starts.
 * No additional properties beyond common props.
 */
export type BrokerStartEvent = Record<string, never>;

/**
 * broker_stop - Emitted when the broker stops.
 */
export interface BrokerStopEvent {
  /** How long the broker was running, in seconds */
  uptime_seconds: number;
  /** Total agents spawned during this session */
  agent_spawn_count: number;
}

/**
 * broker_start_failed - Emitted when the CLI fails to start or connect to a broker.
 * Captures the stage so we can tell config problems from port conflicts from
 * binary-not-found, without leaking paths or args.
 */
export interface BrokerStartFailedEvent {
  /** Coarse phase where we gave up — e.g., 'resolve_binary', 'spawn', 'connect', 'handshake' */
  stage: string;
  /** Error constructor name (e.g., 'ENOENT', 'ECONNREFUSED', 'Error') */
  error_class: string;
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
// Tier 2: Engagement Events (messaging + CLI usage)
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
 * cli_command_run - Emitted before a CLI command's action runs.
 * Now fires for every command (not just interactive), via a global Commander hook.
 */
export interface CliCommandRunEvent {
  /** Full command path — e.g., 'up', 'cloud login', 'workflows list' */
  command_name: string;
  /** Names (not values) of flags/options the user explicitly passed on the CLI */
  flags_used?: string[];
  /** True when stdin is a TTY — helps tell interactive vs scripted runs apart */
  is_tty?: boolean;
  /** Whether this process appears to be running inside CI */
  is_ci?: boolean;
}

/**
 * cli_command_complete - Emitted after a CLI command finishes (success or failure).
 * Pairs with cli_command_run by command_name + same session.
 */
export interface CliCommandCompleteEvent {
  /** Full command path — e.g., 'up', 'cloud login' */
  command_name: string;
  /** True if the command ran to completion without throwing / without exit(non-zero) */
  success: boolean;
  /** Wall-clock duration in milliseconds */
  duration_ms: number;
  /** Exit code if the command or top-level handler requested one */
  exit_code?: number;
  /** Error constructor name when success=false (e.g., 'Error', 'CommanderError') */
  error_class?: string;
}

// =============================================================================
// Tier 3: Domain Events (high-signal product flows)
// =============================================================================

export type WorkflowFileType = 'yaml' | 'ts' | 'py' | 'unknown';

/**
 * workflow_run - Emitted when `agent-relay run <file>` finishes (success or failure).
 * Covers the primary product surface — workflow execution from a local file.
 */
export interface WorkflowRunEvent {
  /** Detected workflow file type */
  file_type: WorkflowFileType;
  /** True if --dry-run was passed */
  is_dry_run: boolean;
  /** True if --resume was passed */
  is_resume: boolean;
  /** True if --start-from was passed */
  is_start_from: boolean;
  /** True for .ts/.tsx/.py scripts (as opposed to YAML) */
  is_script: boolean;
  /** True if the command completed successfully */
  success: boolean;
  /** Wall-clock duration in milliseconds */
  duration_ms: number;
  /** Error constructor name on failure */
  error_class?: string;
}

/**
 * cloud_auth - Emitted for cloud account auth flows (login/logout/whoami/connect).
 * `action` distinguishes the flow; `provider` is only present for `connect`.
 */
export interface CloudAuthEvent {
  /** Which cloud-auth flow ran */
  action: 'login' | 'logout' | 'whoami' | 'connect';
  /** True if the flow completed without throwing */
  success: boolean;
  /** Wall-clock duration in milliseconds */
  duration_ms: number;
  /** Provider id for `connect` flows (e.g., 'anthropic', 'openai') */
  provider?: string;
  /** Error constructor name on failure */
  error_class?: string;
}

/**
 * cloud_workflow_run - Emitted when `agent-relay cloud run` submits a workflow.
 */
export interface CloudWorkflowRunEvent {
  /** Whether --file-type was explicitly set by the user */
  has_explicit_file_type: boolean;
  /** Whether --sync-code was enabled (user or default) */
  sync_code: boolean;
  /** True if --json output mode was requested */
  json_output: boolean;
  /** True if the run was submitted successfully */
  success: boolean;
  /** Wall-clock duration in milliseconds */
  duration_ms: number;
  /** Error constructor name on failure */
  error_class?: string;
}

/**
 * provider_auth - Emitted for `agent-relay auth <provider>` (SSH-based provider login).
 */
export interface ProviderAuthEvent {
  /** Normalized provider id (e.g., 'anthropic', 'openai', 'google') */
  provider: string;
  /** True if auth completed without throwing */
  success: boolean;
  /** Wall-clock duration in milliseconds */
  duration_ms: number;
  /** Whether the --use-auth-broker flag was set */
  use_auth_broker: boolean;
  /** Whether a one-time --token was provided */
  used_token: boolean;
  /** Error constructor name on failure */
  error_class?: string;
}

/**
 * setup_init - Emitted when the first-run init wizard runs.
 */
export interface SetupInitEvent {
  /** True if running inside a cloud workspace (WORKSPACE_ID set) */
  is_cloud: boolean;
  /** True if a broker was already running when init started */
  broker_was_running: boolean;
  /** True if the user accepted the prompt to start the broker */
  user_started_broker: boolean;
  /** True if --yes was passed (non-interactive) */
  yes_flag: boolean;
  /** True if --skip-broker was passed */
  skip_broker: boolean;
}

/**
 * swarm_run - Emitted when an ad-hoc swarm run finishes.
 */
export interface SwarmRunEvent {
  /** Swarm pattern (e.g., 'fan-out', 'competitive', 'pipeline') */
  pattern: string;
  /** Number of teams/stages requested */
  teams: number;
  /** CLI tool used for workers */
  cli: string;
  /** True if --list was passed */
  is_list: boolean;
  /** True if --dry-run was passed */
  is_dry_run: boolean;
  /** Exit code from the broker process */
  exit_code: number;
  /** Wall-clock duration in milliseconds */
  duration_ms: number;
}

/**
 * bridge_spawn - Emitted when the multi-project bridge is launched.
 */
export interface BridgeSpawnEvent {
  /** Number of projects being bridged */
  project_count: number;
  /** CLI tool override if provided (else 'default') */
  cli: string;
  /** True if an architect agent was requested */
  has_architect: boolean;
}

// =============================================================================
// Event Union Type
// =============================================================================

export type TelemetryEventName =
  | 'broker_start'
  | 'broker_stop'
  | 'broker_start_failed'
  | 'agent_spawn'
  | 'agent_release'
  | 'agent_crash'
  | 'message_send'
  | 'cli_command_run'
  | 'cli_command_complete'
  | 'workflow_run'
  | 'cloud_auth'
  | 'cloud_workflow_run'
  | 'provider_auth'
  | 'setup_init'
  | 'swarm_run'
  | 'bridge_spawn';

export interface TelemetryEventMap {
  broker_start: BrokerStartEvent;
  broker_stop: BrokerStopEvent;
  broker_start_failed: BrokerStartFailedEvent;
  agent_spawn: AgentSpawnEvent;
  agent_release: AgentReleaseEvent;
  agent_crash: AgentCrashEvent;
  message_send: MessageSendEvent;
  cli_command_run: CliCommandRunEvent;
  cli_command_complete: CliCommandCompleteEvent;
  workflow_run: WorkflowRunEvent;
  cloud_auth: CloudAuthEvent;
  cloud_workflow_run: CloudWorkflowRunEvent;
  provider_auth: ProviderAuthEvent;
  setup_init: SetupInitEvent;
  swarm_run: SwarmRunEvent;
  bridge_spawn: BridgeSpawnEvent;
}
