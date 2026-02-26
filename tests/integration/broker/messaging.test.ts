/**
 * Broker messaging integration tests.
 *
 * Tests message sending, delivery events, threading, and
 * priority handling through the broker.
 *
 * Run:
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   node --test tests/integration/broker/dist/messaging.test.js
 *
 * Requires:
 *   RELAY_API_KEY — Relaycast workspace key
 *   AGENT_RELAY_BIN (optional) — path to agent-relay binary
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { BrokerHarness, checkPrerequisites, uniqueSuffix } from './utils/broker-harness.js';
import {
  assertNoDoubleDelivery,
  assertNoDroppedDeliveries,
  assertNoAclDenied,
} from './utils/assert-helpers.js';

function skipIfMissing(t: TestContext): boolean {
  const reason = checkPrerequisites();
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

type SendMessageInput = {
  to: string;
  text: string;
  from?: string;
  threadId?: string;
  priority?: number;
};

async function sendMessageOrSkip(
  t: TestContext,
  harness: BrokerHarness,
  input: SendMessageInput
): Promise<{ event_id: string; targets: string[] }> {
  try {
    const result = await harness.sendMessage(input);
    if (result.event_id === 'unsupported_operation') {
      t.skip('send_message is unsupported by this broker build');
      return { event_id: 'unsupported_operation', targets: [] };
    }
    return result;
  } catch (error) {
    if ((error as { code?: string })?.code === 'unsupported_operation') {
      t.skip('send_message is unsupported by this broker build');
      return { event_id: 'unsupported_operation', targets: [] };
    }
    throw error;
  }
}

async function assertSendMessageRejectsOrSkip(
  t: TestContext,
  harness: BrokerHarness,
  input: SendMessageInput,
  predicate: (err: Error) => boolean
): Promise<void> {
  try {
    const result = await harness.sendMessage(input);
    if (result.event_id === 'unsupported_operation') {
      t.skip('send_message is unsupported by this broker build');
      return;
    }
    assert.fail(`Expected sendMessage to reject, got: ${JSON.stringify(result)}`);
  } catch (error) {
    if ((error as { code?: string })?.code === 'unsupported_operation') {
      t.skip('send_message is unsupported by this broker build');
      return;
    }
    assert.ok(
      predicate(error as Error),
      `rejected sendMessage with unexpected error: ${(error as Error).message}`
    );
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('broker: send message to a spawned agent', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const agentName = `msgrecv-${suffix}`;

  try {
    await harness.spawnAgent(agentName);
    await harness.waitForEvent(
      'agent_spawned',
      5_000,
      (e) => e.kind === 'agent_spawned' && e.name === agentName
    ).promise;

    // Send a message
    const result = await sendMessageOrSkip(t, harness, {
      to: agentName,
      text: 'Hello from test',
      from: 'system',
    });

    assert.ok(result.event_id, 'sendMessage should return an event_id');
    assert.ok(Array.isArray(result.targets), 'sendMessage should return targets array');

    // No drops or ACL issues
    await new Promise((r) => setTimeout(r, 500));
    const events = harness.getEvents();
    assertNoDroppedDeliveries(events);
    assertNoAclDenied(events);
  } finally {
    // Clean up
    try {
      await harness.releaseAgent(agentName);
    } catch {
      /* ignore cleanup errors */
    }
    await harness.stop();
  }
});

test('broker: send multiple messages — no double delivery', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const agentName = `multirecv-${suffix}`;

  try {
    await harness.spawnAgent(agentName);
    await harness.waitForEvent(
      'agent_spawned',
      5_000,
      (e) => e.kind === 'agent_spawned' && e.name === agentName
    ).promise;

    // Send 5 messages
    const eventIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await sendMessageOrSkip(t, harness, {
        to: agentName,
        text: `Message ${i}`,
        from: 'system',
      });
      eventIds.push(result.event_id);
    }

    // All event IDs should be unique
    const uniqueIds = new Set(eventIds);
    assert.equal(uniqueIds.size, eventIds.length, 'Each message should have a unique event_id');

    // Wait for delivery processing
    await new Promise((r) => setTimeout(r, 1_000));

    const events = harness.getEvents();
    assertNoDoubleDelivery(events);
    assertNoDroppedDeliveries(events);
  } finally {
    try {
      await harness.releaseAgent(agentName);
    } catch {
      /* ignore cleanup errors */
    }
    await harness.stop();
  }
});

