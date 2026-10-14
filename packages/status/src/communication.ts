/** Communication policy v1. Pure decisions; this module does not send or acknowledge messages. */
import { z } from 'zod';

const id = z.string().min(1);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const instant = z.iso.datetime({ offset: true });
export const COMMUNICATION_STATUS_VERSION = 1 as const;
export const communicationLabel = z.enum(['open', 'knock', 'allow_list', 'busy', 'offline']);
export const communicationIdentity = z.strictObject({
  organizationId: id,
  workspaceId: id,
  agentId: id,
});
export const communicationPolicy = z.strictObject({
  schemaVersion: z.literal(COMMUNICATION_STATUS_VERSION),
  recipient: communicationIdentity,
  revision,
  admission: z.enum(['open', 'knock', 'allow_list']),
  interruption: z.enum(['available', 'busy']),
  allowedAgentIds: z.array(id),
});
export const communicationStatus = z.strictObject({
  schemaVersion: z.literal(COMMUNICATION_STATUS_VERSION),
  policy: communicationPolicy,
  connection: z.enum(['online', 'offline']),
  queueSupported: z.boolean(),
  /** Admission and connectivity can change independently. */
  revision,
  observedAt: instant,
});
export type CommunicationStatus = z.infer<typeof communicationStatus>;
export type CommunicationPolicy = z.infer<typeof communicationPolicy>;
export const conversationGrant = z.strictObject({
  schemaVersion: z.literal(COMMUNICATION_STATUS_VERSION),
  id,
  recipient: communicationIdentity,
  sender: communicationIdentity,
  conversationId: id,
  state: z.enum(['pending', 'approved', 'rejected', 'revoked', 'expired']),
  /** Monotonic for the recipient/sender/conversation tuple, including renewed knocks. */
  revision,
  expiresAt: instant,
});
export const communicationMessage = z.strictObject({
  id,
  sender: communicationIdentity,
  recipient: communicationIdentity,
  conversationId: id,
  inReplyTo: id.nullable(),
});
export const awaitedReply = z.strictObject({
  sender: communicationIdentity,
  conversationId: id,
  requestId: id,
});
export const communicationDecision = z.strictObject({
  action: z.enum(['deliver', 'request_approval', 'hold', 'queue', 'reject']),
  reason: z.enum([
    'allowed',
    'awaited_reply',
    'approval_required',
    'grant_rejected',
    'grant_revoked',
    'grant_expired',
    'not_allowed',
    'wrong_scope',
    'wrong_recipient',
    'busy',
    'offline',
    'offline_not_queueable',
  ]),
  policyRevision: revision,
});
export const communicationReceipt = z.strictObject({
  schemaVersion: z.literal(COMMUNICATION_STATUS_VERSION),
  messageId: id,
  state: z.enum(['pending_approval', 'held', 'queued', 'delivered', 'rejected', 'expired']),
  policyRevision: revision,
  observedAt: instant,
});
export const communicationDecisionInput = z.strictObject({
  status: communicationStatus,
  message: communicationMessage,
  grants: z.array(conversationGrant),
  awaitedReplies: z.array(awaitedReply),
  now: instant,
});
export type CommunicationDecision = z.infer<typeof communicationDecision>;

/** Named schemas exported for generated desktop contracts. */
export const communicationStatusSchemas = {
  CommunicationLabel: communicationLabel,
  CommunicationIdentity: communicationIdentity,
  CommunicationPolicy: communicationPolicy,
  CommunicationStatus: communicationStatus,
  ConversationGrant: conversationGrant,
  CommunicationMessage: communicationMessage,
  AwaitedReply: awaitedReply,
  CommunicationDecision: communicationDecision,
  CommunicationReceipt: communicationReceipt,
  CommunicationDecisionInput: communicationDecisionInput,
};

export function effectiveCommunicationStatus(
  status: CommunicationStatus
): z.infer<typeof communicationLabel> {
  return status.connection === 'offline'
    ? 'offline'
    : status.policy.interruption === 'busy'
      ? 'busy'
      : status.policy.admission;
}
const sameScope = (a: z.infer<typeof communicationIdentity>, b: z.infer<typeof communicationIdentity>) =>
  a.organizationId === b.organizationId && a.workspaceId === b.workspaceId;
const sameAgent = (a: z.infer<typeof communicationIdentity>, b: z.infer<typeof communicationIdentity>) =>
  sameScope(a, b) && a.agentId === b.agentId;

/** Call only with authenticated identities and current grants from trusted storage.
 * A deliver decision is permission to attempt delivery, never a delivered receipt.
 * Re-evaluate before injection, including after approval/reconnect/policy changes.
 */
export function decideCommunication(
  input: z.infer<typeof communicationDecisionInput>
): CommunicationDecision {
  const { status, message, grants, awaitedReplies, now } = communicationDecisionInput.parse(input);
  const p = status.policy;
  const result = (
    action: CommunicationDecision['action'],
    reason: CommunicationDecision['reason']
  ): CommunicationDecision => ({ action, reason, policyRevision: p.revision });
  if (!sameAgent(message.recipient, p.recipient)) return result('reject', 'wrong_recipient');
  if (!sameScope(message.sender, p.recipient)) return result('reject', 'wrong_scope');
  if (p.admission === 'allow_list' && !p.allowedAgentIds.includes(message.sender.agentId))
    return result('reject', 'not_allowed');
  if (p.admission === 'knock') {
    // The latest revision wins, even if an older grant was approved.
    const denialRank = (g: z.infer<typeof conversationGrant>) =>
      g.state === 'revoked'
        ? 5
        : g.state === 'rejected'
          ? 4
          : g.state === 'expired' || Date.parse(g.expiresAt) <= Date.parse(now)
            ? 3
            : g.state === 'pending'
              ? 2
              : 1;
    const matching = grants
      .filter(
        (g) =>
          sameAgent(g.sender, message.sender) &&
          sameAgent(g.recipient, p.recipient) &&
          g.conversationId === message.conversationId
      )
      .sort((a, b) => b.revision - a.revision || denialRank(b) - denialRank(a));
    const grant = matching[0];
    if (grant?.state === 'rejected') return result('reject', 'grant_rejected');
    if (grant?.state === 'revoked') return result('reject', 'grant_revoked');
    if (grant && (grant.state === 'expired' || Date.parse(grant.expiresAt) <= Date.parse(now)))
      return result('reject', 'grant_expired');
    if (!grant || grant.state !== 'approved') return result('request_approval', 'approval_required');
  }
  if (status.connection === 'offline')
    return result(
      status.queueSupported ? 'queue' : 'reject',
      status.queueSupported ? 'offline' : 'offline_not_queueable'
    );
  const expectedReply = awaitedReplies.some(
    (r) =>
      sameAgent(r.sender, message.sender) &&
      r.conversationId === message.conversationId &&
      r.requestId === message.inReplyTo
  );
  if (p.interruption === 'busy' && !expectedReply) return result('hold', 'busy');
  return result('deliver', expectedReply ? 'awaited_reply' : 'allowed');
}

/** Unsupported versions, stale responses, and read failures never reset a policy to Open. */
export function readCommunicationStatus(input: unknown, previous: CommunicationStatus) {
  const parsed = communicationStatus.safeParse(input);
  if (
    !parsed.success ||
    !sameAgent(parsed.data.policy.recipient, previous.policy.recipient) ||
    parsed.data.revision < previous.revision ||
    parsed.data.policy.revision < previous.policy.revision
  )
    return { status: previous, stale: true };
  return { status: parsed.data, stale: false };
}
