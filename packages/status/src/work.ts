/** Versioned work evidence contract. Admission/authentication belongs to the caller. */
import { z } from 'zod';

export const SESSION_STATUS_VERSION = 1 as const;
export const sessionWorkState = z.enum([
  'working',
  'needs_attention',
  'waiting_on_agent',
  'idle',
  'waiting_on_pr',
  'done',
  'archived',
]);
export const sessionWorkReason = z.enum([
  'no_activity',
  'thinking',
  'tool_running',
  'testing',
  'coordinating',
  'human_input',
  'approval',
  'credentials',
  'failure',
  'agent_reply',
  'pr_review',
  'pr_ci',
  'pr_merge',
  'turn_finished',
  'paused',
  'dependencies_resolved',
  'completed',
  'merged',
  'archived',
]);
const id = z.string().min(1);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const instant = z.iso.datetime({ offset: true });
export const sessionStatusIdentity = z.strictObject({
  organizationId: id,
  workspaceId: id,
  source: id,
  sessionId: id,
});
export const sessionWorkDependency = z.strictObject({
  id,
  kind: z.enum(['human', 'agent', 'pr']),
  state: z.enum(['pending', 'resolved']),
  /** Stable agent ID or PR URL; never a display name. */
  target: id,
});
const assessment = {
  state: sessionWorkState,
  reason: sessionWorkReason,
};
export const sessionWorkStatus = z.strictObject({
  schemaVersion: z.literal(SESSION_STATUS_VERSION),
  identity: sessionStatusIdentity,
  workEpisodeId: id.nullable(),
  revision: counter,
  ...assessment,
  basis: z.enum(['observed', 'inferred']),
  observedAt: instant.nullable(),
  lastSeenAt: instant.nullable(),
  dependencies: z.array(sessionWorkDependency),
  evidenceIds: z.array(id),
  producerSequences: z.record(z.string(), counter),
  /** Archive wraps, rather than overwrites, the last work assessment. */
  resume: z.strictObject({ ...assessment, basis: z.enum(['observed', 'inferred']) }).nullable(),
});
export type SessionWorkStatus = z.infer<typeof sessionWorkStatus>;
export type SessionWorkState = z.infer<typeof sessionWorkState>;

const event = {
  schemaVersion: z.literal(SESSION_STATUS_VERSION),
  identity: sessionStatusIdentity,
  eventId: id,
  /** Stable producer incarnation; a restarted sequence needs a new producerId. */
  producerId: id,
  sequence: counter,
  /** Compare-and-set against the projection, not a wall-clock ordering guess. */
  expectedRevision: counter,
  workEpisodeId: id.nullable(),
  observedAt: instant,
};
export const sessionWorkEvent = z.discriminatedUnion('kind', [
  z.strictObject({ ...event, kind: z.literal('start') }),
  z.strictObject({
    ...event,
    kind: z.literal('activity'),
    reason: z.enum(['thinking', 'tool_running', 'testing', 'coordinating']),
  }),
  z.strictObject({
    ...event,
    kind: z.literal('wait'),
    reason: z.enum([
      'human_input',
      'approval',
      'credentials',
      'failure',
      'agent_reply',
      'pr_review',
      'pr_ci',
      'pr_merge',
    ]),
    dependencies: z.array(sessionWorkDependency).min(1),
  }),
  z.strictObject({
    ...event,
    kind: z.literal('resolve_dependency'),
    dependencyId: id,
  }),
  z.strictObject({ ...event, kind: z.literal('turn_finished') }),
  z.strictObject({
    ...event,
    kind: z.literal('complete'),
    reason: z.enum(['completed', 'merged']),
  }),
  z.strictObject({ ...event, kind: z.literal('archive') }),
  z.strictObject({ ...event, kind: z.literal('unarchive') }),
  z.strictObject({ ...event, kind: z.literal('heartbeat') }),
]);
export type SessionWorkEvent = z.infer<typeof sessionWorkEvent>;

