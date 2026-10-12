import { readFileSync } from 'node:fs';

// Cloud and Relaycast calls for a Connect participant, matching the desktop
// probe (relay-desktop probe/src/relay/connect.rs, client.rs, sdk_gaps.rs).
// Errors carry an HTTP status (null when nothing answered), a code, and a
// credential-free cause for the log.

const JOIN_TIMEOUT_MS = 45_000;
const CLOUD_TIMEOUT_MS = 12_000;
const RELAYCAST_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

let packageVersion = '0.0.0';
try {
  packageVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
} catch {
  // A runtime copy without package.json still works; the version is only a header.
}
export const VERSION = packageVersion;

export class RelayHttpError extends Error {
  constructor({ status = null, code, message, cause, requestId }) {
    super(message || code);
    this.name = 'RelayHttpError';
    this.status = status;
    this.code = code;
    this.logCause = cause || (status ? `http_${status}:${code}` : 'transport');
    this.requestId = requestId;
  }
}

/** https, or http on loopback: the only places a credential may be sent. */
export function sendable(url) {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return false;
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

/** The Cloud base: agentrelay.com, or a loopback http override for local end-to-end tests. */
export function cloudBase(env = process.env) {
  const override = env.AGENT_RELAY_CONNECT_CLOUD_URL;
  if (override) {
    try {
      const url = new URL(override);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if ((url.protocol === 'http:' && loopback) || url.protocol === 'https:') {
        return override.replace(/\/+$/, '');
      }
    } catch {
      // Fall through to the shipped destination.
    }
  }
  return 'https://agentrelay.com';
}

/** The Connect id in a link or bare id (connect.rs `connect_id`). */
export function connectIdFrom(link) {
  let id;
  if (typeof link !== 'string') return null;
  if (link.includes('://')) {
    let url;
    try {
      url = new URL(link);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || url.hostname !== 'agentrelay.com') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    id = parts.at(-1) === 'join' ? parts.at(-2) : parts.at(-1);
  } else {
    id = link.trim();
  }
  return id && id.length <= 128 && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

function transportCause(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  const code = error?.cause?.code || error?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return 'connect';
  }
  if (typeof code === 'string' && code.startsWith('ERR_TLS')) return 'tls';
  if (typeof code === 'string' && /CERT|SSL/.test(code)) return 'tls';
  return 'transport';
}

async function readBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error('oversized'), { code: 'oversized' });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One JSON request. Resolves `{status, body}` for any HTTP answer; rejects a
 * RelayHttpError with `status: null` when nothing usable answered.
 */
export async function requestJson(url, { method = 'GET', token, headers = {}, body, timeoutMs, fetchImpl = fetch } = {}) {
  if (!sendable(url)) {
    throw new RelayHttpError({ code: 'connect_unreachable', message: 'Refusing to send to this address.', cause: 'unsendable_url' });
  }
  const finalHeaders = {
    accept: 'application/json',
    'user-agent': `AgentRelayConnect/${VERSION}`,
    ...headers,
  };
  if (token) finalHeaders.authorization = `Bearer ${token}`;
  if (body !== undefined) finalHeaders['content-type'] = 'application/json';
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const cause = transportCause(error);
    throw new RelayHttpError({
      code: cause === 'timeout' ? 'timeout' : 'connect_unreachable',
      message: cause === 'timeout' ? 'The request timed out.' : 'Could not be reached.',
      cause,
    });
  }
  let text;
  try {
    text = await readBody(response);
  } catch (error) {
    throw new RelayHttpError({
      code: 'connect_unreachable',
      message: 'The answer could not be read.',
      cause: error?.code === 'oversized' ? 'oversized' : transportCause(error) === 'timeout' ? 'timeout' : 'read',
    });
  }
  let parsed = null;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  return { status: response.status, body: parsed, requestId: response.headers.get('x-request-id') || undefined };
}

function answerError(answer, fallbackCode, fallbackMessage) {
  const error = answer.body?.error || {};
  const code = typeof error.code === 'string' && error.code ? error.code : fallbackCode;
  const message =
    typeof error.message === 'string' && error.message && error.message.length <= 300 && !error.message.includes('\n')
      ? error.message
      : fallbackMessage;
  return new RelayHttpError({ status: answer.status, code, message, requestId: answer.requestId });
}

function ok(answer) {
  return answer.status >= 200 && answer.status < 300;
}

function inner(body) {
  return body && typeof body === 'object' && body.data !== undefined && body.data !== null ? body.data : body;
}

// Cloud -------------------------------------------------------------------------------

