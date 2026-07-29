export const PROTOCOL_VERSION = 2 as const;
/** Version of the broker <-> native harness sidecar protocol. */
export const NATIVE_HARNESS_PROTOCOL_VERSION = 1 as const;

/**
 * Broker process wrapper, not the public harness execution mode. Native
 * harnesses and attached app servers both use the `headless` process wrapper;
 * inspect `harness_config.runtime` for `pty | native | headless` execution.
 */
export type AgentRuntime = 'pty' | 'headless';
export type HeadlessProvider = 'claude' | 'opencode';
export type InboundDeliveryMode = 'auto_inject' | 'manual_flush';
export type SnapshotFormat = 'plain' | 'ansi';

/**
 * Requested spawn lifecycle. `task_exit`/`single_shot` (and their hyphenated
 * spellings) make the agent exit once its task is complete; `interactive`
 * keeps it running.
 */
export type SpawnMode = 'interactive' | 'task_exit' | 'task-exit' | 'single_shot' | 'single-shot';

export interface RestartPolicy {
  enabled?: boolean;
  max_restarts?: number;
  cooldown_ms?: number;
  max_consecutive_failures?: number;
}

export interface AgentSpec {
  name: string;
  runtime: AgentRuntime;
  provider?: HeadlessProvider;
  cli?: string;
  session_id?: string;
  harness_config?: import('./harness.js').ResolvedHarnessConfig;
  args?: string[];
  channels?: string[];
  model?: string;
  cwd?: string;
  team?: string;
  shadow_of?: string;
  shadow_mode?: string;
  restart_policy?: RestartPolicy;
  /** Request task-exit lifecycle; rides the spawn input to the broker. */
  spawn_mode?: SpawnMode;
  /** Request task-exit lifecycle; rides the spawn input to the broker. */
  exit_after_task?: boolean;
}

export type MessageInjectionMode = 'wait' | 'steer';

export interface RelayDelivery {
  delivery_id: string;
  event_id: string;
  workspace_id?: string;
  workspace_alias?: string;
  from: string;
  target: string;
  body: string;
  thread_id?: string;
  priority?: number;
  injection_mode?: MessageInjectionMode;
}

export interface PendingRelayMessage {
  from: string;
  body: string;
  target: string;
  thread_id?: string;
  workspace_id?: string;
  workspace_alias?: string;
  priority: number;
  mode: MessageInjectionMode;
  queued_at_ms: number;
  event_id?: string;
}

export interface PtySnapshot {
  format: SnapshotFormat;
  rows: number;
  cols: number;
  cursor: [number, number];
  /** Plain text for `format=plain`; base64-encoded ANSI bytes for `format=ansi`. */
  screen: string;
  /**
   * Cumulative per-worker byte offset the grid had consumed when this
   * snapshot was captured. Correlates the snapshot with the `worker_stream`
   * byte stream: a client can drop every buffered `worker_stream` chunk whose
   * `offset` is `<=` this value and apply only what came after. Absent on
   * brokers that predate stream-offset support.
   */
  offset?: number;
}

