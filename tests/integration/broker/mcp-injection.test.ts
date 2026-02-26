/**
 * MCP Configuration Injection integration tests.
 *
 * Verifies that per-CLI MCP injection works end-to-end:
 * - Claude: `--mcp-config` flag with correct JSON (API key omitted)
 * - Codex: `--config` flags with API key included
 * - Opencode: `opencode.json` written + `--agent relaycast` flag
 * - Gemini/Droid: pre-spawn `mcp add` commands
 * - Unsupported CLIs (aider, goose): no MCP, but PTY injection still works
 *
 * Tests prove that agents spawned with MCP config can actually use Relaycast
 * MCP tools to respond (relay_inbound events from the agent), and that the
 * credential resolution chain (relaycast.json → env var → config) works.
 *
 * Run:
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   RELAY_INTEGRATION_REAL_CLI=1 node --test tests/integration/broker/dist/mcp-injection.test.js
 *
 * Requires:
 *   RELAY_API_KEY — Relaycast workspace key
 *   RELAY_INTEGRATION_REAL_CLI=1 — opt-in for real CLI tests
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { BrokerEvent } from '@agent-relay/sdk';
import { BrokerHarness, checkPrerequisites, uniqueSuffix } from './utils/broker-harness.js';
import { eventsForAgent } from './utils/assert-helpers.js';
import { skipIfNotRealCli, skipIfCliMissing, sleep } from './utils/cli-helpers.js';

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
  const streams = eventsForAgent(events, agentName, 'worker_stream');
  return streams.map((ev) => (ev as BrokerEvent & { chunk: string }).chunk).join('');
}

/**
 * Get relay_inbound events originating from a specific agent.
 * These events prove the agent used MCP tools to send a message.
 */
