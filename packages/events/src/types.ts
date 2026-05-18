import type { LogFields, LogLevel, Logger, StructuredLogEntry } from './logger.js';

/**
 * Supported progressive-disclosure levels for normalized runtime events.
 */
export type ExpansionLevel = 'summary' | 'full' | 'diff' | 'thread';

/**
 * Stable actor metadata safe to include in the notification envelope.
 */
export interface EventActorSummary {
  /** Stable provider identifier for the actor. */
  id: string;
  /** Optional display name surfaced for routing or logging. */
  displayName?: string;
}

/**
 * Provider/resource coordinates for the changed resource.
 */
export interface EventResource {
  /** Relayfile-style path for the resource. */
  path: string;
  /** Provider-scoped kind such as `linear.issue`. */
  kind: string;
  /** Stable provider identifier for the resource. */
  id: string;
  /** Top-level provider namespace. */
  provider: string;
}

interface AirtableResourceReference {
  id: string;
  name?: string;
}

interface AirtableTableResource {
  id: string;
  name?: string;
  description?: string | null;
  primaryFieldId?: string;
  baseId?: string;
  base?: AirtableResourceReference | null;
  fields?: Array<{
    id: string;
    name: string;
    type?: string;
    description?: string;
    options?: Record<string, unknown>;
  }>;
  views?: Array<{
    id: string;
    name: string;
    type?: string;
  }>;
  createdTime?: string;
  updatedTime?: string;
}

interface AirtableBaseResource {
  id: string;
  name?: string;
  permissionLevel?: string;
  createdTime?: string;
  tables?: AirtableTableResource[];
  workspace?: AirtableResourceReference | null;
}

interface AirtableRecordResource {
  id: string;
  baseId?: string;
  tableId?: string;
  tableName?: string;
  createdTime?: string;
  updatedTime?: string;
  fields?: Record<string, unknown>;
  commentCount?: number;
}

interface AirtableNotificationResource {
  baseId: string;
  webhookId: string;
  notificationId?: string;
  endpoint?: string;
  path?: string;
  payloads?: Record<string, unknown>[];
  data?: Record<string, unknown>;
  cursor?: number;
  mightHaveMore?: boolean;
  payloadFormat?: string;
  connectionId?: string;
  providerConfigKey?: string;
}

/**
 * Declaration-merging seam mapping `resource.kind` to the expanded full payload.
 */
export interface AgentEventResourceDataMap {
  'airtable.base': AirtableBaseResource;
  'airtable.notification': AirtableNotificationResource;
  'airtable.record': AirtableRecordResource;
  'airtable.table': AirtableTableResource;
  'github.check_run': import('@relayfile/adapter-github').GitHubCheckRun;
  'github.issue': import('@relayfile/adapter-github').GitHubIssue;
  'github.pull_request': import('@relayfile/adapter-github').GitHubPR;
  'github.review': import('@relayfile/adapter-github').GitHubReview;
  'jira.issue': import('@relayfile/adapter-jira').JiraIssue;
  'linear.comment': import('@relayfile/adapter-linear').LinearComment;
  'linear.cycle': import('@relayfile/adapter-linear').LinearCycle;
  'linear.issue': import('@relayfile/adapter-linear').LinearIssue;
  'linear.milestone': import('@relayfile/adapter-linear').LinearMilestone;
  'linear.project': import('@relayfile/adapter-linear').LinearProject;
  'linear.roadmap': import('@relayfile/adapter-linear').LinearRoadmap;
  'notion.block': import('@relayfile/adapter-notion').NotionNormalizedBlock;
  'notion.database': import('@relayfile/adapter-notion').NotionNormalizedDatabase;
  'notion.page': import('@relayfile/adapter-notion').NotionNormalizedPage;
  'slack.resource':
    | import('@relayfile/adapter-slack').SlackChannel
    | import('@relayfile/adapter-slack').SlackEvent
    | import('@relayfile/adapter-slack').SlackFile;
}

export type EventResourceData<TKind extends string = string> = TKind extends keyof AgentEventResourceDataMap
  ? AgentEventResourceDataMap[TKind]
  : Record<string, unknown>;

