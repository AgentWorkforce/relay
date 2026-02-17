/**
 * Real CLI spawn + delivery integration tests.
 *
 * Tests that actual AI CLI tools (claude, codex, gemini, aider, goose)
 * can be spawned via the broker, stay alive, and receive messages through
 * the full delivery pipeline (queued → injected → ack → verified).
 *
 * These tests are gated behind RELAY_INTEGRATION_REAL_CLI=1 to avoid
 * running resource-heavy tests in regular CI. They also skip gracefully
 * when a CLI isn't installed.
 *
 * Run:
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   RELAY_INTEGRATION_REAL_CLI=1 node --test tests/integration/broker/dist/cli-spawn.test.js
 *
 * Requires:
 *   RELAY_API_KEY — Relaycast workspace key
 *   RELAY_INTEGRATION_REAL_CLI=1 — opt-in for real CLI tests
 *   AGENT_RELAY_BIN (optional) — path to agent-relay binary
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { BrokerEvent } from "@agent-relay/broker-sdk";
import {
  BrokerHarness,
  checkPrerequisites,
  uniqueSuffix,
} from "./utils/broker-harness.js";
import {
  assertAgentExists,
  assertNoDroppedDeliveries,
} from "./utils/assert-helpers.js";
import {
  skipIfNotRealCli,
  skipIfCliMissing,
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

/**
 * Shared test logic: spawn a CLI agent, verify it stays alive,
 * send a message, verify full delivery pipeline, release.
 */
async function testCliSpawnAndDeliver(
  harness: BrokerHarness,
  cli: string,
  agentName: string,
): Promise<void> {
  // 1. Spawn via low-level client
  const spawned = await harness.spawnAgent(agentName, cli, ["general"]);
  assert.equal(spawned.name, agentName);
  assert.equal(spawned.runtime, "pty");

  // 2. Wait for agent startup — real CLIs need time to initialize
  await sleep(10_000);

  // 3. Verify agent is still alive
  await assertAgentExists(harness, agentName);

  // 4. Send a message
  const result = await harness.sendMessage({
    to: agentName,
    from: "test-human",
    text: "Respond with: ACK test received",
  });
  assert.ok(result.event_id, "sendMessage should return an event_id");

  // 5. Wait for delivery pipeline to complete
  await sleep(5_000);

  // 6. Verify delivery events
  const events = harness.getEvents();
  const deliveryAck = events.find(
    (e) =>
      e.kind === "delivery_ack" &&
      "name" in e &&
      (e as BrokerEvent & { name: string }).name === agentName,
  );
  const deliveryVerified = events.find(
    (e) =>
      e.kind === "delivery_verified" &&
      "name" in e &&
      (e as BrokerEvent & { name: string }).name === agentName,
  );

  assert.ok(deliveryAck, `${cli}: should receive delivery_ack`);
  assert.ok(deliveryVerified, `${cli}: should receive delivery_verified`);

  // 7. No dropped deliveries
  assertNoDroppedDeliveries(events);

  // 8. Clean release
  await harness.releaseAgent(agentName);
  await sleep(1_000);
}

// ── Per-CLI Tests ───────────────────────────────────────────────────────────

test("cli-spawn: claude — spawn, deliver, release", { timeout: 60_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;
  if (skipIfCliMissing(t, "claude")) return;

  const harness = new BrokerHarness();
  await harness.start();

  try {
    await testCliSpawnAndDeliver(
      harness,
      "claude",
      `claude-test-${uniqueSuffix()}`,
    );
  } finally {
    await harness.stop();
  }
});

test("cli-spawn: codex — spawn, deliver, release", { timeout: 60_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;
  if (skipIfCliMissing(t, "codex")) return;

  const harness = new BrokerHarness();
  await harness.start();

  try {
    await testCliSpawnAndDeliver(
      harness,
      "codex",
      `codex-test-${uniqueSuffix()}`,
    );
  } finally {
    await harness.stop();
  }
});

test("cli-spawn: gemini — spawn, deliver, release", { timeout: 60_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;
  if (skipIfCliMissing(t, "gemini")) return;

  const harness = new BrokerHarness();
  await harness.start();

  try {
    await testCliSpawnAndDeliver(
      harness,
      "gemini",
      `gemini-test-${uniqueSuffix()}`,
    );
  } finally {
    await harness.stop();
  }
});

test("cli-spawn: aider — spawn, deliver, release", { timeout: 60_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;
  if (skipIfCliMissing(t, "aider")) return;

  const harness = new BrokerHarness();
  await harness.start();

  try {
    await testCliSpawnAndDeliver(
      harness,
      "aider",
      `aider-test-${uniqueSuffix()}`,
    );
  } finally {
    await harness.stop();
  }
});

