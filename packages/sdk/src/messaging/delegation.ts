/**
 * Owner-named trusted delegates: verifying Agent Relay Cloud's attestation
 * of a delegate's owner approval, and redeeming an approval through the
 * session socket of the Agent Relay node the calling session runs under.
 *
 * The attestation is a compact JWS (`alg: EdDSA`, Ed25519, `typ:
 * relay-delegation+jws`) checked against the JWKS Cloud publishes at
 * `/.well-known/relay-delegation-keys.json`. A message gets `delegation`
 * only through {@link withVerifiedDelegation}: an unverified claim is never
 * surfaced, so agent code cannot branch on one by mistake.
 */

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { request as httpRequest } from 'node:http';

import type {
  RelayDelegationAction,
  RelayDelegationActionClass,
  RelayMessage,
  RelayMessageDelegation,
  RelayOwnerApprovalInput,
} from './types.js';

/** Every action class of wire contract v1. */
export const RELAY_DELEGATION_CLASSES: readonly RelayDelegationActionClass[] = [
  'merge',
  'pr_ops',
  'deploy',
  'release',
  'secret_change',
  'destructive',
  'spend',
  'external_comms',
  'prompt_approval',
  'config_change',
];

/** Settings a `config_change` may never name (the recipient's delegation settings). */
export const RELAY_DELEGATION_PROTECTED_SETTINGS: readonly string[] = [
  'delegated_approvals_from',
  'spawn_delegate_approvals',
];

/**
 * A `config_change` target as its parts.
 * @param target - `<agent id>:<setting>=<value>`
 * @returns The parts, or `undefined` when malformed or a wildcard
 */
export function parseConfigChangeTarget(
  target: string
): { agentId: string; setting: string; value: string } | undefined {
  if (target.includes('*')) return undefined;
  const colon = target.indexOf(':');
  if (colon <= 0) return undefined;
  const change = target.slice(colon + 1);
  const equals = change.indexOf('=');
  if (equals <= 0 || equals === change.length - 1) return undefined;
  return {
    agentId: target.slice(0, colon),
    setting: change.slice(0, equals),
    value: change.slice(equals + 1),
  };
}

/** A JWKS as Cloud publishes it; only OKP Ed25519 keys with a `kid` are used. */
export interface RelayDelegationJwks {
  keys: Array<{ kty?: string; crv?: string; kid?: string; x?: string; use?: string }>;
}

/** What a delivery must match for its attestation to count. */
export interface RelayDelegationExpected {
  /** The Agent Relay Cloud workspace id. */
  workspaceId: string;
  messageId: string;
  recipientAgentId: string;
  /** The sender's immutable agent id, when known. */
  senderId?: string;
  /** Seconds since the epoch; defaults to now. */
  now?: number;
}

const MAX_LIFETIME_SECS = 360;
const SKEW_SECS = 60;

function decode(part: string): Buffer {
  return Buffer.from(part, 'base64url');
}

