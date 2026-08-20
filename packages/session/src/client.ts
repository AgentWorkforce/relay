import { randomUUID } from 'node:crypto';

import { RelayCast, type SessionMessagesResult } from '@relaycast/sdk';

import { buildReplayContextPrompt, buildReplayTimeline } from './replay.js';
import { buildContextPrompt, determineResumeMode } from './resume.js';
import type {
  ReplayConversationResult,
  ReplaySessionResult,
  RelaySession,
  ResumeSessionResult,
  SessionActor,
  SessionCli,
  SteeringEvent,
  Turn,
  TurnActorRole,
  TurnRole,
} from './types.js';

export interface SessionClientOptions {
  /** Relayhistory base URL. Defaults to RELAYHISTORY_URL. */
  baseUrl?: string;
  /** Relayhistory bearer token. Defaults to Relayhistory/Relay token env vars. */
  token?: string;
  /** CLI receiving resumed sessions. Defaults to RELAY_SESSION_CLI when set. */
  cli?: SessionCli;
  /** Node performing steering operations. */
  node?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  randomUUID?: () => string;
  /** Observes best-effort writeTurn failures. */
  onWriteError?: (error: Error) => void;
  /** Bound on a single Relayhistory HTTP round trip, in milliseconds. Defaults to 15000. */
  timeoutMs?: number;
  /** Relaycast workspace key used for the workspace-wide replay join. */
  workspaceKey?: string;
  /** Relaycast HTTP base URL. Defaults to RELAY_BASE_URL or the Relaycast SDK default. */
  relaycastBaseUrl?: string;
  /** Injectable Relaycast session reader, primarily for adapters and tests. */
  relaycast?: RelaycastSessionReader | null;
}

export interface RelaycastSessionReader {
  bySessionRef(
    sessionRef: string,
    options?: { limit?: number; after?: string }
  ): Promise<SessionMessagesResult>;
}

export interface CreateSessionInput {
  cli: SessionCli;
  node: string;
  owner: SessionActor;
  /**
   * Harness-native session id (e.g. Claude's own session id) to persist at
   * creation time. Required for `determineResumeMode` to ever choose the
   * native Claude-to-Claude continuation path instead of journal injection —
   * there is no way to attach it after the fact.
   */
  nativeResumeId?: string;
}

export interface WriteTurnInput {
  sessionId: string;
  role: TurnRole;
  content: string;
  actor: SessionActor;
}

export interface RecordSteeringInput {
  sessionId: string;
  actor: SessionActor;
  relayMessageId: string;
}

interface RelayhistoryTurn {
  turnIndex: number;
  role: string;
  content: string;
  actorName: string;
  actorRole: string;
  metadata?: unknown;
  ts: string;
}

interface SessionState {
  session: RelaySession;
  turns: Turn[];
  nextTurnIndex: number;
}

const SESSION_CLIS = new Set<SessionCli>(['claude', 'codex', 'opencode', 'grok', 'cursor']);
const TURN_ROLES = new Set<TurnRole>(['user', 'assistant', 'system']);
const TURN_ACTOR_ROLES = new Set<TurnActorRole>(['owner', 'steerer']);
const STEERING_ACTIONS = new Set<SteeringEvent['action']>(['session_started', 'took_control']);
const SLASH_CHAR_CODE = '/'.charCodeAt(0);
/** Default bound on a single Relayhistory HTTP round trip. */
const DEFAULT_TIMEOUT_MS = 15_000;
const RELAYCAST_SESSION_PAGE_LIMIT = 500;
/** Retries for a turn-index write that a concurrent writer clobbered. See `#postTurnAtNextIndex`. */
const MAX_WRITE_CONFLICT_RETRIES = 3;

