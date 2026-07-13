/**
 * Deterministic protocol checks over `relay_inbound` events.
 *
 * Encodes the rules the injected skill tells agents to follow
 * (`.claude/skills/using-agent-relay/SKILL.md`): ACK on task receipt before
 * reporting DONE, and reply in the channel shown rather than DMing the sender.
 */
import type { BrokerEvent } from '@agent-relay/harness-driver';

type RelayInbound = Extract<BrokerEvent, { kind: 'relay_inbound' }>;

function inboundFrom(events: BrokerEvent[], agent: string): RelayInbound[] {
  return events.filter((e): e is RelayInbound => e.kind === 'relay_inbound').filter((e) => e.from === agent);
}

function normalizeChannel(target: string): string {
  return target.replace(/^[#@]/, '').trim().toLowerCase();
}

function isChannelTarget(target: string): boolean {
  return target.startsWith('#');
}

export interface AckDoneResult {
  ackPresent: boolean;
  donePresent: boolean;
  orderOk: boolean;
  /** (ackPresent + donePresent + orderOk) / 3 */
  score: number;
}

/**
 * Score the ACK/DONE protocol for a worker reporting status to its lead.
 * ACK must appear before DONE in the agent's send order.
 *
 * The protocol rule is "report privately to the lead, not broadcast to a
 * channel", so this counts the worker's direct messages (non-channel targets).
 * It deliberately does not require a literal lead name: when the lead is
 * simulated by the harness, the reply target resolves to the harness identity,
 * but it is still a DM. Channel posts (target starts with `#`) are excluded.
 */
export function scoreAckDone(events: BrokerEvent[], worker: string): AckDoneResult {
  const sends = inboundFrom(events, worker).filter((e) => !isChannelTarget(e.target));
  const ackIdx = sends.findIndex((e) => /^\s*ack\b/i.test(e.body));
  const doneIdx = sends.findIndex((e) => /^\s*done\b/i.test(e.body));
  const ackPresent = ackIdx !== -1;
  const donePresent = doneIdx !== -1;
  const orderOk = ackPresent && donePresent && ackIdx < doneIdx;
  const score = (Number(ackPresent) + Number(donePresent) + Number(orderOk)) / 3;
  return { ackPresent, donePresent, orderOk, score };
}

export interface ChannelReplyResult {
  /** Replied at least once in the expected channel. */
  repliedToShownChannel: boolean;
  /** Sends that went to a DM or a different channel than expected. */
  wrongChannelReplies: number;
}

/**
 * Score whether `agent` replied in `expectedChannel` rather than DMing the
 * sender or posting elsewhere. Any send whose target is not the expected
 * channel counts as a wrong-channel reply.
 */
export function scoreChannelReply(
  events: BrokerEvent[],
  agent: string,
  expectedChannel: string
): ChannelReplyResult {
  const expected = normalizeChannel(expectedChannel);
  const sends = inboundFrom(events, agent);
  let repliedToShownChannel = false;
  let wrongChannelReplies = 0;
  for (const s of sends) {
    const target = normalizeChannel(s.target);
    if (isChannelTarget(s.target) && target === expected) {
      repliedToShownChannel = true;
    } else {
      wrongChannelReplies += 1;
    }
  }
  return { repliedToShownChannel, wrongChannelReplies };
}

/** True if `agent` sent at least one direct message (non-channel target). */
export function sentDirectMessage(events: BrokerEvent[], agent: string): boolean {
  return inboundFrom(events, agent).some((e) => !isChannelTarget(e.target));
}

/** True if `agent` sent at least one message whose target matches `name`. */
export function sentTo(events: BrokerEvent[], agent: string, name: string): boolean {
  return inboundFrom(events, agent).some((e) => normalizeChannel(e.target) === normalizeChannel(name));
}

/**
 * Trace a relay chain: each hop is an agent sending to the next. Returns how
 * many hops completed and whether the payload survived to the final target.
 */
export function scoreRelayChain(
  events: BrokerEvent[],
  hops: Array<{ from: string; to: string }>,
  payload: string,
  finalChannel: string
): { hopsCompleted: number; payloadIntact: boolean } {
  let hopsCompleted = 0;
  for (const hop of hops) {
    const sent = inboundFrom(events, hop.from).some(
      (e) => normalizeChannel(e.target) === normalizeChannel(hop.to)
    );
    if (sent) hopsCompleted += 1;
    else break;
  }
  const finalPost = events
    .filter((e): e is RelayInbound => e.kind === 'relay_inbound')
    .find((e) => normalizeChannel(e.target) === normalizeChannel(finalChannel) && e.body.includes(payload));
  return { hopsCompleted, payloadIntact: Boolean(finalPost) };
}
