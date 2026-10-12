import { readFile } from 'node:fs/promises';
import { writeAtomic } from './paths.js';

// The ledger mirrors the desktop probe's connect-sessions.json (relay-desktop
// probe/src/relay/connect.rs): one Connect per session target, and per
// delivery a pending, handled (delivered or in doubt) or failed record keyed
// by `agent_id:delivery_id`. Only the daemon writes it.

export const RETRY_MIN_MS = 5_000;
export const RETRY_MAX_MS = 30_000;
export const HANDOFF_TTL_MS = 60 * 60 * 1_000;
export const JOIN_ATTEMPT_TTL_MS = 15 * 60 * 1_000;
const OUTCOMES_KEPT = 64;

export function handoffTtlMs(value) {
  const seconds = Number.parseInt(value ?? '', 10);
  return Number.isInteger(seconds) && seconds >= 60 && seconds <= 24 * 60 * 60
    ? seconds * 1_000
    : HANDOFF_TTL_MS;
}

export function targetKey(target) {
  return `${target.kind}:${target.id}`;
}

function empty() {
  return {
    version: 1,
    sessions: {},
    join_attempts: {},
    pending: {},
    pending_delivery: {},
    handled: {},
    failures: {},
    notices: [],
    outcomes: [],
  };
}

export class RelayState {
  constructor(path, data = empty(), { now = Date.now, write = writeAtomic } = {}) {
    this.path = path;
    this.data = data;
    this.now = now;
    this.write = write;
  }

