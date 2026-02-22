/**
 * Broker continuity integration tests.
 *
 * Tests the broker-centric agent continuity feature:
 * - Continuity JSON file is written on release
 * - Continuity context is injected when spawning with continueFrom
 *
 * Run:
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   node --test tests/integration/broker/dist/continuity.test.js
 *
 * Requires:
 *   RELAY_API_KEY — Relaycast workspace key
 *   AGENT_RELAY_BIN (optional) — path to agent-relay binary
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { BrokerHarness, checkPrerequisites, uniqueSuffix } from './utils/broker-harness.js';

function skipIfMissing(t: TestContext): boolean {
  const reason = checkPrerequisites();
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

/** Resolve the .agent-relay/continuity directory relative to cwd. */
function continuityDir(): string {
  return path.resolve(process.cwd(), '.agent-relay', 'continuity');
}

/** Read a continuity JSON file for a given agent name. */
function readContinuityFile(agentName: string): Record<string, unknown> | null {
  const filePath = path.join(continuityDir(), `${agentName}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/** Remove a continuity file if it exists. */
function cleanupContinuityFile(agentName: string): void {
  const filePath = path.join(continuityDir(), `${agentName}.json`);
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore if file doesn't exist
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('continuity: release writes continuity JSON file', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const name = `continuity-write-${suffix}`;

  try {
    // Clean up any stale continuity file
    cleanupContinuityFile(name);

    // Spawn with a task
    await harness.spawnAgent(name, 'cat', undefined, {
      task: 'Test continuity write on release',
    });
    await new Promise((r) => setTimeout(r, 500));

    // Release the agent
    await harness.releaseAgent(name);
    await new Promise((r) => setTimeout(r, 1000));

    // Verify continuity file was written
    const data = readContinuityFile(name);
    assert.ok(data, 'continuity file should exist after release');
    assert.equal(data.agent_name, name, 'agent_name should match');
    assert.equal(
      data.initial_task,
      'Test continuity write on release',
      'initial_task should match the task given at spawn'
    );
    assert.ok(typeof data.released_at === 'number', 'released_at should be a number (unix timestamp)');
    assert.ok(typeof data.lifetime_seconds === 'number', 'lifetime_seconds should be a number');
    assert.ok(Array.isArray(data.message_history), 'message_history should be an array');
  } finally {
    cleanupContinuityFile(name);
    await harness.stop();
  }
});

test('continuity: continuity file includes cli and summary', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const name = `continuity-fields-${suffix}`;

  try {
    cleanupContinuityFile(name);

    await harness.spawnAgent(name, 'cat', undefined, {
      task: 'Check all fields',
    });
    await new Promise((r) => setTimeout(r, 500));

    await harness.releaseAgent(name);
    await new Promise((r) => setTimeout(r, 1000));

    const data = readContinuityFile(name);
    assert.ok(data, 'continuity file should exist');

    // cli comes from the AgentSpec
    assert.equal(data.cli, 'cat', 'cli should match the CLI used at spawn');

    // summary defaults to the release reason
    assert.ok(
      typeof data.summary === 'string' && data.summary.length > 0,
      'summary should be a non-empty string'
    );
  } finally {
    cleanupContinuityFile(name);
    await harness.stop();
  }
});

test('continuity: spawn with continueFrom injects context', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const originalName = `continuity-original-${suffix}`;
  const continuedName = `continuity-continued-${suffix}`;

  try {
    cleanupContinuityFile(originalName);

    // Step 1: Spawn and release the original agent
    await harness.spawnAgent(originalName, 'cat', undefined, {
      task: 'Build the auth module',
    });
    await new Promise((r) => setTimeout(r, 500));
    await harness.releaseAgent(originalName);
    await new Promise((r) => setTimeout(r, 1000));

    // Verify continuity file exists
    const data = readContinuityFile(originalName);
    assert.ok(data, 'continuity file should exist for original agent');

    // Step 2: Spawn a new agent with continueFrom
    const spawned = await harness.spawnAgent(continuedName, 'cat', undefined, {
      task: 'Continue the auth work',
      continueFrom: originalName,
    });
    assert.equal(spawned.name, continuedName, 'continued agent should spawn successfully');

    // Verify the agent is running
    const agents = await harness.listAgents();
    const continued = agents.find((a) => a.name === continuedName);
    assert.ok(continued, 'continued agent should appear in agent list');

    // Clean up
    await harness.releaseAgent(continuedName);
  } finally {
    cleanupContinuityFile(originalName);
    cleanupContinuityFile(continuedName);
    await harness.stop();
  }
});

test('continuity: spawn with continueFrom for same name', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const name = `continuity-samename-${suffix}`;

  try {
    cleanupContinuityFile(name);

    // Spawn, release (creates continuity file)
    await harness.spawnAgent(name, 'cat', undefined, {
      task: 'First session task',
    });
    await new Promise((r) => setTimeout(r, 500));
    await harness.releaseAgent(name);
    await new Promise((r) => setTimeout(r, 1000));

    assert.ok(readContinuityFile(name), 'continuity file should exist');

    // Re-spawn with same name using continueFrom: self
    const spawned = await harness.spawnAgent(name, 'cat', undefined, {
      task: 'Second session task',
      continueFrom: name,
    });
    assert.equal(spawned.name, name, 'agent should re-spawn with same name');

    // Verify agent is running
    const agents = await harness.listAgents();
    assert.ok(
      agents.some((a) => a.name === name),
      'agent should be in the agent list after re-spawn'
    );

    await harness.releaseAgent(name);
  } finally {
    cleanupContinuityFile(name);
    await harness.stop();
  }
});

test('continuity: spawn with continueFrom for nonexistent agent still spawns', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const name = `continuity-nofile-${suffix}`;

  try {
    // No prior agent exists — continueFrom points to nothing
    const spawned = await harness.spawnAgent(name, 'cat', undefined, {
      task: 'Should still work',
      continueFrom: 'nonexistent-agent-xyz',
    });
    assert.equal(spawned.name, name, 'agent should spawn even with missing continuity file');

    await harness.releaseAgent(name);
  } finally {
    cleanupContinuityFile(name);
    await harness.stop();
  }
});

test('continuity: re-release overwrites continuity file', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const name = `continuity-overwrite-${suffix}`;

  try {
    cleanupContinuityFile(name);

    // First spawn/release cycle
    await harness.spawnAgent(name, 'cat', undefined, {
      task: 'First task',
    });
    await new Promise((r) => setTimeout(r, 500));
    await harness.releaseAgent(name);
    await new Promise((r) => setTimeout(r, 1000));

    const data1 = readContinuityFile(name);
    assert.ok(data1, 'continuity file should exist after first release');
    assert.equal(data1.initial_task, 'First task');

    // Second spawn/release cycle with different task
    await harness.spawnAgent(name, 'cat', undefined, {
      task: 'Second task',
    });
    await new Promise((r) => setTimeout(r, 500));
    await harness.releaseAgent(name);
    await new Promise((r) => setTimeout(r, 1000));

    const data2 = readContinuityFile(name);
    assert.ok(data2, 'continuity file should exist after second release');
    assert.equal(data2.initial_task, 'Second task', 'continuity file should be overwritten with latest task');
  } finally {
    cleanupContinuityFile(name);
    await harness.stop();
  }
});
