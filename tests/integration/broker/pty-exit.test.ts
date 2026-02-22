/**
 * PTY exit detection integration tests.
 *
 * Verifies that the broker correctly detects when a PTY child process
 * exits — both via the `/exit` command detection path and the child
 * watchdog (kill(pid, 0) fallback).
 *
 * Run:
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   node --test tests/integration/broker/dist/pty-exit.test.js
 *
 * Requires:
 *   RELAY_API_KEY — Relaycast workspace key
 *   AGENT_RELAY_BIN (optional) — path to agent-relay binary
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { BrokerHarness, checkPrerequisites, uniqueSuffix } from './utils/broker-harness.js';
import type { BrokerEvent } from '@agent-relay/sdk';

function skipIfMissing(t: TestContext): boolean {
  const reason = checkPrerequisites();
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('pty-exit: child process exit is detected', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const name = `pty-exit-${suffix}`;

  // Collect all events for debugging
  const collected: BrokerEvent[] = [];
  const unsub = harness.onEvent((e) => {
    collected.push(e);
    console.log(`  [event] ${e.kind} ${(e as any).name ?? ''} ${JSON.stringify(e).slice(0, 200)}`);
  });

  try {
    // Spawn bash -c "sleep 2 && echo done" — exits after 2 seconds
    await harness.client.spawnPty({
      name,
      cli: 'bash',
      args: ['-c', 'sleep 2 && echo done'],
      channels: ['general'],
    });

    console.log(`  spawned ${name}, waiting for agent_exited...`);

    // Wait for agent_exited with generous timeout
    const exitEvent = await harness.waitForEvent(
      'agent_exited',
      30_000,
      (e) => e.kind === 'agent_exited' && e.name === name
    ).promise;

    assert.ok(exitEvent, 'should receive agent_exited event');
    assert.equal(exitEvent.kind, 'agent_exited');
  } catch (err) {
    // On failure, dump all collected events for debugging
    console.log(`  FAILED — collected ${collected.length} events:`);
    for (const e of collected) {
      console.log(`    ${e.kind} ${(e as any).name ?? ''}`);
    }
    throw err;
  } finally {
    unsub();
    await harness.stop();
  }
});

test('pty-exit: long-running process stays alive until released', async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const name = `pty-exit-alive-${suffix}`;

  try {
    await harness.spawnAgent(name, 'cat', ['general']);

    await harness.waitForEvent('agent_spawned', 10_000, (e) => e.kind === 'agent_spawned' && e.name === name)
      .promise;

    await new Promise((r) => setTimeout(r, 8_000));

    const exitEvents = harness
      .getEvents()
      .filter((e) => e.kind === 'agent_exited' && (e as any).name === name);
    assert.equal(exitEvents.length, 0, 'should not see agent_exited while process is alive');

    await harness.releaseAgent(name);
    await harness.waitForEvent(
      'agent_released',
      10_000,
      (e) => e.kind === 'agent_released' && (e as any).name === name
    ).promise;
  } finally {
    await harness.stop();
  }
});
