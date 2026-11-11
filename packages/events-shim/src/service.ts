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
import { deliverInBackground } from './delivery.js';

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
  /** Replaces the wait between wake retries; tests pass one that does not sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Replaces `WAKE_RECOVERY_DELAYS_MS`. */
  recoveryDelaysMs?: readonly number[];
}

/**
 * Creates an inbox and its three capability tokens, stored only as hashes.
 *
 * @param deps - The store and clock.
 * @returns The inbox and the tokens, shown this once.
 */
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
  now: Date
): Promise<ShimRecord | null> {
  if (!token.startsWith(prefix) || !TOKEN_PATTERN.test(token.slice(prefix.length))) return null;
  const shim = await lookup(await sha256Hex(token));
  return shim && isLive(shim, now) ? shim : null;
}

/**
 * Finds a live inbox by its MCP token.
 *
 * @param deps - The store and clock.
 * @param token - The `esm_` token from the MCP URL.
 * @returns The inbox, or `null` when unknown, malformed or expired.
 */
export function findShimByMcpToken(deps: EventsShimDeps, token: string): Promise<ShimRecord | null> {
  return find(token, MCP_TOKEN_PREFIX, (hash) => deps.store.findByMcpTokenHash(hash), clock(deps));
}

/**
 * Finds a live inbox by its manage token.
 *
 * @param deps - The store and clock.
 * @param token - The `esk_` token the page holds.
 * @returns The inbox, or `null` when unknown, malformed or expired.
 */
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
 *
 * @param deps - The store, fetch, clock and optional `defer`.
 * @param input - The hook token, mode, headers and raw body.
 * @returns The HTTP status, JSON body and extra headers to answer with.
 */
export async function receivePost(
  deps: EventsShimDeps,
  input: { hookToken: string; mode: VerificationMode; headers: HeaderReader; rawBody: string }
): Promise<PostOutcome> {
  const now = clock(deps);
  const shim = await find(
    input.hookToken,
    HOOK_TOKEN_PREFIX,
    (hash) => deps.store.findByHookTokenHash(hash),
    now
  );
  if (!shim)
    return {
      status: 404,
      body: { error: 'not_found', message: 'No webhook at this URL. It may have been replaced or expired.' },
    };
  if (new TextEncoder().encode(input.rawBody).byteLength > EVENTS_SHIM_LIMITS.maxBodyBytes) {
    return {
      status: 413,
      body: {
        error: 'payload_too_large',
        message: `Bodies are limited to ${EVENTS_SHIM_LIMITS.maxBodyBytes / 1024} KB.`,
      },
    };
  }
  const verified = await verifyInbound({
    mode: input.mode,
    shim,
    headers: input.headers,
    rawBody: input.rawBody,
    now,
  });
  if (!verified.ok)
    return { status: verified.status, body: { error: verified.code, message: verified.message } };

  const at = now.toISOString();
  const reserved = await deps.store.reservePost(shim.id, at, [
    {
      name: 'hour',
      since: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      limit: EVENTS_SHIM_LIMITS.postsPerHour,
    },
    {
      name: 'day',
      since: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      limit: EVENTS_SHIM_LIMITS.postsPerDay,
    },
  ]);
  if (!reserved.ok) {
    const hour = reserved.window === 'hour';
    return {
      status: 429,
      body: {
        error: 'rate_limited',
        message: hour
          ? `At most ${EVENTS_SHIM_LIMITS.postsPerHour} posts per hour.`
          : `At most ${EVENTS_SHIM_LIMITS.postsPerDay} posts per day.`,
      },
      headers: { 'retry-after': hour ? '300' : '3600' },
    };
  }
  await deps.store.touch(shim.id, at, false);

  const contentType = (input.headers.get('content-type') ?? 'application/octet-stream').slice(0, 200);
  const idempotencyKey = await idempotencyKeyFor(input.mode, input.headers, input.rawBody);
  const eventType = eventTypeFor(input.mode, input.headers, input.rawBody);
  const appended = await deps.store.appendEvent(
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
    {
      feedSize: EVENTS_SHIM_LIMITS.feedSize,
      dedupeSince: new Date(now.getTime() - EVENTS_SHIM_LIMITS.dedupeWindowMs).toISOString(),
    }
  );
  // Linear treats anything but 200 as a failed delivery and retries it.
  const accepted = input.mode === 'linear' ? 200 : 202;
  if (appended.duplicate) {
    return {
      status: 200,
      body: { ok: true, duplicate: true, event_id: appended.eventId, seq: appended.seq },
    };
  }
  const { event } = appended;

  const target = liveTarget(shim);
  if (!target)
    return { status: accepted, body: { ok: true, event_id: event.id, seq: event.seq, wake: 'queued' } };
  // Acknowledge now: senders time out (Linear after 5 s) while retries run.
  // Forward this post, then anything an earlier failure left pending.
  void deliverInBackground(deps, shim.id, target, [event.id]);
  return { status: accepted, body: { ok: true, event_id: event.id, seq: event.seq, wake: 'forwarding' } };
}

