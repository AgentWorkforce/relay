/**
 * The client side of service-caller challenge authentication
 * (`spawn_callers.challenge` and `spawn_callers.authenticate`), served by
 * Agent Relay Desktop's spawn caller extension.
 *
 * A service caller proves it holds its `caller.json` secret without sending
 * it: it asks for a challenge, computes
 * `HMAC-SHA256(SHA-256(secret), transcript)` over the version 1 transcript,
 * and sends that authenticator. A successful authenticate binds the bridge
 * connection to the caller for the rest of its life; the `spawn.*` calls on
 * it then name no caller at all.
 *
 * Rules a caller must know:
 * - A connection can be bound once. Open a new connection to bind again.
 * - A challenge is single-use and expires 30 seconds after it was issued.
 * - Three attempts on one connection that end without a binding lock it
 *   (`auth_locked`); open a new connection.
 * - Neither the secret nor the derived key ever leaves this process.
 */
import { createHash, createHmac } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { inspect } from 'node:util';

import type { CallOptions, CoreClient } from './client.js';
import { CoreBridgeError, CoreRpcError } from './errors.js';

/** The transcript version byte, which is also the challenge `version`. */
export const CALLER_TRANSCRIPT_VERSION = 1;
/** The transcript's domain separation string. */
export const CALLER_TRANSCRIPT_DOMAIN = 'agent-relay/service-caller/v1';
/** How long a challenge stays valid after it was issued, in milliseconds. */
export const CALLER_CHALLENGE_TTL_MS = 30_000;
/** The `caller.json` `auth` value naming this transcript. */
export const CALLER_AUTH_SCHEME = 'challenge-hmac-sha256/v1';
/** The `caller.json` schemas this reader accepts. */
export const CALLER_FILE_SCHEMAS = ['agent-relay-service-caller/1', 'agent-relay-service-caller/2'] as const;
/** The largest `caller.json` this reader opens, in bytes. */
export const MAX_CALLER_FILE_BYTES = 64 * 1024;

/** The params of `spawn_callers.challenge`. */
export type CallerChallengeParams = {
  /** The caller's registry id: `sc_` and 16 lowercase hex characters. */
  caller_id: string;
};

/** The result of `spawn_callers.challenge`. */
export interface CallerChallenge {
  /** Exactly 1: the transcript version byte. */
  version: number;
  /** `ch_` and 32 lowercase hex characters. */
  challenge_id: string;
  /** 32 random bytes in base64url without padding (43 characters). */
  nonce: string;
  /** Unix milliseconds on Desktop's clock. */
  issued_at_ms: number;
  /** `issued_at_ms + 30000`. */
  expires_at_ms: number;
}

/** The params of `spawn_callers.authenticate`. */
export type CallerAuthenticateParams = {
  /** The `challenge_id` of the challenge being answered. */
  challenge_id: string;
  /** The HMAC-SHA256 authenticator in base64url without padding (43 characters). */
  authenticator: string;
};

/** The result of `spawn_callers.authenticate`: the connection is now bound. */
export interface CallerBound {
  caller_id: string;
  /** The caller's display name: 1 to 200 of `A-Z a-z 0-9 _ -`. */
  caller_name: string;
  /** The record's authority generation, from 1 to 2^53 - 1. */
  authority_generation: number;
}

/** Every value the version 1 transcript covers. */
export interface CallerTranscriptInput {
  challengeId: string;
  /** The 32 raw nonce bytes. */
  nonce: Uint8Array;
  callerId: string;
  siteUrl: string;
  workspaceId: string;
  userId: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

const CALLER_ID = /^sc_[0-9a-f]{16}$/;
const CHALLENGE_ID = /^ch_[0-9a-f]{32}$/;
const B64URL_32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const SECRET = /^rsc_[A-Za-z0-9_-]{43}$/;
const CALLER_NAME = /^[A-Za-z0-9_-]{1,200}$/;
const NONCE_BYTES = 32;

function invalid(code: string, message: string): CoreBridgeError {
  return new CoreBridgeError(code, message);
}

function bytesWithin(field: string, value: unknown, min: number, max: number): Buffer {
  if (typeof value !== 'string')
    throw invalid('invalid_params', `Caller transcript input is invalid: ${field} must be a string.`);
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length < min || bytes.length > max) {
    throw invalid(
      'invalid_params',
      `Caller transcript input is invalid: ${field} must be ${min} to ${max} bytes.`
    );
  }
  return bytes;
}

function matching(field: string, value: unknown, pattern: RegExp): Buffer {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw invalid('invalid_params', `Caller transcript input is invalid: ${field} is malformed.`);
  }
  return Buffer.from(value, 'ascii');
}