/**
 * Lightweight routing metadata shipped with the event notification.
 */
export interface EventSummary {
  /** Optional short title or subject for the resource. */
  title?: string;
  /** Optional normalized status field. */
  status?: string;
  /** Optional normalized priority value. */
  priority?: string;
  /** Optional label set. */
  labels?: string[];
  /** Optional actor metadata for the change initiator. */
  actor?: EventActorSummary;
  /** Optional changed-field list for update-style events. */
  fieldsChanged?: string[];
  /** Optional compact tag list. */
  tags?: string[];
}

/**
 * Materialized summary-level expansion.
 */
export interface SummaryExpansion {
  /** Expansion level that was resolved. */
  level: 'summary';
  /** Resource path associated with the event. */
  path: string;
  /** Enriched summary payload. */
  summary: EventSummary;
}

/**
 * Materialized full-level expansion.
 */
export interface FullExpansion<TData = Record<string, unknown>> {
  /** Expansion level that was resolved. */
  level: 'full';
  /** Resource path associated with the event. */
  path: string;
  /** Provider-normalized payload, when available. */
  data: TData;
  /** Optional digest of the expanded resource payload. */
  digest?: string;
}

/**
 * Materialized diff-level expansion.
 */
export interface DiffExpansion {
  /** Expansion level that was resolved. */
  level: 'diff';
  /** Resource path associated with the event. */
  path: string;
  /** Provider-specific diff payload. */
  diff: Record<string, unknown>;
}

/**
 * Cursor/limit options supported by thread expansion.
 */
export interface ThreadExpansionOptions {
  /** Opaque pagination cursor returned by a previous thread expansion call. */
  cursor?: string;
  /** Maximum number of thread items to return. */
  limit?: number;
}

export interface ThreadItemAuthor {
  /** Stable provider identifier for the thread author. */
  id: string;
  /** Human-readable display name when available. */
  displayName: string;
}

export interface ThreadItem {
  /** Stable item identifier within the provider thread. */
  id: string;
  /** Normalized author metadata. */
  author: ThreadItemAuthor;
  /** ISO timestamp for when the item was created. */
  createdAt: string;
  /** Redaction-safe body text. */
  body: string;
  /** Normalized item kind. */
  kind: 'comment' | 'reply' | 'system';
}

/**
 * Materialized thread-level expansion.
 */
export interface ThreadExpansion {
  /** Expansion level that was resolved. */
  level: 'thread';
  /** Provider-normalized thread items for the requested page. */
  items: ThreadItem[];
  /** Whether another page is available. */
  hasMore: boolean;
  /** Opaque cursor for the next page when another page is available. */
  cursor?: string;
}

/**
 * Conditional mapping from an expansion level to its concrete payload.
 */
export type Expansion<L extends ExpansionLevel = ExpansionLevel> = L extends 'summary'
  ? SummaryExpansion
  : L extends 'full'
    ? FullExpansion
    : L extends 'diff'
      ? DiffExpansion
      : ThreadExpansion;

export type ExpansionForResource<
  TResource extends Pick<EventResource, 'kind'> = EventResource,
  L extends ExpansionLevel = ExpansionLevel,
> = L extends 'summary'
  ? SummaryExpansion
  : L extends 'full'
    ? FullExpansion<EventResourceData<TResource['kind']>>
    : L extends 'diff'
      ? DiffExpansion
      : ThreadExpansion;

export type ExpansionOptionsForLevel<L extends ExpansionLevel> = L extends 'thread'
  ? ThreadExpansionOptions
  : never;

/**
 * Fallback pattern for provider-defined event types.
 */
export type ProviderEventType = `${string}.${string}.${string}`;

/**
 * Runtime startup reasons emitted when a stream comes online.
 */
export type StartupReason = 'cold-start' | 'redeploy' | 'manual';

/**
 * Base event envelope delivered before type narrowing.
 */
export interface BaseAgentEvent<
  TType extends string = string,
  TResource extends EventResource = EventResource,
