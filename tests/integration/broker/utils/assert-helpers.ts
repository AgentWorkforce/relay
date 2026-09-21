/**
 * Custom assertion helpers for broker integration tests.
 *
 * Provides semantic assertions over BrokerEvent streams and
 * broker state, making tests more readable and failure messages
 * more informative.
 */
import assert from 'node:assert/strict';

import type { BrokerEvent, ListAgent } from '@agent-relay/harness-driver';
import type { BrokerHarness } from './broker-harness.js';

// ── Delivery assertions ──────────────────────────────────────────────────────

/**
 * Assert that a specific event_id appears in the relay_inbound events.
 */
export function assertDelivered(events: BrokerEvent[], eventId: string, message?: string): void {
  const inbound = events.filter((e) => e.kind === 'relay_inbound') as Array<
    Extract<BrokerEvent, { kind: 'relay_inbound' }>
  >;
  const found = inbound.some((e) => e.event_id === eventId);
  assert.ok(
    found,
    message ??
      `Expected event_id "${eventId}" to be delivered. ` +
        `Got ${inbound.length} relay_inbound events: ${JSON.stringify(inbound.map((e) => e.event_id))}`
  );
}

/**
 * Assert that no event_id appears more than once in relay_inbound events.
 * Detects duplicate delivery bugs.
 */
export function assertNoDoubleDelivery(events: BrokerEvent[]): void {
  const inbound = events.filter((e) => e.kind === 'relay_inbound') as Array<
    Extract<BrokerEvent, { kind: 'relay_inbound' }>
  >;
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const event of inbound) {
    if (seen.has(event.event_id)) {
      dupes.push(event.event_id);
    }
    seen.add(event.event_id);
  }
  assert.equal(dupes.length, 0, `Double-delivered event IDs: ${JSON.stringify(dupes)}`);
}

// ── Event order assertions ───────────────────────────────────────────────────

/**
 * Assert that events of the given kinds appear in the expected order.
 * Only checks relative ordering (doesn't require events to be contiguous).
 *
 * @example
 *   assertEventOrder(events, ["agent_spawned", "relay_inbound", "agent_released"]);
 */
export function assertEventOrder(events: BrokerEvent[], expectedKinds: BrokerEvent['kind'][]): void {
  const kinds = events.map((e) => e.kind);
  let searchFrom = 0;
  for (const expected of expectedKinds) {
    const idx = kinds.indexOf(expected, searchFrom);
    assert.ok(
      idx !== -1,
      `Expected event "${expected}" not found after index ${searchFrom}. ` +
        `Event kinds: ${JSON.stringify(kinds)}`
    );
    searchFrom = idx + 1;
  }
}

/**
 * Assert that a specific sequence of event kinds appears exactly
 * (contiguous, in order) within the events array.
 */
export function assertEventSequence(events: BrokerEvent[], sequence: BrokerEvent['kind'][]): void {
  const kinds = events.map((e) => e.kind);
  const seqStr = JSON.stringify(sequence);
  let found = false;
  for (let i = 0; i <= kinds.length - sequence.length; i++) {
    const slice = kinds.slice(i, i + sequence.length);
    if (JSON.stringify(slice) === seqStr) {
      found = true;
      break;
    }
  }
  assert.ok(
    found,
    `Expected contiguous sequence ${seqStr} not found in events. ` + `Event kinds: ${JSON.stringify(kinds)}`
  );
}

// ── Agent state assertions ───────────────────────────────────────────────────

/**
 * Assert that the broker currently has exactly `count` agents.
 */
export async function assertAgentCount(
  harness: BrokerHarness,
  count: number,
  message?: string
): Promise<void> {
  const agents = await harness.listAgents();
  assert.equal(
    agents.length,
    count,
    message ?? `Expected ${count} agents, got ${agents.length}: ${JSON.stringify(agents.map((a) => a.name))}`
  );
}

/**
 * Assert that an agent with the given name exists in the broker.
 */
export async function assertAgentExists(harness: BrokerHarness, name: string): Promise<ListAgent> {
  const agents = await harness.listAgents();
  const agent = agents.find((a) => a.name === name);
  assert.ok(
    agent,
    `Expected agent "${name}" to exist. ` + `Registered: ${JSON.stringify(agents.map((a) => a.name))}`
  );
  return agent;
}

/**
 * Assert that an agent with the given name does NOT exist in the broker.
 */
export async function assertAgentNotExists(harness: BrokerHarness, name: string): Promise<void> {
  const agents = await harness.listAgents();
  const agent = agents.find((a) => a.name === name);
  assert.ok(!agent, `Expected agent "${name}" to NOT exist, but it was found`);
}

// ── Event content assertions ─────────────────────────────────────────────────

/**
 * Assert that an agent_spawned event exists for the given agent name.
 */
export function assertAgentSpawnedEvent(events: BrokerEvent[], name: string): void {
  const spawned = events.filter((e) => e.kind === 'agent_spawned') as Array<
    Extract<BrokerEvent, { kind: 'agent_spawned' }>
  >;
  const found = spawned.some((e) => e.name === name);
  assert.ok(
    found,
    `Expected agent_spawned event for "${name}". ` +
      `Got spawned events for: ${JSON.stringify(spawned.map((e) => e.name))}`
  );
}

/**
 * Assert that an agent_released event exists for the given agent name.
 */