/** Named schema exports used by the generated Rust/Swift contract. */
export const sessionStatusSchemas = {
  SessionWorkState: sessionWorkState,
  SessionWorkReason: sessionWorkReason,
  SessionStatusIdentity: sessionStatusIdentity,
  SessionWorkDependency: sessionWorkDependency,
  SessionWorkStatus: sessionWorkStatus,
  SessionWorkEvent: sessionWorkEvent,
};

export function initialSessionWorkStatus(identity: SessionWorkStatus['identity']): SessionWorkStatus {
  return sessionWorkStatus.parse({
    schemaVersion: 1,
    identity,
    workEpisodeId: null,
    revision: 0,
    state: 'idle',
    reason: 'no_activity',
    basis: 'inferred',
    observedAt: null,
    lastSeenAt: null,
    dependencies: [],
    evidenceIds: [],
    producerSequences: {},
    resume: null,
  });
}

const waitState = (reason: SessionWorkStatus['reason']): SessionWorkState =>
  reason === 'agent_reply'
    ? 'waiting_on_agent'
    : reason.startsWith('pr_')
      ? 'waiting_on_pr'
      : 'needs_attention';
const pending = (value: SessionWorkStatus) => value.dependencies.filter((d) => d.state === 'pending');
const sameIdentity = (a: SessionWorkStatus['identity'], b: SessionWorkStatus['identity']) =>
  a.organizationId === b.organizationId &&
  a.workspaceId === b.workspaceId &&
  a.source === b.source &&
  a.sessionId === b.sessionId;

/** Pure reference transition. Persistence must commit the returned revision atomically.
 * Native event interpretation, PR-head validation, and inference are separate producers.
 */