test('broker: send message with thread_id', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const agentName = `thread-${suffix}`;

  try {
    await harness.spawnAgent(agentName);
    await harness.waitForEvent(
      'agent_spawned',
      5_000,
      (e) => e.kind === 'agent_spawned' && e.name === agentName
    ).promise;

    // Send initial message
    const msg1 = await sendMessageOrSkip(t, harness, {
      to: agentName,
      text: 'Start of thread',
      from: 'system',
    });
    assert.ok(msg1.event_id);

    // Send follow-up with thread_id
    const msg2 = await sendMessageOrSkip(t, harness, {
      to: agentName,
      text: 'Follow-up',
      from: 'system',
      threadId: msg1.event_id,
    });
    assert.ok(msg2.event_id);
    assert.notEqual(msg1.event_id, msg2.event_id, 'each message gets its own event_id');
  } finally {
    try {
      await harness.releaseAgent(agentName);
    } catch {
      /* ignore cleanup errors */
    }
    await harness.stop();
  }
});

test('broker: send message with priority', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const agentName = `priority-${suffix}`;

  try {
    await harness.spawnAgent(agentName);
    await harness.waitForEvent(
      'agent_spawned',
      5_000,
      (e) => e.kind === 'agent_spawned' && e.name === agentName
    ).promise;

    // Send with explicit priority
    const result = await sendMessageOrSkip(t, harness, {
      to: agentName,
      text: 'Urgent message',
      from: 'system',
      priority: 1, // P1 — high priority
    });
    assert.ok(result.event_id, 'high-priority message should be accepted');

    // Send with low priority
    const result2 = await sendMessageOrSkip(t, harness, {
      to: agentName,
      text: 'Background task',
      from: 'system',
      priority: 4, // P4 — low priority
    });
    assert.ok(result2.event_id, 'low-priority message should be accepted');
  } finally {
    try {
      await harness.releaseAgent(agentName);
    } catch {
      /* ignore cleanup errors */
    }
    await harness.stop();
  }
});

test('broker: send message to nonexistent agent returns error', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();

  try {
    await assertSendMessageRejectsOrSkip(
      t,
      harness,
      {
        to: `ghost-${uniqueSuffix()}`,
        text: 'Hello?',
        from: 'system',
      },
      (err: Error) => {
        return (
          err.message.includes('not_found') || err.name.includes('Protocol') || err.message.includes('agent')
        );
      }
    );
  } finally {
    await harness.stop();
  }
});

test('broker: message between two spawned agents', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const sender = `sender-${suffix}`;
  const receiver = `receiver-${suffix}`;

  try {
    await harness.spawnAgent(sender);
    await harness.spawnAgent(receiver);

    // Wait for both spawns
    await harness.waitForEvent('agent_spawned', 5_000, (e) => e.kind === 'agent_spawned' && e.name === sender)
      .promise;
    await harness.waitForEvent(
      'agent_spawned',
      5_000,
      (e) => e.kind === 'agent_spawned' && e.name === receiver
    ).promise;

    // Send from sender's identity to receiver
    const result = await sendMessageOrSkip(t, harness, {
      to: receiver,
      text: 'Agent-to-agent message',
      from: sender,
    });
    assert.ok(result.event_id);

    await new Promise((r) => setTimeout(r, 500));
    assertNoDroppedDeliveries(harness.getEvents());
  } finally {
    try {
      await harness.releaseAgent(sender);
    } catch {
      /* ignore cleanup errors */
    }
    try {
      await harness.releaseAgent(receiver);
    } catch {
      /* ignore cleanup errors */
    }
    await harness.stop();
  }
});