export function assertAgentReleasedEvent(events: BrokerEvent[], name: string): void {
  const released = events.filter((e) => e.kind === 'agent_released') as Array<
    Extract<BrokerEvent, { kind: 'agent_released' }>
  >;
  const found = released.some((e) => e.name === name);
  assert.ok(
    found,
    `Expected agent_released event for "${name}". ` +
      `Got released events for: ${JSON.stringify(released.map((e) => e.name))}`
  );
}

/**
 * Assert that no delivery_dropped events occurred.
 */
export function assertNoDroppedDeliveries(events: BrokerEvent[]): void {
  const dropped = events.filter((e) => e.kind === 'delivery_dropped');
  assert.equal(dropped.length, 0, `Unexpected delivery_dropped events: ${JSON.stringify(dropped)}`);
}

/**
 * Assert that no acl_denied events occurred.
 */
export function assertNoAclDenied(events: BrokerEvent[]): void {
  const denied = events.filter((e) => e.kind === 'acl_denied');
  assert.equal(denied.length, 0, `Unexpected acl_denied events: ${JSON.stringify(denied)}`);
}

/**
 * Filter events by agent name and optional kind.
 * Handles the BrokerEvent union type safely.
 */
export function eventsForAgent(events: BrokerEvent[], name: string, kind?: string): BrokerEvent[] {
  return events.filter(
    (e) => 'name' in e && (e as BrokerEvent & { name: string }).name === name && (!kind || e.kind === kind)
  );
}

// ── Observation accounting ───────────────────────────────────────────────────

/**
 * The `verification` values that mean the broker actually observed the
 * delivery land, mirroring `is_observed` in
 * `crates/broker/src/broker/delivery_verification.rs`.
 *
 * `echo` — the worker saw the injection echoed back by the child.
 * `process_exit` — a headless child consumed the message and exited cleanly.
 *
 * Anything else (today: `timeout_fallback`) is a delivery the worker wrote and
 * never saw land. Seam rule 4 forbids claiming an acknowledgement nobody
 * observed, so those deliveries carry NO `delivery_ack`.
 */
const OBSERVED_VERIFICATIONS = new Set(['echo', 'process_exit']);

export function isObservedVerification(event: BrokerEvent): boolean {
  const { verification } = event as BrokerEvent & { verification?: string };
  // A frame with no `verification` predates the field; treat it as observed so
  // this helper cannot retroactively fail older recordings.
  return verification === undefined || OBSERVED_VERIFICATIONS.has(verification);
}

/**
 * Assert the delivery-observation ledger balances for one agent.
 *
 * The pre-seam invariant was `delivery_ack.length === delivery_verified.length`.
 * That equality is now wrong by construction: an unobserved delivery emits
 * `delivery_verified` (verification `timeout_fallback`) plus
 * `delivery_unobserved`, and deliberately no `delivery_ack`.
 *
 * The invariant that survives is a per-delivery accounting identity — every
 * verified delivery is EITHER observed and acked with the same `delivery_id`,
 * OR unobserved and reported as such with the same `delivery_id`. Aggregate
 * counts are insufficient: an extra ack for one delivery can otherwise hide a
 * missing ack for another.
 */
export function assertDeliveryObservationLedger(
  events: BrokerEvent[],
  name: string,
  message?: string
): { acks: BrokerEvent[]; verified: BrokerEvent[]; unobserved: BrokerEvent[] } {
  const acks = eventsForAgent(events, name, 'delivery_ack');
  const verified = eventsForAgent(events, name, 'delivery_verified');
  const unobserved = eventsForAgent(events, name, 'delivery_unobserved');

  const observedVerified = verified.filter(isObservedVerification);
  const unobservedVerified = verified.filter((e) => !isObservedVerification(e));
  const prefix = message ? `${message}: ` : '';

  assert.ok(
    verified.length > 0,
    `${prefix}delivery observation ledger is empty; no delivery_verified event was exercised`
  );

  const deliveryId = (event: BrokerEvent): string => {
    const id = (event as BrokerEvent & { delivery_id?: unknown }).delivery_id;
    if (typeof id !== 'string') {
      assert.fail(`${prefix}${event.kind} must carry a delivery_id`);
    }
    assert.ok(id.length > 0, `${prefix}${event.kind} must carry a non-empty delivery_id`);
    return id;
  };
  const ids = new Set([...acks, ...verified, ...unobserved].map(deliveryId));

  for (const id of ids) {
    const acksForId = acks.filter((event) => deliveryId(event) === id);
    const observedForId = observedVerified.filter((event) => deliveryId(event) === id);
    const unobservedVerifiedForId = unobservedVerified.filter((event) => deliveryId(event) === id);
    const unobservedForId = unobserved.filter((event) => deliveryId(event) === id);

    assert.equal(
      acksForId.length,
      observedForId.length,
      `${prefix}every OBSERVED delivery_verified must have a delivery_ack for delivery_id=${id} ` +
        `(acks=${acksForId.length}, observed verified=${observedForId.length})`
    );
    assert.equal(
      unobservedForId.length,
      unobservedVerifiedForId.length,
      `${prefix}every UNOBSERVED delivery_verified must be reported as delivery_unobserved ` +
        `for delivery_id=${id} (delivery_unobserved=${unobservedForId.length}, ` +
        `unobserved verified=${unobservedVerifiedForId.length})`
    );
  }

  return { acks, verified, unobserved };
}