function millis(field: string, value: unknown): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(
      'invalid_params',
      `Caller transcript input is invalid: ${field} must be an integer from 0 to 2^53 - 1.`
    );
  }
  return BigInt(value);
}

function field(bytes: Uint8Array): Buffer {
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(bytes.length);
  return Buffer.concat([prefix, bytes]);
}

function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(value);
  return out;
}

/**
 * Builds the exact version 1 transcript bytes: the version byte, then each
 * field with a big-endian u16 length prefix.
 * @param input - The challenge fields and the caller's own `caller.json` scope.
 * @returns The transcript bytes the authenticator covers.
 * @throws CoreBridgeError `invalid_params` when a value is outside its bound.
 */
export function callerTranscript(input: CallerTranscriptInput): Buffer {
  if (!(input.nonce instanceof Uint8Array) || input.nonce.length !== NONCE_BYTES) {
    throw invalid('invalid_params', 'Caller transcript input is invalid: nonce must be 32 bytes.');
  }
  return Buffer.concat([
    Buffer.from([CALLER_TRANSCRIPT_VERSION]),
    field(Buffer.from(CALLER_TRANSCRIPT_DOMAIN, 'ascii')),
    field(matching('challenge_id', input.challengeId, CHALLENGE_ID)),
    field(input.nonce),
    field(matching('caller_id', input.callerId, CALLER_ID)),
    field(bytesWithin('site_url', input.siteUrl, 1, 2048)),
    field(bytesWithin('workspace_id', input.workspaceId, 1, 256)),
    field(bytesWithin('user_id', input.userId, 1, 256)),
    field(u64(millis('issued_at_ms', input.issuedAtMs))),
    field(u64(millis('expires_at_ms', input.expiresAtMs))),
  ]);
}

const KEY = Symbol('key');

/**
 * A caller's credential as read from `caller.json`. It holds the derived key,
 * never the secret, and prints as `[redacted]`: it cannot be logged or
 * serialised by accident.
 */
export class CallerCredential {
  /** The caller's registry id, which is sent as the challenge param. */
  readonly callerId: string;
  /** `workspace.site_url`, used only in the transcript. */
  readonly siteUrl: string;
  /** `workspace.workspace_id`, used only in the transcript. */
  readonly workspaceId: string;
  /** `account.user_id`, used only in the transcript. */
  readonly userId: string;
  readonly #key: Buffer;

  private constructor(key: Buffer, callerId: string, siteUrl: string, workspaceId: string, userId: string) {
    this.#key = key;
    this.callerId = callerId;
    this.siteUrl = siteUrl;
    this.workspaceId = workspaceId;
    this.userId = userId;
  }

  /**
   * Checks a parsed `caller.json` document and derives its key.
   * @param document - The parsed `caller.json` contents.
   * @returns The credential, holding `SHA-256(secret)` and not the secret.
   * @throws CoreBridgeError `caller_file_invalid` when the document does not
   * have the `caller.json` shape. The message never contains the secret.
   */
  static fromDocument(document: unknown): CallerCredential {
    const bad = (rule: string) => invalid('caller_file_invalid', `caller.json is invalid: ${rule}.`);
    if (typeof document !== 'object' || document === null || Array.isArray(document))
      throw bad('it must be an object');
    const doc = document as Record<string, unknown>;
    if (!(CALLER_FILE_SCHEMAS as readonly unknown[]).includes(doc.schema))
      throw bad('schema is not one this reader knows');
    if (doc.schema !== CALLER_FILE_SCHEMAS[0] && doc.auth !== CALLER_AUTH_SCHEME)
      throw bad('auth is not one this reader knows');
    if (typeof doc.caller_id !== 'string' || !CALLER_ID.test(doc.caller_id)) {
      throw bad('caller_id must be "sc_" and 16 lowercase hex characters');
    }
    if (typeof doc.secret !== 'string' || !SECRET.test(doc.secret)) throw bad('secret is malformed');
    const workspace = doc.workspace as Record<string, unknown> | undefined;
    const account = doc.account as Record<string, unknown> | undefined;
    const text = (value: unknown, name: string, max: number): string => {
      if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > max) {
        throw bad(`${name} must be 1 to ${max} bytes`);
      }
      return value;
    };
    const siteUrl = text(workspace?.site_url, 'workspace.site_url', 2048);
    const workspaceId = text(workspace?.workspace_id, 'workspace.workspace_id', 256);
    const userId = text(account?.user_id, 'account.user_id', 256);
    const key = createHash('sha256').update(doc.secret, 'utf8').digest();
    return new CallerCredential(key, doc.caller_id, siteUrl, workspaceId, userId);
  }

  /**
   * Computes the authenticator for one challenge.
   * @param challenge - The challenge exactly as `spawn_callers.challenge` returned it.
   * @returns The HMAC-SHA256 authenticator in base64url without padding.
   * @throws CoreBridgeError `invalid_reply` when the challenge is malformed.
   */
  authenticatorFor(challenge: CallerChallenge): string {
    checkChallenge(challenge);
    const transcript = callerTranscript({
      challengeId: challenge.challenge_id,
      nonce: Buffer.from(challenge.nonce, 'base64url'),
      callerId: this.callerId,
      siteUrl: this.siteUrl,
      workspaceId: this.workspaceId,
      userId: this.userId,
      issuedAtMs: challenge.issued_at_ms,
      expiresAtMs: challenge.expires_at_ms,
    });
    return createHmac('sha256', this.#key).update(transcript).digest('base64url');
  }

  /**
   * Keeps the key out of JSON.
   * @returns A placeholder.
   */
  toJSON(): string {
    return '[redacted]';
  }

  /**
   * Keeps the key out of string conversion.
   * @returns A placeholder.
   */
  toString(): string {
    return '[redacted]';
  }

  /**
   * Keeps the key out of `console.log` and `util.inspect`.
   * @returns A placeholder.
   */
  [inspect.custom](): string {
    return 'CallerCredential [redacted]';
  }
}

