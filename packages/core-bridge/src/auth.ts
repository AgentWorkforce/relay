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
import {
  SERVICE_CALLER_DISCONNECT_METHOD,
  SERVICE_CALLER_IDENTITY_METHOD,
  SERVICE_CALLER_INBOX_ACK_METHOD,
  SERVICE_CALLER_INBOX_CLOSE_METHOD,
  SERVICE_CALLER_INBOX_FAIL_METHOD,
  SERVICE_CALLER_INBOX_NEXT_METHOD,
  SERVICE_CALLER_INBOX_OPEN_METHOD,
} from './service-callers.js';

/** The transcript version byte, which is also the challenge `version`. */
export const CALLER_TRANSCRIPT_VERSION = 1;
/** The transcript's domain separation string. */
export const CALLER_TRANSCRIPT_DOMAIN = 'agent-relay/service-caller/v1';
/** How long a challenge stays valid after it was issued, in milliseconds. */
export const CALLER_CHALLENGE_TTL_MS = 30_000;
/** The `caller.json` `auth` value naming this transcript. */
export const CALLER_AUTH_SCHEME = 'challenge-hmac-sha256/v1';
/** The exact challenge method named by a schema-v2 caller handoff. */
export const CALLER_CHALLENGE_METHOD = 'spawn_callers.challenge';
/** The exact authenticate method named by a schema-v2 caller handoff. */
export const CALLER_AUTHENTICATE_METHOD = 'spawn_callers.authenticate';
/**
 * The `caller.json` schemas the credential-only reader accepts.
 * @deprecated Schema 1 is retained for 18.0 API compatibility. New callers
 * must use {@link CALLER_FILE_SCHEMA} and {@link readCallerDescriptor}.
 */
export const CALLER_FILE_SCHEMAS = ['agent-relay-service-caller/1', 'agent-relay-service-caller/2'] as const;
/** The strict schema required by the complete service-caller descriptor. */
export const CALLER_FILE_SCHEMA = CALLER_FILE_SCHEMAS[1];
/** The feature methods a service-caller connection requires end to end. */
export const REQUIRED_SERVICE_CALLER_METHODS = [
  CALLER_CHALLENGE_METHOD,
  CALLER_AUTHENTICATE_METHOD,
  'spawn.targets',
  'spawn.invoke',
  'spawn.status',
  'spawn.release',
  SERVICE_CALLER_IDENTITY_METHOD,
  SERVICE_CALLER_INBOX_OPEN_METHOD,
  SERVICE_CALLER_INBOX_NEXT_METHOD,
  SERVICE_CALLER_INBOX_ACK_METHOD,
  SERVICE_CALLER_INBOX_FAIL_METHOD,
  SERVICE_CALLER_INBOX_CLOSE_METHOD,
  SERVICE_CALLER_DISCONNECT_METHOD,
] as const;
/** The largest `caller.json` this reader opens, in bytes. */
export const MAX_CALLER_FILE_BYTES = 64 * 1024;

/** The exact schema-v2 authentication route Desktop writes. */
export interface CallerAuthRoute {
  readonly scheme: typeof CALLER_AUTH_SCHEME;
  readonly challenge: typeof CALLER_CHALLENGE_METHOD;
  readonly authenticate: typeof CALLER_AUTHENTICATE_METHOD;
}

/** The Relaycast agent that publishes this service caller's results. */
export interface CallerFilePublisher {
  readonly id: string;
  readonly name: string;
}

/** The account and workspace scope covered by challenge authentication. */
export interface CallerFileWorkspace {
  readonly site_url: string;
  readonly base_url: string;
  readonly workspace_id: string;
  readonly relaycast_workspace_id: string;
}

export interface CallerFileAccount {
  readonly user_id: string;
}

