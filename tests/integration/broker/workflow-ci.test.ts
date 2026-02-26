/**
 * CI-friendly workflow integration tests using lightweight processes.
 *
 * These tests use a lightweight fake CLI shim (named as an allowed Relaycast
 * CLI) so they can run in CI without API keys or real AI CLI binaries.
 *
 * Run:
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   node --test tests/integration/broker/dist/workflow-ci.test.js
 *
 * No special environment variables required (auto-provisions ephemeral workspace).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { BrokerEvent } from '@agent-relay/sdk';
import { BrokerHarness, checkPrerequisites, uniqueSuffix } from './utils/broker-harness.js';
import {
  assertAgentExists,
  assertAgentNotExists,
  assertNoDroppedDeliveries,
  assertAgentSpawnedEvent,
  assertAgentReleasedEvent,
} from './utils/assert-helpers.js';
import { sleep } from './utils/cli-helpers.js';

const CI_TEST_CLI = 'gemini';
const DELIVERY_PROGRESS_KINDS = new Set<BrokerEvent['kind']>([
  'delivery_queued',
  'delivery_injected',
  'delivery_active',
  'delivery_verified',
  'delivery_ack',
  'delivery_retry',
]);

let fakeCliDir: string | undefined;

function ensureFakeCliDir(): string {
  if (fakeCliDir) return fakeCliDir;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ci-cli-'));
  const script = '#!/usr/bin/env bash\nexec cat\n';
  const fakeCliPath = path.join(dir, CI_TEST_CLI);
  fs.writeFileSync(fakeCliPath, script, { mode: 0o755 });
  fakeCliDir = dir;
  return dir;
}

function createCiHarness(): BrokerHarness {
  const shimDir = ensureFakeCliDir();
  const existingPath = process.env.PATH ?? '';
  const mergedPath = existingPath ? `${shimDir}${path.delimiter}${existingPath}` : shimDir;
  return new BrokerHarness({
    env: {
      ...process.env,
      PATH: mergedPath,
    },
  });
}

function countDeliveryProgress(events: BrokerEvent[], name?: string): number {
  return events.filter((event) => {
    if (!DELIVERY_PROGRESS_KINDS.has(event.kind)) return false;
    if (!name) return true;
    return 'name' in event && (event as BrokerEvent & { name: string }).name === name;
  }).length;
}

function countUniqueDeliveryEventIds(events: BrokerEvent[], name?: string): number {
  const ids = new Set<string>();
  for (const event of events) {
    if (!DELIVERY_PROGRESS_KINDS.has(event.kind)) continue;
    if (!('event_id' in event)) continue;
    if (name && (!('name' in event) || event.name !== name)) continue;
    ids.add(event.event_id);
  }
  return ids.size;
}

function skipIfMissing(t: TestContext): boolean {
  const reason = checkPrerequisites();
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

// ── Basic Cat Agent Tests ────────────────────────────────────────────────────

test('ci: cat agent — spawn and verify alive', { timeout: 30_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const harness = createCiHarness();
  await harness.start();
  const agentName = `cat-basic-${uniqueSuffix()}`;

  try {
    const spawned = await harness.spawnAgent(agentName, CI_TEST_CLI, ['ci-test']);
    assert.equal(spawned.name, agentName);
    assert.equal(spawned.runtime, 'pty');

    await sleep(3_000);
    await assertAgentExists(harness, agentName);

    const events = harness.getEvents();
    assertAgentSpawnedEvent(events, agentName);

    await harness.releaseAgent(agentName);
    await sleep(2_000);
    await assertAgentNotExists(harness, agentName);
  } finally {
    await harness.stop();
  }
});

test('ci: cat agent — message delivery pipeline', { timeout: 30_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const harness = createCiHarness();
  await harness.start();
  const agentName = `cat-delivery-${uniqueSuffix()}`;

  try {
    await harness.spawnAgent(agentName, CI_TEST_CLI, ['ci-test']);
    await sleep(3_000);

    const result = await harness.sendMessage({
      to: agentName,
      from: 'ci-runner',
      text: 'Hello from CI test',
    });
    assert.ok(result.event_id, 'should get event_id');

    await sleep(5_000);

    const events = harness.getEvents();
    assert.ok(
      countDeliveryProgress(events, agentName) >= 1,
      `should see delivery progress for ${agentName}`
    );
    assertNoDroppedDeliveries(events);

    await harness.releaseAgent(agentName);
  } finally {
    await harness.stop();
  }
});

// ── Multi-Agent Workflow Patterns ────────────────────────────────────────────

test('ci: review-loop pattern — 3 cat agents', { timeout: 45_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const harness = createCiHarness();
  await harness.start();
  const suffix = uniqueSuffix();

  try {
    const implementer = `impl-${suffix}`;
    const reviewer1 = `rev1-${suffix}`;
    const reviewer2 = `rev2-${suffix}`;

    // Spawn all agents
    await harness.spawnAgent(implementer, CI_TEST_CLI, ['review-loop']);
    await harness.spawnAgent(reviewer1, CI_TEST_CLI, ['review-loop']);
    await harness.spawnAgent(reviewer2, CI_TEST_CLI, ['review-loop']);
    await sleep(5_000);

    // Verify all alive
    await assertAgentExists(harness, implementer);
    await assertAgentExists(harness, reviewer1);
    await assertAgentExists(harness, reviewer2);

    // Step 1: Send task to implementer
    await harness.sendMessage({
      to: implementer,
      from: 'coordinator',
      text: 'Implement the feature',
    });
    await sleep(3_000);

    // Step 2: Send review tasks to reviewers
    await harness.sendMessage({
      to: reviewer1,
      from: 'coordinator',
      text: 'Review for code quality',
    });
    await harness.sendMessage({
      to: reviewer2,
      from: 'coordinator',
      text: 'Review for security',
    });
    await sleep(3_000);

    // Step 3: Reviewer-to-reviewer communication
    await harness.sendMessage({
      to: reviewer2,
      from: reviewer1,
      text: 'Found an issue, do you agree?',
    });
    await sleep(3_000);

    // Verify deliveries
    const events = harness.getEvents();
    assertNoDroppedDeliveries(events);

    // Review loop sends 4 messages total.
    const uniqueDeliveryIds = countUniqueDeliveryEventIds(events);
    assert.ok(
      uniqueDeliveryIds >= 4,
      `should have delivery progress for at least 4 messages, got ${uniqueDeliveryIds}`
    );

    // Clean up
    await harness.releaseAgent(implementer);
    await harness.releaseAgent(reviewer1);
    await harness.releaseAgent(reviewer2);
    await sleep(2_000);
  } finally {
    await harness.stop();
  }
});

test('ci: hub-spoke pattern — 1 hub + 4 spokes', { timeout: 60_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const harness = createCiHarness();
  await harness.start();
  const suffix = uniqueSuffix();

  try {
    const hub = `hub-${suffix}`;
    const spokes = [`spoke1-${suffix}`, `spoke2-${suffix}`, `spoke3-${suffix}`, `spoke4-${suffix}`];

    // Spawn hub
    await harness.spawnAgent(hub, CI_TEST_CLI, ['hub-spoke']);
    await sleep(2_000);

    // Spawn spokes
    for (const spoke of spokes) {
      await harness.spawnAgent(spoke, CI_TEST_CLI, ['hub-spoke']);
    }
    await sleep(5_000);

    // Verify all alive
    await assertAgentExists(harness, hub);
    for (const spoke of spokes) {
      await assertAgentExists(harness, spoke);
    }

    // Hub fans out to all spokes
    for (const spoke of spokes) {
      await harness.sendMessage({
        to: spoke,
        from: hub,
        text: `Task for ${spoke}`,
      });
    }
    await sleep(5_000);

    // Spokes report back to hub
    for (const spoke of spokes) {
      await harness.sendMessage({
        to: hub,
        from: spoke,
        text: `DONE: ${spoke} completed`,
      });
    }
    await sleep(5_000);

    // Verify deliveries
    const events = harness.getEvents();
    assertNoDroppedDeliveries(events);

    // Hub-spoke sends 8 messages total (4 out + 4 back).
    const uniqueDeliveryIds = countUniqueDeliveryEventIds(events);
    assert.ok(
      uniqueDeliveryIds >= 8,
      `should have delivery progress for at least 8 messages, got ${uniqueDeliveryIds}`
    );

    // Clean up
    await harness.releaseAgent(hub);
    for (const spoke of spokes) {
      await harness.releaseAgent(spoke);
    }
    await sleep(3_000);
  } finally {
    await harness.stop();
  }
});

test('ci: pipeline pattern — sequential message flow', { timeout: 45_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const harness = createCiHarness();
  await harness.start();
  const suffix = uniqueSuffix();

  try {
    const stage1 = `stage1-${suffix}`;
    const stage2 = `stage2-${suffix}`;
    const stage3 = `stage3-${suffix}`;

    // Spawn pipeline stages
    await harness.spawnAgent(stage1, CI_TEST_CLI, ['pipeline']);
    await harness.spawnAgent(stage2, CI_TEST_CLI, ['pipeline']);
    await harness.spawnAgent(stage3, CI_TEST_CLI, ['pipeline']);
    await sleep(5_000);

    // Pipeline: stage1 → stage2 → stage3
    await harness.sendMessage({
      to: stage1,
      from: 'input',
      text: 'Initial data',
    });
    await sleep(2_000);

    await harness.sendMessage({
      to: stage2,
      from: stage1,
      text: 'Processed by stage1',
    });
    await sleep(2_000);

    await harness.sendMessage({
      to: stage3,
      from: stage2,
      text: 'Processed by stage2',
    });
    await sleep(3_000);

    // Verify all stages received messages
    const events = harness.getEvents();
    assertNoDroppedDeliveries(events);

    assert.ok(countDeliveryProgress(events, stage1) >= 1, 'stage1 should receive delivery progress');
    assert.ok(countDeliveryProgress(events, stage2) >= 1, 'stage2 should receive delivery progress');
    assert.ok(countDeliveryProgress(events, stage3) >= 1, 'stage3 should receive delivery progress');

    // Clean up
    await harness.releaseAgent(stage1);
    await harness.releaseAgent(stage2);
    await harness.releaseAgent(stage3);
    await sleep(2_000);
  } finally {
    await harness.stop();
  }
});

// ── Channel-Based Coordination ───────────────────────────────────────────────

test('ci: channel broadcast — message to all agents on channel', { timeout: 45_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const harness = createCiHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const channelName = `ci-channel-${suffix}`;

  try {
    const agent1 = `agent1-${suffix}`;
    const agent2 = `agent2-${suffix}`;
    const agent3 = `agent3-${suffix}`;

    // All agents join same channel
    await harness.spawnAgent(agent1, CI_TEST_CLI, [channelName]);
    await harness.spawnAgent(agent2, CI_TEST_CLI, [channelName]);
    await harness.spawnAgent(agent3, CI_TEST_CLI, [channelName]);
    await sleep(5_000);

    // Broadcast to channel. In broker-only mode this may route through Relaycast and
    // fail with relaycast_publish_failed when channel registration is unavailable.
    let publishFailed = false;
    try {
      const result = await harness.sendMessage({
        to: `#${channelName}`,
        from: agent1,
        text: 'Broadcast: all agents report status',
      });
      assert.ok(result.event_id, 'broadcast should get event_id');
    } catch (error) {
      const code = (error as { code?: string })?.code;
      assert.equal(code, 'relaycast_publish_failed', 'unexpected channel publish error');
      publishFailed = true;
    }

    await sleep(5_000);

    const events = harness.getEvents();
    if (publishFailed) {
      const publishFailures = events.filter((event) => event.kind === 'relaycast_publish_failed');
      assert.ok(publishFailures.length >= 1, 'should emit relaycast_publish_failed for channel broadcast');
    }
    assertNoDroppedDeliveries(events);

    // Clean up
    await harness.releaseAgent(agent1);
    await harness.releaseAgent(agent2);
    await harness.releaseAgent(agent3);
    await sleep(2_000);
  } finally {
    await harness.stop();
  }
});

// ── Lifecycle Tests ──────────────────────────────────────────────────────────

test('ci: agent lifecycle — spawn, release, re-spawn', { timeout: 45_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const harness = createCiHarness();
  await harness.start();
  const agentName = `lifecycle-${uniqueSuffix()}`;

  try {
    // First spawn
    await harness.spawnAgent(agentName, CI_TEST_CLI, ['lifecycle']);
    await sleep(3_000);
    await assertAgentExists(harness, agentName);

    // Release
    await harness.releaseAgent(agentName);
    await sleep(3_000);
    await assertAgentNotExists(harness, agentName);

    // Re-spawn with same name
    await harness.spawnAgent(agentName, CI_TEST_CLI, ['lifecycle']);
    await sleep(3_000);
    await assertAgentExists(harness, agentName);

    // Verify events
    const events = harness.getEvents();
    const spawnEvents = events.filter(
      (e) =>
        e.kind === 'agent_spawned' &&
        'name' in e &&
        (e as BrokerEvent & { name: string }).name === agentName
    );
    const releaseEvents = events.filter(
      (e) =>
        e.kind === 'agent_released' &&
        'name' in e &&
        (e as BrokerEvent & { name: string }).name === agentName
    );

    assert.equal(spawnEvents.length, 2, 'should have 2 spawn events');
    assert.equal(releaseEvents.length, 1, 'should have 1 release event');

    // Clean up
    await harness.releaseAgent(agentName);
    await sleep(2_000);
  } finally {
    await harness.stop();
  }
});

test('ci: rapid spawn/release — 5 agents in sequence', { timeout: 60_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const harness = createCiHarness();
  await harness.start();
  const suffix = uniqueSuffix();

  try {
    for (let i = 0; i < 5; i++) {
      const name = `rapid-${i}-${suffix}`;
      await harness.spawnAgent(name, CI_TEST_CLI, ['rapid']);
      await sleep(2_000);
      await assertAgentExists(harness, name);
      await harness.releaseAgent(name);
      await sleep(2_000);
      await assertAgentNotExists(harness, name);
    }

    // Verify events
    const events = harness.getEvents();
    const spawnCount = events.filter((e) => e.kind === 'agent_spawned').length;
    const releaseCount = events.filter(
      (e) => e.kind === 'agent_released' || e.kind === 'agent_exited'
    ).length;

    assert.ok(spawnCount >= 5, `should have at least 5 spawns, got ${spawnCount}`);
    assert.ok(releaseCount >= 5, `should have at least 5 releases, got ${releaseCount}`);
  } finally {
    await harness.stop();
  }
});

// ── Error Handling ───────────────────────────────────────────────────────────

test('ci: duplicate agent name — second spawn fails', { timeout: 30_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const harness = createCiHarness();
  await harness.start();
  const agentName = `dup-${uniqueSuffix()}`;

  try {
    // First spawn succeeds
    await harness.spawnAgent(agentName, CI_TEST_CLI, ['dup-test']);
    await sleep(3_000);
    await assertAgentExists(harness, agentName);

    // Second spawn with same name should fail
    await assert.rejects(
      () => harness.spawnAgent(agentName, CI_TEST_CLI, ['dup-test']),
      'spawning duplicate name should reject'
    );

    // Clean up
    await harness.releaseAgent(agentName);
    await sleep(2_000);
  } finally {
    await harness.stop();
  }
});

test('ci: message to non-existent agent — delivery dropped', { timeout: 30_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const harness = createCiHarness();
  await harness.start();

  try {
    const sender = `sender-${uniqueSuffix()}`;
    await harness.spawnAgent(sender, CI_TEST_CLI, ['general']);
    await sleep(3_000);

    // Send message to an unknown target. In broker-only mode this can either
    // return an accepted event_id or fail with relaycast_publish_failed.
    let accepted = false;
    try {
      const result = await harness.sendMessage({
        to: `ghost-agent-${uniqueSuffix()}`,
        from: sender,
        text: 'Message to nowhere',
      });
      assert.ok(result.event_id, 'should get event_id when unknown target is accepted');
      accepted = true;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      assert.equal(code, 'relaycast_publish_failed', 'unexpected unknown-target error');
    }

    await sleep(3_000);
    const events = harness.getEvents();
    if (!accepted) {
      const publishFailures = events.filter((event) => event.kind === 'relaycast_publish_failed');
      assert.ok(publishFailures.length >= 1, 'should emit relaycast_publish_failed for unknown target');
    }

    await harness.releaseAgent(sender);
  } finally {
    await harness.stop();
  }
});

// ── Parallel Operations ──────────────────────────────────────────────────────

test('ci: parallel spawn — 6 agents at once', { timeout: 60_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const harness = createCiHarness();
  await harness.start();
  const suffix = uniqueSuffix();

  try {
    const names = [
      `par1-${suffix}`,
      `par2-${suffix}`,
      `par3-${suffix}`,
      `par4-${suffix}`,
      `par5-${suffix}`,
      `par6-${suffix}`,
    ];

    // Spawn all in parallel
    await Promise.all(names.map((name) => harness.spawnAgent(name, CI_TEST_CLI, ['parallel'])));
    await sleep(8_000);

    // Verify all alive
    const agents = await harness.listAgents();
    for (const name of names) {
      assert.ok(
        agents.some((a) => a.name === name),
        `${name} should be alive`
      );
    }

    // Send messages to all in parallel
    await Promise.all(
      names.map((name) =>
        harness.sendMessage({
          to: name,
          from: 'ci-runner',
          text: `Ping ${name}`,
        })
      )
    );
    await sleep(5_000);

    // Verify deliveries
    const events = harness.getEvents();
    const uniqueDeliveryIds = countUniqueDeliveryEventIds(events);
    assert.ok(
      uniqueDeliveryIds >= names.length,
      `should have delivery progress for at least ${names.length} messages, got ${uniqueDeliveryIds}`
    );
    assertNoDroppedDeliveries(events);

    // Clean up in parallel
    await Promise.all(names.map((name) => harness.releaseAgent(name)));
    await sleep(3_000);
  } finally {
    await harness.stop();
  }
});

// ── Workflow Step Simulation ─────────────────────────────────────────────────

test('ci: workflow steps — implement → review → consolidate → address', { timeout: 60_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const harness = createCiHarness();
  await harness.start();
  const suffix = uniqueSuffix();

  try {
    const implementer = `impl-${suffix}`;
    const reviewer = `rev-${suffix}`;

    await harness.spawnAgent(implementer, CI_TEST_CLI, ['workflow']);
    await harness.spawnAgent(reviewer, CI_TEST_CLI, ['workflow']);
    await sleep(5_000);

    // Step 1: Implement
    await harness.sendMessage({
      to: implementer,
      from: 'workflow-engine',
      text: 'Step 1: Implement feature X',
    });
    await sleep(2_000);

    // Step 2: Review (parallel with Step 1 completion)
    await harness.sendMessage({
      to: reviewer,
      from: 'workflow-engine',
      text: 'Step 2: Review implementation',
    });
    await sleep(2_000);

    // Step 3: Consolidate (reviewer → implementer)
    await harness.sendMessage({
      to: implementer,
      from: reviewer,
      text: 'Step 3: Review feedback - found 2 issues',
    });
    await sleep(2_000);

    // Step 4: Address feedback
    await harness.sendMessage({
      to: implementer,
      from: 'workflow-engine',
      text: 'Step 4: Address review feedback',
    });
    await sleep(3_000);

    // Verify all steps executed
    const events = harness.getEvents();
    const implProgress = countDeliveryProgress(events, implementer);
    const revProgress = countDeliveryProgress(events, reviewer);
    assert.ok(
      implProgress >= 2,
      `implementer should have at least 2 delivery progress events, got ${implProgress}`
    );
    assert.ok(
      revProgress >= 1,
      `reviewer should have at least 1 delivery progress event, got ${revProgress}`
    );
    assertNoDroppedDeliveries(events);

    // Clean up
    await harness.releaseAgent(implementer);
    await harness.releaseAgent(reviewer);
    await sleep(2_000);
  } finally {
    await harness.stop();
  }
});