function badReply(rule: string): CoreRpcError {
  return new CoreRpcError(`The caller challenge reply is invalid: ${rule}.`, {
    rpcCode: -32603,
    kind: 'internal',
    retryable: false,
  });
}

function checkChallenge(challenge: CallerChallenge): void {
  if (typeof challenge !== 'object' || challenge === null) throw badReply('it must be an object');
  if (challenge.version !== CALLER_TRANSCRIPT_VERSION) throw badReply('version must be 1');
  if (typeof challenge.challenge_id !== 'string' || !CHALLENGE_ID.test(challenge.challenge_id)) {
    throw badReply('challenge_id is malformed');
  }
  if (typeof challenge.nonce !== 'string' || !B64URL_32.test(challenge.nonce))
    throw badReply('nonce is malformed');
  const { issued_at_ms: issued, expires_at_ms: expires } = challenge;
  if (!Number.isSafeInteger(issued) || issued < 0) throw badReply('issued_at_ms is out of range');
  if (expires !== issued + CALLER_CHALLENGE_TTL_MS || !Number.isSafeInteger(expires)) {
    throw badReply('expires_at_ms must be issued_at_ms + 30000');
  }
}

function checkBound(bound: CallerBound, callerId: string): CallerBound {
  const fail = (rule: string) =>
    new CoreRpcError(`The caller authenticate reply is invalid: ${rule}.`, {
      rpcCode: -32603,
      kind: 'internal',
      retryable: false,
    });
  if (typeof bound !== 'object' || bound === null) throw fail('it must be an object');
  if (bound.caller_id !== callerId) throw fail('caller_id is not the caller that authenticated');
  if (typeof bound.caller_name !== 'string' || !CALLER_NAME.test(bound.caller_name))
    throw fail('caller_name is malformed');
  if (!Number.isSafeInteger(bound.authority_generation) || bound.authority_generation < 1) {
    throw fail('authority_generation is out of range');
  }
  return {
    caller_id: bound.caller_id,
    caller_name: bound.caller_name,
    authority_generation: bound.authority_generation,
  };
}

function requireMethod(client: CoreClient, method: string): void {
  if (!client.hello.methods.includes(method)) {
    throw new CoreRpcError(`This Agent Relay core does not offer ${method}; update Agent Relay Desktop.`, {
      rpcCode: -32601,
      kind: 'method_not_found',
      retryable: false,
    });
  }
}

/**
 * Binds a bridge connection to a service caller: one challenge and one
 * authenticate. After it returns, `spawn.invoke`, `spawn.status` and
 * `spawn.release` on this connection act as the caller and name no caller.
 * Failures are the core's typed errors (`CoreRpcError`), for example
 * `auth_failed`, `auth_locked`, `already_bound` or `challenge_outstanding`.
 * @param client - A greeted connection that has not been bound yet.
 * @param credential - The credential read from `caller.json`.
 * @param options - Optional timeout and cancellation controls for each of
 * the two calls; the default is the client's call timeout (15 seconds).
 * @returns The bound caller.
 */