> {
  /** Stable event identifier used for deduplication. */
  id: string;
  /** Workspace associated with the event. */
  workspace: string;
  /** Discriminant for the normalized event kind. */
  type: TType;
  /** ISO-8601 timestamp for when the event occurred. */
  occurredAt: string;
  /** Delivery attempt number starting at `1`. */
  attempt: number;
  /** Resource handle for the changed object. */
  resource: TResource;
  /** Compact routing metadata for the resource. */
  summary: EventSummary;
  /** Progressive-disclosure loader for extra detail. */
  expand: <L extends ExpansionLevel = 'full'>(
    level?: L,
    options?: ExpansionOptionsForLevel<L>
  ) => Promise<ExpansionForResource<TResource, L>>;
  /** Optional digest of the resource's current state. */
  digest?: string;
}

/**
 * Startup event emitted when the stream comes online.
 */
export interface StartupEvent extends BaseAgentEvent<'startup'> {
  /** Reason the startup notification was emitted. */
  reason: StartupReason;
}

/**
 * Time-based trigger emitted by relaycron-backed schedules.
 */
export interface CronTickEvent extends BaseAgentEvent<'cron.tick'> {
  /** Cron expression or one-shot identifier that fired. */
  schedule: string;
  /** ISO-8601 timestamp the schedule was meant to fire for. */
  scheduledFor: string;
}

/**
 * Relayfile event shape reserved for M2 file/watch triggers.
 */
export interface RelayfileChangeEvent<TResource extends EventResource = EventResource> extends BaseAgentEvent<
  'relayfile.changed',
  TResource
> {
  /** Convenience alias for `resource.path`. */
  path: string;
  /** Watch glob that matched this change when the event came from a watch registration. */
  watch?: string;
  /** Normalized filesystem action inferred from the relayfile change. */
  action?: 'created' | 'updated' | 'deleted';
  /** Optional agent identifier attached by relayfile-originated agent writes. */
  agentId?: string;
  /** Lightweight current-state projection derived from the routing summary. */
  current?: {
    title?: string;
    status?: string;
    priority?: string;
    labels?: string[];
    [key: string]: unknown;
  };
}

/**
 * Canonical change-event alias used by relayfile-backed watch triggers.
 */
export type ChangeEvent = RelayfileChangeEvent;

/**
 * Relaycast event shape reserved for M3 message triggers.
 */
export interface RelaycastMessageEvent extends BaseAgentEvent<'relaycast.message'> {
  /** Source channel or DM. */
  channel: string;
  /** Relaycast message identifier. */
  messageId: string;
  /** Optional thread identifier. */
  threadId?: string;
}

/**
 * Synthetic transport-level event used for websocket failures and parse errors.
 */
export interface TransportErrorEvent extends BaseAgentEvent<'transport.error'> {
  /** Short transport error category. */
  detail: string;
}

/**
 * Declaration-merging seam for adapter-defined event bundles.
 */
export interface AgentEventMap {
  startup: StartupEvent;
  'cron.tick': CronTickEvent;
  'relayfile.changed': RelayfileChangeEvent;
  'relaycast.message': RelaycastMessageEvent;
  'transport.error': TransportErrorEvent;
  [eventType: `github.check_run.${string}`]: BaseAgentEvent<
    `github.check_run.${string}`,
    EventResource & { kind: 'github.check_run'; provider: 'github' }
  >;
  [eventType: `github.issue.${string}`]: BaseAgentEvent<
    `github.issue.${string}`,
    EventResource & { kind: 'github.issue'; provider: 'github' }
  >;
  [eventType: `github.pull_request.${string}`]: BaseAgentEvent<
    `github.pull_request.${string}`,
    EventResource & { kind: 'github.pull_request'; provider: 'github' }
  >;
  [eventType: `github.review.${string}`]: BaseAgentEvent<
    `github.review.${string}`,
    EventResource & { kind: 'github.review'; provider: 'github' }
  >;
  [eventType: `jira.issue.${string}`]: BaseAgentEvent<
    `jira.issue.${string}`,
    EventResource & { kind: 'jira.issue'; provider: 'jira' }
  >;
  [eventType: `linear.comment.${string}`]: BaseAgentEvent<
    `linear.comment.${string}`,
    EventResource & { kind: 'linear.comment'; provider: 'linear' }
  >;
  [eventType: `linear.cycle.${string}`]: BaseAgentEvent<
    `linear.cycle.${string}`,
    EventResource & { kind: 'linear.cycle'; provider: 'linear' }
  >;
  [eventType: `linear.issue.${string}`]: BaseAgentEvent<
    `linear.issue.${string}`,
    EventResource & { kind: 'linear.issue'; provider: 'linear' }
  >;
  [eventType: `linear.milestone.${string}`]: BaseAgentEvent<
    `linear.milestone.${string}`,
    EventResource & { kind: 'linear.milestone'; provider: 'linear' }
  >;
  [eventType: `linear.project.${string}`]: BaseAgentEvent<
    `linear.project.${string}`,
    EventResource & { kind: 'linear.project'; provider: 'linear' }
  >;
  [eventType: `linear.roadmap.${string}`]: BaseAgentEvent<
    `linear.roadmap.${string}`,
    EventResource & { kind: 'linear.roadmap'; provider: 'linear' }
  >;
}