/** Relayhistory-backed client for portable session identity, turns, and attribution. */
export class SessionClient {
  readonly #baseUrl: string | undefined;
  readonly #token: string | undefined;
  readonly #cli: SessionCli | undefined;
  readonly #node: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;
  readonly #randomUUID: () => string;
  readonly #onWriteError: ((error: Error) => void) | undefined;
  readonly #timeoutMs: number;
  readonly #relaycast: RelaycastSessionReader | undefined;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(options: SessionClientOptions = {}) {
    // Blank strings are not absent: `SessionClientOptions.baseUrl: ''` (a
    // common shape for an unset CLI flag) must not shadow a real
    // RELAYHISTORY_URL, and a blank token/node must not silently disable
    // auth or persist an invalid nodeId. `??` alone only catches
    // null/undefined, so every option and env fallback here goes through
    // trimOrUndefined first.
    this.#baseUrl = normalizeBaseUrl(
      trimOrUndefined(options.baseUrl) ?? trimOrUndefined(process.env.RELAYHISTORY_URL)
    );
    this.#token =
      trimOrUndefined(options.token) ??
      trimOrUndefined(process.env.RELAYHISTORY_TOKEN) ??
      trimOrUndefined(process.env.RELAYHISTORY_ACCESS_TOKEN) ??
      trimOrUndefined(process.env.RELAY_AGENT_TOKEN);
    this.#cli =
      sessionCli(trimOrUndefined(options.cli)) ?? sessionCli(trimOrUndefined(process.env.RELAY_SESSION_CLI));
    this.#node =
      trimOrUndefined(options.node) ??
      trimOrUndefined(process.env.RELAY_ORIGIN_NODE) ??
      trimOrUndefined(process.env.HOSTNAME);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#randomUUID = options.randomUUID ?? randomUUID;
    this.#onWriteError = options.onWriteError;
    this.#timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    const workspaceKey =
      trimOrUndefined(options.workspaceKey) ??
      trimOrUndefined(process.env.RELAY_WORKSPACE_KEY) ??
      trimOrUndefined(process.env.AGENT_RELAY_WORKSPACE_KEY);
    const relaycastBaseUrl =
      trimOrUndefined(options.relaycastBaseUrl) ?? trimOrUndefined(process.env.RELAY_BASE_URL);
    this.#relaycast =
      options.relaycast === null
        ? undefined
        : (options.relaycast ??
          (workspaceKey
            ? new RelayCast({
                apiKey: workspaceKey,
                ...(relaycastBaseUrl ? { baseUrl: relaycastBaseUrl } : {}),
              }).messages
            : undefined));
  }

  async createSession(input: CreateSessionInput): Promise<RelaySession> {
    assertActor(input.owner, 'owner');
    assertSafeValue(input.node, 'node');
    if (input.nativeResumeId !== undefined) assertSafeValue(input.nativeResumeId, 'nativeResumeId');

    const sessionId = this.#randomUUID();
    const timestamp = this.#now().toISOString();
    const session: RelaySession = {
      sessionId,
      owner: cloneActor(input.owner),
      activeActor: cloneActor(input.owner),
      steeringLog: [
        {
          actorId: input.owner.userId,
          action: 'session_started',
          relayMessageId: `relay-session:${sessionId}`,
          timestamp,
          nodeId: input.node,
        },
      ],
      originCli: input.cli,
      originNode: input.node,
      ...(input.nativeResumeId ? { nativeResumeId: input.nativeResumeId } : {}),
      createdAt: timestamp,
    };

    await this.#postTurn(session, {
      turnIndex: 0,
      role: 'system',
      content: `[Relay session started by ${input.owner.displayName}]`,
      actor: input.owner,
      actorRole: 'owner',
      timestamp,
      metadata: sessionMetadata(session),
    });

    return cloneSession(session);
  }

  /**
   * Best-effort journal write. The returned promise can be awaited for local
   * ordering, but backend failures are reported through onWriteError instead
   * of interrupting the harness that produced the turn.
   */
  async writeTurn(input: WriteTurnInput): Promise<void> {
    assertActor(input.actor, 'actor');
    try {
      await this.#serialize(input.sessionId, () =>
        this.#postTurnAtNextIndex(input.sessionId, (state) => {
          const actorRole: TurnActorRole =
            input.actor.userId === state.session.owner.userId ? 'owner' : 'steerer';
          return {
            session: state.session,
            turn: {
              turnIndex: state.nextTurnIndex,
              role: input.role,
              content: input.content,
              actor: input.actor,
              actorRole,
              timestamp: this.#now().toISOString(),
              metadata: sessionMetadata(state.session),
            },
          };
        })
      );
    } catch (error) {
      // Isolate the observer: a throwing onWriteError must not make this
      // best-effort write reject anyway, which would defeat its own contract.
      try {
        this.#onWriteError?.(asError(error));
      } catch {
        // Swallowed by design — see above.
      }
    }
  }

  async resumeSession(sessionId: string): Promise<ResumeSessionResult> {
    // Fetch state directly rather than through `replaySession` — that
    // builds a `contextPrompt` unconditionally, which `determineResumeMode`
    // duplicates below for an inject resume and a native resume discards
    // outright. Serializing the journal at most once here avoids both.
    const state = await this.#fetchState(sessionId);
    const session = cloneSession(state.session);
    const turns = state.turns.map(cloneTurn);
    return {
      session,
      turns,
      resume: determineResumeMode({
        session,
        turns,
        targetCli: this.#cli ?? session.originCli,
      }),
    };
  }

  /** Reconstruct a completed session across Relayhistory and Relaycast without mutating its harness. */
  async replaySession(sessionId: string): Promise<ReplaySessionResult> {
    const [state, conversation] = await Promise.all([
      this.#fetchState(sessionId),
      this.#fetchConversation(sessionId),
    ]);
    const session = cloneSession(state.session);
    const turns = state.turns.map(cloneTurn);
    const timeline = buildReplayTimeline(turns, conversation);
    return {
      session,
      turns,
      conversation,
      timeline,
      contextPrompt: buildReplayContextPrompt(session, timeline, conversation),
    };
  }

  async recordSteering(input: RecordSteeringInput): Promise<void> {
    assertActor(input.actor, 'actor');
    assertSafeValue(input.relayMessageId, 'relayMessageId');

    await this.#serialize(input.sessionId, () =>
      this.#postTurnAtNextIndex(input.sessionId, (state) => {
        const timestamp = this.#now().toISOString();
        const event: SteeringEvent = {
          actorId: input.actor.userId,
          action: 'took_control',
          relayMessageId: input.relayMessageId,
          timestamp,
          nodeId: this.#node ?? state.session.originNode,
        };
        const session: RelaySession = {
          ...cloneSession(state.session),
          activeActor: cloneActor(input.actor),
          steeringLog: [...state.session.steeringLog, event],
        };

        return {
          session,
          turn: {
            turnIndex: state.nextTurnIndex,
            role: 'system',
            content: `[Relay control taken by ${input.actor.displayName}]`,
            actor: input.actor,
            actorRole: input.actor.userId === session.owner.userId ? 'owner' : 'steerer',
            timestamp,
            metadata: sessionMetadata(session),
          },
        };
      })
    );
  }

  async getGitTrailers(sessionId: string): Promise<string[]> {
    const { session } = await this.#fetchState(sessionId);
    const coauthors = uniqueActors([session.owner, session.activeActor]).map(
      (actor) => `Co-authored-by: ${actor.displayName} <${actor.email}>`
    );

    return [
      ...coauthors,
      `Relay-Session-Id: ${session.sessionId}`,
      `Relay-Session-Owner-Id: ${session.owner.userId}`,
      ...(session.activeActor ? [`Relay-Active-Actor-Id: ${session.activeActor.userId}`] : []),
      `Relay-Origin-Cli: ${session.originCli}`,
      `Relay-Origin-Node: ${session.originNode}`,
    ];
  }

  async #fetchState(sessionId: string): Promise<SessionState> {
    assertSafeValue(sessionId, 'sessionId');
    const payload = await this.#request(`/sessions/${encodeURIComponent(sessionId)}/turns`);
    const root = record(payload);
    const rawTurns = Array.isArray(root?.turns) ? root.turns : [];
    const wireTurns = rawTurns.map(parseWireTurn).sort((a, b) => a.turnIndex - b.turnIndex);
    if (wireTurns.length === 0) {
      throw new Error(`Relayhistory session ${sessionId} has no turns`);
    }
    for (let index = 1; index < wireTurns.length; index += 1) {
      if (wireTurns[index]!.turnIndex === wireTurns[index - 1]!.turnIndex) {
        throw new Error(
          `Relayhistory session ${sessionId} has duplicate turnIndex ${wireTurns[index]!.turnIndex}`
        );
      }
    }

    const session = sessionFromTurns(sessionId, wireTurns);
    const turns = wireTurns.map((turn) => publicTurn(turn, session));
    return {
      session,
      turns,
      nextTurnIndex: Math.max(...wireTurns.map((turn) => turn.turnIndex)) + 1,
    };
  }

  /**
   * Fetch state, build a turn at the resulting `nextTurnIndex`, and post it —
   * then verify the post actually landed instead of trusting the request
   * succeeded.
   *
   * `#serialize` only orders writes made through *this* instance. Two
   * `SessionClient`s on different machines/processes (the package's core
   * cross-machine scenario) can each fetch the same `nextTurnIndex` and
   * both POST it; the backend replaces-by-index, so whichever POST lands
   * second silently destroys the first turn with no error from either
   * caller. There is no way to prevent that outright without a
   * conditional-write or server-assigned-index contract from Relayhistory,
   * which this client doesn't control — but a client alone *can* detect
   * that its own write didn't survive (by reading it back) and retry into
   * a fresh index instead of returning success for a turn that's already
   * gone.
   *
   * This closes the gap for the common case — two writers racing once —
   * and is bounded so it can't retry forever under sustained contention.
   * It's a mitigation, not a guarantee: a write that lands *after* our
   * verification read still wins silently, same as any optimistic-retry
   * scheme without a real compare-and-swap primitive underneath it.
   */
  async #postTurnAtNextIndex(
    sessionId: string,
    build: (state: SessionState) => { session: RelaySession; turn: Turn },
    attempt = 0
  ): Promise<void> {
    const state = await this.#fetchState(sessionId);
    const { session, turn } = build(state);
    await this.#postTurn(session, turn);

    const verify = await this.#fetchState(sessionId);
    const stored = verify.turns.find((candidate) => candidate.turnIndex === turn.turnIndex);
    const survived =
      !!stored &&
      stored.role === turn.role &&
      stored.content === turn.content &&
      stored.actorRole === turn.actorRole &&
      stored.actor.userId === turn.actor.userId &&
      stored.actor.email === turn.actor.email &&
      stored.actor.displayName === turn.actor.displayName &&
      stored.timestamp === turn.timestamp;

    if (!survived) {
      if (attempt >= MAX_WRITE_CONFLICT_RETRIES) {
        throw new Error(
          `Relayhistory turn ${turn.turnIndex} for session ${sessionId} was overwritten by a ` +
            `concurrent writer after ${MAX_WRITE_CONFLICT_RETRIES + 1} attempts`
        );
      }
      return this.#postTurnAtNextIndex(sessionId, build, attempt + 1);
    }
  }

  async #postTurn(session: RelaySession, turn: Turn): Promise<void> {
    await this.#request(`/sessions/${encodeURIComponent(session.sessionId)}/turns`, {
      method: 'POST',
      body: JSON.stringify({
        sessionOwner: session.owner.userId,
        turns: [
          {
            turnIndex: turn.turnIndex,
            role: turn.role,
            content: turn.content,
            actorName: turn.actor.displayName,
            actorRole: turn.actorRole,
            metadata: {
              ...turn.metadata,
              actor: turn.actor,
              relaySession: session,
            },
            ts: turn.timestamp,
          },
        ],
      }),
    });
  }

  async #fetchConversation(sessionId: string): Promise<ReplayConversationResult> {
    if (!this.#relaycast) {
      return unavailableConversation(sessionId, 'workspace_key_unavailable');
    }

    const seenCursors = new Set<string>();
    const seenMessages = new Set<string>();
    const messages: SessionMessagesResult['messages'] = [];
    let after: string | undefined;
    let first: SessionMessagesResult | undefined;
    let latest: SessionMessagesResult | undefined;
    let availability: SessionMessagesResult['availability'] = 'retained';
    let reason: SessionMessagesResult['reason'];

    try {
      for (;;) {
        const page = await this.#readConversationPage(sessionId, after);
        if (page.sessionRef !== sessionId) {
          return this.#partialConversation(sessionId, 'response_invalid', messages, first, latest);
        }
        if (page.availability === 'unknown') {
          return {
            ...structuredClone(page),
            messages: [],
            page: { nextCursor: null, hasMore: false },
          };
        }
        if (page.availability === 'aged_out') {
          return {
            ...structuredClone(page),
            messages: [],
            page: { nextCursor: null, hasMore: false },
          };
        }

        first ??= page;
        latest = page;
        if (availabilityRank(page.availability) > availabilityRank(availability)) {
          availability = page.availability;
          reason = page.reason;
        } else if (!reason && page.reason) {
          reason = page.reason;
        }
        for (const message of page.messages) {
          if (!seenMessages.has(message.id)) {
            seenMessages.add(message.id);
            messages.push(structuredClone(message));
          }
        }

        if (!page.page.hasMore) break;
        const cursor = page.page.nextCursor;
        if (!cursor || seenCursors.has(cursor)) {
          // Preserve everything fetched so far: an incomplete paginator
          // must not silently discard the earlier valid pages, or replay
          // becomes empty for a session that partially came back.
          return this.#partialConversation(sessionId, 'pagination_incomplete', messages, first, latest);
        }
        seenCursors.add(cursor);
        after = cursor;
      }
    } catch {
      return this.#partialConversation(sessionId, 'query_failed', messages, first, latest);
    }

    if (!first || !latest) {
      return unavailableConversation(sessionId, 'response_invalid');
    }
    return {
      sessionRef: sessionId,
      availability,
      ...(reason ? { reason } : {}),
      retention: structuredClone(latest.retention),
      sessionStartedAt: first.sessionStartedAt,
      sessionLastMessageAt: latest.sessionLastMessageAt,
      messages,
      page: { nextCursor: null, hasMore: false },
    };
  }

  /**
   * Bound a single Relaycast page read at the same budget `#request` uses
   * for Relayhistory. Without this a `RelaycastSessionReader.bySessionRef`
   * implementation that never resolves would leave `replaySession` pending
   * forever — the SDK's own `requestTimeoutMs` covers HTTP, not injected
   * readers, and the surrounding `catch` cannot run for a promise that
   * never settles.
   */
  async #readConversationPage(sessionId: string, after: string | undefined): Promise<SessionMessagesResult> {
    if (!this.#relaycast) {
      throw new Error('Relaycast session reader is not configured');
    }
    const options = { limit: RELAYCAST_SESSION_PAGE_LIMIT, ...(after ? { after } : {}) };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.#relaycast.bySessionRef(sessionId, options),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Relaycast bySessionRef timed out after ${this.#timeoutMs}ms`)),
            this.#timeoutMs
          );
        }),
      ]);
    } finally {
      // Leaving this pending would keep the harness process alive for the
      // full timeout after every successful page read.
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Emit an incomplete-but-partial conversation so a later page failure
   * cannot erase every valid earlier page. Falls back to a fully
   * unavailable result when nothing was fetched at all.
   */
  #partialConversation(
    sessionId: string,
    reason: 'pagination_incomplete' | 'query_failed' | 'response_invalid',
    messages: SessionMessagesResult['messages'],
    first: SessionMessagesResult | undefined,
    latest: SessionMessagesResult | undefined
  ): ReplayConversationResult {
    if (!first || !latest || messages.length === 0) {
      return unavailableConversation(sessionId, reason);
    }
    return {
      sessionRef: sessionId,
      availability: 'unknown',
      reason,
      retention: structuredClone(latest.retention),
      sessionStartedAt: first.sessionStartedAt,
      sessionLastMessageAt: latest.sessionLastMessageAt,
      messages,
      page: { nextCursor: null, hasMore: false },
    };
  }

  async #request(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!this.#baseUrl) {
      throw new Error('RELAYHISTORY_URL is required to use @agent-relay/session');
    }

    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      // Bound every round trip so a stalled connection can't hang the
      // harness awaiting createSession/resumeSession/recordSteering/etc
      // indefinitely. Callers can still supply their own signal.
      signal: init.signal ?? AbortSignal.timeout(this.#timeoutMs),
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`Relayhistory request failed (${response.status}) for ${path}`);
    }
    if (response.status === 204) return undefined;
    return response.json();
  }

  #serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.#queues.get(sessionId) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.#queues.set(sessionId, tail);
    void tail.finally(() => {
      if (this.#queues.get(sessionId) === tail) this.#queues.delete(sessionId);
    });
    return result;
  }
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const baseUrl = stripTrailingSlashes(value?.trim());
  if (!baseUrl) return undefined;
  return baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
}