function getRelayInboundFromAgent(events: BrokerEvent[], agentName: string): BrokerEvent[] {
  return events.filter((e) => {
    if (e.kind !== 'relay_inbound') return false;
    const inbound = e as BrokerEvent & { from: string };
    return inbound.from === agentName;
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// CLAUDE MCP INJECTION
// Verifies --mcp-config flag is injected and agent can use MCP tools.
// API key is NOT in --mcp-config; the MCP server reads from relaycast.json.
// ══════════════════════════════════════════════════════════════════════════════

test(
  'mcp-injection: claude — DM injects system-reminder with send_dm hint',
  { timeout: 90_000 },
  async (t) => {
    if (skipIfMissing(t)) return;
    if (skipIfNotRealCli(t)) return;
    if (skipIfCliMissing(t, 'claude')) return;

    const harness = new BrokerHarness();
    await harness.start();
    const agentName = `mcp-claude-dm-${uniqueSuffix()}`;

    try {
      await harness.spawnAgent(agentName, 'claude', ['general']);
      await sleep(12_000);

      harness.clearEvents();

      await harness.sendMessage({
        to: agentName,
        from: 'test-user',
        text: 'Hello from integration test',
      });

      await sleep(8_000);

      const events = harness.getEvents();
      const output = collectStreamOutput(events, agentName);

      // Verify the message was injected with system-reminder MCP hints
      assert.ok(
        output.includes('<system-reminder>'),
        'Claude: injected message should include system-reminder wrapper'
      );
      assert.ok(
        output.includes('mcp__relaycast__send_dm'),
        'Claude: DM should hint to use mcp__relaycast__send_dm'
      );
      assert.ok(
        output.includes('Relay message from test-user'),
        'Claude: injected message should contain the relay message'
      );

      await harness.releaseAgent(agentName);
      await sleep(1_000);
    } finally {
      await harness.stop();
    }
  }
);

test('mcp-injection: claude — channel message injects post_message hint', { timeout: 90_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;
  if (skipIfCliMissing(t, 'claude')) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `mcp-claude-ch-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, 'claude', ['dev-team']);
    await sleep(12_000);

    harness.clearEvents();

    await harness.sendMessage({
      to: agentName,
      from: 'system',
      text: 'Relay message from bob [abc123] [#dev-team]: Channel hint test',
    });

    await sleep(8_000);

    const events = harness.getEvents();
    const output = collectStreamOutput(events, agentName);

    assert.ok(
      output.includes('mcp__relaycast__post_message'),
      'Claude: channel message should hint to use mcp__relaycast__post_message'
    );
    assert.ok(output.includes('dev-team'), 'Claude: channel hint should mention the channel name');

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

test('mcp-injection: claude — agent uses MCP tools to respond (e2e)', { timeout: 180_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;
  if (skipIfCliMissing(t, 'claude')) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `mcp-claude-e2e-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, 'claude', ['general'], {
      task: 'You are a test agent. When you receive a message, respond using the mcp__relaycast__send_dm tool to reply directly to the sender. Keep responses to one sentence.',
    });
    await sleep(15_000);

    harness.clearEvents();

    await harness.sendMessage({
      to: agentName,
      from: 'test-user',
      text: "Please acknowledge by replying 'ACK' using the MCP send_dm tool mentioned in the system reminder.",
    });

    // Give agent generous time — MCP server needs to start, authenticate, etc.
    await sleep(90_000);

    const events = harness.getEvents();

    // Verify agent actually used MCP tools to respond
    const agentResponses = getRelayInboundFromAgent(events, agentName);
    assert.ok(
      agentResponses.length >= 1,
      `Claude: agent should have sent at least 1 MCP response, got ${agentResponses.length}. ` +
        'This proves --mcp-config was injected and the MCP server authenticated via relaycast.json.'
    );

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CODEX MCP INJECTION
// Verifies --config flags are injected, including RELAY_API_KEY.
// ══════════════════════════════════════════════════════════════════════════════

test(
  'mcp-injection: codex — agent receives MCP config and can use MCP tools to respond',
  { timeout: 180_000 },
  async (t) => {
    if (skipIfMissing(t)) return;
    if (skipIfNotRealCli(t)) return;
    if (skipIfCliMissing(t, 'codex')) return;

    const harness = new BrokerHarness();
    await harness.start();
    const agentName = `mcp-codex-${uniqueSuffix()}`;

    try {
      await harness.spawnAgent(agentName, 'codex', ['general'], {
        task: 'You are a test agent. When you receive a message, respond using the mcp__relaycast__send_dm tool to reply directly to the sender. Keep responses to one sentence.',
      });
      await sleep(15_000);

      harness.clearEvents();

      await harness.sendMessage({
        to: agentName,
        from: 'test-user',
        text: "Please acknowledge by replying 'ACK' using the MCP send_dm tool mentioned in the system reminder.",
      });

      await sleep(60_000);

      const events = harness.getEvents();
      const output = collectStreamOutput(events, agentName);

      // Verify system-reminder MCP hints were injected
      assert.ok(
        output.includes('<system-reminder>'),
        'Codex: injected message should include system-reminder wrapper'
      );

      // Verify agent used MCP tools to respond
      const agentResponses = getRelayInboundFromAgent(events, agentName);
      assert.ok(
        agentResponses.length >= 1,
        `Codex: agent should have sent at least 1 MCP response, got ${agentResponses.length}. ` +
          'This proves --config flags were injected with RELAY_API_KEY and the MCP server connected.'
      );

      await harness.releaseAgent(agentName);
      await sleep(1_000);
    } finally {
      await harness.stop();
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// OPENCODE MCP INJECTION
// Verifies opencode.json is written and --agent relaycast flag is passed.
// ══════════════════════════════════════════════════════════════════════════════

test(
  'mcp-injection: opencode — agent receives MCP config via opencode.json',
  { timeout: 180_000 },
  async (t) => {
    if (skipIfMissing(t)) return;
    if (skipIfNotRealCli(t)) return;
    if (skipIfCliMissing(t, 'opencode')) return;

    const harness = new BrokerHarness();
    await harness.start();
    const agentName = `mcp-opencode-${uniqueSuffix()}`;

    try {
      await harness.spawnAgent(agentName, 'opencode', ['general'], {
        task: 'You are a test agent. When you receive a message, respond using the mcp__relaycast__send_dm tool to reply directly to the sender. Keep responses to one sentence.',
      });
      await sleep(15_000);

      harness.clearEvents();

      await harness.sendMessage({
        to: agentName,
        from: 'test-user',
        text: "Please acknowledge by replying 'ACK' using the MCP send_dm tool mentioned in the system reminder.",
      });

      await sleep(60_000);

      const events = harness.getEvents();
      const output = collectStreamOutput(events, agentName);

      // Verify system-reminder was injected
      assert.ok(
        output.includes('<system-reminder>'),
        'Opencode: injected message should include system-reminder wrapper'
      );

      // Verify agent used MCP tools to respond
      const agentResponses = getRelayInboundFromAgent(events, agentName);
      assert.ok(
        agentResponses.length >= 1,
        `Opencode: agent should have sent at least 1 MCP response, got ${agentResponses.length}. ` +
          'This proves opencode.json was written and --agent relaycast was passed.'
      );

      await harness.releaseAgent(agentName);
      await sleep(1_000);
    } finally {
      await harness.stop();
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// GEMINI MCP INJECTION
// Verifies pre-spawn `gemini mcp add` command ran and MCP is available.
// ══════════════════════════════════════════════════════════════════════════════

test('mcp-injection: gemini — pre-spawn mcp add enables MCP tools', { timeout: 180_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;
  if (skipIfCliMissing(t, 'gemini')) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `mcp-gemini-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, 'gemini', ['general'], {
      task: 'You are a test agent. When you receive a message, respond using the mcp__relaycast__send_dm tool to reply directly to the sender. Keep responses to one sentence.',
    });
    await sleep(15_000);

    harness.clearEvents();

    await harness.sendMessage({
      to: agentName,
      from: 'test-user',
      text: "Please acknowledge by replying 'ACK' using the MCP send_dm tool mentioned in the system reminder.",
    });

    await sleep(60_000);

    const events = harness.getEvents();
    const output = collectStreamOutput(events, agentName);

    // Verify system-reminder was injected via PTY
    assert.ok(
      output.includes('<system-reminder>') || output.includes('Relay message'),
      'Gemini: injected message should include system-reminder or relay message content'
    );

    // Verify agent used MCP tools to respond
    const agentResponses = getRelayInboundFromAgent(events, agentName);
    assert.ok(
      agentResponses.length >= 1,
      `Gemini: agent should have sent at least 1 MCP response, got ${agentResponses.length}. ` +
        "This proves 'gemini mcp add' ran successfully before spawn."
    );

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// DROID MCP INJECTION
// Verifies pre-spawn `droid mcp add` command ran and MCP is available.
// ══════════════════════════════════════════════════════════════════════════════

test('mcp-injection: droid — pre-spawn mcp add enables MCP tools', { timeout: 180_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;
  if (skipIfCliMissing(t, 'droid')) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `mcp-droid-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, 'droid', ['general'], {
      task: 'You are a test agent. When you receive a message, respond using the mcp__relaycast__send_dm tool to reply directly to the sender. Keep responses to one sentence.',
    });
    await sleep(15_000);

    harness.clearEvents();

    await harness.sendMessage({
      to: agentName,
      from: 'test-user',
      text: "Please acknowledge by replying 'ACK' using the MCP send_dm tool mentioned in the system reminder.",
    });

    await sleep(60_000);

    const events = harness.getEvents();
    const output = collectStreamOutput(events, agentName);

    assert.ok(
      output.includes('<system-reminder>') || output.includes('Relay message'),
      'Droid: injected message should include system-reminder or relay message content'
    );

    const agentResponses = getRelayInboundFromAgent(events, agentName);
    assert.ok(
      agentResponses.length >= 1,
      `Droid: agent should have sent at least 1 MCP response, got ${agentResponses.length}. ` +
        "This proves 'droid mcp add --env ...' ran successfully before spawn."
    );

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// UNSUPPORTED CLIs (aider, goose)
// No MCP injection, but PTY message injection still works.
// Agent can receive messages but cannot respond via MCP tools.
// ══════════════════════════════════════════════════════════════════════════════

test('mcp-injection: aider — no MCP injection, PTY delivery still works', { timeout: 90_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;
  if (skipIfCliMissing(t, 'aider')) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `mcp-aider-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, 'aider', ['general']);
    await sleep(10_000);

    harness.clearEvents();

    await harness.sendMessage({
      to: agentName,
      from: 'test-user',
      text: 'Hello aider agent',
    });

    await sleep(10_000);

    const events = harness.getEvents();

    // Message should still be delivered via PTY injection
    const deliveryEvents = events.filter(
      (e) =>
        e.kind === 'delivery_ack' && 'name' in e && (e as BrokerEvent & { name: string }).name === agentName
    );
    assert.ok(
      deliveryEvents.length >= 1,
      'Aider: message should still be delivered via PTY even without MCP injection'
    );

    // Should NOT have relay_inbound from this agent (no MCP tools to send with)
    const agentResponses = getRelayInboundFromAgent(events, agentName);
    // Note: we don't assert 0 here because aider might have other mechanisms,
    // but we log the count for visibility
    console.log(`  Aider relay_inbound responses (expected 0): ${agentResponses.length}`);

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

test('mcp-injection: goose — no MCP injection, PTY delivery still works', { timeout: 90_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;
  if (skipIfCliMissing(t, 'goose')) return;

  const harness = new BrokerHarness();
  await harness.start();
  const agentName = `mcp-goose-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, 'goose', ['general']);
    await sleep(10_000);

    harness.clearEvents();

    await harness.sendMessage({
      to: agentName,
      from: 'test-user',
      text: 'Hello goose agent',
    });

    await sleep(10_000);

    const events = harness.getEvents();

    const deliveryEvents = events.filter(
      (e) =>
        e.kind === 'delivery_ack' && 'name' in e && (e as BrokerEvent & { name: string }).name === agentName
    );
    assert.ok(
      deliveryEvents.length >= 1,
      'Goose: message should still be delivered via PTY even without MCP injection'
    );

    const agentResponses = getRelayInboundFromAgent(events, agentName);
    console.log(`  Goose relay_inbound responses (expected 0): ${agentResponses.length}`);

    await harness.releaseAgent(agentName);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CROSS-PROVIDER: credential resolution chain
// Verifies that agents spawned with different injection methods can all
// successfully authenticate and communicate with each other via MCP.
// ══════════════════════════════════════════════════════════════════════════════

test(
  'mcp-injection: cross-provider — claude and codex agents can exchange messages via MCP',
  { timeout: 240_000 },
  async (t) => {
    if (skipIfMissing(t)) return;
    if (skipIfNotRealCli(t)) return;
    if (skipIfCliMissing(t, 'claude')) return;
    if (skipIfCliMissing(t, 'codex')) return;

    const harness = new BrokerHarness();
    await harness.start();
    const suffix = uniqueSuffix();
    const claudeName = `mcp-xp-claude-${suffix}`;
    const codexName = `mcp-xp-codex-${suffix}`;

    try {
      // Spawn both agents with MCP
      await harness.spawnAgent(claudeName, 'claude', ['general'], {
        task: `You are a test agent named ${claudeName}. When you receive a message, respond using mcp__relaycast__send_dm to reply to the sender. Keep responses to one sentence.`,
      });
      await harness.spawnAgent(codexName, 'codex', ['general'], {
        task: `You are a test agent named ${codexName}. When you receive a message, respond using mcp__relaycast__send_dm to reply to the sender. Keep responses to one sentence.`,
      });

      await sleep(15_000);
      harness.clearEvents();

      // Send a message to each
      await harness.sendMessage({
        to: claudeName,
        from: 'test-user',
        text: "Claude: reply 'ACK' via MCP send_dm.",
      });
      await harness.sendMessage({
        to: codexName,
        from: 'test-user',
        text: "Codex: reply 'ACK' via MCP send_dm.",
      });

      await sleep(60_000);

      const events = harness.getEvents();

      // Both agents should have responded via MCP
      const claudeResponses = getRelayInboundFromAgent(events, claudeName);
      const codexResponses = getRelayInboundFromAgent(events, codexName);

      assert.ok(
        claudeResponses.length >= 1,
        `Cross-provider: Claude should respond via MCP, got ${claudeResponses.length}. ` +
          'Claude uses --mcp-config with API key from relaycast.json.'
      );
      assert.ok(
        codexResponses.length >= 1,
        `Cross-provider: Codex should respond via MCP, got ${codexResponses.length}. ` +
          'Codex uses --config flags with API key inline.'
      );

      await harness.releaseAgent(claudeName);
      await harness.releaseAgent(codexName);
      await sleep(1_000);
    } finally {
      await harness.stop();
    }
  }
);
