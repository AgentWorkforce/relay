import { createExpander } from './expand.js';
import type {
  AgentEvent,
  AgentEventMap,
  BaseAgentEvent,
  CronTickEvent,
  EventResource,
  EventSummary,
  EventType,
  Expansion,
  ThreadExpansionOptions,
  RelaycastMessageEvent,
  RelayfileChangeEvent,
  StartupReason,
  TransportErrorEvent,
} from './types.js';

/**
 * Serializable event record accepted by envelope constructors and transport code.
 */
export interface AgentEventRecord<
  TType extends EventType = EventType,
  TResource extends Partial<EventResource> | undefined = Partial<EventResource> | undefined,
> {
  /** Optional stable event identifier. */
  id?: string;
  /** Workspace associated with the event. */
  workspace: string;
  /** Normalized event type. */
  type: TType;
  /** Optional occurrence timestamp override. */
  occurredAt?: string;
  /** Optional delivery attempt override. */
  attempt?: number;
  /** Optional explicit resource metadata. */
  resource?: TResource;
  /** Optional lightweight summary override. */
  summary?: EventSummary;
  /** Optional digest of the current resource state. */
  digest?: string;
  /** Cron schedule identifier or expression for `cron.tick`. */
  schedule?: string;
  /** Scheduled fire time for `cron.tick`. */
  scheduledFor?: string;
  /** Startup reason for `startup`. */
  reason?: StartupReason;
  /** Changed path for `relayfile.changed`. */
  path?: string;
  /** Matched watch glob for `relayfile.changed`. */
  watch?: string;
  /** Normalized action for `relayfile.changed`. */
  action?: 'created' | 'updated' | 'deleted';
  /** Optional relayfile agent id for agent-authored changes. */
  agentId?: string;
  /** Channel for `relaycast.message`. */
  channel?: string;
  /** Message id for `relaycast.message`. */
  messageId?: string;
  /** Thread id for `relaycast.message`. */
  threadId?: string;
  /** Transport error detail for `transport.error`. */
  detail?: string;
}

/**
 * Additional options used while constructing a normalized event envelope.
 */
export interface CreateAgentEventOptions {
  /** Shared expansion cache keyed by `(event.id, level)`. */
  expansionCache?: Map<string, Promise<Expansion>>;
  /** Loader used by `expand("full")`. */
  loadFull?: () => Promise<Expansion<'full'>>;
  /** Loader used by `expand("diff")`. */
  loadDiff?: () => Promise<Expansion<'diff'>>;
  /** Loader used by `expand("thread")`. */
  loadThread?: (options?: ThreadExpansionOptions) => Promise<Expansion<'thread'>>;
}

type ResolvedRecordResource<TResource extends Partial<EventResource> | undefined> = EventResource &
  (TResource extends Partial<EventResource> ? TResource : Record<string, never>);

type CreatedAgentEvent<
  TType extends EventType,
  TResource extends Partial<EventResource> | undefined,
> = TType extends keyof AgentEventMap
  ? AgentEventMap[TType]
  : BaseAgentEvent<TType, ResolvedRecordResource<TResource>>;

/**
 * Creates a fully typed normalized event envelope.
 */
export function createAgentEvent<
  TType extends EventType,
  TResource extends Partial<EventResource> | undefined = Partial<EventResource> | undefined,
>(
  record: AgentEventRecord<TType, TResource>,
  options: CreateAgentEventOptions = {}
): CreatedAgentEvent<TType, TResource> {
  const id = record.id ?? createId(record.type);
  const occurredAt = record.occurredAt ?? new Date().toISOString();
  const resource = resolveResource(record, id) as ResolvedRecordResource<TResource>;
  const summary = sanitizeSummary(record.summary ?? defaultSummary(record, resource));

  const base: BaseAgentEvent<TType, ResolvedRecordResource<TResource>> = {
    id,
    workspace: record.workspace,
    type: record.type,
    occurredAt,
    attempt: record.attempt ?? 1,
    resource,
    summary,
    expand: createExpander({
      eventId: id,
      path: resource.path,
      summary,
      cache: options.expansionCache,
      loadFull: options.loadFull,
      loadDiff: options.loadDiff,
      loadThread: options.loadThread,
    }) as BaseAgentEvent<TType, ResolvedRecordResource<TResource>>['expand'],
    digest: record.digest,
  };

  switch (record.type) {
    case 'startup':
      return {
        ...base,
        reason: record.reason ?? 'manual',
      } as unknown as CreatedAgentEvent<TType, TResource>;
    case 'cron.tick':
      return {
        ...base,
        schedule: record.schedule ?? 'manual',
        scheduledFor: record.scheduledFor ?? occurredAt,
      } as unknown as CreatedAgentEvent<TType, TResource>;
    case 'relaycast.message':
      return {
        ...base,
        channel: record.channel ?? 'unknown',
        messageId: record.messageId ?? resource.id,
        threadId: record.threadId,
      } as unknown as CreatedAgentEvent<TType, TResource>;
    case 'transport.error':
      return {
        ...base,
        detail: record.detail ?? 'transport.error',
      } as unknown as CreatedAgentEvent<TType, TResource>;
    case 'relayfile.changed':
      return {
        ...base,
        path: resource.path,
        watch: record.watch,
        action: record.action,
        agentId: record.agentId,
        current: buildRelayfileCurrent(summary),
      } as unknown as CreatedAgentEvent<TType, TResource>;
    default:
      return base as CreatedAgentEvent<TType, TResource>;
  }
}

