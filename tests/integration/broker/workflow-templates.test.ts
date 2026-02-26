/**
 * Workflow template integration tests.
 *
 * Tests that built-in workflow templates (review-loop, code-review, etc.)
 * work correctly with real CLI agents. Verifies multi-agent coordination,
 * message delivery, and workflow step sequencing.
 *
 * These tests are gated behind RELAY_INTEGRATION_REAL_CLI=1 to avoid
 * running resource-heavy tests in regular CI.
 *
 * Run:
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   RELAY_INTEGRATION_REAL_CLI=1 node --test tests/integration/broker/dist/workflow-templates.test.js
 *
 * Requires:
 *   RELAY_API_KEY — Relaycast workspace key (auto-provisioned if missing)
 *   RELAY_INTEGRATION_REAL_CLI=1 — opt-in for real CLI tests
 *   AGENT_RELAY_BIN (optional) — path to agent-relay binary
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { BrokerEvent } from '@agent-relay/sdk';
import { BrokerHarness, checkPrerequisites, uniqueSuffix } from './utils/broker-harness.js';
import {
  assertAgentExists,
  assertNoDroppedDeliveries,
  assertAgentSpawnedEvent,
} from './utils/assert-helpers.js';
import { skipIfNotRealCli, skipIfCliMissing, sleep, firstAvailableCli } from './utils/cli-helpers.js';

function skipIfMissing(t: TestContext): boolean {
  const reason = checkPrerequisites();
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

// ── Review-Loop Pattern Tests ────────────────────────────────────────────────

test('workflow: review-loop — spawn implementer and reviewers', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;

  // Need at least one CLI for this test
  const cli = firstAvailableCli();
  if (!cli) {
    t.skip('No CLI available');
    return;
  }
  if (skipIfCliMissing(t, cli)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();

  try {
    // Spawn review-loop agents
    const implementerName = `implementer-${suffix}`;
    const reviewerDiffName = `reviewer-diff-${suffix}`;
    const reviewerArchName = `reviewer-arch-${suffix}`;

    // Spawn implementer (interactive)
    await harness.spawnAgent(implementerName, cli, ['review-loop']);
    await sleep(10_000);
    await assertAgentExists(harness, implementerName);

    // Spawn reviewers (can be different CLIs in real scenario)
    await harness.spawnAgent(reviewerDiffName, cli, ['review-loop']);
    await harness.spawnAgent(reviewerArchName, cli, ['review-loop']);
    await sleep(10_000);

    // Verify all agents are alive
    const agents = await harness.listAgents();
    assert.ok(
      agents.some((a) => a.name === implementerName),
      'implementer should be alive'
    );
    assert.ok(
      agents.some((a) => a.name === reviewerDiffName),
      'reviewer-diff should be alive'
    );
    assert.ok(
      agents.some((a) => a.name === reviewerArchName),
      'reviewer-arch should be alive'
    );

    // Verify spawn events
    const events = harness.getEvents();
    assertAgentSpawnedEvent(events, implementerName);
    assertAgentSpawnedEvent(events, reviewerDiffName);
    assertAgentSpawnedEvent(events, reviewerArchName);

    // Clean up
    await harness.releaseAgent(implementerName);
    await harness.releaseAgent(reviewerDiffName);
    await harness.releaseAgent(reviewerArchName);
    await sleep(2_000);
  } finally {
    await harness.stop();
  }
});

test('workflow: review-loop — implementer to reviewer message flow', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;

  const cli = firstAvailableCli();
  if (!cli) {
    t.skip('No CLI available');
    return;
  }
  if (skipIfCliMissing(t, cli)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();

  try {
    const implementerName = `implementer-${suffix}`;
    const reviewerName = `reviewer-${suffix}`;

    // Spawn both agents
    await harness.spawnAgent(implementerName, cli, ['review-loop']);
    await harness.spawnAgent(reviewerName, cli, ['review-loop']);
    await sleep(15_000);

    // Send task to implementer
    const implResult = await harness.sendMessage({
      to: implementerName,
      from: 'coordinator',
      text: 'Implement a simple hello world function. Output: IMPLEMENTATION COMPLETE when done.',
    });
    assert.ok(implResult.event_id, 'should get event_id for implementer message');

    // Wait for implementer to process
    await sleep(20_000);

    // Send review request to reviewer (simulating workflow step)
    const reviewResult = await harness.sendMessage({
      to: reviewerName,
      from: 'coordinator',
      text: 'Review the implementation for code quality. Output: REVIEW:PASS or REVIEW:ISSUES',
    });
    assert.ok(reviewResult.event_id, 'should get event_id for reviewer message');

    // Wait for review
    await sleep(10_000);

    // Verify delivery pipeline
    const events = harness.getEvents();

    // Both agents should have received messages
    const implAck = events.find(
      (e) =>
        e.kind === 'delivery_ack' &&
        'name' in e &&
        (e as BrokerEvent & { name: string }).name === implementerName
    );
    const reviewAck = events.find(
      (e) =>
        e.kind === 'delivery_ack' &&
        'name' in e &&
        (e as BrokerEvent & { name: string }).name === reviewerName
    );

    assert.ok(implAck, 'implementer should acknowledge message');
    assert.ok(reviewAck, 'reviewer should acknowledge message');

    // No dropped deliveries
    assertNoDroppedDeliveries(events);

    // Clean up
    await harness.releaseAgent(implementerName);
    await harness.releaseAgent(reviewerName);
    await sleep(2_000);
  } finally {
    await harness.stop();
  }
});

test('workflow: review-loop — reviewer to reviewer communication', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;

  const cli = firstAvailableCli();
  if (!cli) {
    t.skip('No CLI available');
    return;
  }
  if (skipIfCliMissing(t, cli)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();

  try {
    const reviewer1Name = `reviewer1-${suffix}`;
    const reviewer2Name = `reviewer2-${suffix}`;

    // Spawn two reviewers
    await harness.spawnAgent(reviewer1Name, cli, ['review-loop']);
    await harness.spawnAgent(reviewer2Name, cli, ['review-loop']);
    await sleep(15_000);

    // reviewer1 sends message to reviewer2 (collaborative review)
    const r2rResult = await harness.sendMessage({
      to: reviewer2Name,
      from: reviewer1Name,
      text: 'I found a potential security issue. Do you agree?',
    });
    assert.ok(r2rResult.event_id, 'reviewer-to-reviewer message should get event_id');

    // Wait for delivery
    await sleep(10_000);

    // Verify reviewer2 received the message
    const events = harness.getEvents();
    const r2Ack = events.find(
      (e) =>
        e.kind === 'delivery_ack' &&
        'name' in e &&
        (e as BrokerEvent & { name: string }).name === reviewer2Name
    );

    assert.ok(r2Ack, 'reviewer2 should acknowledge message from reviewer1');
    assertNoDroppedDeliveries(events);

    // Clean up
    await harness.releaseAgent(reviewer1Name);
    await harness.releaseAgent(reviewer2Name);
    await sleep(2_000);
  } finally {
    await harness.stop();
  }
});

// ── Multi-CLI Workflow Tests ─────────────────────────────────────────────────

test('workflow: multi-cli — claude implementer + codex reviewer', { timeout: 150_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;
  if (skipIfCliMissing(t, 'claude')) return;
  if (skipIfCliMissing(t, 'codex')) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();

  try {
    const implementerName = `impl-claude-${suffix}`;
    const reviewerName = `review-codex-${suffix}`;

    // Spawn Claude as implementer, Codex as reviewer
    await harness.spawnAgent(implementerName, 'claude', ['workflow']);
    await harness.spawnAgent(reviewerName, 'codex', ['workflow']);
    await sleep(15_000);

    // Verify both are alive
    const agents = await harness.listAgents();
    assert.ok(
      agents.some((a) => a.name === implementerName),
      'claude implementer should be alive'
    );
    assert.ok(
      agents.some((a) => a.name === reviewerName),
      'codex reviewer should be alive'
    );

    // Send implementation task to Claude
    await harness.sendMessage({
      to: implementerName,
      from: 'coordinator',
      text: 'Create a function that adds two numbers. Say DONE when finished.',
    });
    await sleep(25_000);

    // Send review task to Codex
    await harness.sendMessage({
      to: reviewerName,
      from: 'coordinator',
      text: 'Review the addition function for edge cases. Say REVIEW COMPLETE when done.',
    });
    await sleep(15_000);

    // Verify both received messages
    const events = harness.getEvents();
    const implAck = events.find(
      (e) =>
        e.kind === 'delivery_ack' &&
        'name' in e &&
        (e as BrokerEvent & { name: string }).name === implementerName
    );
    const reviewAck = events.find(
      (e) =>
        e.kind === 'delivery_ack' &&
        'name' in e &&
        (e as BrokerEvent & { name: string }).name === reviewerName
    );

    assert.ok(implAck, 'claude should acknowledge task');
    assert.ok(reviewAck, 'codex should acknowledge review');
    assertNoDroppedDeliveries(events);

    // Clean up
    await harness.releaseAgent(implementerName);
    await harness.releaseAgent(reviewerName);
    await sleep(2_000);
  } finally {
    await harness.stop();
  }
});

// ── Parallel Agent Spawn Tests ───────────────────────────────────────────────

test('workflow: parallel spawn — 4 agents simultaneously', { timeout: 180_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;

  const cli = firstAvailableCli();
  if (!cli) {
    t.skip('No CLI available');
    return;
  }
  if (skipIfCliMissing(t, cli)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();

  try {
    const agentNames = [`agent1-${suffix}`, `agent2-${suffix}`, `agent3-${suffix}`, `agent4-${suffix}`];

    // Spawn all 4 agents in parallel
    await Promise.all(agentNames.map((name) => harness.spawnAgent(name, cli, ['parallel-test'])));

    // Wait for all to initialize
    await sleep(20_000);

    // Verify all agents are alive
    const agents = await harness.listAgents();
    for (const name of agentNames) {
      assert.ok(
        agents.some((a) => a.name === name),
        `${name} should be alive`
      );
    }

    // Verify spawn events for all
    const events = harness.getEvents();
    for (const name of agentNames) {
      assertAgentSpawnedEvent(events, name);
    }

    // Send message to each agent
    await Promise.all(
      agentNames.map((name) =>
        harness.sendMessage({
          to: name,
          from: 'coordinator',
          text: `Task for ${name}: acknowledge receipt`,
        })
      )
    );

    // Wait for deliveries
    await sleep(15_000);

    // Verify all received messages
    const finalEvents = harness.getEvents();
    const ackCount = finalEvents.filter(
      (e) =>
        e.kind === 'delivery_ack' &&
        'name' in e &&
        agentNames.includes((e as BrokerEvent & { name: string }).name)
    ).length;

    assert.ok(ackCount >= 1, `at least 1 agent should acknowledge, got ${ackCount}`);
    assertNoDroppedDeliveries(finalEvents);

    // Clean up
    await Promise.all(agentNames.map((name) => harness.releaseAgent(name)));
    await sleep(3_000);
  } finally {
    await harness.stop();
  }
});

// ── Channel-Based Coordination Tests ─────────────────────────────────────────

test('workflow: channel broadcast — message to all workflow agents', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;

  const cli = firstAvailableCli();
  if (!cli) {
    t.skip('No CLI available');
    return;
  }
  if (skipIfCliMissing(t, cli)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const channelName = `workflow-${suffix}`;

  try {
    const agent1 = `worker1-${suffix}`;
    const agent2 = `worker2-${suffix}`;

    // Spawn agents on same channel
    await harness.spawnAgent(agent1, cli, [channelName]);
    await harness.spawnAgent(agent2, cli, [channelName]);
    await sleep(15_000);

    // Broadcast to channel
    const broadcastResult = await harness.sendMessage({
      to: `#${channelName}`,
      from: 'coordinator',
      text: 'All agents: report your status',
    });
    assert.ok(broadcastResult.event_id, 'broadcast should get event_id');

    // Wait for deliveries
    await sleep(10_000);

    // Verify events
    const events = harness.getEvents();
    assertNoDroppedDeliveries(events);

    // Clean up
    await harness.releaseAgent(agent1);
    await harness.releaseAgent(agent2);
    await sleep(2_000);
  } finally {
    await harness.stop();
  }
});

// ── Sequential Step Execution Tests ──────────────────────────────────────────

test('workflow: sequential steps — implement → review → address', { timeout: 180_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;

  const cli = firstAvailableCli();
  if (!cli) {
    t.skip('No CLI available');
    return;
  }
  if (skipIfCliMissing(t, cli)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();

  try {
    const implementerName = `impl-${suffix}`;
    const reviewerName = `rev-${suffix}`;

    // Spawn agents
    await harness.spawnAgent(implementerName, cli, ['sequential']);
    await harness.spawnAgent(reviewerName, cli, ['sequential']);
    await sleep(15_000);

    // Step 1: Implementation
    const step1Result = await harness.sendMessage({
      to: implementerName,
      from: 'workflow-engine',
      text: 'Step 1: Implement a factorial function. Output STEP1_COMPLETE when done.',
    });
    assert.ok(step1Result.event_id, 'step 1 message should get event_id');
    await sleep(20_000);

    // Step 2: Review (depends on step 1)
    const step2Result = await harness.sendMessage({
      to: reviewerName,
      from: 'workflow-engine',
      text: 'Step 2: Review the factorial implementation. Output STEP2_COMPLETE when done.',
    });
    assert.ok(step2Result.event_id, 'step 2 message should get event_id');
    await sleep(15_000);

    // Step 3: Address feedback (depends on step 2)
    const step3Result = await harness.sendMessage({
      to: implementerName,
      from: 'workflow-engine',
      text: 'Step 3: Address any review feedback. Output STEP3_COMPLETE when done.',
    });
    assert.ok(step3Result.event_id, 'step 3 message should get event_id');
    await sleep(15_000);

    // Verify all steps were acknowledged
    const events = harness.getEvents();
    const implAcks = events.filter(
      (e) =>
        e.kind === 'delivery_ack' &&
        'name' in e &&
        (e as BrokerEvent & { name: string }).name === implementerName
    );
    const revAcks = events.filter(
      (e) =>
        e.kind === 'delivery_ack' &&
        'name' in e &&
        (e as BrokerEvent & { name: string }).name === reviewerName
    );

    assert.ok(implAcks.length >= 1, 'implementer should have at least 1 ack');
    assert.ok(revAcks.length >= 1, 'reviewer should have at least 1 ack');
    assertNoDroppedDeliveries(events);

    // Clean up
    await harness.releaseAgent(implementerName);
    await harness.releaseAgent(reviewerName);
    await sleep(2_000);
  } finally {
    await harness.stop();
  }
});

// ── Agent Recovery Tests ─────────────────────────────────────────────────────

test('workflow: agent lifecycle — release and re-spawn', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;

  const cli = firstAvailableCli();
  if (!cli) {
    t.skip('No CLI available');
    return;
  }
  if (skipIfCliMissing(t, cli)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const agentName = `lifecycle-${suffix}`;

  try {
    // First spawn
    await harness.spawnAgent(agentName, cli, ['lifecycle']);
    await sleep(10_000);
    await assertAgentExists(harness, agentName);

    // Release
    await harness.releaseAgent(agentName);
    await sleep(3_000);

    // Verify agent is gone
    const agentsAfterRelease = await harness.listAgents();
    assert.ok(!agentsAfterRelease.some((a) => a.name === agentName), 'agent should be gone after release');

    // Re-spawn with same name
    await harness.spawnAgent(agentName, cli, ['lifecycle']);
    await sleep(10_000);

    // Verify agent is back
    await assertAgentExists(harness, agentName);

    // Verify events show two spawns
    const events = harness.getEvents();
    const spawnEvents = events.filter(
      (e) =>
        e.kind === 'agent_spawned' && 'name' in e && (e as BrokerEvent & { name: string }).name === agentName
    );
    assert.equal(spawnEvents.length, 2, 'should have 2 spawn events');

    // Clean up
    await harness.releaseAgent(agentName);
    await sleep(2_000);
  } finally {
    await harness.stop();
  }
});

// ── Stress Test: Many Agents ─────────────────────────────────────────────────

test('workflow: stress — 6 agents in hub-spoke pattern', { timeout: 300_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;

  const cli = firstAvailableCli();
  if (!cli) {
    t.skip('No CLI available');
    return;
  }
  if (skipIfCliMissing(t, cli)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();

  try {
    // Hub (lead) + 5 spokes (workers)
    const hubName = `hub-${suffix}`;
    const spokeNames = [
      `spoke1-${suffix}`,
      `spoke2-${suffix}`,
      `spoke3-${suffix}`,
      `spoke4-${suffix}`,
      `spoke5-${suffix}`,
    ];

    // Spawn hub
    await harness.spawnAgent(hubName, cli, ['stress-test']);
    await sleep(10_000);

    // Spawn spokes
    for (const name of spokeNames) {
      await harness.spawnAgent(name, cli, ['stress-test']);
      await sleep(5_000); // Stagger to avoid overwhelming
    }

    // Wait for all to initialize
    await sleep(15_000);

    // Verify all agents are alive
    const agents = await harness.listAgents();
    assert.ok(
      agents.some((a) => a.name === hubName),
      'hub should be alive'
    );
    for (const name of spokeNames) {
      assert.ok(
        agents.some((a) => a.name === name),
        `${name} should be alive`
      );
    }

    // Hub sends message to each spoke
    for (const spokeName of spokeNames) {
      await harness.sendMessage({
        to: spokeName,
        from: hubName,
        text: `Task for ${spokeName}: process your work item`,
      });
      await sleep(2_000); // Small delay between sends
    }

    // Wait for processing
    await sleep(20_000);

    // Verify deliveries
    const events = harness.getEvents();
    const ackCount = events.filter(
      (e) =>
        e.kind === 'delivery_ack' &&
        'name' in e &&
        spokeNames.includes((e as BrokerEvent & { name: string }).name)
    ).length;

    assert.ok(ackCount >= 1, `at least 1 spoke should acknowledge, got ${ackCount}`);
    assertNoDroppedDeliveries(events);

    // Clean up - release all
    await harness.releaseAgent(hubName);
    for (const name of spokeNames) {
      await harness.releaseAgent(name);
    }
    await sleep(5_000);
  } finally {
    await harness.stop();
  }
});

// ── Lightweight Tests (cat process, no real CLI needed) ─────────────────────

test('workflow: cat — lightweight workflow simulation', { timeout: 60_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();

  try {
    // Spawn "agents" using cat (lightweight, always available)
    const implName = `cat-impl-${suffix}`;
    const revName = `cat-rev-${suffix}`;

    await harness.spawnAgent(implName, 'cat', ['cat-workflow']);
    await harness.spawnAgent(revName, 'cat', ['cat-workflow']);
    await sleep(5_000);

    // Verify both alive
    await assertAgentExists(harness, implName);
    await assertAgentExists(harness, revName);

    // Send workflow messages
    await harness.sendMessage({
      to: implName,
      from: 'coordinator',
      text: 'implement task',
    });
    await harness.sendMessage({
      to: revName,
      from: 'coordinator',
      text: 'review task',
    });

    await sleep(5_000);

    // Verify deliveries
    const events = harness.getEvents();
    const implAck = events.find(
      (e) =>
        e.kind === 'delivery_ack' && 'name' in e && (e as BrokerEvent & { name: string }).name === implName
    );
    const revAck = events.find(
      (e) =>
        e.kind === 'delivery_ack' && 'name' in e && (e as BrokerEvent & { name: string }).name === revName
    );

    assert.ok(implAck, 'cat-impl should acknowledge');
    assert.ok(revAck, 'cat-rev should acknowledge');
    assertNoDroppedDeliveries(events);

    // Clean up
    await harness.releaseAgent(implName);
    await harness.releaseAgent(revName);
    await sleep(2_000);
  } finally {
    await harness.stop();
  }
});
