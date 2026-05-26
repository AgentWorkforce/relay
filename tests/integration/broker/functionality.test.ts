/**
 * Full functionality tests for the real CLI delivery pipeline.
 *
 * Tests complete feature coverage: worker_stream output capture,
 * delivery event field shapes, threading, priority, bypass prompt
 * handling, and channel isolation.
 *
 * Run:
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   RELAY_INTEGRATION_REAL_CLI=1 node --test tests/integration/broker/dist/functionality.test.js
 *
 * Requires:
 *   RELAY_API_KEY — Relaycast workspace key
 *   RELAY_INTEGRATION_REAL_CLI=1 — opt-in for real CLI tests
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { BrokerEvent } from '@agent-relay/sdk';
import { BrokerHarness, checkPrerequisites, uniqueSuffix } from './utils/broker-harness.js';
import {
  assertNoDroppedDeliveries,
  assertAgentExists,
  assertAgentSpawnedEvent,
  eventsForAgent,
} from './utils/assert-helpers.js';
import { skipIfNotRealCli, skipIfCliMissing, skipUnlessAnyCli, sleep } from './utils/cli-helpers.js';

function skipIfMissing(t: TestContext): boolean {
  const reason = checkPrerequisites();
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

// ── worker_stream Capture ──────────────────────────────────────────────────

test('functionality: worker_stream — CLI output captured as events', { timeout: 90_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `stream-${uniqueSuffix()}`;

  try {
    harness.clearEvents();
    await harness.spawnAgent(agentName, cli, ['general']);

    // Wait for CLI startup output
    await sleep(15_000);

    const events = harness.getEvents();
    const streams = eventsForAgent(events, agentName, 'worker_stream');

    assert.ok(
      streams.length >= 3,
      `should have at least 3 worker_stream events during startup, got ${streams.length}`
    );

    // Verify stream events have correct shape
    for (const ev of streams) {
      const s = ev as BrokerEvent & { stream: string; chunk: string };
      assert.ok(
        s.stream === 'stdout' || s.stream === 'stderr',
        `stream should be stdout or stderr, got ${s.stream}`
      );
      assert.ok(typeof s.chunk === 'string', 'chunk should be a string');
    }

    // Total output should be substantial (CLI startup)
    const totalBytes = streams.reduce((sum, ev) => {
      const s = ev as BrokerEvent & { chunk: string };
      return sum + s.chunk.length;
    }, 0);
    assert.ok(totalBytes > 100, `total worker_stream output should be > 100 bytes, got ${totalBytes}`);

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

// ── Delivery Event Fields ──────────────────────────────────────────────────

test('functionality: delivery event fields — verify payload shapes', { timeout: 90_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `fields-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, cli, ['general']);
    await sleep(12_000);

    harness.clearEvents();
    const result = await harness.sendMessage({
      to: agentName,
      from: 'func-test',
      text: 'Delivery field verification test',
    });

    await sleep(10_000);

    const events = harness.getEvents();

    // Check delivery_queued
    const queued = eventsForAgent(events, agentName, 'delivery_queued');
    assert.ok(queued.length >= 1, 'should have delivery_queued');
    const qEvent = queued[0] as BrokerEvent & {
      delivery_id?: string;
      event_id?: string;
    };
    assert.ok(qEvent.delivery_id, 'delivery_queued should have delivery_id');
    assert.ok(qEvent.event_id, 'delivery_queued should have event_id');

    // Check delivery_injected
    const injected = eventsForAgent(events, agentName, 'delivery_injected');
    assert.ok(injected.length >= 1, 'should have delivery_injected');
    const iEvent = injected[0] as BrokerEvent & {
      delivery_id?: string;
      event_id?: string;
    };
    assert.ok(iEvent.delivery_id, 'delivery_injected should have delivery_id');
    assert.ok(iEvent.event_id, 'delivery_injected should have event_id');

    // Check delivery_ack
    const acks = eventsForAgent(events, agentName, 'delivery_ack');
    assert.ok(acks.length >= 1, 'should have delivery_ack');
    const aEvent = acks[0] as BrokerEvent & {
      delivery_id?: string;
      event_id?: string;
    };
    assert.ok(aEvent.delivery_id, 'delivery_ack should have delivery_id');
    assert.ok(aEvent.event_id, 'delivery_ack should have event_id');

    // Check delivery_verified
    const verified = eventsForAgent(events, agentName, 'delivery_verified');
    assert.ok(verified.length >= 1, 'should have delivery_verified');
    const vEvent = verified[0] as BrokerEvent & {
      delivery_id?: string;
      event_id?: string;
    };
    assert.ok(vEvent.delivery_id, 'delivery_verified should have delivery_id');
    assert.ok(vEvent.event_id, 'delivery_verified should have event_id');

    // All events should share the same delivery_id
    if (qEvent.delivery_id && iEvent.delivery_id && aEvent.delivery_id && vEvent.delivery_id) {
      assert.equal(iEvent.delivery_id, qEvent.delivery_id, 'injected delivery_id should match queued');
      assert.equal(aEvent.delivery_id, qEvent.delivery_id, 'ack delivery_id should match queued');
      assert.equal(vEvent.delivery_id, qEvent.delivery_id, 'verified delivery_id should match queued');
    }

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

// ── Thread ID Preservation ─────────────────────────────────────────────────

test('functionality: thread_id — threaded messages accepted', { timeout: 90_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `thread-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, cli, ['general']);
    await sleep(12_000);

    // Message 1 — no thread
    const msg1 = await harness.sendMessage({
      to: agentName,
      from: 'func-test',
      text: 'Thread parent message',
    });
    assert.ok(msg1.event_id, 'parent message should get event_id');

    await sleep(3_000);

    // Message 2 — threaded to msg1
    const msg2 = await harness.sendMessage({
      to: agentName,
      from: 'func-test',
      text: 'Thread reply 1',
      threadId: msg1.event_id,
    });
    assert.ok(msg2.event_id, 'threaded reply should get event_id');

    // Message 3 — also threaded to msg1
    const msg3 = await harness.sendMessage({
      to: agentName,
      from: 'func-test',
      text: 'Thread reply 2',
      threadId: msg1.event_id,
    });
    assert.ok(msg3.event_id, 'second threaded reply should get event_id');

    // All 3 should have unique event_ids
    const ids = new Set([msg1.event_id, msg2.event_id, msg3.event_id]);
    assert.equal(ids.size, 3, 'all 3 messages should have unique event_ids');

    await sleep(10_000);

    // Verify deliveries occurred
    const events = harness.getEvents();
    const acks = eventsForAgent(events, agentName, 'delivery_ack');
    assert.ok(
      acks.length >= 2,
      `should have at least 2 delivery_ack for threaded messages, got ${acks.length}`
    );

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

// ── Priority ───────────────────────────────────────────────────────────────

test('functionality: priority — P1 and P4 messages both delivered', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `priority-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, cli, ['general']);
    await sleep(12_000);

    // Send P4 (low) then P1 (high)
    const low = await harness.sendMessage({
      to: agentName,
      from: 'func-test',
      text: 'LOW_PRIORITY_MSG',
      priority: 4,
    });
    const high = await harness.sendMessage({
      to: agentName,
      from: 'func-test',
      text: 'HIGH_PRIORITY_MSG',
      priority: 1,
    });

    assert.ok(low.event_id, 'low priority message should get event_id');
    assert.ok(high.event_id, 'high priority message should get event_id');

    await sleep(15_000);

    const events = harness.getEvents();
    const acks = eventsForAgent(events, agentName, 'delivery_ack');

    // Both should be delivered
    assert.ok(acks.length >= 2, `both priority messages should be delivered, got ${acks.length} acks`);

    assertNoDroppedDeliveries(events);

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

// ── Bypass Prompt Handling ─────────────────────────────────────────────────

test(
  'functionality: bypass prompt — Claude starts with --dangerously-skip-permissions',
  { timeout: 90_000 },
  async (t) => {
    if (skipIfMissing(t)) return;
    if (skipIfNotRealCli(t)) return;
    if (skipIfCliMissing(t, 'claude')) return;

    const harness = new BrokerHarness();
    await harness.start();
    const agentName = `bypass-${uniqueSuffix()}`;

    try {
      harness.clearEvents();
      await harness.spawnAgent(agentName, 'claude', ['general']);

      // Wait for startup + bypass prompt handling
      await sleep(15_000);

      // Agent should be alive (bypass was auto-handled)
      await assertAgentExists(harness, agentName);

      // Send a test message to verify agent is functional
      const result = await harness.sendMessage({
        to: agentName,
        from: 'func-test',
        text: 'Bypass verification test',
      });
      assert.ok(result.event_id);

      await sleep(10_000);

      const events = harness.getEvents();

      // No worker_error events
      const errors = eventsForAgent(events, agentName, 'worker_error');
      assert.equal(errors.length, 0, 'no worker_error after bypass');

      // Should get delivery_ack (agent is functional)
      const acks = eventsForAgent(events, agentName, 'delivery_ack');
      assert.ok(acks.length >= 1, 'Claude should process messages after bypass prompt auto-handling');

      // Check worker_stream output doesn't contain stuck permission prompts
      const streams = eventsForAgent(events, agentName, 'worker_stream');
      const fullOutput = streams.map((e) => (e as BrokerEvent & { chunk: string }).chunk).join('');
      const lowerOutput = fullOutput.toLowerCase();

      // Should NOT still be stuck on permission prompt
      const stuckPatterns = [
        'do you want to allow',
        'are you sure you want to proceed',
        'waiting for confirmation',
      ];
      for (const pattern of stuckPatterns) {
        // Only flag if the pattern appears in the LAST portion of output
        // (early occurrence during auto-handling is expected)
        const lastChunk = lowerOutput.slice(-500);
        assert.ok(!lastChunk.includes(pattern), `agent should not be stuck on "${pattern}" prompt`);
      }

      await harness.releaseAgent(agentName);
      await sleep(1_000);
    } finally {
      await harness.stop();
    }
  }
);

// ── worker_stream During Processing ────────────────────────────────────────

test(
  'functionality: worker_stream during message processing — output captured',
  { timeout: 120_000 },
  async (t) => {
    if (skipIfMissing(t)) return;
    const cli = skipUnlessAnyCli(t);
    if (!cli) return;

    const harness = new BrokerHarness();
    await harness.start();
    const agentName = `process-${uniqueSuffix()}`;

    try {
      await harness.spawnAgent(agentName, cli, ['general']);
      await sleep(12_000);

      // Clear events to isolate message processing output
      harness.clearEvents();

      await harness.sendMessage({
        to: agentName,
        from: 'func-test',
        text: 'Reply with exactly: RELAY_TEST_ECHO_12345',
      });

      // Wait for agent to process and respond
      await sleep(30_000);

      const events = harness.getEvents();
      const streams = eventsForAgent(events, agentName, 'worker_stream');

      // Agent should produce output while processing the message
      const totalBytes = streams.reduce((sum, ev) => {
        const s = ev as BrokerEvent & { chunk: string };
        return sum + s.chunk.length;
      }, 0);

      assert.ok(totalBytes > 200, `should capture > 200 bytes of processing output, got ${totalBytes}`);

      await harness.releaseAgent(agentName);
      await sleep(1_000);
    } finally {
      await harness.stop();
    }
  }
);

// ── Channel Isolation ──────────────────────────────────────────────────────

test(
  'functionality: channel isolation — messages route to correct agent',
  { timeout: 120_000 },
  async (t) => {
    if (skipIfMissing(t)) return;
    const cli = skipUnlessAnyCli(t);
    if (!cli) return;

    const harness = new BrokerHarness();
    await harness.start();
    const suffix = uniqueSuffix();
    const agentA = `alpha-agent-${suffix}`;
    const agentB = `beta-agent-${suffix}`;

    try {
      await harness.spawnAgent(agentA, cli, ['alpha']);
      await harness.spawnAgent(agentB, cli, ['beta']);
      await sleep(15_000);

      await assertAgentExists(harness, agentA);
      await assertAgentExists(harness, agentB);

      harness.clearEvents();

      // Send to agent A
      await harness.sendMessage({
        to: agentA,
        from: 'func-test',
        text: 'Message for alpha agent',
      });

      // Send to agent B
      await harness.sendMessage({
        to: agentB,
        from: 'func-test',
        text: 'Message for beta agent',
      });

      await sleep(15_000);

      const events = harness.getEvents();

      // Agent A should have delivery_ack
      const acksA = eventsForAgent(events, agentA, 'delivery_ack');
      assert.ok(acksA.length >= 1, 'agent A should receive delivery_ack');

      // Agent B should have delivery_ack
      const acksB = eventsForAgent(events, agentB, 'delivery_ack');
      assert.ok(acksB.length >= 1, 'agent B should receive delivery_ack');

      assertNoDroppedDeliveries(events);

      await harness.releaseAgent(agentA);
      await harness.releaseAgent(agentB);
      await sleep(1_000);
    } finally {
      await harness.stop();
    }
  }
);

// ── Agent Spawn Event Fields ───────────────────────────────────────────────

test('functionality: agent_spawned event — correct fields', { timeout: 60_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `spawnevt-${uniqueSuffix()}`;

  try {
    harness.clearEvents();
    await harness.spawnAgent(agentName, cli, ['general']);
    await sleep(5_000);

    const events = harness.getEvents();

    // Verify agent_spawned event
    assertAgentSpawnedEvent(events, agentName);

    const spawned = events.find(
      (e) => e.kind === 'agent_spawned' && (e as BrokerEvent & { name: string }).name === agentName
    ) as BrokerEvent & { name: string; runtime?: string };

    assert.ok(spawned, 'agent_spawned event should exist');
    assert.equal(spawned.name, agentName, 'name should match');
    assert.equal(spawned.runtime, 'pty', 'runtime should be pty');

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});
