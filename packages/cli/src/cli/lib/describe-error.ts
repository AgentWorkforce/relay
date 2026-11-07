/**
 * Human-readable rendering for values caught in a `catch` or a rejected
 * promise.
 *
 * `String(err)` collapses a protocol-shaped rejection such as `{ status: 401 }`
 * into `[object Object]`, which is how a clear attach authorization failure
 * reached users as garbage. {@link describeError} keeps the useful fields
 * visible so the backstop formatter never destroys the diagnosis.
 */

// Imported from the `redact` leaf, not the package barrel: this module is
// reachable from the CLI entrypoint and from small libs, and the barrel drags
// in the whole cloud surface (auth, workflows, child-process spawning).
import { redactCredentialValues } from '@agent-relay/cloud/redact';

import { redactSecrets } from './redact.js';

/** Longest JSON fallback we will print before truncating. */
const MAX_JSON_LENGTH = 500;

/** How far to follow `cause` / nested `error` values. */
const MAX_DEPTH = 2;

/** Last resort when a value carries no describable text at all. */
const UNKNOWN = 'Unknown error';

/**
 * Describe an unknown thrown or rejected value as a single-line string.
 *
 * - `Error` → its `message`, or its `name`/`cause` when the message is empty
 * - object → `message`/`error` text plus `status`/`code` context, else compact
 *   JSON with credential-named fields redacted
 * - primitive → `String(value)`
 *
 * Every branch's output passes through {@link redactCredentialValues}: a server
 * error payload is free to echo the credential that was sent to it, so the text
 * we lift out of `message`/`error` needs the same value-pattern masking the rest
 * of the CLI's error output gets.
 *
 * @param value - The caught or rejected value.
 * @returns A non-empty, single-line description. Never `[object Object]`.
 */
export function describeError(value: unknown): string {
  const described = redactCredentialValues(describe(value, 0)).trim();
  return described === '' ? UNKNOWN : described;
}

function describe(value: unknown, depth: number): string {
  if (value === null || value === undefined) return String(value);
  if (value instanceof Error) return describeErrorInstance(value, depth);
  if (typeof value === 'function') return `[Function: ${value.name || 'anonymous'}]`;
  if (typeof value !== 'object') return String(value);
  return describeObject(value, depth);
}

function describeErrorInstance(error: Error, depth: number): string {
  const message = error.message.trim();
  if (message) return message;
  // An Error with an empty message printed as nothing at all — just as opaque
  // as `[object Object]`. Fall back to whatever else identifies it.
  const name = error.name.trim();
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined && depth < MAX_DEPTH) {
    const described = describe(cause, depth + 1).trim();
    if (described) return name ? `${name}: ${described}` : described;
  }
  return name || 'Error';
}

function describeObject(value: object, depth: number): string {
  if (Array.isArray(value)) return toCompactJson(value);
  const record = value as Record<string, unknown>;
  const text = describeText(record, depth);
  // No text field to lead with — the compact JSON already carries `status`,
  // `code`, and whatever else the thrower attached, so print that instead of
  // restating a subset of it.
  if (!text) return toCompactJson(value);
  const context = describeContext(record);
  return context ? `${text} (${context})` : text;
}

/** Pull the leading human message out of a protocol-shaped rejection. */
function describeText(record: Record<string, unknown>, depth: number): string | null {
  const message = toText(record.message);
  if (message) return message;
  if (typeof record.error === 'string') return record.error.trim() || null;
  if (record.error && typeof record.error === 'object' && depth < MAX_DEPTH) {
    return describe(record.error, depth + 1).trim() || null;
  }
  return null;
}

/** `status` / `code` rendered as trailing context for the message. */
function describeContext(record: Record<string, unknown>): string {
  const parts: string[] = [];
  const status = toText(record.status);
  if (status) parts.push(`status ${status}`);
  const code = toText(record.code);
  if (code) parts.push(`code ${code}`);
  return parts.join(', ');
}

function toText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/**
 * Serialize a value for display: credentials redacted, cycles tolerated, and
 * truncated so a large payload cannot flood the terminal.
 */
function toCompactJson(value: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(redactSecrets(value), jsonSafeReplacer);
  } catch {
    json = undefined;
  }
  if (json === undefined) return unserializableTag(value);
  return json.length > MAX_JSON_LENGTH ? `${json.slice(0, MAX_JSON_LENGTH)}…` : json;
}

/**
 * Keep members `JSON.stringify` refuses or drops — it throws on `BigInt` and
 * silently omits functions and symbols, either of which would turn a readable
 * payload back into a useless one.
 */
function jsonSafeReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return `[Function: ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return value.toString();
  return value;
}

/**
 * Name a value we could not serialize at all (a throwing getter, say). Falls
 * back to the constructor or tag rather than `[object Object]`, which is the
 * exact rendering this module exists to eliminate.
 */
function unserializableTag(value: unknown): string {
  const name = (value as { constructor?: { name?: string } } | null)?.constructor?.name;
  return `[unserializable ${name || Object.prototype.toString.call(value).slice(8, -1)}]`;
}