  static async load(path, options = {}) {
    let data = empty();
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      if (parsed && parsed.version === 1) data = { ...empty(), ...parsed };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`Could not read ${path}: ${error.message}`);
    }
    return new RelayState(path, data, options);
  }

  async persist() {
    await this.write(this.path, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  // Sessions -----------------------------------------------------------------

  session(target) {
    return this.data.sessions[targetKey(target)] || null;
  }

  sessions() {
    return Object.values(this.data.sessions);
  }

  async insertSession(session) {
    const key = targetKey(session.target);
    const previous = this.data.sessions[key];
    const previousAttempt = this.data.join_attempts[key];
    this.data.sessions[key] = session;
    delete this.data.join_attempts[key];
    try {
      await this.persist();
    } catch (error) {
      if (previous) this.data.sessions[key] = previous;
      else delete this.data.sessions[key];
      if (previousAttempt) this.data.join_attempts[key] = previousAttempt;
      throw error;
    }
  }

  /** Removes the session and every ledger entry for its credential. */
  async removeSession(target, agentId) {
    const key = targetKey(target);
    const current = this.data.sessions[key];
    if (!current || (agentId && current.agent_id !== agentId)) return null;
    delete this.data.sessions[key];
    const prefix = `${current.agent_id}:`;
    for (const map of ['pending', 'pending_delivery', 'handled', 'failures']) {
      for (const ledger of Object.keys(this.data[map])) {
        if (ledger.startsWith(prefix)) delete this.data[map][ledger];
      }
    }
    await this.persist();
    return current;
  }

  async observeParticipant(session, name) {
    const current = this.session(session.target);
    if (!current || current.agent_id !== session.agent_id) return;
    const known = current.participants.some((p) => p.agent_name === name);
    if (known || current.observed_participants.includes(name) || name === current.agent_name) return;
    current.observed_participants.push(name);
    await this.persist();
  }

  // Join attempts --------------------------------------------------------------

  /** The idempotency key for this join, reusing a live attempt with the same request. */
  async beginJoinAttempt(target, requestHash, newKey) {
    const key = targetKey(target);
    const now = this.now();
    const current = this.data.join_attempts[key];
    if (current && current.expires_at_ms > now) {
      if (current.request_hash !== requestHash) return null;
      return current.idempotency_key;
    }
    this.data.join_attempts[key] = {
      request_hash: requestHash,
      idempotency_key: newKey,
      expires_at_ms: now + JOIN_ATTEMPT_TTL_MS,
    };
    await this.persist();
    return newKey;
  }

  async clearJoinAttempt(target, idempotencyKey) {
    const key = targetKey(target);
    if (this.data.join_attempts[key]?.idempotency_key !== idempotencyKey) return;
    delete this.data.join_attempts[key];
    await this.persist();
  }

  // Delivery ledger ----------------------------------------------------------------

  settled(ledger) {
    if (this.data.handled[ledger]) return { kind: 'handled', ...this.data.handled[ledger] };
    if (this.data.failures[ledger]) return { kind: 'failed', ...this.data.failures[ledger] };
    return null;
  }

  async rememberPending(ledger, messageId) {
    if (!this.data.pending[ledger]) this.data.pending[ledger] = messageId;
    if (!this.data.pending_delivery[ledger]) {
      this.data.pending_delivery[ledger] = {
        kind: 'waiting',
        detail: 'Queued for local delivery.',
        first_seen_ms: this.now(),
        last_attempt_ms: 0,
        next_attempt_ms: 0,
        attempts: 0,
        accepted: false,
        behind_turn: false,
      };
    }
    await this.persist();
  }

  /** `{wait:true}`, or `{wait:false, finalAttempt}` once the handoff TTL has passed. */
  pendingAction(ledger, ttlMs) {
    const pending = this.data.pending_delivery[ledger];
    if (!pending) return { wait: false, finalAttempt: false };
    const now = this.now();
    if (!pending.accepted && now - pending.first_seen_ms >= ttlMs) return { wait: false, finalAttempt: true };
    if (pending.next_attempt_ms > now) return { wait: true };
    return { wait: false, finalAttempt: false };
  }

  pendingWasAccepted(ledger) {
    return this.data.pending_delivery[ledger]?.accepted === true;
  }

  async rememberWaiting(ledger, kind, detail) {
    const pending = this.data.pending_delivery[ledger];
    if (!pending) throw new Error('pending delivery disappeared before its outcome was recorded');
    const now = this.now();
    pending.kind = kind;
    pending.accepted = pending.accepted || kind === 'accepted';
    pending.detail = detail;
    pending.last_attempt_ms = now;
    pending.attempts += 1;
    // Observing an accepted handoff only reads the provider's queue and
    // transcript, so it never backs off.
    const shift = pending.accepted ? 0 : Math.min(3, Math.max(0, pending.attempts - 1));
    pending.next_attempt_ms = now + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** shift);
    await this.persist();
  }

  /** Returns a failure detail when this was the final attempt, otherwise null after backing off. */
  async rememberUnacceptedAttempt(ledger, messageId, kind, reason, finalAttempt) {
    if (finalAttempt) {
      const detail = `The local session remained unavailable without accepting the handoff — ${reason}`;
      await this.rememberFailed(ledger, messageId, 'unavailable', detail);
      return detail;
    }
    const detail =
      kind === 'retry'
        ? `Local delivery will retry — ${reason}`
        : `Waiting for the local session — ${reason}`;
    await this.rememberWaiting(ledger, kind, detail);
    return null;
  }

  /** Records that the provider's queue holds the message. Returns whether that changed. */
  async rememberAccepted(ledger, behindTurn, reason) {
    const pending = this.data.pending_delivery[ledger];
    if (!pending) throw new Error('pending delivery disappeared before its outcome was recorded');
    const changed = !pending.accepted || pending.behind_turn !== behindTurn;
    pending.behind_turn = behindTurn;
    pending.accepted_at_ms ??= this.now();
    await this.rememberWaiting(ledger, 'accepted', `Accepted by the local session queue — ${reason}`);
    return changed;
  }

  async rememberHandled(ledger, messageId, outcome, detail) {
    delete this.data.pending[ledger];
    delete this.data.pending_delivery[ledger];
    this.data.handled[ledger] = { outcome, message_id: messageId, detail, at_ms: this.now() };
    this.recordOutcome(ledger, outcome, detail);
    await this.persist();
  }

  async rememberFailed(ledger, messageId, outcome, detail) {
    delete this.data.pending[ledger];
    delete this.data.pending_delivery[ledger];
    this.data.failures[ledger] = { outcome, message_id: messageId, detail, at_ms: this.now() };
    this.recordOutcome(ledger, outcome, detail);
    await this.persist();
  }

  recordOutcome(ledger, outcome, detail) {
    this.data.outcomes.unshift({ ledger, outcome, detail, at_ms: this.now() });
    this.data.outcomes.length = Math.min(this.data.outcomes.length, OUTCOMES_KEPT);
  }

  deliveryPublic(session) {
    const prefix = `${session.agent_id}:`;
    const pending = Object.entries(this.data.pending_delivery)
      .filter(([ledger]) => ledger.startsWith(prefix))
      .map(([ledger, entry]) => ({
        delivery_id: ledger.slice(prefix.length),
        state: entry.kind,
        detail: entry.detail,
        attempts: entry.attempts,
      }));
    const recent = this.data.outcomes
      .filter((entry) => entry.ledger.startsWith(prefix))
      .slice(0, 10)
      .map((entry) => ({
        delivery_id: entry.ledger.slice(prefix.length),
        outcome: entry.outcome,
        detail: entry.detail,
      }));
    return pending.length || recent.length ? { pending, recent } : null;
  }

  // Notices for sessions whose Connect closed -----------------------------------------

  async queueNotice(notice) {
    if (this.data.notices.some((queued) => queued.id === notice.id)) return;
    this.data.notices.push(notice);
    await this.persist();
  }

  async dropNotice(id) {
    this.data.notices = this.data.notices.filter((notice) => notice.id !== id);
    await this.persist();
  }
}
