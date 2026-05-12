import type { AgentEvent, LogFields, LogLevel, Logger, StructuredLogEntry } from '@agent-relay/events';

/**
 * Cron or one-shot trigger definition accepted by `agent()`.
 */
export type ScheduleSpec = string | { cron: string; tz?: string } | { at: string | Date };

/**
 * Hosted-agent approval policy modes parsed from agent definitions.
 */
export type AgentPolicyMode = 'suggest' | 'auto' | 'approval-required';

export type PolicyActionType = 'external-message' | 'write' | 'delete' | 'schedule';

/**
 * Action policy definition enforced by the agent context helpers.
 */
export interface AgentPolicy {
  /** Approval mode to associate with the agent. */
  mode: AgentPolicyMode;
  /** Action classes that should require explicit approval before execution. */
  approvals?: PolicyActionType[];
}

export interface AgentProviderConfig {
  /** Whether hosted execution should use Relay-managed credentials or BYOK. */
  mode: 'managed' | 'byok';
  /** Secret reference used when `mode === "byok"`. */
  secretRef?: string;
}

/**
 * Replay bootstrap options reserved for M2 file triggers.
 */
export type ReplayOnStart = 'none' | `last:${number}` | `since:${string}`;

/**
 * Missed-tick policy for downtime recovery.
 */
export type CoalesceMissedTicksMode = 'drop' | 'fire-once';

/**
 * Runtime tuning options for the layered agent SDK.
 */
export interface AgentOptions {
  /** Optional API key override. Falls back to `RELAY_API_KEY`. */
  apiKey?: string;
  /** Optional event gateway websocket URL. */
  gatewayUrl?: string;
  /** Optional direct relayfile base URL for local/offline helper calls. */
  relayfileUrl?: string;
  /** Optional direct relaycast base URL for local/offline helper calls. */
  relaycastUrl?: string;
  /** Deprecated HTTP scheduler base URL kept for compatibility with legacy tests. */
  relaycronBaseUrl?: string;
  /** Maximum number of concurrent handlers for the workspace. */
  concurrency?: number;
  /** Maximum queued backlog before the remote runtime should start dropping events. */
  maxBacklog?: number;
  /** Graceful shutdown drain timeout in milliseconds. Defaults to `30000`. */
  drainMs?: number;
  /** Per-handler timeout in milliseconds. Defaults to `300000`. */
  handlerTimeoutMs?: number;
  /** Whether SIGTERM and SIGINT should call `handle.stop()`. */
  handleSignals?: boolean;
  /** Replay bootstrap mode reserved for M2. `since:` values must be ISO-8601 timestamps. */
  replayOnStart?: ReplayOnStart;
  /** Default watch-event coalescing window in milliseconds. Defaults to `200`. */
  coalesceMs?: number;
  /** Missed-tick coalescing mode reserved for gateway enforcement. */
  coalesceMissedTicks?: CoalesceMissedTicksMode;
  /** Minimum structured log level emitted by `ctx.logger`. Defaults to `info`. */
  logLevel?: LogLevel;
}

/**
 * Workspace file materialized through the gateway relayfile proxy.
 */
export interface WorkspaceFile {
  /** Workspace-relative or absolute path for the file. */
  path: string;
  /** Parsed file body when available. */
  body: unknown;
  /** Optional relayfile revision returned by the backend. */
  revision?: string;
  /** Optional content-type metadata. */
  contentType?: string;
  /** Optional text/binary encoding marker. */
  encoding?: 'utf-8' | 'base64';
  /** Optional relayfile semantics payload. */
  semantics?: Record<string, unknown>;
}

/**
 * Optional write metadata forwarded to the relayfile proxy.
 */
export interface WriteMeta {
  /** Optional content-type override. */
  contentType?: string;
  /** Optional text/binary encoding marker. */
  encoding?: 'utf-8' | 'base64';
  /** Optional relayfile semantics payload. */
  semantics?: Record<string, unknown>;
  /** Optional compare-and-swap base revision. */
  baseRevision?: string;
  /** Optional idempotency identity forwarded to relayfile. */
  contentIdentity?: {
    kind: string;
    key: string;
  };
}

/**
 * File list entry returned by the relayfile proxy.
 */
export interface FileSummary {
  /** File path. */
  path: string;
  /** Optional node type. */
  type?: 'file' | 'dir';
  /** Optional relayfile revision. */
  revision?: string;
  /** Optional provider namespace. */
  provider?: string;
  /** Optional provider object id. */
  providerObjectId?: string;
  /** Optional size in bytes. */
  size?: number;
  /** Optional update timestamp. */
  updatedAt?: string;
  /** Optional projected property count. */
  propertyCount?: number;
  /** Optional projected relation count. */
  relationCount?: number;
  /** Optional projected permission count. */
  permissionCount?: number;
  /** Optional projected comment count. */
  commentCount?: number;
}