/**
 * Known event type names plus provider-defined extensions.
 */
export type EventType = keyof AgentEventMap | ProviderEventType;

/**
 * Strongly typed normalized event union.
 */
export type AgentEvent<TType extends EventType = EventType> = TType extends keyof AgentEventMap
  ? AgentEventMap[TType]
  : BaseAgentEvent<TType>;

/**
 * Event handler signature used by the low-level stream API.
 */
export type EventHandler = (event: AgentEvent) => Promise<void> | void;

/**
 * Error callback used when delivery or transport work fails.
 */
export type EventDispatchErrorHandler = (error: unknown, event: AgentEvent) => Promise<void> | void;

/**
 * Constructor signature used to create websocket connections.
 */
export type WebSocketFactory = (url: string) => WebSocket;

/**
 * Options for opening a normalized event stream.
 */
export interface EventStreamOptions {
  /** Workspace whose events should be streamed. */
  workspace: string;
  /** Optional API key override. Falls back to `RELAY_API_KEY`. */
  apiKey?: string;
  /** Optional stable agent identifier used for subscription registration. */
  agentId?: string;
  /** Optional explicit gateway websocket URL. */
  gatewayUrl?: string;
  /** Optional abort signal for externally managed shutdown. */
  signal?: AbortSignal;
  /** Callback invoked for each delivered normalized event. */
  onEvent: EventHandler;
  /** Optional callback invoked after final delivery failure or transport errors. */
  onError?: EventDispatchErrorHandler;
  /** Optional websocket factory override used in tests or custom runtimes. */
  webSocketFactory?: WebSocketFactory;
}

export type WatchReplayOnStart = 'none' | `last:${number}` | `since:${string}`;

export interface WatchRegistration {
  glob: string | string[];
  replayOnStart?: WatchReplayOnStart;
  coalesceMs?: number;
  maxBacklog?: number;
  handlerTimeoutMs?: number;
}

export type WatchRegistrationInput = string | WatchRegistration | Array<string | WatchRegistration>;

export type InboxRegistrationInput = string | string[];

export interface GatewayRegistrationResult {
  schedules?: Array<{ gatewayScheduleId?: string }>;
  watches?: unknown[];
  inbox?: string[];
}

export interface MessageRpcOptions {
  idempotencyKey?: string;
}

/**
 * Handle returned by `events(...)`.
 */