/**
 * Creates a cron tick event using the M1 synthetic resource conventions.
 */
export function createCronTickEvent(input: {
  workspace: string;
  schedule: string;
  scheduledFor?: string;
  id?: string;
  attempt?: number;
  occurredAt?: string;
  digest?: string;
  resourceId?: string;
  /**
   * Compatibility alias for `resourceId` — callers that compute their
   * own schedule identity (e.g. relaycron client) commonly use
   * `scheduleId`. Both spellings map to the same synthetic resource
   * identity; `resourceId` wins when both are set.
   */
  scheduleId?: string;
  summary?: EventSummary;
}): CronTickEvent {
  const resourceId = input.resourceId ?? input.scheduleId ?? sanitizeScheduleId(input.schedule);
  return createAgentEvent({
    workspace: input.workspace,
    type: 'cron.tick',
    id: input.id,
    occurredAt: input.occurredAt,
    attempt: input.attempt,
    digest: input.digest,
    schedule: input.schedule,
    scheduledFor: input.scheduledFor,
    summary: input.summary,
    resource: {
      path: `/_cron/${resourceId}`,
      kind: 'cron.tick',
      id: resourceId,
      provider: 'internal',
    },
  }) as CronTickEvent;
}

/**
 * Creates a startup event envelope.
 */
export function createStartupEvent(input: {
  workspace: string;
  reason?: StartupReason;
  id?: string;
  attempt?: number;
  occurredAt?: string;
  digest?: string;
  summary?: EventSummary;
}): AgentEvent<'startup'> {
  return createAgentEvent({
    workspace: input.workspace,
    type: 'startup',
    id: input.id,
    occurredAt: input.occurredAt,
    attempt: input.attempt,
    digest: input.digest,
    reason: input.reason,
    summary: input.summary,
    resource: {
      path: '/_system/startup',
      kind: 'startup',
      id: input.id ?? 'startup',
      provider: 'internal',
    },
  });
}

/**
 * Creates a synthetic transport error event.
 */
export function createTransportErrorEvent(input: {
  workspace: string;
  detail: string;
  id?: string;
  occurredAt?: string;
}): TransportErrorEvent {
  return createAgentEvent({
    workspace: input.workspace,
    type: 'transport.error',
    id: input.id,
    occurredAt: input.occurredAt,
    detail: input.detail,
    resource: {
      path: '/_system/transport',
      kind: 'transport.error',
      id: input.id ?? 'transport.error',
      provider: 'internal',
    },
    summary: {
      title: 'transport error',
      status: input.detail,
      tags: ['transport'],
    },
  }) as TransportErrorEvent;
}

/**
 * Converts a typed event back into the serializable record form.
 */
export function toAgentEventRecord(event: AgentEvent): AgentEventRecord {
  const record: AgentEventRecord = {
    id: event.id,
    workspace: event.workspace,
    type: event.type,
    occurredAt: event.occurredAt,
    attempt: event.attempt,
    resource: { ...event.resource },
    summary: cloneSummary(event.summary),
    digest: event.digest,
  };

  if (isCronTickEvent(event)) {
    record.schedule = event.schedule;
    record.scheduledFor = event.scheduledFor;
  }
  if (isStartupEvent(event)) {
    record.reason = event.reason;
  }
  if (isRelayfileChangeEvent(event)) {
    record.watch = event.watch;
    record.action = event.action;
    record.agentId = event.agentId;
  }
  if (isRelaycastMessageEvent(event)) {
    record.channel = event.channel;
    record.messageId = event.messageId;
    record.threadId = event.threadId;
  }
  if (isTransportErrorEvent(event)) {
    record.detail = event.detail;
  }

  return record;
}

/**
 * Type guard for `cron.tick`.
 */
export function isCronTickEvent(event: AgentEvent): event is CronTickEvent {
  return event.type === 'cron.tick';
}

/**
 * Type guard for `startup`.
 */
export function isStartupEvent(event: AgentEvent): event is AgentEvent<'startup'> {
  return event.type === 'startup';
}