function unavailableConversation(
  sessionRef: string,
  reason: 'workspace_key_unavailable' | 'pagination_incomplete' | 'query_failed' | 'response_invalid'
): ReplayConversationResult {
  return {
    sessionRef,
    availability: 'unknown',
    reason,
    retention: {
      policy: 'unknown',
      messageTtlDays: null,
      retainedSince: null,
      source: 'unknown',
      reason: 'boundary_unavailable',
    },
    sessionStartedAt: null,
    sessionLastMessageAt: null,
    messages: [],
    page: { nextCursor: null, hasMore: false },
  };
}

function availabilityRank(value: SessionMessagesResult['availability']): number {
  switch (value) {
    case 'retained':
      return 0;
    case 'partial':
      return 1;
    case 'aged_out':
      return 2;
    case 'unknown':
      return 3;
  }
}

/** A blank or whitespace-only string is treated as absent, not as a value. */
function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Clamp an untrusted `timeoutMs` option to a value `AbortSignal.timeout`
 * accepts. A fractional, negative, non-finite, or oversized number would
 * otherwise throw synchronously (negative/NaN) or exceed Node's timer range
 * (`setTimeout`'s ~2^31-1 ms ceiling) inside every `#request` call.
 */
function normalizeTimeoutMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.max(1, Math.min(2_147_483_647, Math.floor(value)));
}

