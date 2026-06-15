/**
 * Shared scoring building blocks every scenario reuses: actual-send counts,
 * phantom detection, and delivery health derived from the broker event stream.
 */
import type { BrokerEvent } from '@agent-relay/harness-driver';

import type { ScenarioResult, TranscriptEntry } from '../types.js';
import { detectPhantoms } from './phantom.js';

/**
 * Build the message transcript from `relay_inbound` events — every message that
 * reached the broker, in order. Entries whose sender is an agent under test are
 * real tool-backed sends; the rest are the injected stimulus.
 */
export function buildTranscript(events: BrokerEvent[], agents: string[]): TranscriptEntry[] {
  const set = new Set(agents);
  return events
    .filter((e): e is Extract<BrokerEvent, { kind: 'relay_inbound' }> => e.kind === 'relay_inbound')
    .map((e) => ({
      from: e.from,
      target: e.target,
      body: e.body,
      fromAgent: set.has(e.from),
      threadId: e.thread_id,
    }));
}

/** Count `relay_inbound` events originating from any of the given agents. */
export function countSends(events: BrokerEvent[], agents: string[]): number {
  const set = new Set(agents);
  return events.filter((e) => e.kind === 'relay_inbound' && set.has(e.from)).length;
}

/** Coarse delivery-health counts for the report. */
export function deliveryCounts(events: BrokerEvent[]): {
  relayInbound: number;
  dropped: number;
  aclDenied: number;
} {
  return {
    relayInbound: events.filter((e) => e.kind === 'relay_inbound').length,
    dropped: events.filter((e) => e.kind === 'delivery_dropped').length,
    aclDenied: events.filter((e) => e.kind === 'acl_denied').length,
  };
}

export interface BaseScore {
  sent: number;
  phantoms: ScenarioResult['phantoms'];
  totalIntents: number;
  deliveryOk: boolean;
  events: ScenarioResult['events'];
  transcript: TranscriptEntry[];
}

/**
 * Compute the scenario-agnostic signals: how many messages the agents actually
 * sent, what phantom messages they emitted, whether delivery stayed clean, and
 * the message transcript.
 */
export function baseScore(events: BrokerEvent[], agents: string[]): BaseScore {
  const phantomResult = detectPhantoms(events, agents);
  const counts = deliveryCounts(events);
  return {
    sent: countSends(events, agents),
    phantoms: phantomResult.phantoms,
    totalIntents: phantomResult.totalIntents,
    deliveryOk: counts.dropped === 0 && counts.aclDenied === 0,
    events: counts,
    transcript: buildTranscript(events, agents),
  };
}