/** The exact schema-v2 result-inbox route Desktop writes. */
export interface CallerInboxRoute {
  readonly transport: 'core-bridge';
  readonly open: typeof SERVICE_CALLER_INBOX_OPEN_METHOD;
  readonly next: typeof SERVICE_CALLER_INBOX_NEXT_METHOD;
  readonly ack: typeof SERVICE_CALLER_INBOX_ACK_METHOD;
  readonly fail: typeof SERVICE_CALLER_INBOX_FAIL_METHOD;
  readonly close: typeof SERVICE_CALLER_INBOX_CLOSE_METHOD;
  readonly disconnect: typeof SERVICE_CALLER_DISCONNECT_METHOD;
}

/**
 * A validated schema-v2 caller handoff. It deliberately has no `secret`:
 * only the redacting {@link credential} retains its derived key.
 */
export interface CallerFileDescriptor {
  readonly schema: typeof CALLER_FILE_SCHEMA;
  readonly schemaVersion: 2;
  readonly auth: CallerAuthRoute;
  readonly callerId: string;
  readonly callerName: string;
  readonly publisher: CallerFilePublisher;
  readonly workspace: CallerFileWorkspace;
  readonly account: CallerFileAccount;
  readonly credential: CallerCredential;
  readonly createdAt: string;
  readonly rotatedAt?: string;
  readonly expiresAt: string;
  readonly harnesses: readonly string[];
  readonly directoryScope: readonly string[];
  readonly ownsOnly: boolean;
  readonly socket: string;
  readonly inbox: CallerInboxRoute;
  readonly desktopVersion: string;
}

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
const HARNESS = /^[A-Za-z0-9_-]{1,64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const NONCE_BYTES = 32;

const CALLER_KEYS = [
  'account',
  'auth',
  'caller_id',
  'caller_name',
  'created_at',
  'desktop_version',
  'directory_scope',
  'expires_at',
  'harnesses',
  'inbox',
  'owns_only',
  'publisher',
  'schema',
  'secret',
  'socket',
  'workspace',
] as const;

interface ParsedCallerDocument {
  auth: CallerAuthRoute;
  callerId: string;
  callerName: string;
  publisher: CallerFilePublisher;
  workspace: CallerFileWorkspace;
  account: CallerFileAccount;
  secret: string;
  createdAt: string;
  rotatedAt?: string;
  expiresAt: string;
  harnesses: string[];
  directoryScope: string[];
  ownsOnly: boolean;
  socket: string;
  inbox: CallerInboxRoute;
  desktopVersion: string;
}

interface ParsedCallerCredential {
  callerId: string;
  secret: string;
  siteUrl: string;
  workspaceId: string;
  userId: string;
}

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

function callerFileBad(rule: string): CoreBridgeError {
  return invalid('caller_file_invalid', `caller.json is invalid: ${rule}.`);
}

function fileRecord(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw callerFileBad(`${name} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== [...keys].sort().join(',')) {
    throw callerFileBad(`${name} has fields this reader does not know`);
  }
  return record;
}

function fileText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > max) {
    throw callerFileBad(`${name} must be 1 to ${max} bytes`);
  }
  return value;
}

function timestamp(value: unknown, name: string): string {
  const text = fileText(value, name, 128);
  if (!RFC3339.test(text) || !Number.isFinite(Date.parse(text))) {
    throw callerFileBad(`${name} must be RFC 3339`);
  }
  return text;
}

function fileBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw callerFileBad(`${name} must be a boolean`);
  return value;
}

function uniqueStrings(value: unknown, name: string, check: (item: string) => boolean): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw callerFileBad(`${name} must contain 1 to 256 entries`);
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !check(item)) throw callerFileBad(`${name} has a malformed entry`);
    if (items.includes(item)) throw callerFileBad(`${name} has a duplicate entry`);
    items.push(item);
  }
  return items;
}

function currentAuthRoute(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const auth = value as Record<string, unknown>;
  return (
    Object.keys(auth).sort().join(',') === 'authenticate,challenge,scheme' &&
    auth.scheme === CALLER_AUTH_SCHEME &&
    auth.challenge === CALLER_CHALLENGE_METHOD &&
    auth.authenticate === CALLER_AUTHENTICATE_METHOD
  );
}

/**
 * Preserves the public 18.0 credential-only contract. Schema 1 had no auth
 * field, and the first schema-2 writer used the scheme string; current
 * Desktop writes the explicit route object. Descriptor parsing below remains
 * strict and accepts only the complete current schema.
 */
function parseCallerCredential(document: unknown): ParsedCallerCredential {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw callerFileBad('it must be an object');
  }
  const doc = document as Record<string, unknown>;
  if (!(CALLER_FILE_SCHEMAS as readonly unknown[]).includes(doc.schema)) {
    throw callerFileBad('schema is not one this reader knows');
  }
  if (doc.schema === CALLER_FILE_SCHEMA && doc.auth !== CALLER_AUTH_SCHEME && !currentAuthRoute(doc.auth)) {
    throw callerFileBad('auth is not one this reader knows');
  }
  if (typeof doc.caller_id !== 'string' || !CALLER_ID.test(doc.caller_id)) {
    throw callerFileBad('caller_id must be "sc_" and 16 lowercase hex characters');
  }
  if (typeof doc.secret !== 'string' || !SECRET.test(doc.secret)) {
    throw callerFileBad('secret is malformed');
  }
  const workspace =
    typeof doc.workspace === 'object' && doc.workspace !== null && !Array.isArray(doc.workspace)
      ? (doc.workspace as Record<string, unknown>)
      : undefined;
  const account =
    typeof doc.account === 'object' && doc.account !== null && !Array.isArray(doc.account)
      ? (doc.account as Record<string, unknown>)
      : undefined;
  return {
    callerId: doc.caller_id,
    secret: doc.secret,
    siteUrl: fileText(workspace?.site_url, 'workspace.site_url', 2048),
    workspaceId: fileText(workspace?.workspace_id, 'workspace.workspace_id', 256),
    userId: fileText(account?.user_id, 'account.user_id', 256),
  };
}

function parseCallerDocument(document: unknown): ParsedCallerDocument {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw callerFileBad('it must be an object');
  }
  const raw = document as Record<string, unknown>;
  if (raw.schema === 'agent-relay-service-caller/1') {
    throw callerFileBad('schema 1 is retired; rotate the caller in Agent Relay');
  }
  if (raw.schema !== CALLER_FILE_SCHEMA) throw callerFileBad('schema is not one this reader knows');
  const keys = raw.rotated_at === undefined ? CALLER_KEYS : [...CALLER_KEYS, 'rotated_at'];
  const doc = fileRecord(raw, 'it', keys);

  const auth = fileRecord(doc.auth, 'auth', ['authenticate', 'challenge', 'scheme']);
  if (
    auth.scheme !== CALLER_AUTH_SCHEME ||
    auth.challenge !== CALLER_CHALLENGE_METHOD ||
    auth.authenticate !== CALLER_AUTHENTICATE_METHOD
  ) {
    throw callerFileBad('auth is not one this reader knows');
  }
  if (typeof doc.caller_id !== 'string' || !CALLER_ID.test(doc.caller_id)) {
    throw callerFileBad('caller_id must be "sc_" and 16 lowercase hex characters');
  }
  if (typeof doc.caller_name !== 'string' || !CALLER_NAME.test(doc.caller_name)) {
    throw callerFileBad('caller_name is malformed');
  }
  if (typeof doc.secret !== 'string' || !SECRET.test(doc.secret)) {
    throw callerFileBad('secret is malformed');
  }

  const publisher = fileRecord(doc.publisher, 'publisher', ['id', 'name']);
  const workspace = fileRecord(doc.workspace, 'workspace', [
    'base_url',
    'relaycast_workspace_id',
    'site_url',
    'workspace_id',
  ]);
  const account = fileRecord(doc.account, 'account', ['user_id']);
  const inbox = fileRecord(doc.inbox, 'inbox', [
    'ack',
    'close',
    'disconnect',
    'fail',
    'next',
    'open',
    'transport',
  ]);
  if (
    inbox.transport !== 'core-bridge' ||
    inbox.open !== SERVICE_CALLER_INBOX_OPEN_METHOD ||
    inbox.next !== SERVICE_CALLER_INBOX_NEXT_METHOD ||
    inbox.ack !== SERVICE_CALLER_INBOX_ACK_METHOD ||
    inbox.fail !== SERVICE_CALLER_INBOX_FAIL_METHOD ||
    inbox.close !== SERVICE_CALLER_INBOX_CLOSE_METHOD ||
    inbox.disconnect !== SERVICE_CALLER_DISCONNECT_METHOD
  ) {
    throw callerFileBad('inbox is not one this reader knows');
  }

  const socket = fileText(doc.socket, 'socket', 4096);
  if (
    socket.includes('\0') ||
    (!path.isAbsolute(socket) && !path.win32.isAbsolute(socket) && !/^\\\\\.\\pipe\\/i.test(socket))
  ) {
    throw callerFileBad('socket must be an absolute path or named pipe');
  }

  const callerName = doc.caller_name;
  const publisherName = fileText(publisher.name, 'publisher.name', 256);
  if (publisherName !== callerName) {
    throw callerFileBad('publisher.name must match caller_name');
  }
  const createdAt = timestamp(doc.created_at, 'created_at');
  const rotatedAt = doc.rotated_at === undefined ? undefined : timestamp(doc.rotated_at, 'rotated_at');
  const expiresAt = timestamp(doc.expires_at, 'expires_at');
  const createdMs = Date.parse(createdAt);
  const rotatedMs = rotatedAt === undefined ? undefined : Date.parse(rotatedAt);
  const expiresMs = Date.parse(expiresAt);
  if (
    expiresMs <= createdMs ||
    (rotatedMs !== undefined && (rotatedMs < createdMs || rotatedMs >= expiresMs))
  ) {
    throw callerFileBad('timestamps are out of order');
  }

  return {
    auth: {
      scheme: CALLER_AUTH_SCHEME,
      challenge: CALLER_CHALLENGE_METHOD,
      authenticate: CALLER_AUTHENTICATE_METHOD,
    },
    callerId: doc.caller_id,
    callerName,
    publisher: {
      id: fileText(publisher.id, 'publisher.id', 256),
      name: publisherName,
    },
    workspace: {
      site_url: fileText(workspace.site_url, 'workspace.site_url', 2048),
      base_url: fileText(workspace.base_url, 'workspace.base_url', 2048),
      workspace_id: fileText(workspace.workspace_id, 'workspace.workspace_id', 256),
      relaycast_workspace_id: fileText(
        workspace.relaycast_workspace_id,
        'workspace.relaycast_workspace_id',
        256
      ),
    },
    account: { user_id: fileText(account.user_id, 'account.user_id', 256) },
    secret: doc.secret,
    createdAt,
    ...(rotatedAt === undefined ? {} : { rotatedAt }),
    expiresAt,
    harnesses: uniqueStrings(doc.harnesses, 'harnesses', (item) => HARNESS.test(item)),
    directoryScope: uniqueStrings(
      doc.directory_scope,
      'directory_scope',
      (item) =>
        item.length <= 4096 && !item.includes('\0') && (path.isAbsolute(item) || path.win32.isAbsolute(item))
    ),
    ownsOnly: fileBoolean(doc.owns_only, 'owns_only'),
    socket,
    inbox: {
      transport: 'core-bridge',
      open: SERVICE_CALLER_INBOX_OPEN_METHOD,
      next: SERVICE_CALLER_INBOX_NEXT_METHOD,
      ack: SERVICE_CALLER_INBOX_ACK_METHOD,
      fail: SERVICE_CALLER_INBOX_FAIL_METHOD,
      close: SERVICE_CALLER_INBOX_CLOSE_METHOD,
      disconnect: SERVICE_CALLER_DISCONNECT_METHOD,
    },
    desktopVersion: fileText(doc.desktop_version, 'desktop_version', 128),
  };
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
    Object.freeze(this);
  }

  /**
   * Checks a parsed `caller.json` document and derives its key.
   * @param document - The parsed `caller.json` contents.
   * @returns The credential, holding `SHA-256(secret)` and not the secret.
   * @throws CoreBridgeError `caller_file_invalid` when the document does not
   * have the `caller.json` shape. The message never contains the secret.
   */
  static fromDocument(document: unknown): CallerCredential {
    const parsed = parseCallerCredential(document);
    const key = createHash('sha256').update(parsed.secret, 'utf8').digest();
    return new CallerCredential(key, parsed.callerId, parsed.siteUrl, parsed.workspaceId, parsed.userId);
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

function descriptorFromDocument(document: unknown): CallerFileDescriptor {
  const parsed = parseCallerDocument(document);
  return Object.freeze({
    schema: CALLER_FILE_SCHEMA,
    schemaVersion: 2,
    auth: Object.freeze({ ...parsed.auth }),
    callerId: parsed.callerId,
    callerName: parsed.callerName,
    publisher: Object.freeze({ ...parsed.publisher }),
    workspace: Object.freeze({ ...parsed.workspace }),
    account: Object.freeze({ ...parsed.account }),
    credential: CallerCredential.fromDocument(document),
    createdAt: parsed.createdAt,
    ...(parsed.rotatedAt === undefined ? {} : { rotatedAt: parsed.rotatedAt }),
    expiresAt: parsed.expiresAt,
    harnesses: Object.freeze([...parsed.harnesses]),
    directoryScope: Object.freeze([...parsed.directoryScope]),
    ownsOnly: parsed.ownsOnly,
    socket: parsed.socket,
    inbox: Object.freeze({ ...parsed.inbox }),
    desktopVersion: parsed.desktopVersion,
  });
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

function requireMethods(client: Pick<CoreClient, 'hello'>, methods: readonly string[]): void {
  for (const method of methods) {
    if (client.hello.methods.includes(method)) continue;
    throw new CoreRpcError(`This Agent Relay core does not offer ${method}; update Agent Relay Desktop.`, {
      rpcCode: -32601,
      kind: 'method_not_found',
      retryable: false,
    });
  }
}

/**
 * Refuses a core that cannot provide the complete service-caller lifecycle.
 * @param client - A greeted bridge connection whose advertised methods are checked.
 * @returns Nothing when every required service-caller method is available.
 */
export function requireServiceCallerMethods(client: Pick<CoreClient, 'hello'>): void {
  requireMethods(client, REQUIRED_SERVICE_CALLER_METHODS);
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
  requireMethods(client, [CALLER_CHALLENGE_METHOD, CALLER_AUTHENTICATE_METHOD]);
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
 * Reads and parses `caller.json` once through a checked file descriptor.
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
 * @returns The parsed document; callers immediately validate it and discard
 * its secret after deriving the credential key.
 * @throws CoreBridgeError `caller_file_unsafe` when the file fails a check
 * above, `caller_file_invalid` when its contents are malformed.
 */
async function readCallerDocument(file: string): Promise<unknown> {
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
  return document;
}

/**
 * Securely reads and validates the complete schema-v2 caller handoff.
 * The returned descriptor contains no secret; {@link CallerFileDescriptor.credential}
 * retains only its derived key and always prints as `[redacted]`.
 * @param file - The absolute path of the schema-v2 `caller.json` handoff.
 * @returns The validated descriptor and its redacting challenge credential.
 */
export async function readCallerDescriptor(file: string): Promise<CallerFileDescriptor> {
  return descriptorFromDocument(await readCallerDocument(file));
}

/**
 * Securely reads `caller.json` and returns only its challenge credential.
 * Prefer {@link readCallerDescriptor} when a caller also needs the socket,
 * publisher, workspace, scope or inbox route from the same checked read.
 * @param file - The absolute path of `caller.json`.
 * @returns The credential, holding the derived key and never the secret.
 */
export async function readCallerCredential(file: string): Promise<CallerCredential> {
  return CallerCredential.fromDocument(await readCallerDocument(file));
}