/**
 * Trim trailing `/` characters without a regex. A quantified trailing-slash
 * pattern on library-supplied input trips static ReDoS scanners even though
 * `\/+$` has no backtracking ambiguity; a manual scan sidesteps the question
 * entirely and stays linear by construction.
 */
function stripTrailingSlashes(value: string | undefined): string | undefined {
  if (!value) return value;
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === SLASH_CHAR_CODE) end -= 1;
  return value.slice(0, end);
}

function sessionMetadata(session: RelaySession): Record<string, unknown> {
  return {
    relaySession: session,
    originNode: session.originNode,
    ...(session.originCli === 'claude' || session.originCli === 'codex'
      ? { nativeCli: session.originCli }
      : {}),
    ...(session.nativeResumeId ? { nativeResumeId: session.nativeResumeId } : {}),
  };
}

function sessionFromTurns(sessionId: string, turns: readonly RelayhistoryTurn[]): RelaySession {
  let session: RelaySession | undefined;
  let canonicalOwner: SessionActor | undefined;
  let nativeResumeId: string | undefined;

  // Oldest-first: the earliest valid snapshot's owner is canonical.
  // RelaySession.owner is documented as immutable — a later turn's
  // `relaySession.owner` differing (corruption, or a forged/foreign write)
  // must not be able to silently move who git trailers and
  // owner-vs-steerer attribution point at.
  for (const turn of turns) {
    if (canonicalOwner) break;
    const parsed = parseSession(record(turn.metadata)?.relaySession);
    if (parsed && parsed.sessionId === sessionId) canonicalOwner = parsed.owner;
  }

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const metadata = record(turns[index]?.metadata);
    nativeResumeId ??= stringValue(metadata?.nativeResumeId);
    if (!session) {
      const parsed = parseSession(metadata?.relaySession);
      if (parsed?.sessionId === sessionId) session = parsed;
    }
  }

  if (!session || !canonicalOwner) {
    throw new Error(`Relayhistory session ${sessionId} is missing Relay identity metadata`);
  }
  return cloneSession({
    ...session,
    owner: canonicalOwner,
    ...(nativeResumeId ? { nativeResumeId } : {}),
  });
}

