import { mintToken, sha256Hex } from './crypto.js';
import { EVENTS_SHIM_LIMITS } from './limits.js';
import type {
  EventsShimStore,
  MintedShim,
  SecretMode,
  ShimEvent,
  ShimRecord,
  ShimUrls,
  VerificationMode,
} from './types.js';
import { VERIFICATION_MODES } from './types.js';
import { eventTypeFor, idempotencyKeyFor, keptHeaders, verifyInbound, type HeaderReader } from './verify.js';
import { forwardWake } from './wake.js';

export const MCP_TOKEN_PREFIX = 'esm_';
export const HOOK_TOKEN_PREFIX = 'esh_';
export const MANAGE_TOKEN_PREFIX = 'esk_';
export const BEARER_SECRET_PREFIX = 'esb_';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface EventsShimDeps {
  store: EventsShimStore;
  /** Clock; tests pin it. */
  now?: () => Date;
  fetchImpl?: typeof fetch;
  /** Called after a post is stored but its wake is still in flight (e.g. `ctx.waitUntil`). */
  defer?: (work: Promise<unknown>) => void;
}

export async function createShim(deps: EventsShimDeps): Promise<MintedShim> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const mcpToken = mintToken(MCP_TOKEN_PREFIX);
  const hookToken = mintToken(HOOK_TOKEN_PREFIX);
  const manageToken = mintToken(MANAGE_TOKEN_PREFIX);
  const shim = await deps.store.createShim({
    id: crypto.randomUUID(),
    mcpTokenHash: await sha256Hex(mcpToken),
    hookToken,
    hookTokenHash: await sha256Hex(hookToken),
    manageTokenHash: await sha256Hex(manageToken),
    now,
  });
  return { shim, mcpToken, hookToken, manageToken };
}

function isLive(shim: ShimRecord, now: Date): boolean {
  return now.getTime() - Date.parse(shim.lastUsedAt) < EVENTS_SHIM_LIMITS.idleExpiryMs;
}

async function find(
  token: string,
  prefix: string,
  lookup: (hash: string) => Promise<ShimRecord | null>,
  now: Date,
): Promise<ShimRecord | null> {
  if (!token.startsWith(prefix) || !TOKEN_PATTERN.test(token.slice(prefix.length))) return null;
  const shim = await lookup(await sha256Hex(token));
  return shim && isLive(shim, now) ? shim : null;
}

export function findShimByMcpToken(deps: EventsShimDeps, token: string): Promise<ShimRecord | null> {
  return find(token, MCP_TOKEN_PREFIX, (hash) => deps.store.findByMcpTokenHash(hash), clock(deps));
}

export function findShimByManageToken(deps: EventsShimDeps, token: string): Promise<ShimRecord | null> {
  return find(token, MANAGE_TOKEN_PREFIX, (hash) => deps.store.findByManageTokenHash(hash), clock(deps));
}