function json(part: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(decode(part).toString('utf8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function validCondition(condition: unknown): boolean {
  if (!condition || typeof condition !== 'object') return false;
  const c = condition as Record<string, unknown>;
  switch (c.type) {
    case 'ci_green':
    case 'mergeable':
      return true;
    case 'head_sha':
      return typeof c.sha === 'string' && /^[0-9a-f]{40}$/.test(c.sha);
    case 'reviews_approved':
      return typeof c.min === 'number' && Number.isInteger(c.min) && c.min >= 1 && c.min <= 10;
    case 'not_before':
      return typeof c.at === 'string' && !Number.isNaN(Date.parse(c.at));
    default:
      return false;
  }
}

function validAction(action: unknown): action is RelayDelegationAction {
  if (!action || typeof action !== 'object') return false;
  const a = action as Record<string, unknown>;
  const conditions = a.conditions ?? [];
  return (
    typeof a.class === 'string' &&
    (RELAY_DELEGATION_CLASSES as readonly string[]).includes(a.class) &&
    typeof a.target === 'string' &&
    a.target.trim().length > 0 &&
    [...a.target].length <= 256 &&
    Array.isArray(conditions) &&
    conditions.length <= 5 &&
    conditions.every(validCondition) &&
    (a.class !== 'config_change' || parseConfigChangeTarget(a.target) !== undefined) &&
    (a.class !== 'config_change' ||
      conditions.every((c) => (c as Record<string, unknown>).type === 'not_before')) &&
    (a.class !== 'prompt_approval' || (conditions.length === 0 && PROMPT_TARGET.test(a.target))) &&
    (a.class !== 'pr_ops' || parsePrOpsTarget(a.target) !== undefined)
  );
}

const PROMPT_TARGET = /^[^:\s]+:[0-9a-f]{16}:(approve|deny)$/;

/**
 * A `pr_ops` target as its parts.
 * @param target - `owner/repo#N:<op>`, `<op>` one of `open`, `close`, `reopen`,
 *   `label=<name>`, `unlabel=<name>`, `request_review=<login>`, `rerun_ci`, `comment`
 * @returns The pull request and operation, or `undefined` when malformed
 */
export function parsePrOpsTarget(target: string): { pull: string; op: string } | undefined {
  // The pull request ends at its number; the operation is everything after
  // the colon that follows it (a label may hold colons).
  const match = /^([^\s/#:]+\/[^\s/#:]+#\d+):(.+)$/.exec(target);
  if (!match) return undefined;
  const [, pull, op] = match;
  const ok =
    ['open', 'close', 'reopen', 'rerun_ci', 'comment'].includes(op) ||
    /^request_review=[^\s]+$/.test(op) ||
    // A label may hold single spaces (`help wanted`), never at its ends,
    // repeated, or a control character.
    (/^(label|unlabel)=[^\s](?:[^\s]| (?! ))*$/.test(op) && !/\p{Cc}/u.test(op) && !op.endsWith(' '));
  return ok ? { pull, op } : undefined;
}

/**
 * The verified delegation `jws` attests for this delivery, or `undefined`
 * when it does not verify: a bad signature, an unknown key id, another
 * workspace, message, recipient or sender, an expired or over-long
 * attestation, or claims that are not v1.
 * @param jws - Cloud's compact JWS attestation
 * @param jwks - Cloud's published keys (`/.well-known/relay-delegation-keys.json`)
 * @param expected - The delivery it must be for, and the time to check expiry at
 * @returns The verified delegation, or `undefined`
 */
export function verifyDelegationAttestation(
  jws: string,
  jwks: RelayDelegationJwks,
  expected: RelayDelegationExpected
): RelayMessageDelegation | undefined {
  const parts = jws.split('.');
  if (parts.length !== 3) return undefined;
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = json(headerPart);
  if (!header || header.alg !== 'EdDSA' || header.typ !== 'relay-delegation+jws' || 'crit' in header) {
    return undefined;
  }
  const kid = header.kid;
  const jwk = jwks.keys.find(
    (key) =>
      key.kty === 'OKP' &&
      key.crv === 'Ed25519' &&
      typeof key.kid === 'string' &&
      key.kid === kid &&
      (key.use === undefined || key.use === 'sig') &&
      typeof key.x === 'string'
  );
  if (!jwk) return undefined;
  let valid = false;
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
    valid = verifySignature(null, Buffer.from(`${headerPart}.${payloadPart}`), key, decode(signaturePart));
  } catch {
    return undefined;
  }
  if (!valid) return undefined;
  const claims = json(payloadPart);
  if (!claims) return undefined;
  const now = expected.now ?? Math.floor(Date.now() / 1000);
  const actions = claims.actions;
  const standing = claims.standing ?? 'own_owner';
  const iat = claims.iat;
  const exp = claims.exp;
  if (
    claims.v !== 1 ||
    (claims.tier !== 'D' && claims.tier !== 'O') ||
    (standing !== 'own_owner' && standing !== 'code_owner') ||
    !Array.isArray(actions) ||
    actions.length < 1 ||
    actions.length > 20 ||
    !actions.every(validAction) ||
    typeof iat !== 'number' ||
    typeof exp !== 'number' ||
    typeof claims.approval_id !== 'string' ||
    typeof claims.delegate_agent_id !== 'string' ||
    typeof claims.grant_id !== 'string' ||
    typeof claims.owner_id !== 'string'
  ) {
    return undefined;
  }
  if (
    claims.ws !== expected.workspaceId ||
    claims.message_id !== expected.messageId ||
    claims.recipient_agent_id !== expected.recipientAgentId ||
    (expected.senderId !== undefined && claims.delegate_agent_id !== expected.senderId)
  ) {
    return undefined;
  }
  if (
    exp <= now ||
    iat > now + SKEW_SECS ||
    exp - now > MAX_LIFETIME_SECS ||
    exp - iat > MAX_LIFETIME_SECS ||
    exp < iat
  ) {
    return undefined;
  }
  // A config_change only ever changes the recipient itself, never its
  // delegation settings (as the node refuses it).
  for (const action of actions) {
    const change = action.class === 'config_change' ? parseConfigChangeTarget(action.target) : undefined;
    if (
      change &&
      (change.agentId !== expected.recipientAgentId ||
        RELAY_DELEGATION_PROTECTED_SETTINGS.includes(change.setting))
    ) {
      return undefined;
    }
  }
  const singleUse = claims.single_use === true;
  // A config change is always single use.
  if (!singleUse && actions.some((action) => action.class === 'config_change')) return undefined;
  return {
    verified: true,
    tier: claims.tier,
    standing,
    ownerId: claims.owner_id,
    ...(typeof claims.owner_display === 'string' ? { ownerDisplay: claims.owner_display } : {}),
    delegateAgentId: claims.delegate_agent_id,
    grantId: claims.grant_id,
    approvalId: claims.approval_id,
    actions,
    singleUse,
    ...(typeof claims.quote === 'string' ? { quote: claims.quote } : {}),
    expiresAt: new Date(exp * 1000).toISOString(),
    jws,
  };
}

/**
 * `message` with `delegation` set when `jws` verifies for it; otherwise without one.
 * @param message - The received message; any `delegation` it carries is dropped first
 * @param jws - Cloud's compact JWS attestation for it
 * @param jwks - Cloud's published keys
 * @param expected - The workspace, recipient and time; message and sender come from `message`
 * @returns A copy of the message, with `delegation` only when verified
 */
export function withVerifiedDelegation(
  message: RelayMessage,
  jws: string,
  jwks: RelayDelegationJwks,
  expected: Omit<RelayDelegationExpected, 'messageId' | 'senderId'>
): RelayMessage {
  const { delegation: _unverified, ...rest } = message;
  const delegation = verifyDelegationAttestation(jws, jwks, {
    ...expected,
    messageId: message.id,
    ...(message.from.id ? { senderId: message.from.id } : {}),
  });
  return delegation ? { ...rest, delegation } : rest;
}

/**
 * Whether a verified, unexpired delegation covers exactly this class and
 * target. Matching does not redeem the approval: call
 * {@link redeemOwnerApproval} right before every action.
 * @param message - A message whose `delegation` was set by {@link withVerifiedDelegation}
 * @param action - The exact class and target about to be acted on
 * @param now - Milliseconds since the epoch; defaults to `Date.now()`
 * @returns `true` only for a verified delegation, not yet expired, listing this action
 */
export function delegationCovers(
  message: Pick<RelayMessage, 'delegation'>,
  action: { class: RelayDelegationActionClass; target: string },
  now: number = Date.now()
): boolean {
  const delegation = message.delegation;
  return (
    delegation?.verified === true &&
    Date.parse(delegation.expiresAt) > now &&
    delegation.actions.some((covered) => covered.class === action.class && covered.target === action.target)
  );
}

/**
 * The wire shape of an owner approval (`owner_approval`, v1).
 * @param input - The approval as the SDK takes it
 * @returns The snake_case object Relaycast stores
 */
export function toWireOwnerApproval(input: RelayOwnerApprovalInput): Record<string, unknown> {
  return {
    v: 1,
    owner_id: input.ownerId,
    actions: input.actions.map((action) => ({
      class: action.class,
      target: action.target,
      ...(action.conditions?.length ? { conditions: action.conditions } : {}),
      ...(action.note !== undefined ? { note: action.note } : {}),
    })),
    ...(input.quote !== undefined ? { quote: input.quote } : {}),
    ...(input.quotedAt !== undefined ? { quoted_at: input.quotedAt } : {}),
    ...(input.quoteSource !== undefined ? { quote_source: input.quoteSource } : {}),
    ...(input.expiresAt !== undefined ? { expires_at: input.expiresAt } : {}),
    ...(input.approvalRef !== undefined ? { approval_ref: input.approvalRef } : {}),
  };
}

/**
 * Where to connect for the node's session socket at `path`: the path itself,
 * or on Windows the named pipe the core derives from it (the core's
 * `transport::pipe_name`: the path lowercased with backslash separators,
 * without a `\\?\` prefix or trailing separator, hashed with SHA-256, the
 * first 8 bytes in hex).
 * @param path - The session socket path, as the probe is given it
 * @param platform - Defaults to `process.platform`
 * @returns The path to connect to
 */
export function sessionSocketEndpoint(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return path;
  let key = path.replace(/\//g, '\\').toLowerCase();
  if (key.startsWith('\\\\?\\')) key = key.slice(4);
  while (key.length > 1 && key.endsWith('\\')) key = key.slice(0, -1);
  const hex = createHash('sha256').update(key, 'utf8').digest().subarray(0, 8).toString('hex');
  return `\\\\.\\pipe\\agent-relay-${hex}`;
}

/** What redeeming an approval came to. */
export type RelayRedeemResult =
  | { ok: true; consumed: boolean; checked?: { head_sha: string } }
  | { ok: false; reason: string; unmet?: unknown[] };

export interface RelayRedeemOptions {
  /**
   * The Agent Relay node's session socket. Defaults to `AGENT_RELAY_SOCKET`.
   * The node identifies the calling session by its process, so this works
   * only from inside a session the node has on the relay.
   */
  socketPath?: string;
}

/**
 * Redeems `approvalId` for `action`, right before acting, as the calling
 * session's own agent (`POST /delegation/redeem` on the node's session
 * socket). `condition_unmet` (with `unmet`) leaves the approval unconsumed:
 * wait and redeem again before it expires.
 *
 * On Windows the named pipe is opened by name, and Node cannot check which
 * process serves it; a pipe another local user created first could answer.
 * Use it only where local users are trusted, or verify the outcome through
 * Cloud.
 * @param approvalId - The approval id from the delegate line (`apv_…`)
 * @param action - The exact class and target about to be acted on
 * @param options - Where the node's session socket is
 * @returns `{ok: true, consumed}` or `{ok: false, reason, unmet?}`
 */
export async function redeemOwnerApproval(
  approvalId: string,
  action: { class: Exclude<RelayDelegationActionClass, 'prompt_approval'>; target: string },
  options: RelayRedeemOptions = {}
): Promise<RelayRedeemResult> {
  const socketPath = options.socketPath ?? process.env.AGENT_RELAY_SOCKET;
  if (!socketPath) {
    throw new Error('redeemOwnerApproval needs socketPath or AGENT_RELAY_SOCKET: the node session socket.');
  }
  const query = new URLSearchParams({ approval: approvalId, class: action.class, target: action.target });
  const answer = await postSessionSocket(socketPath, `/delegation/redeem?${query.toString()}`);
  if (answer.ok === true) {
    const checked = answer.checked as Record<string, unknown> | undefined;
    const sha = checked && typeof checked.head_sha === 'string' ? checked.head_sha : undefined;
    return {
      ok: true,
      consumed: answer.consumed === true,
      ...(sha && /^[0-9a-f]{40}$/.test(sha) ? { checked: { head_sha: sha } } : {}),
    };
  }
  return {
    ok: false,
    reason: typeof answer.reason === 'string' ? answer.reason : 'refused',
    ...(Array.isArray(answer.unmet) ? { unmet: answer.unmet } : {}),
  };
}

/**
 * POSTs to the node's session socket and unwraps its `{"ok": true, "data": …}` envelope.
 * @param socketPath - The session socket path
 * @param path - The route and query
 * @returns The route's answer (`data`)
 */
async function postSessionSocket(socketPath: string, path: string): Promise<Record<string, unknown>> {
  const route = path.split('?')[0];
  const body = await new Promise<string>((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: sessionSocketEndpoint(socketPath),
        method: 'POST',
        path,
        headers: { 'content-length': 0 },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`${route} refused (${res.statusCode}): ${text}`));
          } else {
            resolve(text);
          }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });
  // The socket wraps every answer as `{"ok": true, "data": …}`; the route's
  // own `ok` is inside `data`.
  const envelope = JSON.parse(body) as Record<string, unknown>;
  const data = envelope.data;
  if (envelope.ok !== true || !data || typeof data !== 'object') {
    throw new Error(`${route} answered without a result: ${body}`);
  }
  return data as Record<string, unknown>;
}

/**
 * Withdraws an approval this session's own agent sent as a delegate (narrowing
 * only, for a later "no" from the owner): `POST /delegation/withdraw` on the
 * node's session socket, which asks Cloud's `/messaging/delegation/withdraw`.
 * @param approvalId - The approval id (`apv_…`)
 * @param options - Where the node's session socket is
 * @returns `{ok: true}` or `{ok: false, reason}`
 */
export async function withdrawOwnerApproval(
  approvalId: string,
  options: RelayRedeemOptions = {}
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const socketPath = options.socketPath ?? process.env.AGENT_RELAY_SOCKET;
  if (!socketPath) {
    throw new Error('withdrawOwnerApproval needs socketPath or AGENT_RELAY_SOCKET: the node session socket.');
  }
  const query = new URLSearchParams({ approval: approvalId });
  const answer = await postSessionSocket(socketPath, `/delegation/withdraw?${query.toString()}`);
  if (answer.ok === true) return { ok: true };
  return { ok: false, reason: typeof answer.reason === 'string' ? answer.reason : 'refused' };
}
