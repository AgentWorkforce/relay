/**
 * Web Crypto helpers. The shim runs in Node (relay-control) and in
 * Cloudflare Workers (Cloud), so it avoids `node:crypto`.
 */

const ENCODER = new TextEncoder();

/**
 * A capability token: `prefix` followed by 43 base64url characters (256 random bits).
 *
 * @param prefix - Marks the token's kind, e.g. `esm_`.
 * @returns The new token.
 */
export function mintToken(prefix: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefix}${base64Url(bytes)}`;
}

/**
 * Lowercase hex sha256 of `value`. Tokens are stored only as this hash.
 *
 * @param value - The text to hash.
 * @returns 64 hex characters.
 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', ENCODER.encode(value));
  return hex(new Uint8Array(digest));
}

/**
 * Lowercase hex HMAC-SHA256 of `message` keyed by `secret`.
 *
 * @param secret - The signing secret.
 * @param message - The signed content.
 * @returns 64 hex characters.
 */
export async function hmacSha256Hex(secret: string, message: string | Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    ENCODER.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const data = typeof message === 'string' ? ENCODER.encode(message) : message;
  const signature = await crypto.subtle.sign('HMAC', key, data as BufferSource);
  return hex(new Uint8Array(signature));
}

/**
 * Compares two strings without an early exit on the first difference.
 *
 * @param a - One string.
 * @param b - The other string.
 * @returns Whether they are equal.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = ENCODER.encode(a);
  const right = ENCODER.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
