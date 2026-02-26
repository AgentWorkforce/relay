/**
 * Broker event stream integration tests.
 *
 * Tests the broker's event emission, event ordering, event
 * collection, and the waitForEvent utility.
 *
 * Run:
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   node --test tests/integration/broker/dist/events.test.js
 *
 * Requires:
 *   RELAY_API_KEY — Relaycast workspace key
 *   AGENT_RELAY_BIN (optional) — path to agent-relay binary
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { BrokerHarness, checkPrerequisites, uniqueSuffix } from './utils/broker-harness.js';
import {
  assertEventOrder,
  assertEventSequence,
  assertAgentSpawnedEvent,
  assertAgentReleasedEvent,
  assertNoAclDenied,
} from './utils/assert-helpers.js';
import type { BrokerEvent } from '@agent-relay/sdk';

function skipIfMissing(t: TestContext): boolean {
  const reason = checkPrerequisites();
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('broker: event subscription receives all event kinds', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const name = `evtsub-${suffix}`;

  const collected: BrokerEvent[] = [];
  const unsub = harness.onEvent((event) => collected.push(event));

  try {
    await harness.spawnAgent(name);
    await harness.waitForEvent('agent_spawned', 5_000, (e) => e.kind === 'agent_spawned' && e.name === name)
      .promise;

    await harness.releaseAgent(name);
    await harness.waitForEvent('agent_released', 5_000, (e) => e.kind === 'agent_released' && e.name === name)
      .promise;

    // The subscription should have received at least spawn + release
    const kinds = collected.map((e) => e.kind);
    assert.ok(kinds.includes('agent_spawned'), 'subscription should see agent_spawned');
    assert.ok(kinds.includes('agent_released'), 'subscription should see agent_released');
  } finally {
    unsub();
    await harness.stop();
  }
});

test('broker: collectEvents captures events over a duration', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const name = `collect-${suffix}`;

  try {
    // Start collecting before spawn
    const collectPromise = harness.collectEvents(3_000);

    // Trigger events during collection window
    await harness.spawnAgent(name);
    await new Promise((r) => setTimeout(r, 500));
    await harness.releaseAgent(name);

    const events = await collectPromise;
    assert.ok(events.length > 0, 'should have collected at least one event');

    const kinds = events.map((e) => e.kind);
    assert.ok(
      kinds.includes('agent_spawned') || kinds.includes('agent_released'),
      `collected events should include lifecycle events, got: ${JSON.stringify(kinds)}`
    );
  } finally {
    await harness.stop();
  }
});

test("broker: waitForEvent times out when event doesn't arrive", async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  harness.clearEvents();

  try {
    // Wait for an event that will never come, with short timeout
    await assert.rejects(
      harness.waitForEvent(
        'agent_spawned',
        500,
        (e) => e.kind === 'agent_spawned' && (e as any).name === 'never-exists'
      ).promise,
      (err: Error) => err.message.includes('Timed out'),
      'should reject with timeout error'
    );
  } finally {
    await harness.stop();
  }
});

test('broker: waitForEvent resolves from buffer if event already arrived', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const name = `buffered-${suffix}`;

  try {
    // Trigger an event
    await harness.spawnAgent(name);
    // Wait a bit for the event to land in the buffer
    await new Promise((r) => setTimeout(r, 500));

    // Now wait for it — should resolve immediately from buffer
    const event = await harness.waitForEvent(
      'agent_spawned',
      1_000,
      (e) => e.kind === 'agent_spawned' && e.name === name
    ).promise;

    assert.ok(event, 'should resolve from buffer');
    assert.equal(event.kind, 'agent_spawned');
  } finally {
    try {
      await harness.releaseAgent(name);
    } catch {}
    await harness.stop();
  }
});

test('broker: clearEvents resets the event buffer', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();

  try {
    // Generate some events
    await harness.spawnAgent(`clear-a-${suffix}`);
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(harness.getEvents().length > 0, 'should have events before clear');

    harness.clearEvents();
    assert.equal(harness.getEvents().length, 0, 'should have no events after clear');

    // Generate more events
    await harness.spawnAgent(`clear-b-${suffix}`);
    await new Promise((r) => setTimeout(r, 300));

    const events = harness.getEvents();
    assert.ok(events.length > 0, 'should have new events after clear');

    // Only the second spawn should be present
    assertAgentSpawnedEvent(events, `clear-b-${suffix}`);
  } finally {
    try {
      await harness.releaseAgent(`clear-a-${suffix}`);
    } catch {}
    try {
      await harness.releaseAgent(`clear-b-${suffix}`);
    } catch {}
    await harness.stop();
  }
});

test('broker: getEventsByKind filters correctly', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const name = `filter-${suffix}`;

  try {
    harness.clearEvents();
    await harness.spawnAgent(name);
    await harness.waitForEvent('agent_spawned', 5_000, (e) => e.kind === 'agent_spawned' && e.name === name)
      .promise;

    await harness.releaseAgent(name);
    await harness.waitForEvent('agent_released', 5_000, (e) => e.kind === 'agent_released' && e.name === name)
      .promise;

    const spawned = harness.getEventsByKind('agent_spawned');
    const released = harness.getEventsByKind('agent_released');
    const nonexistent = harness.getEventsByKind('nonexistent_kind');

    assert.ok(spawned.length > 0, 'should have spawned events');
    assert.ok(released.length > 0, 'should have released events');
    assert.equal(nonexistent.length, 0, 'should have no nonexistent events');

    // All filtered events should be the right kind
    for (const e of spawned) assert.equal(e.kind, 'agent_spawned');
    for (const e of released) assert.equal(e.kind, 'agent_released');
  } finally {
    await harness.stop();
  }
});

test('broker: full lifecycle event sequence', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const nameA = `seqA-${suffix}`;
  const nameB = `seqB-${suffix}`;

  try {
    harness.clearEvents();

    // Spawn A, then B
    await harness.spawnAgent(nameA);
    await harness.waitForEvent('agent_spawned', 5_000, (e) => e.kind === 'agent_spawned' && e.name === nameA)
      .promise;

    await harness.spawnAgent(nameB);
    await harness.waitForEvent('agent_spawned', 5_000, (e) => e.kind === 'agent_spawned' && e.name === nameB)
      .promise;

    // Release A, then B
    await harness.releaseAgent(nameA);
    await harness.waitForEvent(
      'agent_released',
      5_000,
      (e) => e.kind === 'agent_released' && e.name === nameA
    ).promise;

    await harness.releaseAgent(nameB);
    await harness.waitForEvent(
      'agent_released',
      5_000,
      (e) => e.kind === 'agent_released' && e.name === nameB
    ).promise;

    // The full event order should be: spawn_A, spawn_B, release_A, release_B
    const events = harness.getEvents();
    assertEventOrder(events, [
      'agent_spawned', // A
      'agent_spawned', // B
      'agent_released', // A
      'agent_released', // B
    ]);

    assertNoAclDenied(events);
  } finally {
    await harness.stop();
  }
});