function parseSession(value: unknown): RelaySession | undefined {
  const input = record(value);
  const owner = parseActor(input?.owner);
  const activeActor = input?.activeActor === null ? null : parseActor(input?.activeActor);
  const originCli = sessionCli(input?.originCli);
  const rawLog = Array.isArray(input?.steeringLog) ? input.steeringLog : undefined;
  if (
    !input ||
    !nonEmptyString(input.sessionId) ||
    !owner ||
    activeActor === undefined ||
    !rawLog ||
    !originCli ||
    !nonEmptyString(input.originNode) ||
    !nonEmptyString(input.createdAt)
  ) {
    return undefined;
  }

  const steeringLog = rawLog.map(parseSteeringEvent);
  if (steeringLog.some((event) => !event)) return undefined;
  const nativeResumeId = stringValue(input.nativeResumeId);
  return {
    sessionId: input.sessionId as string,
    owner,
    activeActor,
    steeringLog: steeringLog as SteeringEvent[],
    originCli,
    originNode: input.originNode as string,
    ...(nativeResumeId ? { nativeResumeId } : {}),
    createdAt: input.createdAt as string,
  };
}

function parseSteeringEvent(value: unknown): SteeringEvent | undefined {
  const input = record(value);
  const action = input?.action;
  if (
    !input ||
    !nonEmptyString(input.actorId) ||
    typeof action !== 'string' ||
    !STEERING_ACTIONS.has(action as SteeringEvent['action']) ||
    typeof input.relayMessageId !== 'string' ||
    !nonEmptyString(input.timestamp) ||
    !nonEmptyString(input.nodeId)
  ) {
    return undefined;
  }
  return {
    actorId: input.actorId,
    action: action as SteeringEvent['action'],
    relayMessageId: input.relayMessageId,
    timestamp: input.timestamp,
    nodeId: input.nodeId,
  };
}