/**
 * Outbound relaycast message options.
 */
export interface PostOpts {
  /** Optional application-level idempotency key. */
  idempotencyKey?: string;
}

export type PolicyDecision = 'auto' | 'suggested' | 'approved' | 'rejected';

export interface PolicySuggestion {
  /** Stable policy event id used for audit and approval artifacts. */
  id: string;
  /** Decision produced by the policy gate. */
  decision: 'suggested';
  /** Action class evaluated by the gate. */
  actionType: PolicyActionType;
  /** Workspace associated with the action. */
  workspace: string;
  /** Agent associated with the action. */
  agentId: string;
  /** ISO timestamp when the suggestion was created. */
  createdAt: string;
  /** Structured action payload. */
  action: Record<string, unknown>;
}

export interface ApprovalVerdictRecord {
  /** Stable approval id matching `/pending-approvals/<id>.json`. */
  id: string;
  /** Human verdict value. */
  verdict: 'approved' | 'rejected';
  /** Optional approver metadata. */
  approvedBy?: string;
  /** Optional decision rationale. */
  reason?: string;
  /** Full raw payload written by the approver. */
  raw: Record<string, unknown>;
}

/**
 * Raw relayfile client surface exposed through `ctx.raw`.
 */
export interface RelayfileClient {
  /** Whether the runtime has a live relayfile binding behind this client. */
  available?: boolean;
  /** Reads a workspace file. */
  read(path: string): Promise<WorkspaceFile | null>;
  /** Writes a workspace file. */
  write(path: string, body: unknown, meta?: WriteMeta): Promise<void>;
  /** Deletes a workspace file. */
  delete(path: string): Promise<void>;
  /** Lists files matching a glob. */
  list(glob: string): Promise<FileSummary[]>;
}

/**
 * Raw relaycast client surface exposed through `ctx.raw`.
 */
export interface RelaycastClient {
  /** Whether the runtime has a live relaycast binding behind this client. */
  available?: boolean;
  /** Posts a message to a channel. */
  post(channel: string, text: string, opts?: PostOpts): Promise<{ id: string } | PolicySuggestion>;
  /** Replies to a thread. */
  reply(threadId: string, text: string, opts?: PostOpts): Promise<{ id: string } | PolicySuggestion>;
  /** Sends a direct message. */
  dm(agentOrUser: string, text: string, opts?: PostOpts): Promise<{ id: string } | PolicySuggestion>;
}

/**
 * Raw relaycron schedule registration payload.
 */
export interface RelaycronScheduleDefinition {
  /** Cron expression for a recurring schedule. */
  cron?: string;
  /** ISO timestamp or `Date` for a one-shot schedule. */
  at?: string | Date;
  /** Optional timezone for recurring schedules. */
  tz?: string;
  /** Optional payload to associate with the schedule. */
  payload?: unknown;
}

/**
 * Schedule handle returned by the M1 relaycron wrapper.
 */
export interface RelaycronScheduleHandle {
  /** Stable schedule identifier. */
  id: string;
}

/**
 * Raw relaycron client surface exposed through `ctx.raw`.
 */
export interface RelaycronClient {
  /** Whether the runtime has a live relaycron binding behind this client. */
  available?: boolean;
  /** Registers a recurring or one-shot schedule. */
  register(definition: RelaycronScheduleDefinition): Promise<RelaycronScheduleHandle>;
  /** Cancels a schedule by id. */
  cancel(id: string): Promise<void>;
}

/**
 * Runtime context delivered to agent event handlers.
 */