export async function authenticate(
  client: CoreClient,
  credential: CallerCredential,
  options?: CallOptions
): Promise<CallerBound> {
  requireMethod(client, 'spawn_callers.challenge');
  requireMethod(client, 'spawn_callers.authenticate');
  const challengeParams: CallerChallengeParams = { caller_id: credential.callerId };
  const challenge = await client.call<CallerChallenge>('spawn_callers.challenge', challengeParams, options);
  const params: CallerAuthenticateParams = {
    challenge_id: challenge?.challenge_id,
    authenticator: credential.authenticatorFor(challenge),
  };
  return checkBound(
    await client.call<CallerBound>('spawn_callers.authenticate', params, options),
    credential.callerId
  );
}

function unsafe(file: string, rule: string): CoreBridgeError {
  return new CoreBridgeError('caller_file_unsafe', `Refusing to read ${file}: ${rule}.`);
}

/**
 * Reads `caller.json` securely and returns its credential.
 *
 * On macOS and Linux the file must be a regular file (not a symlink), owned
 * by this user, with no group or other permission bits (0600 or stricter),
 * in a directory that is not group- or world-writable unless it is sticky;
 * it is opened with `O_NOFOLLOW`.
 *
 * On Windows the path must be absolute, the file must not be a symlink or
 * reparse point (its real path must be itself), and it must be a regular
 * file. Node has no API to read a Windows access list, so the reader cannot
 * verify the file's DACL or owner; it relies on the per-user profile's
 * access list that Desktop writes the file under.
 * @param file - The absolute path of `caller.json`.
 * @returns The credential, holding the derived key and not the secret.
 * @throws CoreBridgeError `caller_file_unsafe` when the file fails a check
 * above, `caller_file_invalid` when its contents are malformed.
 */
export async function readCallerCredential(file: string): Promise<CallerCredential> {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) {
    throw unsafe(String(file), 'the path must be absolute');
  }
  // Open once and check the open descriptor, not the path, so nothing can
  // swap the file between a check and the read. On macOS and Linux
  // O_NOFOLLOW refuses a symlink in place of the file (ELOOP) and O_NONBLOCK
  // keeps a FIFO from blocking the open; Windows has neither flag.
  const posix = process.platform !== 'win32';
  let flags = fsConstants.O_RDONLY;
  if (posix) {
    if (typeof fsConstants.O_NOFOLLOW === 'number') flags |= fsConstants.O_NOFOLLOW;
    if (typeof fsConstants.O_NONBLOCK === 'number') flags |= fsConstants.O_NONBLOCK;
  }
  let handle: FileHandle;
  try {
    handle = await open(file, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ELOOP') throw unsafe(file, 'it is a symbolic link');
    if (code === 'EISDIR') throw unsafe(file, 'it is not a regular file');
    // ENOENT and ENOTDIR pass through unchanged, as a missing file always has.
    throw error;
  }
  let text: string;
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw unsafe(file, 'it is not a regular file');
    if (opened.size > MAX_CALLER_FILE_BYTES) throw unsafe(file, 'it is larger than 64 KiB');
    if (!posix) {
      // Windows gap: Node exposes no access-list API, so the DACL and owner
      // are not verified here. The file lives in the user's profile, whose
      // access list admits only that user, SYSTEM and administrators. What
      // can be checked is: an absolute path that is not a reparse point.
      // The path is examined after the open and must name the file that was
      // opened; it is never used to read. Paths compare case-insensitively,
      // as NTFS resolves them.
      const link = await lstat(file);
      if (link.isSymbolicLink()) throw unsafe(file, 'it is a symbolic link');
      if (link.ino !== opened.ino || link.dev !== opened.dev) {
        throw unsafe(file, 'it changed while being opened');
      }
      if ((await realpath(file)).toLowerCase() !== path.resolve(file).toLowerCase()) {
        throw unsafe(file, 'it resolves through a link');
      }
    } else {
      if (typeof process.getuid === 'function' && opened.uid !== process.getuid()) {
        throw unsafe(file, 'it is not owned by this user');
      }
      if ((opened.mode & 0o077) !== 0)
        throw unsafe(file, 'it is readable or writable by other users (it must be 0600)');
      const parent = await stat(path.dirname(file));
      if ((parent.mode & 0o022) !== 0 && (parent.mode & 0o1000) === 0) {
        throw unsafe(file, 'its directory is writable by other users');
      }
    }
    const buffer = Buffer.alloc(MAX_CALLER_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CALLER_FILE_BYTES) throw unsafe(file, 'it is larger than 64 KiB');
    text = buffer.subarray(0, bytesRead).toString('utf8');
    buffer.fill(0);
  } finally {
    await handle.close();
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    // The parser's message can quote the file, secret included.
    throw new CoreBridgeError('caller_file_invalid', 'caller.json is invalid: it is not JSON.');
  }
  return CallerCredential.fromDocument(document);
}