function parseWireTurn(value: unknown): RelayhistoryTurn {
  const input = record(value);
  if (
    !input ||
    !Number.isInteger(input.turnIndex) ||
    (input.turnIndex as number) < 0 ||
    typeof input.role !== 'string' ||
    !TURN_ROLES.has(input.role as TurnRole) ||
    typeof input.content !== 'string' ||
    typeof input.actorName !== 'string' ||
    typeof input.actorRole !== 'string' ||
    !TURN_ACTOR_ROLES.has(input.actorRole as TurnActorRole) ||
    !nonEmptyString(input.ts)
  ) {
    throw new Error('Relayhistory returned an invalid session turn');
  }
  return {
    turnIndex: input.turnIndex as number,
    role: input.role,
    content: input.content,
    actorName: input.actorName,
    actorRole: input.actorRole,
    metadata: input.metadata,
    ts: input.ts,
  };
}

function publicTurn(turn: RelayhistoryTurn, session: RelaySession): Turn {
  const metadata = record(turn.metadata);
  const actor =
    parseActor(metadata?.actor) ??
    (turn.actorRole === 'owner'
      ? cloneActor(session.owner)
      : {
          userId: turn.actorName,
          email: '',
          displayName: turn.actorName,
        });
  return {
    turnIndex: turn.turnIndex,
    role: turn.role as TurnRole,
    content: turn.content,
    actor,
    actorRole: turn.actorRole === 'owner' ? 'owner' : 'steerer',
    timestamp: turn.ts,
    ...(metadata ? { metadata } : {}),
  };
}