export interface Context {
  /** Workspace associated with the running agent. */
  workspace: string;
  /** Stable runtime agent identifier. */
  agentId: string;
  /** Structured logger surface. */
  logger: Logger;
  /** Handler-scoped abort signal for timeout and shutdown propagation. */
  signal: AbortSignal;
  /** Applies burn tagging to a fetch function or compatible LLM client. */
  tagged<T>(value: T): T;
  /** Relayfile helpers backed by the runtime gateway. */
  files: {
    /** Reads a workspace file. */
    read(path: string): Promise<WorkspaceFile | null>;
    /** Writes a workspace file. */
    write(path: string, body: unknown, meta?: WriteMeta): Promise<void | PolicySuggestion>;
    /** Deletes a workspace file. */
    delete(path: string): Promise<void | PolicySuggestion>;
    /** Lists matching files. */
    list(glob: string): Promise<FileSummary[]>;
  };
  /** Relaycast helpers. */
  messages: {
    /** Posts a message to a channel. */
    post(channel: string, text: string, opts?: PostOpts): Promise<{ id: string } | PolicySuggestion>;
    /** Replies to an existing thread. */
    reply(threadId: string, text: string, opts?: PostOpts): Promise<{ id: string } | PolicySuggestion>;
    /** Sends a direct message to an agent or user. */
    dm(agentOrUser: string, text: string, opts?: PostOpts): Promise<{ id: string } | PolicySuggestion>;
  };
  /** Relaycron helpers available in M1. */
  schedule: {
    /** Creates a one-shot wakeup. */
    at(when: string | Date, payload?: unknown): Promise<{ id: string } | PolicySuggestion>;
    /** Creates a recurring cron trigger. */
    every(
      cron: string,
      payload?: unknown,
      opts?: { tz?: string }
    ): Promise<{ id: string } | PolicySuggestion>;
    /** Cancels a previously created schedule. */
    cancel(id: string): Promise<void | PolicySuggestion>;
  };
  /** Underlying raw primitive clients. */
  raw: {
    relayfile: RelayfileClient;
    relaycron: RelaycronClient;
    relaycast: RelaycastClient;
  };
  /** Application-level idempotency helper for non-event side effects. */
  once<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Declarative agent definition for the layered SDK.
 */
export interface AgentDefinition {
  /** Unified workspace name across runtime primitives. */
  workspace: string;
  /** Optional human-readable agent name. Defaults to the workspace. */
  name?: string;
  /** Optional time triggers. */
  schedule?: ScheduleSpec | ScheduleSpec[];
  /** Optional relayfile watch globs. */
  watch?: string | string[];
  /** Optional relaycast inbox subscriptions. */
  inbox?: string | string[];
  /** Single event handler for all normalized event types. */
  onEvent: (ctx: Context, event: AgentEvent) => Promise<void> | void;
  /** Optional startup hook invoked once the runtime is registered. */
  onStart?: (ctx: Context) => Promise<void> | void;
  /** Optional shutdown hook invoked during `handle.stop()`. */
  onStop?: (ctx: Context) => Promise<void> | void;
  /** Optional error hook for final delivery failures. */
  onError?: (ctx: Context, error: Error, event: AgentEvent) => Promise<void> | void;
  /** Action policy metadata enforced by the runtime helpers. */
  policy?: AgentPolicy;
  /** Hosted runtime model/provider configuration. */
  provider?: AgentProviderConfig;
  /** Runtime tuning options. */
  options?: AgentOptions;
}

export type HostedAgentHandler = (ctx: Context, event: AgentEvent) => Promise<void> | void;

/**
 * Declarative hosted-agent definition accepted by `deployAgent(...)`.
 */
export interface HostedAgentDefinition {
  /** Unified workspace name across runtime primitives. */
  workspace: string;
  /** Human-readable deployment name. */
  name: string;
  /** Hosted default runtime model identifier. */
  model: string;
  /** Hosted default runtime system instructions. */
  instructions: string;
  /** Optional time triggers. */
  schedule?: ScheduleSpec | ScheduleSpec[];
  /** Optional relayfile watch globs. */
  watch?: string | string[];
  /** Optional relaycast inbox subscriptions. */
  inbox?: string | string[];
  /** Optional custom runtime override for the managed sandbox. */
  onEvent?: HostedAgentHandler;
  /** Optional action policy metadata enforced by the runtime helpers. */
  policy?: AgentPolicy;
  /** Hosted runtime provider configuration. */
  provider: AgentProviderConfig;
}

export interface HostedAgentStatus {
  /** Stable runtime agent identifier. */
  agentId: string;
  /** Stable deployment identifier. */
  deployId: string;
  /** Current deployment state as reported by the control plane. */
  state: string;
  [key: string]: unknown;
}

export interface DeployHandle {
  /** Stable runtime agent identifier. */
  agentId: string;
  /** Stable deployment identifier. */
  deployId: string;
  /** Reads the current control-plane deployment status. */
  status(): Promise<HostedAgentStatus>;
  /** Tears down the hosted deployment. */
  undeploy(): Promise<void>;
}

/**
 * Handle returned by `agent(...)`.
 */
export interface AgentHandle {
  /** Resolves once the agent is registered and ready to receive events. */
  ready: Promise<void>;
  /** Stops the event stream, drains in-flight work, and tears down lifecycle hooks. */
  stop(): Promise<void>;
  /** Imperatively injects an event into the local dispatcher. */
  trigger(event: Partial<AgentEvent>): Promise<void>;
  /** Shared agent context outside an event scope. */
  ctx: Context;
}

export type { LogFields, LogLevel, Logger, StructuredLogEntry };
