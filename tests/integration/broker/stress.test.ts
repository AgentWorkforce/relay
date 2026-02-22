/**
 * Stress tests against real CLI agents.
 *
 * Tests the broker PTY pipeline under sustained load, burst conditions,
 * and concurrent agent scenarios using actual AI CLI tools.
 *
 * Run:
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   RELAY_INTEGRATION_REAL_CLI=1 node --test tests/integration/broker/dist/stress.test.js
 *
 * Requires:
 *   RELAY_API_KEY — Relaycast workspace key
 *   RELAY_INTEGRATION_REAL_CLI=1 — opt-in for real CLI tests
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { BrokerEvent } from "@agent-relay/sdk";
import {
  BrokerHarness,
  checkPrerequisites,
  uniqueSuffix,
} from "./utils/broker-harness.js";
import {
  assertNoDroppedDeliveries,
  assertNoDoubleDelivery,
  assertAgentExists,
  eventsForAgent,
} from "./utils/assert-helpers.js";
import {
  skipIfNotRealCli,
  skipIfCliMissing,
  skipUnlessAnyCli,
  sleep,
} from "./utils/cli-helpers.js";

function skipIfMissing(t: TestContext): boolean {
  const reason = checkPrerequisites();
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

// ── Burst Load ─────────────────────────────────────────────────────────────

test("stress: burst 10 messages to a single CLI agent", { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `burst-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, cli, ["general"]);
    await sleep(12_000);

    // Fire 10 messages in rapid succession
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        harness.sendMessage({
          to: agentName,
          from: "stress-test",
          text: `Burst message ${i + 1} of 10`,
        }),
      ),
    );

    // All should return unique event_ids
    const eventIds = results.map((r) => r.event_id);
    assert.equal(new Set(eventIds).size, 10, "all 10 messages should get unique event_ids");

    // Wait for delivery pipeline to process
    await sleep(30_000);

    const events = harness.getEvents();
    const acks = eventsForAgent(events, agentName, "delivery_ack");

    assert.ok(
      acks.length >= 8,
      `should have at least 8 delivery_ack events, got ${acks.length}`,
    );

    assertNoDroppedDeliveries(events);
    assertNoDoubleDelivery(events);

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

// ── Sustained Load ─────────────────────────────────────────────────────────

test("stress: sustained 20 messages with 2s intervals", { timeout: 180_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `sustained-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, cli, ["general"]);
    await sleep(12_000);

    // Send 20 messages with 2s spacing
    for (let i = 0; i < 20; i++) {
      const result = await harness.sendMessage({
        to: agentName,
        from: "stress-test",
        text: `Sustained message ${i + 1}`,
      });
      assert.ok(result.event_id, `message ${i + 1} should get event_id`);
      await sleep(2_000);
    }

    // Wait for final deliveries
    await sleep(10_000);

    const events = harness.getEvents();
    const acks = eventsForAgent(events, agentName, "delivery_ack");
    const verified = eventsForAgent(events, agentName, "delivery_verified");

    assert.ok(
      acks.length >= 18,
      `should have at least 18 delivery_ack events, got ${acks.length}`,
    );
    assert.equal(
      acks.length,
      verified.length,
      "delivery_ack count should match delivery_verified count",
    );

    assertNoDroppedDeliveries(events);

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

// ── Concurrent Agents ──────────────────────────────────────────────────────

test("stress: 3 concurrent agents receiving interleaved messages", { timeout: 180_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const agents = [`agent-a-${suffix}`, `agent-b-${suffix}`, `agent-c-${suffix}`];

  try {
    // Spawn all 3 agents
    for (const name of agents) {
      await harness.spawnAgent(name, cli, ["general"]);
    }
    await sleep(15_000);

    // Verify all alive
    for (const name of agents) {
      await assertAgentExists(harness, name);
    }

    // Interleave 5 messages to each agent
    for (let i = 0; i < 5; i++) {
      for (const name of agents) {
        await harness.sendMessage({
          to: name,
          from: "stress-test",
          text: `Interleaved message ${i + 1} for ${name}`,
        });
      }
      await sleep(1_000);
    }

    // Wait for deliveries
    await sleep(20_000);

    const events = harness.getEvents();

    // Each agent should have at least 3 delivery_ack events
    for (const name of agents) {
      const acks = eventsForAgent(events, name, "delivery_ack");
      assert.ok(
        acks.length >= 3,
        `${name} should have >= 3 acks, got ${acks.length}`,
      );
    }

    assertNoDroppedDeliveries(events);

    // Clean up
    for (const name of agents) {
      await harness.releaseAgent(name);
    }
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

// ── Lifecycle Stress ───────────────────────────────────────────────────────

test("stress: spawn-deliver-release cycle repeated 5 times", { timeout: 300_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();

  try {
    for (let cycle = 0; cycle < 5; cycle++) {
      const agentName = `cycle-${cycle}-${uniqueSuffix()}`;
      harness.clearEvents();

      // Spawn
      await harness.spawnAgent(agentName, cli, ["general"]);
      await sleep(12_000);
      await assertAgentExists(harness, agentName);

      // Deliver 2 messages
      for (let i = 0; i < 2; i++) {
        await harness.sendMessage({
          to: agentName,
          from: "stress-test",
          text: `Cycle ${cycle} message ${i}`,
        });
        await sleep(2_000);
      }

      await sleep(5_000);

      // Verify deliveries
      const events = harness.getEvents();
      const acks = eventsForAgent(events, agentName, "delivery_ack");
      assert.ok(
        acks.length >= 1,
        `cycle ${cycle}: should have at least 1 delivery_ack, got ${acks.length}`,
      );

      // Release
      await harness.releaseAgent(agentName);
      await sleep(3_000);
    }

    // Final check: no leaked agents
    const remaining = await harness.listAgents();
    assert.equal(
      remaining.length,
      0,
      `should have 0 agents after all cycles, got ${remaining.length}: ${JSON.stringify(remaining.map((a) => a.name))}`,
    );
  } finally {
    await harness.stop();
  }
});

// ── Message to Released Agent ──────────────────────────────────────────────

test("stress: message to released agent rejects cleanly", { timeout: 90_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `released-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, cli, ["general"]);
    await sleep(12_000);
    await assertAgentExists(harness, agentName);

    // Release the agent
    await harness.releaseAgent(agentName);
    await sleep(3_000);

    // Try sending to released agent — should reject
    await assert.rejects(
      () =>
        harness.sendMessage({
          to: agentName,
          from: "stress-test",
          text: "message to dead agent",
        }),
      "sending to released agent should reject",
    );
  } finally {
    await harness.stop();
  }
});