export async function cloudJoin({ connectId, name, hostClaim, idempotencyKey, env, fetchImpl }) {
  const body = {};
  if (name) body.agent_name = name;
  if (hostClaim) body.host_claim = hostClaim;
  let answer;
  try {
    answer = await requestJson(`${cloudBase(env)}/cloud/connect/${connectId}/join`, {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body,
      timeoutMs: JOIN_TIMEOUT_MS,
      fetchImpl,
    });
  } catch (error) {
    if (error.code === 'timeout') {
      throw new RelayHttpError({
        status: 504,
        code: 'connect_join_timeout',
        message: 'Relay Connect join timed out. Retry the same join; it is safe to retry.',
        cause: 'timeout',
      });
    }
    throw new RelayHttpError({
      status: 503,
      code: 'connect_unreachable',
      message: 'Relay Connect could not be reached. Retry the same join; it is safe to retry.',
      cause: error.logCause,
    });
  }
  if (!ok(answer)) throw answerError(answer, 'connect_join_failed', 'Could not join this Connect.');
  const data = inner(answer.body);
  const participant = data?.participant;
  const valid =
    data &&
    typeof data.connect_id === 'string' &&
    typeof data.expires_at === 'string' &&
    !Number.isNaN(Date.parse(data.expires_at)) &&
    participant &&
    typeof participant.token === 'string' &&
    participant.token &&
    typeof participant.agent_id === 'string' &&
    participant.agent_id &&
    typeof participant.agent_name === 'string' &&
    sendable(participant.relay_base_url || '') &&
    Array.isArray(data.participants) &&
    data.participants.some((entry) => entry?.agent_name === participant.agent_name);
  if (!valid) {
    throw new RelayHttpError({
      status: 502,
      code: 'invalid_join_response',
      message: 'Relay Connect returned an incomplete join response.',
      cause: 'invalid_join_response',
    });
  }
  return data;
}

/** Whether Cloud still lists the Connect: `{active:true}`, `{gone:{code,message}}`, or throws. */
export async function cloudAvailability({ connectId, env, fetchImpl }) {
  let answer;
  try {
    answer = await requestJson(`${cloudBase(env)}/connect/${connectId}`, { timeoutMs: CLOUD_TIMEOUT_MS, fetchImpl });
  } catch (error) {
    throw new RelayHttpError({
      status: 503,
      code: 'connect_unreachable',
      message: 'Relay Connect could not be reached to check whether this Connect is still open. Retry once.',
      cause: error.logCause,
    });
  }
  if (ok(answer)) return { active: true };
  const fallback = answer.status === 404 ? 'connect_not_found' : answer.status === 410 ? 'connect_ended' : '';
  const code = answer.body?.error?.code || fallback;
  if ([404, 410].includes(answer.status) && ['connect_not_found', 'connect_ended', 'connect_expired'].includes(code)) {
    const messages = {
      connect_expired: 'This Connect has expired.',
      connect_not_found: 'This Connect was not found.',
      connect_ended: 'This Connect has ended.',
    };
    return { gone: { code, message: answerError(answer, code, messages[code]).message } };
  }
  throw new RelayHttpError({
    status: 502,
    code: 'connect_upstream_error',
    message: `Relay Connect answered HTTP ${answer.status} when checking whether this Connect is still open. Retry once.`,
    cause: code ? `http_${answer.status}:${code}` : `http_${answer.status}`,
  });
}

/** Tells Cloud this participant left, freeing its name. Best effort; resolves the answer. */
export async function cloudLeave({ connectId, token, env, fetchImpl }) {
  const answer = await requestJson(`${cloudBase(env)}/cloud/connect/${connectId}/leave`, {
    method: 'POST',
    token,
    timeoutMs: CLOUD_TIMEOUT_MS,
    fetchImpl,
  });
  if (ok(answer)) return inner(answer.body);
  throw answerError(answer, 'connect_leave_failed', 'Relay Connect could not record the leave.');
}

// Relaycast, as the participant ------------------------------------------------------------

export function relaycast({ baseUrl, token, fetchImpl }) {
  const base = baseUrl.replace(/\/+$/, '');
  const call = async (method, path, { body, headers, timeoutMs = RELAYCAST_TIMEOUT_MS } = {}) => {
    const answer = await requestJson(`${base}${path}`, {
      method,
      token,
      body,
      headers: { 'x-relaycast-origin-client': 'agent-relay-connect', 'x-relaycast-origin-version': VERSION, ...headers },
      timeoutMs,
      fetchImpl,
    });
    if (!ok(answer)) throw answerError(answer, 'relaycast_error', `Relaycast answered HTTP ${answer.status}.`);
    return inner(answer.body);
  };
  return {
    dm: (to, text, idempotencyKey) =>
      call('POST', '/v1/dm', {
        body: { to, text, mode: 'wait' },
        headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
      }),
    agents: () => call('GET', '/v1/agents?status=all'),
    deliveries: () => call('GET', '/v1/deliveries?limit=50'),
    ack: (id) => call('POST', `/v1/deliveries/${encodeURIComponent(id)}/ack`),
    fail: (id, error) =>
      call('POST', `/v1/deliveries/${encodeURIComponent(id)}/fail`, {
        body: { error: String(error).slice(0, 500), retryable: false },
      }),
    heartbeat: () => call('POST', '/v1/agents/heartbeat', { body: {} }),
    disconnect: () => call('POST', '/v1/agents/disconnect', { body: {} }),
  };
}

export function isAuthRejection(error) {
  return error?.status === 401 || error?.status === 403;
}
