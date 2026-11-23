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

import { createPublicKey, verify as verifySignature } from 'node:crypto';
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

/** A `config_change` target as its parts, or `undefined` when malformed. */
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
    (a.class !== 'config_change' || parseConfigChangeTarget(a.target) !== undefined)
  );
}

/**
 * The verified delegation `jws` attests for this delivery, or `undefined`
 * when it does not verify: a bad signature, an unknown key id, another
 * workspace, message, recipient or sender, an expired or over-long
 * attestation, or claims that are not v1.
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
  if (exp <= now || iat > now + SKEW_SECS || exp - now > MAX_LIFETIME_SECS || exp < iat) {
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
    redeemFirst:
      singleUse ||
      actions.some((action) => action.class === 'config_change' || (action.conditions?.length ?? 0) > 0),
    expiresAt: new Date(exp * 1000).toISOString(),
    jws,
  };
}

/** `message` with `delegation` set when `jws` verifies for it; otherwise without one. */
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

/** Whether a verified delegation covers exactly this class and target. */
export function delegationCovers(
  message: Pick<RelayMessage, 'delegation'>,
  action: { class: RelayDelegationActionClass; target: string }
): boolean {
  return (
    message.delegation?.verified === true &&
    message.delegation.actions.some(
      (covered) => covered.class === action.class && covered.target === action.target
    )
  );
}

/** The wire shape of an owner approval (`owner_approval`, v1). */
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

/** What redeeming an approval came to. */
export type RelayRedeemResult =
  { ok: true; consumed: boolean } | { ok: false; reason: string; unmet?: unknown[] };

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
  const body = await new Promise<string>((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        method: 'POST',
        path: `/delegation/redeem?${query.toString()}`,
        headers: { 'content-length': 0 },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`redeem refused (${res.statusCode}): ${text}`));
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
  const answer = JSON.parse(body) as Record<string, unknown>;
  if (answer.ok === true) return { ok: true, consumed: answer.consumed === true };
  return {
    ok: false,
    reason: typeof answer.reason === 'string' ? answer.reason : 'refused',
    ...(Array.isArray(answer.unmet) ? { unmet: answer.unmet } : {}),
  };
}
