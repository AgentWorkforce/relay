import { hmacSha256Hex, sha256Hex, timingSafeEqual } from './crypto.js';
import { EVENTS_SHIM_LIMITS } from './limits.js';
import type { ShimRecord, VerificationMode } from './types.js';

/** Request headers, case-insensitive (a `Headers` or a plain lowercase-keyed map). */
export type HeaderReader = Pick<Headers, 'get'>;

export type VerifyResult =
  { ok: true } | { ok: false; status: 401 | 403 | 409; code: string; message: string };

/**
 * Checks a post against its URL's mode. `open` accepts anyone holding the URL;
 * the others check the sender's signature or bearer against the secret stored
 * for that mode.
 *
 * @param input - The mode, the inbox, the request headers, the raw body and the time.
 * @returns `ok`, or the HTTP status, code and message to refuse with.
 */
export async function verifyInbound(input: {
  mode: VerificationMode;
  shim: ShimRecord;
  headers: HeaderReader;
  rawBody: string;
  now: Date;
}): Promise<VerifyResult> {
  const { mode, shim, headers, rawBody, now } = input;
  if (mode === 'open') return { ok: true };
  const secret = shim.secrets[mode];
  if (!secret) {
    return {
      ok: false,
      status: 409,
      code: 'verification_not_configured',
      message: `This webhook has no ${mode} secret yet. Set one on the page that created it, or post to the open URL.`,
    };
  }
  switch (mode) {
    case 'bearer': {
      const match = /^Bearer\s+(\S+)$/i.exec(headers.get('authorization') ?? '');
      return match && timingSafeEqual(match[1]!, secret)
        ? { ok: true }
        : refused('Missing or wrong bearer token.');
    }
    case 'github': {
      const header = headers.get('x-hub-signature-256') ?? '';
      if (!header.startsWith('sha256=')) return refused('Missing X-Hub-Signature-256.');
      const expected = await hmacSha256Hex(secret, rawBody);
      return timingSafeEqual(header.slice('sha256='.length).toLowerCase(), expected)
        ? { ok: true }
        : refused('GitHub signature does not match the stored secret.');
    }
    case 'stripe': {
      const header = headers.get('stripe-signature') ?? '';
      const parts = header
        .split(',')
        .map((part) => part.trim().split('=', 2) as [string, string | undefined]);
      const timestamp = parts.find(([key]) => key === 't')?.[1];
      const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value ?? '');
      if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) {
        return refused('Missing or malformed Stripe-Signature.');
      }
      if (Math.abs(now.getTime() - Number(timestamp) * 1000) > EVENTS_SHIM_LIMITS.signatureToleranceMs) {
        return refused('Stripe-Signature timestamp is outside the accepted window.');
      }
      const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
      return signatures.some((signature) => timingSafeEqual(signature.toLowerCase(), expected))
        ? { ok: true }
        : refused('Stripe signature does not match the stored secret.');
    }
    case 'linear': {
      const header = (headers.get('linear-signature') ?? '').trim().toLowerCase();
      if (!header) return refused('Missing Linear-Signature.');
      const expected = await hmacSha256Hex(secret, rawBody);
      if (!timingSafeEqual(header, expected))
        return refused('Linear signature does not match the stored secret.');
      // Linear signs webhookTimestamp into every body; without it a captured
      // post could be replayed once deduplication forgets it.
      const timestamp = readJson(rawBody)?.webhookTimestamp;
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
        return refused('Linear body has no numeric webhookTimestamp.');
      }
      if (Math.abs(now.getTime() - timestamp) > EVENTS_SHIM_LIMITS.signatureToleranceMs) {
        return refused('Linear webhookTimestamp is outside the accepted window.');
      }
      return { ok: true };
    }
  }
}

function refused(message: string): VerifyResult {
  return { ok: false, status: 401, code: 'signature_invalid', message };
}

/**
 * The key that makes a retried post arrive once. For signed provider modes
 * it comes only from signed content, never from a header the signature does
 * not cover, so a captured request cannot be replayed under a new key:
 * Stripe's event `id`, otherwise a hash of the signed body (GitHub and
 * Linear redeliveries resend the same body). Bearer and open posts use the
 * sender's `Idempotency-Key`, each in its own namespace.
 *
 * @param mode - How the post was verified.
 * @param headers - The request headers.
 * @param rawBody - The raw request body the signature covered.
 * @returns The dedupe key, or `undefined` when the post has none.
 */
export async function idempotencyKeyFor(
  mode: VerificationMode,
  headers: HeaderReader,
  rawBody: string
): Promise<string | undefined> {
  if (mode === 'stripe') {
    const id = readJson(rawBody)?.id;
    if (typeof id === 'string' && id) return `stripe:${await boundedKey(id)}`;
  }
  if (mode === 'github' || mode === 'stripe' || mode === 'linear') {
    return `${mode}:body:${await sha256Hex(rawBody)}`;
  }
  const explicit = headers.get('idempotency-key')?.trim();
  // Namespaced by mode, so an open post cannot suppress a verified one with the same key.
  return explicit ? `${mode}:key:${await boundedKey(explicit)}` : undefined;
}

/** The key itself when short; otherwise a hash of all of it, so distinct long keys stay distinct. */
async function boundedKey(key: string): Promise<string> {
  return key.length <= EVENTS_SHIM_LIMITS.maxIdempotencyKeyLength ? key : `sha256:${await sha256Hex(key)}`;
}

/**
 * A short event name for the feed and the wake message, when the sender gives one.
 *
 * @param mode - How the post was verified.
 * @param headers - The request headers.
 * @param rawBody - The raw request body.
 * @returns e.g. `pull_request.opened`, or `undefined`.
 */
export function eventTypeFor(
  mode: VerificationMode,
  headers: HeaderReader,
  rawBody: string
): string | undefined {
  const body = readJson(rawBody);
  if (mode === 'github') {
    const event = headers.get('x-github-event')?.trim();
    if (!event) return undefined;
    return typeof body?.action === 'string' ? `${event}.${body.action}` : event;
  }
  if (mode === 'stripe') return typeof body?.type === 'string' ? body.type : undefined;
  if (mode === 'linear') {
    if (typeof body?.type !== 'string') return undefined;
    return typeof body.action === 'string' ? `${body.type}.${body.action}` : body.type;
  }
  const explicit = headers.get('x-event-type')?.trim();
  if (explicit) return explicit.slice(0, 100);
  return typeof body?.type === 'string' ? body.type.slice(0, 100) : undefined;
}

/** Headers worth showing the agent; everything else (auth, cookies, IPs) is dropped. */
const KEPT_HEADERS = [
  'content-type',
  'user-agent',
  'x-event-type',
  'x-github-event',
  'x-github-delivery',
  'x-github-hook-id',
  'linear-delivery',
  'linear-event',
  'idempotency-key',
] as const;

/**
 * The few request headers worth showing the agent; auth, cookies and addresses are dropped.
 *
 * @param headers - The request headers.
 * @returns The kept headers, each at most 300 characters.
 */
export function keptHeaders(headers: HeaderReader): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = headers.get(name);
    if (value) kept[name] = value.slice(0, 300);
  }
  return kept;
}

function readJson(rawBody: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(rawBody);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
