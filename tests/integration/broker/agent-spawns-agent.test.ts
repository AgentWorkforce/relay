/**
 * Agent-spawns-agent MCP injection test.
 *
 * Reproduces the exact flow when an agent calls `agent_add` via MCP:
 *   1. Start broker
 *   2. Use Relaycast API to spawn agent (simulating agent_add MCP tool)
 *   3. Verify spawned agent has MCP tools and can respond via relay_inbound
 *
 * This exercises the WS `AgentSpawnRequested` → `workers.spawn()` path,
 * which is different from the SDK `spawn_agent` frame path.
 *
 * Run:
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   RELAY_INTEGRATION_REAL_CLI=1 node --test tests/integration/broker/dist/agent-spawns-agent.test.js
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { RelayCast, type BrokerEvent } from '@agent-relay/sdk';
import {
  BrokerHarness,
  checkPrerequisites,
  uniqueSuffix,
} from './utils/broker-harness.js';
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

function collectStreamOutput(events: BrokerEvent[], agentName: string): string {
  const streams = eventsForAgent(events, agentName, 'worker_stream');
  return streams.map((ev) => (ev as BrokerEvent & { chunk: string }).chunk).join('');
}

function getRelayInboundFromAgent(events: BrokerEvent[], agentName: string): BrokerEvent[] {
  return events.filter((e) => {
    if (e.kind !== 'relay_inbound') return false;
    const inbound = e as BrokerEvent & { from: string };
    return inbound.from === agentName;
  });
}

/**
 * Shared test logic: spawn an agent via the Relaycast API (agent_add path),
 * send it a message, and verify it can respond using MCP tools.
 */
async function testAgentAddSpawn(
  cli: 'claude' | 'codex' | 'gemini' | 'aider' | 'goose',
  harness: BrokerHarness,
  opts: { initWaitMs?: number; responseWaitMs?: number } = {}
): Promise<void> {
  const initWait = opts.initWaitMs ?? 20_000;
  const responseWait = opts.responseWaitMs ?? 60_000;

  const suffix = uniqueSuffix();
  const childName = `child-${cli}-${suffix}`;

  const apiKey = process.env.RELAY_API_KEY!;
  const relay = new RelayCast({ apiKey });
  console.log(`  Spawning '${childName}' via Relaycast API (agent_add path)...`);
  const spawnResult = await relay.agents.spawn({
    name: childName,
    cli,
    task: 'You are a test agent. When you receive a message, respond using the mcp__relaycast__message_dm_send tool to reply directly to the sender. Keep responses to one sentence.',
    channel: 'general',
  });
  console.log(`  Spawn result: id=${(spawnResult as Record<string, unknown>).id}, alreadyExisted=${(spawnResult as Record<string, unknown>).alreadyExisted}`);

  console.log(`  Waiting ${initWait / 1000}s for agent to initialize...`);
  await sleep(initWait);

  // Verify agent exists
  const agents = await harness.listAgents();
  console.log(`  Active agents: ${agents.map((a) => a.name).join(', ') || 'NONE'}`);
  const childAgent = agents.find((a) => a.name === childName);
  assert.ok(childAgent, `Agent '${childName}' should exist in broker`);

  // Send message and check MCP response
  harness.clearEvents();
  await harness.sendMessage({
    to: childName,
    from: 'test-user',
    text: "Reply 'ACK' using the MCP send_dm tool.",
  });

  console.log(`  Waiting ${responseWait / 1000}s for MCP response...`);
  await sleep(responseWait);

  const events = harness.getEvents();
  const childResponses = getRelayInboundFromAgent(events, childName);
  console.log(`  relay_inbound responses: ${childResponses.length}`);

  // Log output for diagnosis on failure
  if (childResponses.length === 0) {
    const output = collectStreamOutput(events, childName);
    const clean = output
      .replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\[[\?][0-9]*[a-z]/g, '')
      .replace(/\r/g, '');
    console.log(`  Agent output (last 2000 chars):\n${clean.slice(-2000)}`);
  }

  assert.ok(
    childResponses.length >= 1,
    `${cli} agent spawned via Relaycast API (agent_add) should respond via MCP. ` +
      `Got ${childResponses.length} responses. ` +
      `This proves WS AgentSpawnRequested → workers.spawn() correctly injects MCP config with pre-registered token.`
  );

  await harness.releaseAgent(childName);
  await sleep(1_000);
}

// ══════════════════════════════════════════════════════════════════════════════
// CLAUDE
// ══════════════════════════════════════════════════════════════════════════════

test(
  'agent-spawns-agent: claude via relaycast API has MCP tools',
  { timeout: 180_000 },
  async (t) => {
    if (skipIfMissing(t)) return;
    if (skipIfNotRealCli(t)) return;
    if (skipIfCliMissing(t, 'claude')) return;

    const harness = new BrokerHarness();
    await harness.start();
    try {
      await testAgentAddSpawn('claude', harness);
    } finally {
      await harness.stop();
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// CODEX
// ══════════════════════════════════════════════════════════════════════════════

test(
  'agent-spawns-agent: codex via relaycast API has MCP tools',
  { timeout: 180_000 },
  async (t) => {
    if (skipIfMissing(t)) return;
    if (skipIfNotRealCli(t)) return;
    if (skipIfCliMissing(t, 'codex')) return;

    const harness = new BrokerHarness();
    await harness.start();
    try {
      await testAgentAddSpawn('codex', harness);
    } finally {
      await harness.stop();
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// GEMINI
// ══════════════════════════════════════════════════════════════════════════════

test(
  'agent-spawns-agent: gemini via relaycast API has MCP tools',
  { timeout: 180_000 },
  async (t) => {
    if (skipIfMissing(t)) return;
    if (skipIfNotRealCli(t)) return;
    if (skipIfCliMissing(t, 'gemini')) return;

    const harness = new BrokerHarness();
    await harness.start();
    try {
      await testAgentAddSpawn('gemini', harness);
    } finally {
      await harness.stop();
    }
  }
);

// Note: opencode and droid are not in the Relaycast API's cli enum,
// so they can't be spawned via agent_add. They are only spawnable via
// the SDK's spawnPty (which uses the broker's spawn_agent frame path).
// Those paths are covered by the existing mcp-injection.test.ts tests.