export function transitionSessionWorkStatus(
  previous: SessionWorkStatus,
  input: unknown
): {
  status: SessionWorkStatus;
  outcome:
    | 'applied'
    | 'invalid'
    | 'wrong_session'
    | 'duplicate'
    | 'conflict'
    | 'wrong_episode'
    | 'archived'
    | 'invalid_transition';
} {
  const parsed = sessionWorkEvent.safeParse(input);
  const unchanged = (
    outcome: Exclude<ReturnType<typeof transitionSessionWorkStatus>['outcome'], 'applied'>
  ) => ({ status: previous, outcome });
  if (!parsed.success) return unchanged('invalid');
  const e = parsed.data;
  if (!sameIdentity(previous.identity, e.identity)) return unchanged('wrong_session');
  if (
    Object.hasOwn(previous.producerSequences, e.producerId) &&
    e.sequence <= previous.producerSequences[e.producerId]!
  )
    return unchanged('duplicate');
  if (e.expectedRevision !== previous.revision) return unchanged('conflict');
  if (e.workEpisodeId === null && !['archive', 'unarchive', 'heartbeat'].includes(e.kind))
    return unchanged('invalid_transition');
  if (previous.revision === Number.MAX_SAFE_INTEGER) return unchanged('invalid_transition');
  if (e.kind !== 'start' && e.workEpisodeId !== previous.workEpisodeId) return unchanged('wrong_episode');
  if (previous.state === 'archived' && !['unarchive', 'heartbeat'].includes(e.kind))
    return unchanged('archived');
  const next: SessionWorkStatus = structuredClone(previous);
  switch (e.kind) {
    case 'start':
      if (e.workEpisodeId === null) return unchanged('invalid_transition');
      if (e.workEpisodeId === previous.workEpisodeId) return unchanged('invalid_transition');
      next.workEpisodeId = e.workEpisodeId;
      next.state = 'working';
      next.reason = 'thinking';
      next.dependencies = [];
      next.resume = null;
      break;
    case 'activity':
      if (previous.state === 'done') return unchanged('invalid_transition');
      next.state = 'working';
      next.reason = e.reason;
      break;
    case 'wait': {
      if (previous.state === 'done') return unchanged('invalid_transition');
      const kind = e.reason === 'agent_reply' ? 'agent' : e.reason.startsWith('pr_') ? 'pr' : 'human';
      if (
        !e.dependencies.some((d) => d.kind === kind && d.state === 'pending') ||
        new Set(e.dependencies.map((d) => d.id)).size !== e.dependencies.length
      )
        return unchanged('invalid_transition');
      next.state = waitState(e.reason);
      next.reason = e.reason;
      // A new wait cannot erase another producer's outstanding dependency.
      for (const dependency of e.dependencies) {
        const existing = next.dependencies.find((d) => d.id === dependency.id);
        if (
          existing &&
          (existing.kind !== dependency.kind ||
            existing.target !== dependency.target ||
            existing.state !== dependency.state)
        )
          return unchanged('invalid_transition');
        if (!existing) next.dependencies.push(dependency);
      }
      break;
    }
    case 'resolve_dependency':
      if (!next.dependencies.some((d) => d.id === e.dependencyId && d.state === 'pending'))
        return unchanged('invalid_transition');
      next.dependencies = next.dependencies.map((d) =>
        d.id === e.dependencyId ? { ...d, state: 'resolved' } : d
      );
      if (previous.state !== 'working') selectWait(next);
      break;
    case 'turn_finished':
      if (previous.state === 'working') {
        next.state = 'idle';
        next.reason = 'turn_finished';
        if (pending(next).length) selectWait(next);
      }
      break;
    case 'complete':
      if (pending(next).length || (e.reason === 'merged' && !next.dependencies.some((d) => d.kind === 'pr')))
        return unchanged('invalid_transition');
      next.state = 'done';
      next.reason = e.reason;
      break;
    case 'archive':
      next.resume = {
        state: previous.state,
        reason: previous.reason,
        basis: previous.basis,
      };
      next.state = 'archived';
      next.reason = 'archived';
      break;
    case 'unarchive':
      if (previous.state !== 'archived' || !previous.resume || previous.resume.state === 'archived')
        return unchanged('invalid_transition');
      next.state = previous.resume.state;
      next.reason = previous.resume.reason;
      next.resume = null;
      break;
    case 'heartbeat':
      break;
  }
  next.revision++;
  next.producerSequences = {
    ...next.producerSequences,
    [e.producerId]: e.sequence,
  };
  // Older wall clocks cannot make a session less fresh. They also do not order work.
  next.lastSeenAt = latestInstant(previous.lastSeenAt, e.observedAt);
  if (
    e.kind !== 'heartbeat' &&
    !(e.kind === 'turn_finished' && next.state === previous.state && next.reason === previous.reason)
  ) {
    next.observedAt = e.observedAt;
    next.basis = e.kind === 'unarchive' ? previous.resume!.basis : 'observed';
    next.evidenceIds = [e.eventId];
  }
  return { status: next, outcome: 'applied' };
}

function latestInstant(a: string | null, b: string) {
  return a && Date.parse(a) > Date.parse(b) ? a : b;
}
function selectWait(status: SessionWorkStatus) {
  const waiting = pending(status);
  const kind = ['human', 'agent', 'pr'].find((k) => waiting.some((d) => d.kind === k));
  const currentKind =
    status.state === 'needs_attention'
      ? 'human'
      : status.state === 'waiting_on_agent'
        ? 'agent'
        : status.state === 'waiting_on_pr'
          ? 'pr'
          : null;
  if (kind && kind === currentKind) return;
  const reason =
    kind === 'human'
      ? 'human_input'
      : kind === 'agent'
        ? 'agent_reply'
        : kind === 'pr'
          ? 'pr_review'
          : 'dependencies_resolved';
  status.state = kind ? waitState(reason) : 'idle';
  status.reason = reason;
}

/** An unsupported server version/read failure preserves the last supported snapshot. */
export function readSessionWorkStatus(input: unknown, previous: SessionWorkStatus) {
  const parsed = sessionWorkStatus.safeParse(input);
  if (
    !parsed.success ||
    !sameIdentity(previous.identity, parsed.data.identity) ||
    parsed.data.revision < previous.revision
  )
    return { status: previous, stale: true };
  return { status: parsed.data, stale: false };
}
