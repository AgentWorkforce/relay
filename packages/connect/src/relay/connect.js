import { createHash, randomUUID } from 'node:crypto';
import {
  cloudAvailability,
  cloudJoin,
  cloudLeave,
  connectIdFrom,
  isAuthRejection,
  relaycast,
  RelayHttpError,
} from './cloud.js';
import { handoffTtlMs } from './state.js';

// The Connect half of the Node relay: the local join/send/status/leave
// routes and the poll → inject → settle pass, ported from the desktop probe
// (relay-desktop probe/src/relay/connect.rs and outbound.rs). Every rule that
// decides when a delivery is acked, failed, retried or left alone matches the
// probe's ledger; see docs/connect-node-local-relay.md.

export const HEARTBEAT_MS = 30_000;
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const NOTICE_TTL_MS = 60 * 60_000;
const INJECTED_REASONS = new Set(['dm', 'mention', 'thread-reply']);

export class ConnectError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ConnectError';
    this.status = status;
    this.code = code;
  }
}

export function messageRef(messageId) {
  return createHash('sha256').update(messageId).digest('hex').slice(0, 12);
}

/** One line, no brackets: the probe's `policy::one_line`. */
export function oneLine(value) {
  return String(value)
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function joinRequestHash(connectId, name, hostClaim) {
  const request = JSON.stringify(['relay-connect-join:v1', connectId, name ?? null, hostClaim ?? null]);
  return createHash('sha256').update(request).digest('hex');
}

function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A `GET /v1/deliveries` item, as the probe's `Delivery::from_queue_item` reads it. */
export function parseDelivery(item) {
  const id = str(item?.id);
  const messageId = str(item?.message_id);
  if (!id || !messageId) return null;
  const message = item.message || {};
  const attachments = [
    ...(Array.isArray(message.attachments) ? message.attachments : []),
    ...(Array.isArray(item.attachments) ? item.attachments : []),
  ];
  return {
    id,
    messageId,
    status: typeof item.status === 'string' ? item.status : '',
    reason: str(item.reason),
    channelId: str(item.channel_id),
    sender: str(message.agent_name),
    senderAddress: str(message.agent_address),
    text: typeof message.text === 'string' ? message.text : null,
    threadId: str(message.thread_id),
    relayfilePath: str(message.metadata?.relayfile?.path),
    attachments,
  };
}

export function decide(delivery) {
  if (!delivery.reason || !INJECTED_REASONS.has(delivery.reason)) {
    return { inject: false, reason: `not addressed to this agent (${delivery.reason || 'unknown'})` };
  }
  const text = delivery.text && delivery.text.trim() ? delivery.text : null;
  if (!text && delivery.attachments.length === 0) return { inject: false, reason: 'the message has no text' };
  return { inject: true };
}

function withAttachments(body, attachments) {
  const lines = [];
  const seen = new Set();
  for (const attachment of attachments) {
    const name = oneLine(attachment?.filename || attachment?.name || attachment?.file_name || 'file');
    const where =
      str(attachment?.url) ||
      str(attachment?.download_url) ||
      str(attachment?.file_id) ||
      str(attachment?.id);
    const key = `${name}|${where}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const type = str(attachment?.content_type) || str(attachment?.mime_type);
    lines.push(`- ${name}${type ? ` (${oneLine(type)})` : ''}${where ? ` ${oneLine(where)}` : ''}`);
  }
  if (lines.length === 0) return body;
  return `${body}${body ? '\n\n' : ''}Attachments:\n${lines.join('\n')}`;
}

export function injectedText(delivery, hint) {
  const sender = oneLine(delivery.sender || 'participant');
  let body = delivery.text || '';
  if (delivery.relayfilePath) {
    const line = `Relayfile path: ${delivery.relayfilePath}`;
    if (!body.includes(line)) body = `${body}\n\n${line}`;
  }
  body = withAttachments(body, delivery.attachments);
  return `[Relay Connect — from ${sender} · ref ${messageRef(delivery.messageId)}]\n${hint || ''}\n\n${body}`;
}

function goneError(code, message) {
  return new ConnectError(code === 'connect_not_found' ? 404 : 410, code, message);
}

function expired(session, now) {
  const at = Date.parse(session.expires_at);
  return Number.isNaN(at) || at <= now;
}

export function joinPublic(session) {
  return {
    connect_id: session.connect_id,
    agent_name: session.agent_name,
    role: session.role,
    task: session.task,
    expires_at: session.expires_at,
    host: session.host,
    participants: session.participants.map((p) => ({ agent_name: p.agent_name, role: p.role })),
  };
}

export function participantNames(session, roster) {
  const names = [...session.participants.map((p) => p.agent_name), ...session.observed_participants];
  for (const agent of roster || []) {
    const name = agent?.name;
    if (typeof name === 'string' && name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function statusPublic(session, roster) {
  const roles = new Map(session.participants.map((p) => [p.agent_name, p.role]));
  return {
    connect_id: session.connect_id,
    agent_name: session.agent_name,
    role: session.role,
    task: session.task,
    expires_at: session.expires_at,
    participants: participantNames(session, roster).map((name) => ({
      agent_name: name,
      role: roles.get(name) ?? null,
      online: roster
        ? roster.some((agent) => agent?.name === name && ['active', 'online'].includes(agent?.status))
        : null,
    })),
  };
}

function closeNotice(session, code) {
  const ended = code !== 'connect_expired';
  return {
    id: `connect-${ended ? 'ended' : 'expired'}-${session.connect_id}`,
    target: session.target,
    text: ended
      ? '[Relay Connect] This Connect ended. Its local credential was removed.'
      : '[Relay Connect] This Connect expired. Its local credential was removed.',
  };
}

/**
 * The Connect service. `injector` routes text into a session:
 * `inject(target, {messageId, text})`, `observe(...)`, `preflight(target)`,
 * `prepare(target)` (Claude Code's direct-delivery setting), all resolving
 * `{outcome, detail}` where an outcome applies.
 */
export class ConnectService {
  constructor({
    state,
    injector,
    log = () => {},
    env = process.env,
    now = Date.now,
    fetchImpl,
    replyHint = () => '',
    onChange = () => {},
  }) {
    this.state = state;
    this.injector = injector;
    this.log = log;
    this.env = env;
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.replyHint = replyHint;
    this.onChange = onChange;
    this.locks = new Map();
    this.lastHeartbeat = new Map();
    this.backoff = new Map();
  }

  client(session) {
    return relaycast({ baseUrl: session.base_url, token: session.token, fetchImpl: this.fetchImpl });
  }

  logFailure(operation, connectId, code, cause) {
    this.log(
      `relay connect ${operation} failed code=${code} connect_ref=${messageRef(connectId)} cause=${cause}`
    );
  }

  /** Serializes one credential's passes and route calls, like the probe's agent locks. */
  async withLock(key, task) {
    const previous = this.locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.locks.set(key, chained);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    }
  }

  async close(session, code) {
    const removed = await this.state.removeSession(session.target, session.agent_id);
    if (removed) {
      await this.state.queueNotice({ ...closeNotice(session, code), queued_at_ms: this.now() });
      this.onChange();
    }
    return removed;
  }

  async availability(session) {
    try {
      return await cloudAvailability({
        connectId: session.connect_id,
        env: this.env,
        fetchImpl: this.fetchImpl,
      });
    } catch (error) {
      this.logFailure('availability', session.connect_id, error.code, error.logCause);
      throw new ConnectError(error.status || 503, error.code, error.message);
    }
  }

  async current(target) {
    const session = this.state.session(target);
    if (!session)
      throw new ConnectError(404, 'connect_not_joined', 'This agent session has not joined a Relay Connect.');
    if (expired(session, this.now())) {
      await this.close(session, 'connect_expired');
      throw new ConnectError(410, 'connect_expired', 'This Connect has expired.');
    }
    return session;
  }

  // Routes -------------------------------------------------------------------------------

  async join(target, fields) {
    const extra = Object.keys(fields || {}).filter((key) => !['link', 'name', 'host_claim'].includes(key));
    if (extra.length)
      throw new ConnectError(400, 'invalid_request', 'Use link, optional name and optional host_claim.');
    const link = typeof fields.link === 'string' ? fields.link.trim() : '';
    if (!link) throw new ConnectError(400, 'invalid_request', 'A Relay Connect link or id is required.');
    const requestedId = connectIdFrom(link);
    if (!requestedId) throw new ConnectError(400, 'invalid_link', 'Use a Relay Connect link or id.');
    let name = null;
    if (fields.name !== undefined && fields.name !== null) {
      name = typeof fields.name === 'string' ? fields.name.trim().toLowerCase() : '';
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length < 2 || name.length > 48) {
        throw new ConnectError(
          400,
          'invalid_name',
          'Names are 2-48 lowercase letters, numbers, or single hyphens.'
        );
      }
    }
    let claim = null;
    if (fields.host_claim !== undefined) {
      if (typeof fields.host_claim !== 'string' || !fields.host_claim) {
        throw new ConnectError(400, 'invalid_request', 'host_claim must be a non-empty string.');
      }
      claim = fields.host_claim;
    }

    const existing = this.state.session(target);
    if (existing) {
      if (expired(existing, this.now())) await this.close(existing, 'connect_expired');
      else if (existing.connect_id === requestedId) return { ...joinPublic(existing), warnings: [] };
      else
        throw new ConnectError(
          409,
          'connect_already_joined',
          'This agent session is already in a different Relay Connect.'
        );
    }

    // Before Cloud: a session that cannot receive replies should not join.
    if (this.injector.prepare) {
      try {
        await this.injector.prepare(target);
      } catch (error) {
        throw new ConnectError(409, error.code || 'session_not_injectable', error.message);
      }
    }

    const idempotencyKey = await this.state.beginJoinAttempt(
      target,
      joinRequestHash(requestedId, name, claim),
      `node-v1-${randomUUID()}`
    );
    if (!idempotencyKey) {
      throw new ConnectError(
        409,
        'connect_join_pending',
        'A previous join has an unknown outcome. Retry with the same link, name, and host claim.'
      );
    }
    let joined;
    try {
      joined = await cloudJoin({
        connectId: requestedId,
        name,
        hostClaim: claim,
        idempotencyKey,
        env: this.env,
        fetchImpl: this.fetchImpl,
      });
    } catch (error) {
      const status = error.status ?? 503;
      if (status >= 500 || error.code === 'connect_join_timeout')
        this.logFailure('join', requestedId, error.code, error.logCause);
      if (status < 500 && status !== 429) await this.state.clearJoinAttempt(target, idempotencyKey);
      throw new ConnectError(status, error.code, error.message);
    }
    if (joined.connect_id !== requestedId) {
      throw new ConnectError(502, 'invalid_join_response', 'Relay Connect returned a different Connect.');
    }
    const participant = joined.participant;
    const session = {
      target,
      connect_id: joined.connect_id,
      task: typeof joined.task === 'string' ? joined.task : '',
      expires_at: joined.expires_at,
      host: joined.host || {},
      agent_name: participant.agent_name,
      agent_id: participant.agent_id,
      role: participant.role || 'guest',
      token: participant.token,
      base_url: participant.relay_base_url,
      participants: joined.participants
        .filter((p) => typeof p?.agent_name === 'string')
        .map((p) => ({ agent_name: p.agent_name, role: typeof p.role === 'string' ? p.role : null })),
      observed_participants: [],
      joined_at_ms: this.now(),
    };
    if (expired(session, this.now()))
      throw new ConnectError(410, 'connect_expired', 'This Connect has expired.');
    try {
      await this.state.insertSession(session);
    } catch {
      throw new ConnectError(500, 'connect_save_failed', 'This Connect could not be saved locally.');
    }
    this.onChange();
    const warnings = [];
    if (this.injector.preflight) {
      const check = await this.injector
        .preflight(target)
        .catch((error) => ({ ok: false, reason: error.message }));
      if (!check.ok) warnings.push(`Replies may not reach this session yet: ${check.reason}`);
    }
    return { ...joinPublic(session), warnings };
  }

  async send(target, text, { to, requestKey } = {}) {
    if (typeof text !== 'string' || !text)
      throw new ConnectError(400, 'invalid_text', 'The message must be non-empty UTF-8 text.');
    const session = await this.current(target);
    const roster = await this.roster(session);
    const names = participantNames(session, roster);
    let recipients;
    if (to !== undefined && to !== null) {
      if (to === session.agent_name)
        throw new ConnectError(400, 'invalid_recipient', 'Cannot send to this session itself.');
      if (!names.includes(to))
        throw new ConnectError(404, 'participant_not_found', 'That participant is not in this Connect.');
      recipients = [to];
    } else {
      recipients = names.filter((name) => name !== session.agent_name);
    }
    const key = requestKey || randomUUID();
    const sent = [];
    const client = this.client(session);
    for (const name of recipients) {
      let result;
      try {
        result = await client.dm(name, text, `connect-send:${key}:${name}`);
      } catch (error) {
        const failure = await this.sendFailure(session, name, error);
        if (sent.length)
          failure.message = `${failure.message} Already sent to ${sent.map((s) => s.to).join(', ')}.`;
        throw failure;
      }
      sent.push({ to: name, message_id: str(result?.message?.id) || str(result?.id) });
    }
    return { sent };
  }

  async sendFailure(session, name, error) {
    if (error.status === 404 && ['agent_not_found', 'address_not_found'].includes(error.code)) {
      return new ConnectError(404, error.code, error.message);
    }
    if (error.status === 404 || error.status === 410) {
      await this.close(session, 'connect_ended');
      return new ConnectError(410, 'connect_ended', 'This Connect expired or ended.');
    }
    if (isAuthRejection(error)) {
      let availability;
      try {
        availability = await this.availability(session);
      } catch (availabilityError) {
        return availabilityError;
      }
      if (availability.gone) {
        await this.close(session, availability.gone.code);
        return goneError(availability.gone.code, availability.gone.message);
      }
      this.logFailure('send', session.connect_id, 'connect_auth_rejected', error.logCause);
      return new ConnectError(
        503,
        'connect_auth_rejected',
        "Relay Connect refused this session's credential although the Connect is still open. This can happen briefly after the host changes; retry once."
      );
    }
    if (error.status === null || error.status === undefined) {
      this.logFailure('send', session.connect_id, 'connect_unreachable', error.logCause);
      return new ConnectError(
        503,
        'connect_unreachable',
        `Relay Connect could not be reached; the message to ${name} may or may not have been delivered. Ask before resending.`
      );
    }
    if (error.status >= 500) {
      this.logFailure('send', session.connect_id, 'connect_upstream_error', error.logCause);
      return new ConnectError(
        502,
        'connect_upstream_error',
        `Relay Connect's server failed (HTTP ${error.status}); the message to ${name} may already have been delivered. Ask before resending.`
      );
    }
    return new ConnectError(error.status, error.code, error.message);
  }

  /** The Relaycast roster, or null when it cannot be read; closes a gone Connect. */
  async roster(session) {
    try {
      const agents = await this.client(session).agents();
      return Array.isArray(agents) ? agents : Array.isArray(agents?.agents) ? agents.agents : null;
    } catch (error) {
      if (error.status === 404 || error.status === 410) {
        await this.close(session, 'connect_ended');
        throw new ConnectError(410, 'connect_ended', 'This Connect expired or ended.');
      }
      if (isAuthRejection(error)) {
        const availability = await this.availability(session).catch(() => null);
        if (availability?.gone) {
          await this.close(session, availability.gone.code);
          throw goneError(availability.gone.code, availability.gone.message);
        }
      }
      return null;
    }
  }

  async status(target) {
    const session = await this.current(target);
    const roster = await this.roster(session);
    const status = statusPublic(session, roster);
    const delivery = this.state.deliveryPublic(session);
    if (delivery) status.delivery = delivery;
    return status;
  }

  async leave(target) {
    const session = await this.current(target);
    return await this.withLock(`connect:${session.agent_id}`, async () => {
      // Cloud's leave frees the name and deletes this participant's Relaycast
      // agent. Without it (an older Cloud, or a failure), at least mark the
      // agent offline. Both are best effort: leaving locally always succeeds.
      let cloudLeft = false;
      try {
        await cloudLeave({
          connectId: session.connect_id,
          token: session.token,
          env: this.env,
          fetchImpl: this.fetchImpl,
        });
        cloudLeft = true;
      } catch (error) {
        this.logFailure(
          'leave',
          session.connect_id,
          error.code || 'connect_leave_failed',
          error.logCause || 'unknown'
        );
      }
      if (!cloudLeft) {
        try {
          await this.client(session).disconnect();
        } catch (error) {
          this.logFailure(
            'disconnect',
            session.connect_id,
            error.code || 'relaycast_error',
            error.logCause || 'unknown'
          );
        }
      }
      await this.state.removeSession(session.target, session.agent_id);
      this.onChange();
      return { left: true, connect_id: session.connect_id };
    });
  }

  // The poll pass --------------------------------------------------------------------------

  gate(connectId) {
    const entry = this.backoff.get(connectId);
    return !entry || entry.until <= this.now();
  }

  observe(connectId, error) {
    const limited = error?.status === 429 || ['rate_limit_exceeded', 'workspace_busy'].includes(error?.code);
    if (!limited) {
      if (!error) this.backoff.delete(connectId);
      return;
    }
    const previous = this.backoff.get(connectId);
    const delay = previous ? Math.min(BACKOFF_MAX_MS, previous.delay * 2) : BACKOFF_MIN_MS;
    this.backoff.set(connectId, { delay, until: this.now() + delay });
  }

  async pollAll() {
    await this.deliverNotices();
    for (const session of this.state.sessions()) {
      await this.withLock(`connect:${session.agent_id}`, () => this.pollOne(session));
    }
  }

  async deliverNotices() {
    for (const notice of [...this.state.data.notices]) {
      let result;
      try {
        result = await this.injector.inject(notice.target, { messageId: notice.id, text: notice.text });
      } catch (error) {
        result = { outcome: 'in_doubt', detail: error.message };
      }
      const keep =
        ['retry', 'waiting'].includes(result.outcome) &&
        this.now() - (notice.queued_at_ms || 0) < NOTICE_TTL_MS;
      if (!keep) await this.state.dropNotice(notice.id);
    }
  }

  async settle(client, connectId, delivery, settled) {
    try {
      if (settled.kind === 'handled' && settled.outcome === 'delivered') await client.ack(delivery.id);
      else
        await client.fail(
          delivery.id,
          settled.detail || (settled.kind === 'handled' ? 'in doubt, not resent' : 'refused by the session')
        );
      this.observe(connectId, null);
    } catch (error) {
      this.observe(connectId, error);
    }
  }

  async ack(client, connectId, deliveryId) {
    try {
      await client.ack(deliveryId);
    } catch (error) {
      this.observe(connectId, error);
    }
  }

  async fail(client, connectId, deliveryId, detail) {
    try {
      await client.fail(deliveryId, detail);
    } catch (error) {
      this.observe(connectId, error);
    }
  }

  async pollOne(snapshot) {
    const session = this.state.session(snapshot.target);
    if (!session || session.agent_id !== snapshot.agent_id) return;
    if (expired(session, this.now())) {
      await this.close(session, 'connect_expired');
      return;
    }
    const client = this.client(session);
    const connectId = session.connect_id;

    const last = this.lastHeartbeat.get(session.agent_id);
    if ((last === undefined || this.now() - last >= HEARTBEAT_MS) && this.gate(connectId)) {
      this.lastHeartbeat.set(session.agent_id, this.now());
      try {
        await client.heartbeat();
        this.observe(connectId, null);
      } catch (error) {
        this.observe(connectId, error);
        if (error.status === 404 || error.status === 410) {
          await this.close(session, 'connect_ended');
          return;
        }
        if (isAuthRejection(error)) {
          const availability = await this.availability(session).catch(() => null);
          if (availability?.gone) {
            await this.close(session, availability.gone.code);
            return;
          }
        }
      }
    }
    if (!this.gate(connectId)) return;

    let items;
    try {
      items = await client.deliveries();
      this.observe(connectId, null);
    } catch (error) {
      this.observe(connectId, error);
      if (error.status === 404 || error.status === 410) {
        await this.close(session, 'connect_ended');
        return;
      }
      if (isAuthRejection(error)) {
        const availability = await this.availability(session).catch(() => null);
        if (availability?.gone) await this.close(session, availability.gone.code);
      }
      return;
    }
    const deliveries = (
      Array.isArray(items) ? items : Array.isArray(items?.deliveries) ? items.deliveries : []
    )
      .map(parseDelivery)
      .filter((delivery) => delivery && ['queued', 'delivered'].includes(delivery.status));
    const ttlMs = handoffTtlMs(this.env.AGENT_RELAY_CONNECT_HANDOFF_TIMEOUT_SECONDS);

    for (const delivery of deliveries) {
      const current = this.state.session(session.target);
      if (!current || current.agent_id !== session.agent_id) break;
      const ledger = `${session.agent_id}:${delivery.id}`;
      const settled = this.state.settled(ledger);
      if (settled) {
        await this.settle(client, connectId, delivery, settled);
        continue;
      }
      if (delivery.sender === session.agent_name) {
        await this.ack(client, connectId, delivery.id);
        continue;
      }
      if (delivery.sender) await this.state.observeParticipant(session, delivery.sender);
      if (!decide(delivery).inject) {
        await this.ack(client, connectId, delivery.id);
        continue;
      }
      try {
        await this.state.rememberPending(ledger, delivery.messageId);
      } catch (error) {
        this.log(
          `relay connect ledger write failed connect_ref=${messageRef(connectId)} cause=${error.code || 'io'}`
        );
        break;
      }
      const action = this.state.pendingAction(ledger, ttlMs);
      const alreadyAccepted = this.state.pendingWasAccepted(ledger);
      if (action.wait) {
        // One target is an ordered stream: a backing-off head holds later
        // items, unless the provider's queue already holds it.
        if (alreadyAccepted) continue;
        break;
      }
      const hint = alreadyAccepted || !delivery.sender ? '' : this.replyHint(delivery.sender, session.target);
      const text = injectedText(delivery, hint);
      let result;
      try {
        result = alreadyAccepted
          ? await this.injector.observe(session.target, { messageId: delivery.messageId, text })
          : await this.injector.inject(session.target, { messageId: delivery.messageId, text });
      } catch (error) {
        result = { outcome: 'crashed', detail: error.message };
      }
      const stop = await this.record(client, connectId, ledger, delivery, result, action.finalAttempt);
      if (stop) break;
    }
  }

  /** Persists one handoff outcome, then settles it. Returns true when the pass must stop. */
  async record(client, connectId, ledger, delivery, result, finalAttempt) {
    const reason = result?.detail || 'no detail';
    try {
      switch (result?.outcome) {
        case 'delivered':
          await this.state.rememberHandled(
            ledger,
            delivery.messageId,
            'delivered',
            'Injected into the session.'
          );
          await this.ack(client, connectId, delivery.id);
          return false;
        case 'in_doubt': {
          const detail = `In doubt; not resent — ${reason}`;
          await this.state.rememberHandled(ledger, delivery.messageId, 'in_doubt', detail);
          await this.fail(client, connectId, delivery.id, detail);
          return false;
        }
        case 'refused': {
          const detail = `Refused by the session — ${reason}`;
          await this.state.rememberFailed(ledger, delivery.messageId, 'refused', detail);
          await this.fail(client, connectId, delivery.id, detail);
          return false;
        }
        case 'retry':
        case 'waiting': {
          const detail = await this.state.rememberUnacceptedAttempt(
            ledger,
            delivery.messageId,
            result.outcome,
            reason,
            finalAttempt
          );
          if (detail) {
            await this.fail(client, connectId, delivery.id, detail);
            return false;
          }
          return true;
        }
        case 'accepted':
        case 'waiting_for_turn':
          await this.state.rememberAccepted(ledger, result.outcome === 'waiting_for_turn', reason);
          return false;
        default: {
          const detail = 'In doubt; the local session handoff stopped unexpectedly and was not resent.';
          await this.state.rememberHandled(ledger, delivery.messageId, 'in_doubt', detail);
          await this.fail(client, connectId, delivery.id, detail);
          return false;
        }
      }
    } catch (error) {
      this.log(
        `relay connect ledger write failed connect_ref=${messageRef(connectId)} cause=${error.code || 'io'}`
      );
      return true;
    }
  }
}

export { RelayHttpError };