function liveTarget(shim: ShimRecord) {
  return shim.wake && !shim.wake.brokenAt ? shim.wake : undefined;
}

/**
 * Starts a background pass for posts an earlier temporary failure left
 * pending, if the inbox has a working wake link. Called on feed reads and
 * tool calls so a stalled post does not wait for the next post.
 *
 * @param deps - The store, fetch, clock and optional `defer`.
 * @param shim - The inbox.
 * @returns Nothing; the pass runs in the background.
 */
export function drainStalledWakes(deps: EventsShimDeps, shim: ShimRecord): void {
  const target = liveTarget(shim);
  if (target) void deliverInBackground({ ...deps, recoveryDelaysMs: [] }, shim.id, target);
}

/**
 * What the page shows: the feed, the URLs and whether an agent is connected.
 *
 * @param deps - The store and clock.
 * @param shim - The inbox.
 * @param urls - The host's URL shapes.
 * @returns The feed as JSON.
 */
export async function feedFor(
  deps: EventsShimDeps,
  shim: ShimRecord,
  urls: ShimUrls
): Promise<Record<string, unknown>> {
  drainStalledWakes(deps, shim);
  const events = await deps.store.listRecent(shim.id, EVENTS_SHIM_LIMITS.feedSize);
  return {
    shim_id: shim.id,
    webhook_urls: Object.fromEntries(
      VERIFICATION_MODES.map((mode) => [mode, urls.hookUrl(shim.hookToken, mode)])
    ),
    secrets_set: Object.fromEntries(
      VERIFICATION_MODES.filter((mode) => mode !== 'open').map((mode) => [
        mode,
        Boolean(shim.secrets[mode as SecretMode]),
      ])
    ),
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

/**
 * A post as the page and the MCP tools show it.
 *
 * @param event - The stored post.
 * @returns Its JSON form.
 */
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

/**
 * Replaces the webhook token; the old URL stops working immediately.
 *
 * @param deps - The store and clock.
 * @param shim - The inbox.
 * @returns The new hook token.
 */
export async function rotateHook(deps: EventsShimDeps, shim: ShimRecord): Promise<string> {
  const hookToken = mintToken(HOOK_TOKEN_PREFIX);
  await deps.store.rotateHookToken(shim.id, hookToken, await sha256Hex(hookToken));
  await deps.store.touch(shim.id, clock(deps).toISOString(), false);
  return hookToken;
}

/**
 * Stores the signing secret for a mode. For `bearer`, omitting `secret` (or
 * sending a blank one) generates one, which is returned once.
 *
 * @param deps - The store.
 * @param shim - The inbox.
 * @param mode - Which verified URL the secret is for.
 * @param secret - The secret, `undefined` to generate a bearer token, or `null` to remove it.
 * @returns The generated bearer token, when one was generated.
 */
export async function setModeSecret(
  deps: EventsShimDeps,
  shim: ShimRecord,
  mode: SecretMode,
  secret: string | null | undefined
): Promise<{ secret?: string }> {
  if (secret === null) {
    await deps.store.setSecret(shim.id, mode, null);
    return {};
  }
  let value = secret?.trim();
  let generated = false;
  if (!value) {
    if (mode !== 'bearer') throw new EventsShimInputError(`Paste the ${mode} signing secret.`);
    value = mintToken(BEARER_SECRET_PREFIX);
    generated = true;
  }
  if (value.length < 8 || value.length > 256 || /\s/.test(value)) {
    throw new EventsShimInputError('Secrets are 8 to 256 characters with no spaces.');
  }
  await deps.store.setSecret(shim.id, mode, value);
  return generated ? { secret: value } : {};
}

export class EventsShimInputError extends Error {}