function clock(deps: EventsShimDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

export interface PostOutcome {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

/**
 * Handles one post to a webhook URL: checks the sender, enforces limits,
 * stores the post (once per idempotency key), and wakes the agent.
 */
export async function receivePost(
  deps: EventsShimDeps,
  input: { hookToken: string; mode: VerificationMode; headers: HeaderReader; rawBody: string },
): Promise<PostOutcome> {
  const now = clock(deps);
  const shim = await find(input.hookToken, HOOK_TOKEN_PREFIX, (hash) => deps.store.findByHookTokenHash(hash), now);
  if (!shim) return { status: 404, body: { error: 'not_found', message: 'No webhook at this URL. It may have been replaced or expired.' } };
  if (new TextEncoder().encode(input.rawBody).byteLength > EVENTS_SHIM_LIMITS.maxBodyBytes) {
    return { status: 413, body: { error: 'payload_too_large', message: `Bodies are limited to ${EVENTS_SHIM_LIMITS.maxBodyBytes / 1024} KB.` } };
  }
  const verified = await verifyInbound({ mode: input.mode, shim, headers: input.headers, rawBody: input.rawBody, now });
  if (!verified.ok) return { status: verified.status, body: { error: verified.code, message: verified.message } };

  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  if ((await deps.store.countPostsSince(shim.id, hourAgo)) >= EVENTS_SHIM_LIMITS.postsPerHour) {
    return { status: 429, body: { error: 'rate_limited', message: `At most ${EVENTS_SHIM_LIMITS.postsPerHour} posts per hour.` }, headers: { 'retry-after': '300' } };
  }
  if ((await deps.store.countPostsSince(shim.id, dayAgo)) >= EVENTS_SHIM_LIMITS.postsPerDay) {
    return { status: 429, body: { error: 'rate_limited', message: `At most ${EVENTS_SHIM_LIMITS.postsPerDay} posts per day.` }, headers: { 'retry-after': '3600' } };
  }
  const at = now.toISOString();
  await deps.store.recordPost(shim.id, at);
  await deps.store.touch(shim.id, at, false);

  const contentType = (input.headers.get('content-type') ?? 'application/octet-stream').slice(0, 200);
  const idempotencyKey = idempotencyKeyFor(input.mode, input.headers, input.rawBody);
  const eventType = eventTypeFor(input.mode, input.headers, input.rawBody);
  const { event, duplicate } = await deps.store.appendEvent(
    shim.id,
    {
      receivedAt: at,
      mode: input.mode,
      contentType,
      body: input.rawBody,
      headers: keptHeaders(input.headers),
      ...(eventType ? { eventType } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
    EVENTS_SHIM_LIMITS.feedSize,
  );
  if (duplicate) {
    return { status: 200, body: { ok: true, duplicate: true, event_id: event.id, seq: event.seq } };
  }

  const wake = shim.wake && !shim.wake.brokenAt ? wakeOne(deps, shim, event) : undefined;
  if (wake && deps.defer) deps.defer(wake);
  else if (wake) await wake;
  return {
    status: 202,
    body: { ok: true, event_id: event.id, seq: event.seq, wake: shim.wake && !shim.wake.brokenAt ? 'forwarded' : 'queued' },
  };
}

async function wakeOne(deps: EventsShimDeps, shim: ShimRecord, event: ShimEvent): Promise<void> {
  const target = shim.wake!;
  const result = await forwardWake({ url: target.url, secret: target.secret, event, fetchImpl: deps.fetchImpl });
  const at = clock(deps).toISOString();
  if (result.ok) {
    await deps.store.markDelivery(shim.id, [event.id], 'woken', at);
    return;
  }
  await deps.store.markDelivery(shim.id, [event.id], 'pending', at, result.reason);
  if (result.permanent) {
    await deps.store.setWakeTarget(shim.id, { ...target, brokenAt: at, brokenReason: result.reason });
  }
}

/** What the page shows: the feed and whether an agent is connected. */
export async function feedFor(deps: EventsShimDeps, shim: ShimRecord, urls: ShimUrls): Promise<Record<string, unknown>> {
  const events = await deps.store.listRecent(shim.id, EVENTS_SHIM_LIMITS.feedSize);
  return {
    shim_id: shim.id,
    webhook_urls: Object.fromEntries(VERIFICATION_MODES.map((mode) => [mode, urls.hookUrl(shim.hookToken, mode)])),
    secrets_set: Object.fromEntries(VERIFICATION_MODES.filter((mode) => mode !== 'open').map((mode) => [mode, Boolean(shim.secrets[mode as SecretMode])])),
    agent: {
      connected: Boolean(shim.agentSeenAt),
      last_seen_at: shim.agentSeenAt ?? null,
      wake: shim.wake ? (shim.wake.brokenAt ? 'broken' : 'linked') : 'none',
      wake_error: shim.wake?.brokenReason ?? null,
    },
    expires_at: new Date(Date.parse(shim.lastUsedAt) + EVENTS_SHIM_LIMITS.idleExpiryMs).toISOString(),
    events: events.map(publicEvent),
    limits: EVENTS_SHIM_LIMITS,
  };
}

export function publicEvent(event: ShimEvent): Record<string, unknown> {
  return {
    id: event.id,
    seq: event.seq,
    received_at: event.receivedAt,
    mode: event.mode,
    event_type: event.eventType ?? null,
    content_type: event.contentType,
    headers: event.headers,
    body: event.body,
    delivery: event.delivery,
    delivered_at: event.deliveredAt ?? null,
    wake_error: event.wakeError ?? null,
  };
}

/** Replaces the webhook token; the old URL stops working immediately. */
export async function rotateHook(deps: EventsShimDeps, shim: ShimRecord): Promise<string> {
  const hookToken = mintToken(HOOK_TOKEN_PREFIX);
  await deps.store.rotateHookToken(shim.id, hookToken, await sha256Hex(hookToken));
  await deps.store.touch(shim.id, clock(deps).toISOString(), false);
  return hookToken;
}

/**
 * Stores the signing secret for a mode. For `bearer`, omitting `secret`
 * generates one, which is returned once.
 */
export async function setModeSecret(
  deps: EventsShimDeps,
  shim: ShimRecord,
  mode: SecretMode,
  secret: string | null | undefined,
): Promise<{ secret?: string }> {
  if (secret === null) {
    await deps.store.setSecret(shim.id, mode, null);
    return {};
  }
  let value = secret?.trim();
  if (!value) {
    if (mode !== 'bearer') throw new EventsShimInputError(`Paste the ${mode} signing secret.`);
    value = mintToken(BEARER_SECRET_PREFIX);
  }
  if (value.length < 8 || value.length > 256 || /\s/.test(value)) {
    throw new EventsShimInputError('Secrets are 8 to 256 characters with no spaces.');
  }
  await deps.store.setSecret(shim.id, mode, value);
  return mode === 'bearer' && !secret ? { secret: value } : {};
}

export class EventsShimInputError extends Error {}