/**
 * Type guard for `relayfile.changed`.
 */
export function isRelayfileChangeEvent(event: AgentEvent): event is RelayfileChangeEvent {
  return event.type === 'relayfile.changed';
}

/**
 * Type guard for `relaycast.message`.
 */
export function isRelaycastMessageEvent(event: AgentEvent): event is RelaycastMessageEvent {
  return event.type === 'relaycast.message';
}

/**
 * Type guard for `transport.error`.
 */
export function isTransportErrorEvent(event: AgentEvent): event is TransportErrorEvent {
  return event.type === 'transport.error';
}

function resolveResource(record: AgentEventRecord, fallbackId: string): EventResource {
  if (record.resource?.path && record.resource.id && record.resource.kind && record.resource.provider) {
    return {
      path: record.resource.path,
      id: record.resource.id,
      kind: record.resource.kind,
      provider: record.resource.provider,
    };
  }

  switch (record.type) {
    case 'cron.tick': {
      const scheduleId = sanitizeScheduleId(record.schedule ?? fallbackId);
      return {
        path: record.resource?.path ?? `/_cron/${scheduleId}`,
        kind: record.resource?.kind ?? 'cron.tick',
        id: record.resource?.id ?? scheduleId,
        provider: record.resource?.provider ?? 'internal',
      };
    }
    case 'startup':
      return {
        path: record.resource?.path ?? '/_system/startup',
        kind: record.resource?.kind ?? 'startup',
        id: record.resource?.id ?? fallbackId,
        provider: record.resource?.provider ?? 'internal',
      };
    case 'relayfile.changed': {
      const path = record.resource?.path ?? record.path ?? `/_relayfile/${fallbackId}`;
      const provider = record.resource?.provider ?? inferProviderFromPath(path);
      return {
        path,
        kind: record.resource?.kind ?? inferRelayfileResourceKind(path, provider),
        id: record.resource?.id ?? inferRelayfileResourceId(path, fallbackId),
        provider,
      };
    }
    case 'relaycast.message':
      return {
        path:
          record.resource?.path ??
          `/_relaycast/${record.channel ?? 'unknown'}/${record.messageId ?? fallbackId}`,
        kind: record.resource?.kind ?? 'relaycast.message',
        id: record.resource?.id ?? record.messageId ?? fallbackId,
        provider: record.resource?.provider ?? 'relaycast',
      };
    case 'transport.error':
      return {
        path: record.resource?.path ?? '/_system/transport',
        kind: record.resource?.kind ?? 'transport.error',
        id: record.resource?.id ?? fallbackId,
        provider: record.resource?.provider ?? 'internal',
      };
    default:
      return {
        path: record.resource?.path ?? `/_events/${record.type}/${fallbackId}`,
        kind: record.resource?.kind ?? record.type,
        id: record.resource?.id ?? fallbackId,
        provider: record.resource?.provider ?? inferProvider(record.type),
      };
  }
}

function defaultSummary(record: AgentEventRecord, resource?: EventResource): EventSummary {
  switch (record.type) {
    case 'cron.tick':
      return {
        title: 'cron tick',
        status: record.schedule ?? 'manual',
        tags: ['cron'],
      };
    case 'startup':
      return {
        title: 'startup',
        status: record.reason ?? 'manual',
        tags: ['runtime'],
      };
    case 'transport.error':
      return {
        title: 'transport error',
        status: record.detail ?? 'transport.error',
        tags: ['transport'],
      };
    case 'relayfile.changed': {
      const path = resource?.path ?? record.resource?.path ?? record.path;
      const provider =
        resource?.provider ?? record.resource?.provider ?? (path ? inferProviderFromPath(path) : 'relayfile');
      return {
        ...(path ? { title: describePath(path) } : { title: 'relayfile.changed' }),
        ...(record.action ? { status: record.action } : {}),
        ...(provider && provider !== 'relayfile' ? { tags: [provider] } : {}),
      };
    }
    default:
      return {
        title: record.type,
      };
  }
}

function inferProvider(type: string): string {
  const [provider] = type.split('.', 1);
  return provider || 'internal';
}

function inferProviderFromPath(path: string): string {
  const segments = path.split('/').filter(Boolean);
  const first = segments[0]?.toLowerCase();
  return !first || first.startsWith('_') ? 'relayfile' : first;
}

function inferRelayfileResourceKind(path: string, provider: string): string {
  if (provider === 'relayfile') {
    return 'relayfile.file';
  }

  const segments = path.split('/').filter(Boolean);
  const collection = segments.length > 1 ? segments.at(-2) : undefined;
  const normalized = normalizeResourceCollection(collection);
  return normalized ? `${provider}.${normalized}` : `${provider}.resource`;
}