export interface EventStreamHandle {
  /** Resolves once the transport is registered and ready. */
  ready: Promise<void>;
  /** Stops the transport and prevents further remote delivery. */
  close(): Promise<void>;
  /** Attempts to reserve an idempotency key in the runtime. */
  acquireOnce(key: string): Promise<boolean>;
  /** Releases a previously reserved idempotency key after local failure. */
  releaseOnce(key: string): Promise<void>;
  /** Registers a recurring or one-shot schedule through the gateway control plane. */
  registerSchedule(
    schedule: string | { cron: string; tz?: string } | { at: string }
  ): Promise<{ id: string }>;
  /** Cancels previously registered schedules through the gateway control plane. */
  unregisterSchedules(scheduleIds?: string[]): Promise<void>;
  /** Registers watch globs through the gateway control plane. */
  registerWatches(watch: WatchRegistrationInput): Promise<GatewayRegistrationResult>;
  /** Registers inbox subscriptions through the gateway control plane. */
  registerInboxes(inbox: InboxRegistrationInput): Promise<GatewayRegistrationResult>;
  /** Resolves an on-demand event expansion through the gateway control plane. */
  requestExpansion<L extends Exclude<ExpansionLevel, 'summary'>>(
    eventId: string,
    level: L,
    options?: ExpansionOptionsForLevel<L>
  ): Promise<Expansion<L>>;
  /** Posts a channel message through the gateway control plane. */
  postMessage(channel: string, text: string, opts?: MessageRpcOptions): Promise<{ id: string }>;
  /** Posts a thread reply through the gateway control plane. */
  replyMessage(threadId: string, text: string, opts?: MessageRpcOptions): Promise<{ id: string }>;
  /** Sends a direct message through the gateway control plane. */
  sendDm(agentOrUser: string, text: string, opts?: MessageRpcOptions): Promise<{ id: string }>;
  /** Waits for a human-written approval verdict through the gateway control plane. */
  awaitApproval(approvalId: string): Promise<unknown>;
  /** Reads a workspace file through the gateway control plane. */
  readFile(path: string): Promise<unknown>;
  /** Writes a workspace file through the gateway control plane. */
  writeFile(path: string, body: unknown, meta?: Record<string, unknown>): Promise<void>;
  /** Deletes a workspace file through the gateway control plane. */
  deleteFile(path: string): Promise<void>;
  /** Lists workspace files through the gateway control plane. */
  listFiles(glob: string): Promise<unknown[]>;
  /** Emits a structured SDK log record over the gateway control plane. */
  publishLog(entry: StructuredLogEntry): void;
  /** Imperatively injects a synthetic event into the local stream. */
  trigger(event: Partial<AgentEvent>): Promise<void>;
}

export type { LogFields, LogLevel, Logger, StructuredLogEntry };

/**
 * Error code used by staged surfaces that intentionally do not exist yet.
 */
export type FeatureNotImplementedCode = 'M2_NOT_IMPLEMENTED' | 'M3_NOT_IMPLEMENTED' | 'M5_NOT_IMPLEMENTED';

/**
 * Structured error used when a later milestone surface is intentionally stubbed.
 */
export class FeatureNotImplementedError extends Error {
  /** Stable implementation-stage code. */
  readonly code: FeatureNotImplementedCode;

  /**
   * Creates a milestone-scoped not-implemented error.
   */
  constructor(code: FeatureNotImplementedCode, message: string) {
    super(message);
    this.name = 'FeatureNotImplementedError';
    this.code = code;
  }
}

/**
 * Sentinel error that skips retry orchestration when thrown by a handler.
 */
export class NoRetry extends Error {
  /**
   * Creates a non-retryable error.
   */
  constructor(message: string) {
    super(message);
    this.name = 'NoRetry';
  }
}

/**
 * Options for the future relayfile tool factory used by hosted-agent integrations.
 */
export interface RelayfileToolsOptions {
  /** Workspace the toolset should operate against. */
  workspace: string;
  /** Optional abort signal for downstream reads and writes. */
  signal?: AbortSignal;
  /** Optional live relayfile binding to expose as tools. */
  client?: {
    available?: boolean;
    read(path: string): Promise<unknown>;
    write(path: string, body: unknown): Promise<void>;
    list(glob: string): Promise<unknown[]>;
  } | null;
}

/**
 * Relayfile-style tool surface reserved for M2 integrations.
 */
export interface RelayfileToolset {
  /** Whether the runtime exposed a live relayfile binding for this toolset. */
  available?: boolean;
  /** Reads a workspace file. */
  read(path: string): Promise<unknown>;
  /** Writes a workspace file. */
  write(path: string, body: unknown): Promise<void>;
  /** Lists workspace files matching a glob. */
  list(glob: string): Promise<unknown[]>;
}
