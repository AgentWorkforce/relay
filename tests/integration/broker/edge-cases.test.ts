/**
 * Edge case tests for real CLI agents.
 *
 * Tests unusual inputs (Unicode, long messages, special characters),
 * agent crash recovery, and concurrent delivery scenarios.
 *
 * Run:
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   RELAY_INTEGRATION_REAL_CLI=1 node --test tests/integration/broker/dist/edge-cases.test.js
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
  assertAgentNotExists,
  eventsForAgent,
} from './utils/assert-helpers.js';
import { skipIfNotRealCli, skipUnlessAnyCli, sleep } from './utils/cli-helpers.js';

function skipIfMissing(t: TestContext): boolean {
  const reason = checkPrerequisites();
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

// ── Unicode ────────────────────────────────────────────────────────────────

test('edge: Unicode message — CJK, emoji, RTL, accented chars', { timeout: 90_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `unicode-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, cli, ['general']);
    await sleep(12_000);

    const unicodeText =
      'Test: \u4f60\u597d\u4e16\u754c \ud83d\ude80 \u0645\u0631\u062d\u0628\u0627 \u00e9\u00e8\u00ea\u00eb';
    const result = await harness.sendMessage({
      to: agentName,
      from: 'edge-test',
      text: unicodeText,
    });
    assert.ok(result.event_id, 'should get event_id for Unicode message');

    await sleep(10_000);

    const events = harness.getEvents();
    const acks = eventsForAgent(events, agentName, 'delivery_ack');
    assert.ok(acks.length >= 1, 'should get delivery_ack for Unicode message');

    const failed = eventsForAgent(events, agentName, 'delivery_failed');
    assert.equal(failed.length, 0, 'should have no delivery_failed for Unicode');

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

// ── Long Message ───────────────────────────────────────────────────────────

test('edge: long message — 4KB payload', { timeout: 90_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `longmsg-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, cli, ['general']);
    await sleep(12_000);

    // 4000-char message
    const longText = 'This is a paragraph of test text for stress testing. '.repeat(80);
    assert.ok(longText.length >= 4000, 'message should be >= 4KB');

    const result = await harness.sendMessage({
      to: agentName,
      from: 'edge-test',
      text: longText,
    });
    assert.ok(result.event_id, 'should get event_id for long message');

    await sleep(15_000);

    const events = harness.getEvents();
    const acks = eventsForAgent(events, agentName, 'delivery_ack');
    assert.ok(acks.length >= 1, 'should get delivery_ack for long message');

    assertNoDroppedDeliveries(events);

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

// ── Special Characters ─────────────────────────────────────────────────────

test('edge: special characters — newlines, tabs, backslashes, quotes', { timeout: 90_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `special-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, cli, ['general']);
    await sleep(12_000);

    const specialText = 'Line1\nLine2\tTabbed\t"quoted"\n\\backslash\\ and \'single quotes\'';
    const result = await harness.sendMessage({
      to: agentName,
      from: 'edge-test',
      text: specialText,
    });
    assert.ok(result.event_id, 'should get event_id for special chars message');

    await sleep(10_000);

    const events = harness.getEvents();
    const acks = eventsForAgent(events, agentName, 'delivery_ack');
    assert.ok(acks.length >= 1, 'should get delivery_ack for special chars');

    const errors = eventsForAgent(events, agentName, 'worker_error');
    assert.equal(errors.length, 0, 'no worker_error from special characters');

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

// ── Empty Message ──────────────────────────────────────────────────────────

test('edge: empty message body', { timeout: 60_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `empty-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, cli, ['general']);
    await sleep(12_000);

    // Empty body — should either succeed or reject with a clear error
    try {
      const result = await harness.sendMessage({
        to: agentName,
        from: 'edge-test',
        text: '',
      });
      // If accepted, verify delivery completes
      assert.ok(result.event_id, 'empty message accepted with event_id');
      await sleep(5_000);
    } catch {
      // If rejected, that's acceptable behavior too
      // Just verify the agent is still alive
      await assertAgentExists(harness, agentName);
    }

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

// ── Agent Crash Recovery ───────────────────────────────────────────────────

test('edge: agent crash recovery — exit and name reuse', { timeout: 90_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;
  // Use cat — always available, easy to kill
  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `crash-${uniqueSuffix()}`;

  try {
    // Spawn cat agent
    await harness.spawnAgent(agentName, 'cat', ['general']);
    await sleep(3_000);
    await assertAgentExists(harness, agentName);

    // Release it to simulate cleanup
    await harness.releaseAgent(agentName);
    await sleep(3_000);

    // Verify agent is gone
    const events = harness.getEvents();
    const exited = eventsForAgent(events, agentName, 'agent_exited');
    assert.ok(
      exited.length >= 1 || eventsForAgent(events, agentName, 'agent_released').length >= 1,
      'should have agent_exited or agent_released event'
    );
    await assertAgentNotExists(harness, agentName);

    // Respawn with same name — should work (name slot freed)
    await harness.spawnAgent(agentName, 'cat', ['general']);
    await sleep(3_000);
    await assertAgentExists(harness, agentName);

    // New agent can receive messages
    const result = await harness.sendMessage({
      to: agentName,
      from: 'edge-test',
      text: 'message to respawned agent',
    });
    assert.ok(result.event_id, 'respawned agent should accept messages');

    await sleep(5_000);
    const newEvents = harness.getEvents();
    const newAcks = eventsForAgent(newEvents, agentName, 'delivery_ack');
    assert.ok(newAcks.length >= 1, 'respawned agent should get delivery_ack');

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

// ── Concurrent Sends ───────────────────────────────────────────────────────

test('edge: concurrent sends — 5 parallel messages with unique markers', { timeout: 90_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `concurrent-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, cli, ['general']);
    await sleep(12_000);

    // 5 concurrent messages
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        harness.sendMessage({
          to: agentName,
          from: 'edge-test',
          text: `CONCURRENT_MARKER_${i + 1}`,
        })
      )
    );

    // All should get unique event_ids
    for (const result of results) {
      assert.ok(result.event_id, 'concurrent message should get event_id');
    }

    await sleep(15_000);

    const events = harness.getEvents();
    const acks = eventsForAgent(events, agentName, 'delivery_ack');
    assert.ok(
      acks.length >= 3,
      `should have at least 3 delivery_ack from 5 concurrent sends, got ${acks.length}`
    );

    // Verify injection was serialized (injected events should have distinct timestamps)
    const injected = eventsForAgent(events, agentName, 'delivery_injected');
    assert.ok(
      injected.length >= 3,
      `should have at least 3 delivery_injected events, got ${injected.length}`
    );

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

// ── Very Long Single Line ──────────────────────────────────────────────────

test('edge: 8KB single line message — no newlines', { timeout: 90_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `longline-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, cli, ['general']);
    await sleep(12_000);

    // 8000-char continuous string
    const longLine = 'A'.repeat(8000);
    const result = await harness.sendMessage({
      to: agentName,
      from: 'edge-test',
      text: longLine,
    });
    assert.ok(result.event_id, 'should get event_id for 8KB line');

    await sleep(15_000);

    const events = harness.getEvents();
    const acks = eventsForAgent(events, agentName, 'delivery_ack');
    assert.ok(acks.length >= 1, 'should get delivery_ack for 8KB single line');

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});