function inferRelayfileResourceId(path: string, fallbackId: string): string {
  const segments = path.split('/').filter(Boolean);
  const leaf = segments.at(-1);
  if (!leaf) {
    return fallbackId;
  }
  const trimmed = leaf.replace(/\.(json|md|txt|yaml|yml)$/i, '').trim();
  return trimmed || fallbackId;
}

function normalizeResourceCollection(segment: string | undefined): string | undefined {
  const normalized = segment?.trim().replace(/^_+/, '').toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const aliases: Record<string, string> = {
    notifications: 'notification',
    prs: 'pull_request',
    pulls: 'pull_request',
    merge_requests: 'merge_request',
    'merge-requests': 'merge_request',
    records: 'record',
    issues: 'issue',
    comments: 'comment',
    tickets: 'ticket',
    pages: 'page',
    tasks: 'task',
    projects: 'project',
    messages: 'message',
    threads: 'thread',
    files: 'file',
    tables: 'table',
    bases: 'base',
  };

  if (aliases[normalized]) {
    return aliases[normalized];
  }

  if (normalized.endsWith('ies')) {
    return `${normalized.slice(0, -3)}y`;
  }
  if (normalized.endsWith('s') && normalized.length > 1) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function sanitizeScheduleId(schedule: string): string {
  return schedule.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function createId(type: string): string {
  return `${type}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

function buildRelayfileCurrent(summary: EventSummary): RelayfileChangeEvent['current'] | undefined {
  const current = {
    ...(summary.title ? { title: summary.title } : {}),
    ...(summary.status ? { status: summary.status } : {}),
    ...(summary.priority ? { priority: summary.priority } : {}),
    ...(summary.labels?.length ? { labels: [...summary.labels] } : {}),
  };
  return Object.keys(current).length > 0 ? current : undefined;
}

function cloneSummary(summary: EventSummary): EventSummary {
  return {
    ...summary,
    labels: summary.labels ? [...summary.labels] : undefined,
    fieldsChanged: summary.fieldsChanged ? [...summary.fieldsChanged] : undefined,
    tags: summary.tags ? [...summary.tags] : undefined,
    actor: summary.actor ? { ...summary.actor } : undefined,
  };
}

const MAX_LABELS = 8;
const MAX_FIELDS_CHANGED = 16;
const MAX_TAGS = 8;
const MAX_TITLE_LENGTH = 120;
const MAX_STATUS_LENGTH = 96;
const MAX_PRIORITY_LENGTH = 48;
const MAX_TOKEN_LENGTH = 96;

function sanitizeSummary(summary: EventSummary): EventSummary {
  return {
    ...(sanitizeText(summary.title, MAX_TITLE_LENGTH)
      ? { title: sanitizeText(summary.title, MAX_TITLE_LENGTH) }
      : {}),
    ...(sanitizeText(summary.status, MAX_STATUS_LENGTH)
      ? { status: sanitizeText(summary.status, MAX_STATUS_LENGTH) }
      : {}),
    ...(sanitizeText(summary.priority, MAX_PRIORITY_LENGTH)
      ? { priority: sanitizeText(summary.priority, MAX_PRIORITY_LENGTH) }
      : {}),
    ...(sanitizeTokenList(summary.labels, MAX_LABELS)
      ? { labels: sanitizeTokenList(summary.labels, MAX_LABELS) }
      : {}),
    ...(sanitizeTokenList(summary.fieldsChanged, MAX_FIELDS_CHANGED)
      ? { fieldsChanged: sanitizeTokenList(summary.fieldsChanged, MAX_FIELDS_CHANGED) }
      : {}),
    ...(sanitizeTokenList(summary.tags, MAX_TAGS) ? { tags: sanitizeTokenList(summary.tags, MAX_TAGS) } : {}),
    ...(summary.actor?.id?.trim()
      ? {
          actor: {
            id: summary.actor.id.trim(),
            ...(sanitizeText(summary.actor.displayName, MAX_TOKEN_LENGTH)
              ? { displayName: sanitizeText(summary.actor.displayName, MAX_TOKEN_LENGTH) }
              : {}),
          },
        }
      : {}),
  };
}

function sanitizeTokenList(values: string[] | undefined, max: number): string[] | undefined {
  if (!values?.length) {
    return undefined;
  }
  const output: string[] = [];
  for (const value of values) {
    const normalized = sanitizeText(value, MAX_TOKEN_LENGTH);
    if (!normalized || output.includes(normalized)) {
      continue;
    }
    output.push(normalized);
    if (output.length >= max) {
      break;
    }
  }
  return output.length > 0 ? output : undefined;
}

function sanitizeText(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function describePath(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments.at(-1) || path || 'relayfile change';
}
