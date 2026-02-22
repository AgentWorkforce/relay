/**
 * MCP Reply Hints integration tests.
 *
 * Verifies that injected messages include system-reminder wrappers
 * that guide agents to respond using Relaycast MCP tools.
 *
 * Run:
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   RELAY_INTEGRATION_REAL_CLI=1 node --test tests/integration/broker/dist/mcp-hints.test.js
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
  eventsForAgent,
} from "./utils/assert-helpers.js";
import {
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

/**
 * Collect all worker_stream chunks for an agent into a single string.
 */
function collectStreamOutput(events: BrokerEvent[], agentName: string): string {
  const streams = eventsForAgent(events, agentName, "worker_stream");
  return streams
    .map((ev) => (ev as BrokerEvent & { chunk: string }).chunk)
    .join("");
}

// ── MCP Hint Wrapper Tests ──────────────────────────────────────────────────

test("mcp-hints: injected messages include system-reminder wrapper", { timeout: 90_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `mcp-hint-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, cli, ["general"]);
    await sleep(12_000); // Wait for CLI startup

    harness.clearEvents();

    // Send a direct message
    await harness.sendMessage({
      to: agentName,
      from: "test-sender",
      text: "Hello, please acknowledge this message",
    });

    await sleep(8_000); // Wait for injection

    const events = harness.getEvents();
    const output = collectStreamOutput(events, agentName);

    // Verify system-reminder wrapper is present
    assert.ok(
      output.includes("<system-reminder>"),
      "Injected message should include <system-reminder> opening tag"
    );
    assert.ok(
      output.includes("</system-reminder>"),
      "Injected message should include </system-reminder> closing tag"
    );

    // Verify MCP tool hints are present
    assert.ok(
      output.includes("mcp__relaycast__"),
      "Injected message should mention Relaycast MCP tools"
    );
    assert.ok(
      output.includes("Relaycast MCP"),
      "Injected message should mention Relaycast MCP"
    );

    // Verify the actual relay message is present
    assert.ok(
      output.includes("Relay message from test-sender"),
      "Injected message should include the relay message content"
    );

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

test("mcp-hints: DM messages hint to use send_dm", { timeout: 90_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `mcp-dm-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, cli, ["general"]);
    await sleep(12_000);

    harness.clearEvents();

    // Send a direct message
    await harness.sendMessage({
      to: agentName,
      from: "alice",
      text: "Direct message test",
    });

    await sleep(8_000);

    const events = harness.getEvents();
    const output = collectStreamOutput(events, agentName);

    // DM should hint to use send_dm with sender name
    assert.ok(
      output.includes("mcp__relaycast__send_dm"),
      "DM should hint to use mcp__relaycast__send_dm"
    );
    assert.ok(
      output.includes("alice"),
      "DM hint should mention the sender (alice) to reply to"
    );

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

test("mcp-hints: channel messages hint to use post_message with channel", { timeout: 90_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `mcp-channel-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, cli, ["dev-team"]);
    await sleep(12_000);

    harness.clearEvents();

    // Send a channel message (using pre-formatted body with channel hint)
    // This simulates what Relaycast sends when delivering channel messages
    await harness.sendMessage({
      to: agentName,
      from: "system",
      text: "Relay message from bob [abc12345] [#dev-team]: Channel message test",
    });

    await sleep(8_000);

    const events = harness.getEvents();
    const output = collectStreamOutput(events, agentName);

    // Channel message should hint to use post_message with specific channel
    assert.ok(
      output.includes("mcp__relaycast__post_message"),
      "Channel message should hint to use mcp__relaycast__post_message"
    );
    assert.ok(
      output.includes("#dev-team") || output.includes("dev-team"),
      "Channel hint should mention the channel name"
    );

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

test("mcp-hints: no double-wrapping of system-reminder", { timeout: 90_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `mcp-nowrap-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, cli, ["general"]);
    await sleep(12_000);

    harness.clearEvents();

    // Send multiple messages rapidly
    await harness.sendMessage({
      to: agentName,
      from: "sender1",
      text: "First message",
    });
    await harness.sendMessage({
      to: agentName,
      from: "sender2",
      text: "Second message",
    });

    await sleep(10_000);

    const events = harness.getEvents();
    const output = collectStreamOutput(events, agentName);

    // Count occurrences of system-reminder tags
    const openTags = (output.match(/<system-reminder>/g) || []).length;
    const closeTags = (output.match(/<\/system-reminder>/g) || []).length;

    // Should have exactly 2 of each (one per message)
    assert.ok(
      openTags >= 2,
      `Should have at least 2 <system-reminder> tags for 2 messages, got ${openTags}`
    );
    assert.equal(
      openTags,
      closeTags,
      `Open and close tags should match: ${openTags} vs ${closeTags}`
    );

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

// ── Idle Detection Tests ────────────────────────────────────────────────────

test("mcp-hints: idle detection handles system-reminder format", { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `mcp-idle-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, cli, ["general"]);
    await sleep(12_000);

    harness.clearEvents();

    // Send first message
    await harness.sendMessage({
      to: agentName,
      from: "test",
      text: "First message - agent should process this",
    });

    await sleep(15_000); // Give agent time to process

    // Send second message - this tests that idle detection works
    // and allows injection after the first message's echo
    const result = await harness.sendMessage({
      to: agentName,
      from: "test",
      text: "Second message - should also be delivered",
    });

    assert.ok(result.event_id, "Second message should be accepted");

    await sleep(10_000);

    const events = harness.getEvents();

    // Both messages should have been injected
    const injected = eventsForAgent(events, agentName, "delivery_injected");
    assert.ok(
      injected.length >= 2,
      `Both messages should be injected, got ${injected.length} delivery_injected events`
    );

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});