export interface ProtocolEnvelope<TPayload> {
  v: number;
  type: string;
  request_id?: string;
  payload: TPayload;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type NativeHarnessInputMode = 'auto' | 'active' | 'idle';
export type NativeHarnessCommandKind =
  | 'submit_user_message'
  | 'interrupt'
  | 'approve_tool'
  | 'reject_tool'
  | 'compact'
  | 'release';

/**
 * Portable normalized agent-event payload. The SDK owns the canonical event discriminants;
 * the driver intentionally preserves adapter additions as JSON instead of
 * coupling protocol compatibility to one SDK package release.
 */
export interface AgentEventPayload {
  kind: string;
  [key: string]: JsonValue;
}

export interface NativeHarnessDiagnosticPayload {
  level: 'debug' | 'info' | 'warning' | 'error';
  message: string;
  [key: string]: JsonValue;
}

export interface AgentEventEnvelope {
  protocol_version: typeof NATIVE_HARNESS_PROTOCOL_VERSION;
  name: string;
  sequence: number;
  timestamp: string;
  event: AgentEventPayload;
}

export interface NativeHarnessDiagnosticEnvelope {
  protocol_version: typeof NATIVE_HARNESS_PROTOCOL_VERSION;
  name: string;
  sequence: number;
  timestamp: string;
  diagnostic: NativeHarnessDiagnosticPayload;
}

export interface NativeHarnessCommand {
  protocol_version: typeof NATIVE_HARNESS_PROTOCOL_VERSION;
  kind: NativeHarnessCommandKind;
  idempotency_key: string;
  text?: string;
  mode?: NativeHarnessInputMode;
  approval_id?: string;
  /** Optional adapter-specific compaction guidance. Valid only for `compact`. */
  instructions?: string;
}

export interface NativeHarnessCommandAck {
  protocol_version: typeof NATIVE_HARNESS_PROTOCOL_VERSION;
  request_id: string;
  idempotency_key: string;
  accepted: boolean;
  duplicate?: boolean;
  active_turn?: boolean;
  error?: ProtocolError;
}

export interface AgentEventHistoryResponse {
  protocol_version: typeof NATIVE_HARNESS_PROTOCOL_VERSION;
  name: string;
  events: AgentEventEnvelope[];
  high_water_sequence: number;
  oldest_available_sequence: number | null;
  gap: boolean;
}

export interface NodeCapabilityManifest {
  name: string;
  kind?: string;
  /** Capability metadata only; handler code stays in the sidecar. */
  metadata?: Record<string, JsonValue>;
}

type AssertNodeCapabilityManifest<T extends NodeCapabilityManifest> = T;
type _NodeCapabilityAllowsObjectMetadata = AssertNodeCapabilityManifest<{
  name: 'run-foo';
  metadata: { schema: { type: 'object' }; retryable: false };
}>;
type _NodeCapabilityAllowsMissingMetadata = AssertNodeCapabilityManifest<{
  name: 'run-bar';
}>;
// @ts-expect-error capability metadata must be an object record.
type _NodeCapabilityRejectsScalarMetadata = AssertNodeCapabilityManifest<{
  name: 'run-baz';
  metadata: 'v1';
}>;
// @ts-expect-error capability metadata must be an object record.
type _NodeCapabilityRejectsArrayMetadata = AssertNodeCapabilityManifest<{
  name: 'run-qux';
  metadata: ['v1'];
}>;

export interface NodeManifest {
  name: string;
  node_id?: string;
  capabilities: NodeCapabilityManifest[];
  max_agents?: number;
  tags?: string[];
  version?: string;
}

export interface PendingDeliveryInfo {
  delivery_id: string;
  worker_name: string;
  event_id: string;
  from?: string;
  to?: string;
  attempts: number;
  queued_at_ms?: number;
  age_ms?: number;
  last_error?: string;
}

/**
 * One spawned agent as the broker reports it. `GET /api/spawned` returns these
 * directly and `GET /api/status` embeds the same array, so both surfaces are
 * declared once here — they are serialized from a single `WorkerRegistry::list`
 * call in the broker.
 */
export interface ListAgent {
  name: string;
  runtime: AgentRuntime;
  provider?: HeadlessProvider;
  cli?: string;
  model?: string;
  sessionId?: string;
  team?: string;
  channels: string[];
  parent?: string;
  pid?: number;
  last_activity_at?: string;
  last_activity_ms?: number;
  context_budget_pct?: number | null;
  current_state?: AgentCurrentState;
  /**
   * Messages that have not reached the agent yet: queued inbound messages plus
   * in-flight deliveries still awaiting worker confirmation.
   */
  pending_messages?: number;
  /** Attach/runtime discriminator independent from the process wrapper. */
  runtime_kind?: 'pty' | 'headless' | 'native';
  native_harness_protocol_version?: number;
  native_harness_capabilities?: Record<string, unknown>;
}

export interface BrokerStatus {
  agent_count: number;
  agents: ListAgent[];
  pending_delivery_count: number;
  pending_deliveries: PendingDeliveryInfo[];
  node_connected?: boolean;
  node_delivery?: {
    token_present?: boolean;
    connected?: boolean;
  };
  dead_letter_count?: number;
  auth?: BrokerAuthStatus;
}

/** A terminally-failed delivery retained in the broker's dead-letter queue. */
export interface DeadLetterInfo {
  delivery_id: string;
  worker_name: string;
  event_id: string;
  from: string;
  to: string;
  attempts: number;
  reason: string;
  queued_at_ms: number;
  failed_at_ms: number;
  age_ms: number;
}

export interface DeadLettersResponse {
  count: number;
  dead_letters: DeadLetterInfo[];
}

export interface RedeliverDeadLettersResponse {
  redelivered: Array<{ delivery_id: string; worker_name: string; event_id: string }>;
  skipped: Array<{ delivery_id: string; worker_name: string; reason: string }>;
}

export type AgentCurrentState = 'working' | 'idle' | 'blocked_on_send';

export interface BrokerAuthStatus {
  authenticated: boolean;
  workspace_count: number;
  default_workspace_id?: string | null;
  workspaces: Array<{
    workspace_id: string;
    workspace_alias?: string | null;
    self_name: string;
    self_agent_id: string;
    authenticated: boolean;
    default: boolean;
  }>;
}

export type BrokerAgentStatus = 'healthy' | 'restarting' | 'dead' | 'released';

export interface AgentStats {
  spawns: number;
  crashes: number;
  restarts: number;
  releases: number;
  status: BrokerAgentStatus;
  current_uptime_secs: number;
  memory_bytes: number;
}

export interface BrokerStats {
  uptime_secs: number;
  total_agents_spawned: number;
  total_crashes: number;
  total_restarts: number;
  active_agents: number;
}

export type CrashCategory = 'oom' | 'segfault' | 'error' | 'signal' | 'unknown';

export interface CrashRecord {
  agent_name: string;
  exit_code?: number;
  signal?: string;
  timestamp: number;
  uptime_secs: number;
  category: CrashCategory;
  description: string;
}

export interface CrashPattern {
  category: CrashCategory;
  count: number;
  agents: string[];
}

export interface CrashInsightsResponse {
  total_crashes: number;
  recent: CrashRecord[];
  patterns: CrashPattern[];
  health_score: number;
}

export interface ProtocolError {
  code: string;
  message: string;
  retryable: boolean;
  data?: unknown;
}

export type BrokerEvent =
  | {
      kind: 'agent_spawned';
      name: string;
      runtime: AgentRuntime;
      provider?: HeadlessProvider;
      cli?: string;
      model?: string;
      sessionId?: string;
      parent?: string;
      pid?: number;
      source?: string;
    }
  | {
      kind: 'agent_released';
      name: string;
    }
  | {
      kind: 'agent_exit';
      name: string;
      reason: string;
    }
  | {
      kind: 'agent_exited';
      name: string;
      code?: number;
      signal?: string;
      reason?: string;
    }
  | {
      kind: 'agent_context_low';
      name: string;
      pct: number;
    }
  | {
      kind: 'relay_inbound';
      event_id: string;
      from: string;
      target: string;
      body: string;
      thread_id?: string;
      mode?: MessageInjectionMode;
      injection_mode?: MessageInjectionMode;
    }
  | {
      kind: 'worker_stream';
      name: string;
      stream: string;
      chunk: string;
      /**
       * Cumulative per-worker byte offset at the end of this chunk. Present
       * for PTY workers; absent for headless workers and pre-offset brokers.
       */
      offset?: number;
    }
  | ({ kind: 'agent_event' } & AgentEventEnvelope)
  | ({ kind: 'native_harness_diagnostic' } & NativeHarnessDiagnosticEnvelope)
  | {
      kind: 'delivery_retry';
      name: string;
      delivery_id: string;
      event_id: string;
      attempts: number;
    }
  | {
      kind: 'delivery_dropped';
      name: string;
      count: number;
      reason: string;
    }
  | {
      kind: 'delivery_queued';
      name: string;
      delivery_id: string;
      event_id: string;
      timestamp?: unknown;
    }
  | {
      kind: 'agent_pending_drained';
      name: string;
      count: number;
      reason?: string;
    }
  | {
      kind: 'agent_inbound_delivery_mode_changed';
      name: string;
      previous_mode: InboundDeliveryMode;
      mode: InboundDeliveryMode;
    }
  | {
      kind: 'delivery_injected';
      name: string;
      delivery_id: string;
      event_id: string;
      timestamp?: unknown;
    }
  | {
      kind: 'delivery_verified';
      name: string;
      delivery_id: string;
      event_id: string;
      /** 'echo' when confirmed in PTY output, 'timeout_fallback' when acked unverified. */
      verification?: string;
      reason?: string;
    }
  | {
      kind: 'delivery_failed';
      name: string;
      delivery_id: string;
      event_id: string;
      reason: string;
    }
  | {
      kind: 'message_delivery_confirmed';
      name: string;
      delivery_id: string;
      event_id: string;
      from: string;
      to: string;
    }
  | {
      kind: 'delivery_read_ack';
      name: string;
      delivery_id: string;
      event_id: string;
      status: 'marked' | 'failed' | 'skipped_synthetic' | 'suppressed_duplicate';
      reason?: string;
    }
  | {
      kind: 'message_delivery_failed';
      name: string;
      delivery_id?: string;
      event_id?: string;
      from: string;
      to: string;
      attempts: number;
      lastError: string;
    }
  | {
      kind: 'dead_letter_added';
      name: string;
      delivery_id: string;
      event_id: string;
      from: string;
      to: string;
      attempts: number;
      reason: string;
    }
  | {
      kind: 'dead_letter_redelivered';
      name: string;
      delivery_id: string;
      event_id: string;
    }
  | {
      kind: 'delivery_active';
      name: string;
      delivery_id: string;
      event_id: string;
    }
  | {
      kind: 'delivery_ack';
      name: string;
      delivery_id: string;
      event_id: string;
    }
  | {
      kind: 'channel_subscribed';
      name: string;
      channels: string[];
    }
  | {
      kind: 'channel_unsubscribed';
      name: string;
      channels: string[];
    }
  | {
      kind: 'worker_ready';
      name: string;
      runtime: AgentRuntime;
      provider?: HeadlessProvider;
      cli?: string;
      model?: string;
      sessionId?: string;
      pid?: number;
    }
  | {
      kind: 'worker_error';
      name: string;
      code: string;
      message: string;
    }
  | {
      kind: 'relaycast_published';
      event_id: string;
      to: string;
      target_type: string;
    }
  | {
      kind: 'relaycast_publish_failed';
      event_id: string;
      to: string;
      reason: string;
    }
  | {
      kind: 'acl_denied';
      name: string;
      sender: string;
      owner_chain: string[];
    }
  | {
      kind: 'agent_idle';
      name: string;
      idle_secs: number;
      since?: string;
    }
  | {
      kind: 'agent_result';
      name: string;
      result_id: string;
      data: unknown;
      final: boolean;
      metadata?: unknown;
    }
  | {
      kind: 'agent_blocked_on_send';
      name: string;
      blocked_secs: number;
      pending_delivery_count: number;
    }
  | {
      kind: 'agent_restarting';
      name: string;
      code?: number;
      signal?: string;
      restart_count: number;
      delay_ms: number;
    }
  | {
      kind: 'agent_restarted';
      name: string;
      restart_count: number;
    }
  | {
      kind: 'agent_permanently_dead';
      name: string;
      reason: string;
    };

export type BrokerToWorker =
  | {
      type: 'init_worker';
      payload: { agent: AgentSpec };
    }
  | {
      type: 'deliver_relay';
      payload: RelayDelivery;
    }
  | {
      type: 'shutdown_worker';
      payload: { reason: string; grace_ms?: number };
    }
  | {
      type: 'ping';
      payload: { ts_ms: number };
    }
  | {
      type: 'resize_pty';
      payload: { rows: number; cols: number };
    }
  | {
      /**
       * Pause (`hold: true`) or resume (`hold: false`) worker-side automation
       * while a human drives the PTY. Sent when the inbound delivery mode flips
       * to/from `manual_flush`. While held the worker stops popping pending
       * injections, freezes any in-flight injection, and gates its auto-enter
       * and prompt auto-responders.
       */
      type: 'set_interactive_hold';
      payload: { hold: boolean };
    }
  | {
      /**
       * One-shot request to inject the worker's currently-queued pending
       * injections even while an interactive hold is active. Sent by the
       * broker on an explicit `POST /api/spawned/{name}/flush` so a human who
       * asked for the backlog gets it injected immediately instead of it
       * sitting frozen until the drive session detaches. Deliveries that
       * arrive after the flush stay parked under the hold as usual.
       *
       * With `event_id` set the flush is narrowed to that single delivery
       * instead of the whole backlog: it is popped through the hold even if
       * other injections sit in front of it, and they stay parked. The broker
       * sends it that way to start a (re)spawn's initial task under a hold
       * replayed onto a restarted worker.
       */
      type: 'flush_injections';
      payload: { event_id?: string };
    }
  | {
      type: 'native_harness_command';
      request_id?: string;
      payload: NativeHarnessCommand;
    };

export type WorkerToBroker =
  | {
      type: 'worker_ready';
      payload: { name: string; runtime: AgentRuntime; provider?: HeadlessProvider; sessionId?: string };
    }
  | {
      type: 'delivery_ack';
      payload: { delivery_id: string; event_id: string };
    }
  | {
      type: 'delivery_verified';
      payload: { delivery_id: string; event_id: string; verification?: string; reason?: string };
    }
  | {
      type: 'delivery_failed';
      payload: { delivery_id: string; event_id: string; reason: string };
    }
  | {
      type: 'worker_stream';
      payload: { stream: string; chunk: string; offset?: number };
    }
  | {
      type: 'worker_error';
      payload: ProtocolError;
    }
  | {
      type: 'worker_exited';
      payload: { code?: number; signal?: string };
    }
  | {
      type: 'pong';
      payload: { ts_ms: number };
    }
  | {
      type: 'agent_event';
      payload: Omit<AgentEventEnvelope, 'name'>;
    }
  | {
      type: 'native_harness_diagnostic';
      payload: Omit<NativeHarnessDiagnosticEnvelope, 'name'>;
    }
  | {
      type: 'native_harness_command_response';
      request_id?: string;
      payload: NativeHarnessCommandAck;
    };
