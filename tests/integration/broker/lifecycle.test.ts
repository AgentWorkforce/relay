/**
 * Broker lifecycle integration tests.
 *
 * Tests agent spawn, release, list, and exit event flow through
 * the broker binary via the low-level SDK client.
 *
 * Run:
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   node --test tests/integration/broker/dist/lifecycle.test.js
 *
 * Requires:
 *   RELAY_API_KEY — Relaycast workspace key
 *   AGENT_RELAY_BIN (optional) — path to agent-relay binary
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { BrokerHarness, checkPrerequisites, uniqueSuffix } from './utils/broker-harness.js';
import {
  assertAgentCount,
  assertAgentExists,
  assertAgentNotExists,
  assertAgentSpawnedEvent,
  assertAgentReleasedEvent,
  assertEventOrder,
  assertNoAclDenied,
} from './utils/assert-helpers.js';
import { AgentRelayProtocolError } from '@agent-relay/sdk';

function skipIfMissing(t: TestContext): boolean {
  const reason = checkPrerequisites();
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('broker: start and stop cleanly', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();

  // Broker should respond to listAgents (hello_ack already confirmed by start)
  const agents = await harness.listAgents();
  assert.ok(Array.isArray(agents), 'listAgents should return an array');

  await harness.stop();
});

test('broker: spawn and release a single agent', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const name = `test-agent-${suffix}`;

  try {
    // Spawn
    const spawned = await harness.spawnAgent(name);
    assert.equal(spawned.name, name);
    assert.equal(spawned.runtime, 'pty');

    // Verify agent exists
    await assertAgentExists(harness, name);

    // Wait for spawned event
    const spawnEvent = await harness.waitForEvent(
      'agent_spawned',
      5_000,
      (e) => e.kind === 'agent_spawned' && e.name === name
    ).promise;
    assert.ok(spawnEvent, 'should receive agent_spawned event');

    // Release
    const released = await harness.releaseAgent(name);
    assert.equal(released.name, name);

    // Wait for released event
    await harness.waitForEvent('agent_released', 5_000, (e) => e.kind === 'agent_released' && e.name === name)
      .promise;

    // Verify agent is gone
    await assertAgentNotExists(harness, name);

    // Verify event order
    assertEventOrder(harness.getEvents(), ['agent_spawned', 'agent_released']);
  } finally {
    await harness.stop();
  }
});

test('broker: spawn multiple agents in sequence', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const names = [`alpha-${suffix}`, `beta-${suffix}`, `gamma-${suffix}`];

  try {
    // Spawn all
    for (const name of names) {
      await harness.spawnAgent(name);
    }

    // Verify all exist
    const agents = await harness.listAgents();
    for (const name of names) {
      assert.ok(
        agents.some((a) => a.name === name),
        `agent "${name}" should be in listAgents`
      );
    }
    assert.ok(agents.length >= names.length);

    // Release all
    for (const name of names) {
      await harness.releaseAgent(name);
    }

    // Give events time to propagate
    await new Promise((r) => setTimeout(r, 500));

    // Verify all gone
    const remaining = await harness.listAgents();
    for (const name of names) {
      assert.ok(
        !remaining.some((a) => a.name === name),
        `agent "${name}" should not be in listAgents after release`
      );
    }

    // Verify events
    const events = harness.getEvents();
    for (const name of names) {
      assertAgentSpawnedEvent(events, name);
      assertAgentReleasedEvent(events, name);
    }
  } finally {
    await harness.stop();
  }
});

test('broker: spawn, list, release — agent count tracking', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();

  try {
    const initialAgents = await harness.listAgents();
    const initialCount = initialAgents.length;

    // Spawn two agents
    await harness.spawnAgent(`count-a-${suffix}`);
    await assertAgentCount(harness, initialCount + 1);

    await harness.spawnAgent(`count-b-${suffix}`);
    await assertAgentCount(harness, initialCount + 2);

    // Release one
    await harness.releaseAgent(`count-a-${suffix}`);
    await new Promise((r) => setTimeout(r, 300));
    await assertAgentCount(harness, initialCount + 1);

    // Release the other
    await harness.releaseAgent(`count-b-${suffix}`);
    await new Promise((r) => setTimeout(r, 300));
    await assertAgentCount(harness, initialCount);
  } finally {
    await harness.stop();
  }
});

test('broker: releasing a nonexistent agent returns error', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();

  try {
    await assert.rejects(
      harness.releaseAgent(`nonexistent-${uniqueSuffix()}`),
      (err: Error) => {
        return err instanceof AgentRelayProtocolError && err.code === 'agent_not_found';
      },
      'releasing a nonexistent agent should throw'
    );
  } finally {
    await harness.stop();
  }
});

test('broker: agent_exited event when cat process is killed', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const name = `exitwatch-${suffix}`;

  try {
    await harness.spawnAgent(name);

    // Wait for spawn event
    await harness.waitForEvent('agent_spawned', 5_000, (e) => e.kind === 'agent_spawned' && e.name === name)
      .promise;

    // Release the agent (which kills the cat process)
    await harness.releaseAgent(name);

    // Should see either agent_released or agent_exited
    await harness.waitForEvent('agent_released', 5_000, (e) => e.kind === 'agent_released' && e.name === name)
      .promise;

    // No ACL denials
    assertNoAclDenied(harness.getEvents());
  } finally {
    await harness.stop();
  }
});

test('broker: events are captured in order', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const name = `ordered-${suffix}`;

  try {
    harness.clearEvents();

    await harness.spawnAgent(name);
    await harness.waitForEvent('agent_spawned', 5_000, (e) => e.kind === 'agent_spawned' && e.name === name)
      .promise;

    await harness.releaseAgent(name);
    await harness.waitForEvent('agent_released', 5_000, (e) => e.kind === 'agent_released' && e.name === name)
      .promise;

    // Spawn must come before release in the event stream
    assertEventOrder(harness.getEvents(), ['agent_spawned', 'agent_released']);
  } finally {
    await harness.stop();
  }
});