test("cli-spawn: goose — spawn, deliver, release", { timeout: 60_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;
  if (skipIfCliMissing(t, "goose")) return;

  const harness = new BrokerHarness();
  await harness.start();

  try {
    await testCliSpawnAndDeliver(
      harness,
      "goose",
      `goose-test-${uniqueSuffix()}`,
    );
  } finally {
    await harness.stop();
  }
});

// ── Multi-CLI Tests ─────────────────────────────────────────────────────────

test("cli-spawn: multi-cli — spawn claude + codex simultaneously", { timeout: 90_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;
  if (skipIfCliMissing(t, "claude")) return;
  if (skipIfCliMissing(t, "codex")) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();

  try {
    // Spawn both
    const claudeName = `claude-multi-${suffix}`;
    const codexName = `codex-multi-${suffix}`;

    await harness.spawnAgent(claudeName, "claude", ["general"]);
    await harness.spawnAgent(codexName, "codex", ["general"]);

    // Wait for both to start up
    await sleep(10_000);

    // Verify both alive
    const agents = await harness.listAgents();
    assert.ok(
      agents.some((a) => a.name === claudeName),
      "claude agent should be alive",
    );
    assert.ok(
      agents.some((a) => a.name === codexName),
      "codex agent should be alive",
    );

    // Send message to each
    await harness.sendMessage({
      to: claudeName,
      from: "test-human",
      text: "test message for claude",
    });
    await harness.sendMessage({
      to: codexName,
      from: "test-human",
      text: "test message for codex",
    });

    // Wait for deliveries
    await sleep(5_000);

    // Both should have delivery_ack events
    const events = harness.getEvents();
    const claudeAck = events.find(
      (e) =>
        e.kind === "delivery_ack" &&
        "name" in e &&
        (e as BrokerEvent & { name: string }).name === claudeName,
    );
    const codexAck = events.find(
      (e) =>
        e.kind === "delivery_ack" &&
        "name" in e &&
        (e as BrokerEvent & { name: string }).name === codexName,
    );

    assert.ok(claudeAck, "claude should receive delivery_ack");
    assert.ok(codexAck, "codex should receive delivery_ack");

    // No dropped deliveries
    assertNoDroppedDeliveries(events);

    // Release both
    await harness.releaseAgent(claudeName);
    await harness.releaseAgent(codexName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

// ── Delivery Pipeline Verification ──────────────────────────────────────────

test("cli-spawn: delivery pipeline — full event sequence", { timeout: 60_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;

  // Use whichever CLI is available (prefer claude, fallback to codex)
  let cli = "claude";
  if (skipIfCliMissing(t, "claude")) {
    cli = "codex";
    if (skipIfCliMissing(t, "codex")) return;
  }

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `pipeline-${uniqueSuffix()}`;

  try {
    harness.clearEvents();

    await harness.spawnAgent(agentName, cli, ["general"]);
    await sleep(10_000);

    // Send message
    const result = await harness.sendMessage({
      to: agentName,
      from: "test-human",
      text: "Pipeline test message",
    });

    // Wait for pipeline
    await sleep(5_000);

    // Verify event ordering: queued → injected → ack → verified
    const events = harness.getEvents();
    const deliveryEvents = events.filter(
      (e) =>
        e.kind.startsWith("delivery_") &&
        "name" in e &&
        (e as BrokerEvent & { name: string }).name === agentName,
    );

    const kinds = deliveryEvents.map((e) => e.kind);
    assert.ok(kinds.includes("delivery_queued"), "should have delivery_queued");
    assert.ok(kinds.includes("delivery_injected"), "should have delivery_injected");
    assert.ok(kinds.includes("delivery_ack"), "should have delivery_ack");
    assert.ok(kinds.includes("delivery_verified"), "should have delivery_verified");

    // Verify ordering
    const queuedIdx = kinds.indexOf("delivery_queued");
    const injectedIdx = kinds.indexOf("delivery_injected");
    const ackIdx = kinds.indexOf("delivery_ack");
    const verifiedIdx = kinds.indexOf("delivery_verified");

    assert.ok(queuedIdx < injectedIdx, "queued should come before injected");
    assert.ok(injectedIdx < ackIdx, "injected should come before ack");
    assert.ok(ackIdx < verifiedIdx, "ack should come before verified");

    await harness.releaseAgent(agentName);
  } finally {
    await harness.stop();
  }
});

// ── Multiple Rapid Messages ────────────────────────────────────────────────

test("cli-spawn: rapid messages — send 3 messages in quick succession", { timeout: 90_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;

  // Use whichever CLI is available
  let cli = "claude";
  if (skipIfCliMissing(t, "claude")) {
    cli = "codex";
    if (skipIfCliMissing(t, "codex")) return;
  }

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `rapid-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, cli, ["general"]);
    await sleep(10_000);

    // Send 3 messages rapidly without waiting between them
    const results = await Promise.all([
      harness.sendMessage({
        to: agentName,
        from: "test-human",
        text: "Rapid message 1",
      }),
      harness.sendMessage({
        to: agentName,
        from: "test-human",
        text: "Rapid message 2",
      }),
      harness.sendMessage({
        to: agentName,
        from: "test-human",
        text: "Rapid message 3",
      }),
    ]);

    // All should get event_ids
    for (const result of results) {
      assert.ok(result.event_id, "each message should get an event_id");
    }

    // Wait for deliveries to process
    await sleep(15_000);

    // Verify at least some delivery_ack events arrived
    const events = harness.getEvents();
    const acks = events.filter(
      (e) =>
        e.kind === "delivery_ack" &&
        "name" in e &&
        (e as BrokerEvent & { name: string }).name === agentName,
    );

    assert.ok(acks.length >= 1, `should have at least 1 delivery_ack, got ${acks.length}`);

    // No delivery_dropped events
    assertNoDroppedDeliveries(events);

    await harness.releaseAgent(agentName);
  } finally {
    await harness.stop();
  }
});

// ── Agent Release Verification ─────────────────────────────────────────────

test("cli-spawn: release — agent disappears from list after release", { timeout: 60_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;

  let cli = "claude";
  if (skipIfCliMissing(t, "claude")) {
    cli = "codex";
    if (skipIfCliMissing(t, "codex")) return;
  }

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `release-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, cli, ["general"]);
    await sleep(10_000);

    // Verify agent is alive
    const agentsBefore = await harness.listAgents();
    assert.ok(
      agentsBefore.some((a) => a.name === agentName),
      "agent should be alive before release",
    );

    // Release
    await harness.releaseAgent(agentName);
    await sleep(3_000);

    // Verify agent is gone
    const agentsAfter = await harness.listAgents();
    assert.ok(
      !agentsAfter.some((a) => a.name === agentName),
      "agent should be gone after release",
    );

    // Should have worker_exited event
    const events = harness.getEvents();
    const exited = events.find(
      (e) =>
        e.kind === "agent_exited" &&
        "name" in e &&
        (e as BrokerEvent & { name: string }).name === agentName,
    );
    assert.ok(exited, "should have agent_exited event after release");
  } finally {
    await harness.stop();
  }
});

// ── Duplicate Agent Name ────────────────────────────────────────────────────

test("cli-spawn: duplicate name — second spawn with same name fails", { timeout: 60_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;

  let cli = "claude";
  if (skipIfCliMissing(t, "claude")) {
    cli = "codex";
    if (skipIfCliMissing(t, "codex")) return;
  }

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `dup-${uniqueSuffix()}`;

  try {
    // First spawn should succeed
    await harness.spawnAgent(agentName, cli, ["general"]);
    await sleep(5_000);

    // Second spawn with same name should fail
    await assert.rejects(
      () => harness.spawnAgent(agentName, cli, ["general"]),
      "spawning duplicate agent name should reject",
    );

    // Clean up
    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

// ── Cat Process Tests (lightweight, no real CLI needed) ────────────────────

test("cli-spawn: cat — spawn lightweight process and deliver", { timeout: 30_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  // This test uses "cat" which is always available — no CLI check needed
  // But still needs RELAY_INTEGRATION_REAL_CLI=1 gate
  if (skipIfNotRealCli(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `cat-${uniqueSuffix()}`;

  try {
    const spawned = await harness.spawnAgent(agentName, "cat", ["general"]);
    assert.equal(spawned.name, agentName);
    assert.equal(spawned.runtime, "pty");

    // cat is ready immediately (byte threshold from startup)
    await sleep(3_000);

    // Verify agent is alive
    await assertAgentExists(harness, agentName);

    // Send a message
    const result = await harness.sendMessage({
      to: agentName,
      from: "test-human",
      text: "hello cat",
    });
    assert.ok(result.event_id);

    await sleep(5_000);

    // Should get delivery events
    const events = harness.getEvents();
    const ack = events.find(
      (e) =>
        e.kind === "delivery_ack" &&
        "name" in e &&
        (e as BrokerEvent & { name: string }).name === agentName,
    );
    assert.ok(ack, "cat: should receive delivery_ack");

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});
