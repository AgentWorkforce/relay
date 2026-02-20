/**
 * Broker observability & utility integration tests.
 *
 * Tests getStatus, getMetrics, getCrashInsights, and sendInput
 * through the broker binary via the low-level SDK client.
 *
 * Run:
 *   npx tsx tests/integration/broker/observability.test.ts
 *
 * Requires:
 *   RELAY_API_KEY — Relaycast workspace key (auto-provisioned if unset)
 *   AGENT_RELAY_BIN (optional) — path to agent-relay binary
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { BrokerHarness, checkPrerequisites, uniqueSuffix } from './utils/broker-harness.js';
import { AgentRelayProtocolError } from '@agent-relay/sdk';

function skipIfMissing(t: TestContext): boolean {
  const reason = checkPrerequisites();
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

// ── getStatus ─────────────────────────────────────────────────────────────────

test('broker: getStatus returns agent count and pending deliveries', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const name = `status-agent-${suffix}`;

  try {
    // Fresh broker — no agents
    const status0 = await harness.client.getStatus();
    assert.equal(typeof status0.agent_count, 'number');
    assert.ok(Array.isArray(status0.agents), 'agents should be an array');
    assert.equal(typeof status0.pending_delivery_count, 'number');
    assert.ok(Array.isArray(status0.pending_deliveries), 'pending_deliveries should be an array');

    const initialCount = status0.agent_count;

    // Spawn an agent and verify count increases
    await harness.spawnAgent(name);
    const status1 = await harness.client.getStatus();
    assert.equal(status1.agent_count, initialCount + 1);
    assert.ok(
      status1.agents.some((a) => a.name === name),
      'spawned agent should appear in status agents list'
    );

    // Release and verify count decreases
    await harness.releaseAgent(name);
    await new Promise((r) => setTimeout(r, 300));
    const status2 = await harness.client.getStatus();
    assert.equal(status2.agent_count, initialCount);
  } finally {
    await harness.stop();
  }
});

// ── getMetrics ────────────────────────────────────────────────────────────────

test('broker: getMetrics returns broker and agent metrics', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const name = `metrics-agent-${suffix}`;

  try {
    await harness.spawnAgent(name);

    // Wait briefly for process stats to populate
    await new Promise((r) => setTimeout(r, 500));

    // All metrics
    const all = await harness.client.getMetrics();
    assert.ok(Array.isArray(all.agents), 'agents should be an array');
    const agent = all.agents.find((a) => a.name === name);
    assert.ok(agent, 'spawned agent should appear in metrics');
    assert.equal(typeof agent!.pid, 'number');
    assert.equal(typeof agent!.memory_bytes, 'number');
    assert.equal(typeof agent!.uptime_secs, 'number');

    // Broker stats
    assert.ok(all.broker, 'broker stats should be present');
    assert.equal(typeof all.broker!.uptime_secs, 'number');
    assert.equal(typeof all.broker!.active_agents, 'number');

    // Filtered by agent name
    const filtered = await harness.client.getMetrics(name);
    assert.equal(filtered.agents.length, 1);
    assert.equal(filtered.agents[0].name, name);

    await harness.releaseAgent(name);
  } finally {
    await harness.stop();
  }
});

test('broker: getMetrics for nonexistent agent returns error', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();

  try {
    await assert.rejects(
      harness.client.getMetrics(`nonexistent-${uniqueSuffix()}`),
      (err: Error) => {
        return err instanceof AgentRelayProtocolError && err.code === 'agent_not_found';
      },
      'getMetrics for nonexistent agent should throw AgentRelayProtocolError'
    );
  } finally {
    await harness.stop();
  }
});

// ── getCrashInsights ──────────────────────────────────────────────────────────

test('broker: getCrashInsights returns crash data shape', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();

  try {
    const insights = await harness.client.getCrashInsights();
    assert.equal(typeof insights.total_crashes, 'number');
    assert.ok(Array.isArray(insights.recent), 'recent should be an array');
    assert.ok(Array.isArray(insights.patterns), 'patterns should be an array');
    assert.equal(typeof insights.health_score, 'number');
  } finally {
    await harness.stop();
  }
});

// ── sendInput ─────────────────────────────────────────────────────────────────

test('broker: sendInput writes data to agent PTY', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const name = `input-agent-${suffix}`;

  try {
    await harness.spawnAgent(name);

    // Wait for spawn event so the PTY is ready
    await harness.waitForEvent('agent_spawned', 5_000, (e) => e.kind === 'agent_spawned' && e.name === name)
      .promise;

    // Send input to the cat agent and verify it reports bytes written
    const result = await harness.client.sendInput(name, 'hello\n');
    assert.equal(result.name, name);
    assert.equal(typeof result.bytes_written, 'number');
    assert.ok(result.bytes_written > 0, 'should have written bytes');
    assert.equal(result.bytes_written, 6, "should have written 6 bytes for 'hello\\n'");

    await harness.releaseAgent(name);
  } finally {
    await harness.stop();
  }
});

test('broker: sendInput to nonexistent agent returns error', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();

  try {
    await assert.rejects(
      harness.client.sendInput(`nonexistent-${uniqueSuffix()}`, 'data'),
      (err: Error) => {
        return err instanceof AgentRelayProtocolError && err.code === 'agent_not_found';
      },
      'sendInput to nonexistent agent should throw AgentRelayProtocolError'
    );
  } finally {
    await harness.stop();
  }
});
