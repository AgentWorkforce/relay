import { hmacSha256Hex, timingSafeEqual } from './crypto.js';
import { EVENTS_SHIM_LIMITS } from './limits.js';
import type { ShimRecord, VerificationMode } from './types.js';

/** Request headers, case-insensitive (a `Headers` or a plain lowercase-keyed map). */
export type HeaderReader = Pick<Headers, 'get'>;

export type VerifyResult =
  { ok: true } | { ok: false; status: 401 | 403 | 409; code: string; message: string };

/**
 * Checks a post against the shim's mode. `open` accepts anyone holding
 * the URL; the others check the sender's signature or bearer against the
 * secret stored for that mode.
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
      const timestamp = readJson(rawBody)?.webhookTimestamp;
      if (
        typeof timestamp === 'number' &&
        Math.abs(now.getTime() - timestamp) > EVENTS_SHIM_LIMITS.signatureToleranceMs
      ) {
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
 * The key that makes a retried post arrive once: the sender's
 * `Idempotency-Key`, else the provider's own delivery or event id.
 */
export function idempotencyKeyFor(
  mode: VerificationMode,
  headers: HeaderReader,
  rawBody: string
): string | undefined {
  const explicit = headers.get('idempotency-key')?.trim();
  if (explicit) return `key:${explicit.slice(0, EVENTS_SHIM_LIMITS.maxIdempotencyKeyLength)}`;
  if (mode === 'github') {
    const delivery = headers.get('x-github-delivery')?.trim();
    if (delivery) return `github:${delivery}`;
  }
  if (mode === 'linear') {
    const delivery = headers.get('linear-delivery')?.trim();
    if (delivery) return `linear:${delivery}`;
  }
  if (mode === 'stripe') {
    const id = readJson(rawBody)?.id;
    if (typeof id === 'string' && id) return `stripe:${id}`;
  }
  return undefined;
}

/** A short event name for the feed and the wake message, when the sender says one. */
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