function parseActor(value: unknown): SessionActor | undefined {
  const input = record(value);
  if (
    !input ||
    !nonEmptyString(input.userId) ||
    typeof input.email !== 'string' ||
    // email may legitimately be '' (see publicTurn's steerer fallback above),
    // so this can't use nonEmptyString — but it still must reject embedded
    // CR/LF: getGitTrailers interpolates it into a `Co-authored-by:` line,
    // and this value round-trips through Relayhistory rather than being
    // produced locally, so a newline here forges extra git trailers.
    /[\r\n]/u.test(input.email) ||
    !nonEmptyString(input.displayName)
  ) {
    return undefined;
  }
  return {
    userId: input.userId,
    email: input.email,
    displayName: input.displayName,
  };
}

function uniqueActors(actors: Array<SessionActor | null>): SessionActor[] {
  const seen = new Set<string>();
  return actors.filter((actor): actor is SessionActor => {
    if (!actor?.email || seen.has(actor.userId)) return false;
    seen.add(actor.userId);
    return true;
  });
}

function cloneActor(actor: SessionActor): SessionActor {
  return { ...actor };
}

function cloneSession(session: RelaySession): RelaySession {
  return {
    ...session,
    owner: cloneActor(session.owner),
    activeActor: session.activeActor ? cloneActor(session.activeActor) : null,
    steeringLog: session.steeringLog.map((event) => ({ ...event })),
  };
}

function cloneTurn(turn: Turn): Turn {
  return {
    ...turn,
    actor: cloneActor(turn.actor),
    ...(turn.metadata ? { metadata: structuredClone(turn.metadata) } : {}),
  };
}

function sessionCli(value: unknown): SessionCli | undefined {
  return typeof value === 'string' && SESSION_CLIS.has(value as SessionCli)
    ? (value as SessionCli)
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\r\n]/u.test(value);
}

function stringValue(value: unknown): string | undefined {
  return nonEmptyString(value) ? value : undefined;
}

function assertActor(actor: SessionActor, label: string): void {
  assertSafeValue(actor.userId, `${label}.userId`);
  assertSafeValue(actor.email, `${label}.email`);
  assertSafeValue(actor.displayName, `${label}.displayName`);
}

function assertSafeValue(value: string, label: string): void {
  if (!value.trim() || /[\r\n]/u.test(value)) {
    throw new Error(`${label} must be a non-empty single-line string`);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
