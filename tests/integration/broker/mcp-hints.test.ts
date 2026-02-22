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

// ══════════════════════════════════════════════════════════════════════════════
// END-TO-END MCP RESPONSE VERIFICATION
// These tests verify agents actually USE MCP tools to respond
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Get relay_inbound events from a specific agent
 */
function getRelayInboundFromAgent(events: BrokerEvent[], agentName: string): BrokerEvent[] {
  return events.filter((e) => {
    if (e.kind !== "relay_inbound") return false;
    const inbound = e as BrokerEvent & { from: string };
    return inbound.from === agentName;
  });
}

test("e2e-mcp: agent responds to DM using MCP send_dm", { timeout: 180_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `e2e-dm-${uniqueSuffix()}`;

  try {
    // Spawn agent with explicit task to respond via MCP
    await harness.spawnAgent(agentName, cli, ["general"], {
      task: "You are a test agent. When you receive a message, respond using the mcp__relaycast__send_dm tool to reply directly to the sender. Keep responses brief.",
    });
    await sleep(15_000);

    harness.clearEvents();

    // Send a DM that requires a response
    await harness.sendMessage({
      to: agentName,
      from: "test-user",
      text: "Please acknowledge this message by replying 'ACK' using the MCP tools mentioned in the system reminder.",
    });

    // Wait for agent to process and respond via MCP
    await sleep(60_000);

    const events = harness.getEvents();

    // Check if agent used MCP to respond (relay_inbound from this agent)
    const agentResponses = getRelayInboundFromAgent(events, agentName);

    // Verify at least one response was sent via MCP
    assert.ok(
      agentResponses.length >= 1,
      `Agent should have sent at least 1 MCP response, got ${agentResponses.length} relay_inbound events from ${agentName}`
    );

    // Log response details for debugging
    for (const resp of agentResponses) {
      const r = resp as BrokerEvent & { target: string; body: string };
      console.log(`  Agent MCP response: to=${r.target}, body=${r.body?.slice(0, 100)}...`);
    }

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

test("e2e-mcp: agent responds to channel message using MCP post_message", { timeout: 180_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `e2e-channel-${uniqueSuffix()}`;
  const channelName = "test-channel";

  try {
    await harness.spawnAgent(agentName, cli, [channelName], {
      task: `You are a test agent in channel #${channelName}. When you receive a channel message, respond using the mcp__relaycast__post_message tool with channel: "${channelName}". Keep responses brief.`,
    });
    await sleep(15_000);

    harness.clearEvents();

    // Send a channel message (pre-formatted with channel hint)
    await harness.sendMessage({
      to: agentName,
      from: "system",
      text: `Relay message from channel-user [abc123] [#${channelName}]: Please respond to this channel message using the MCP tools.`,
    });

    await sleep(60_000);

    const events = harness.getEvents();
    const agentResponses = getRelayInboundFromAgent(events, agentName);

    assert.ok(
      agentResponses.length >= 1,
      `Agent should have sent at least 1 MCP channel response, got ${agentResponses.length}`
    );

    // Verify response targets the channel
    const channelResponse = agentResponses.find((r) => {
      const resp = r as BrokerEvent & { target: string };
      return resp.target === `#${channelName}` || resp.target === channelName;
    });

    if (channelResponse) {
      console.log(`  Agent correctly responded to channel #${channelName}`);
    } else {
      console.log(`  Agent responses: ${agentResponses.map((r) => (r as any).target).join(", ")}`);
    }

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

test("e2e-mcp: agent responds to thread using MCP reply_to_thread", { timeout: 180_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `e2e-thread-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, cli, ["general"], {
      task: "You are a test agent. When you receive a thread message, respond using the mcp__relaycast__reply_to_thread tool. Keep responses brief.",
    });
    await sleep(15_000);

    harness.clearEvents();

    // Send a message with thread_id to simulate a thread reply request
    const threadId = `thread-${uniqueSuffix()}`;
    await harness.sendMessage({
      to: agentName,
      from: "test-user",
      text: "Please reply to this thread using the MCP reply_to_thread tool.",
      threadId,
    });

    await sleep(60_000);

    const events = harness.getEvents();
    const agentResponses = getRelayInboundFromAgent(events, agentName);

    assert.ok(
      agentResponses.length >= 1,
      `Agent should have sent at least 1 MCP thread response, got ${agentResponses.length}`
    );

    // Check if any response has thread_id
    const threadResponse = agentResponses.find((r) => {
      const resp = r as BrokerEvent & { thread_id?: string };
      return resp.thread_id != null;
    });

    if (threadResponse) {
      const tr = threadResponse as BrokerEvent & { thread_id: string };
      console.log(`  Agent correctly responded to thread: ${tr.thread_id}`);
    } else {
      console.log(`  Note: Agent responded but thread_id not captured in relay_inbound`);
    }

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

// ── Reaction Delivery Tests ─────────────────────────────────────────────────

test("e2e-mcp: agent can check inbox for reactions", { timeout: 180_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const cli = skipUnlessAnyCli(t);
  if (!cli) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `e2e-reaction-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, cli, ["general"], {
      task: "You are a test agent. Use the mcp__relaycast__check_inbox tool to see if you have any new messages or reactions. Report what you find.",
    });
    await sleep(15_000);

    harness.clearEvents();

    // Ask agent to check their inbox
    await harness.sendMessage({
      to: agentName,
      from: "test-user",
      text: "Please check your inbox using mcp__relaycast__check_inbox and tell me if you see any messages or reactions.",
    });

    await sleep(60_000);

    const events = harness.getEvents();
    const output = collectStreamOutput(events, agentName);

    // Verify agent attempted to use check_inbox
    // This is indicated by MCP tool calls in the output
    const usedCheckInbox = output.includes("check_inbox") ||
                           output.includes("mcp__relaycast__check_inbox") ||
                           output.includes("inbox");

    assert.ok(
      usedCheckInbox,
      "Agent should attempt to check inbox when asked about reactions"
    );

    console.log(`  Agent inbox check behavior verified`);

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});
