/**
 * Tic-Tac-Toe — the OG integration test.
 *
 * Two real CLI agents playing tic-tac-toe, taking turns via the
 * broker relay loop. This was the first test that proved agent-relay
 * worked end-to-end.
 *
 * Verifies multi-round A→B, B→A, A→B delivery through the full
 * injection pipeline with real AI CLIs.
 *
 * Uses BrokerHarness with the SDK's built-in event buffer
 * (queryEvents / onEvent) for turn-by-turn ack tracking.
 *
 * Run:
 *   RELAY_INTEGRATION_REAL_CLI=1 npx tsx tests/integration/broker/tic-tac-toe.test.ts
 *
 * Requires:
 *   RELAY_API_KEY — Relaycast workspace key (auto-provisioned if unset)
 *   RELAY_INTEGRATION_REAL_CLI=1 — opt-in for real CLI tests
 *   AGENT_RELAY_BIN (optional) — path to agent-relay binary
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { AgentRelayClient, BrokerEvent } from '@agent-relay/sdk';
import { BrokerHarness, checkPrerequisites, uniqueSuffix } from './utils/broker-harness.js';
import { assertAgentExists, assertNoDroppedDeliveries, eventsForAgent } from './utils/assert-helpers.js';
import { skipIfCliMissing, skipIfNotRealCli, sleep } from './utils/cli-helpers.js';

function skipIfMissing(t: TestContext): boolean {
  const reason = checkPrerequisites();
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

/**
 * Send a message and wait for delivery_ack using the client's event system.
 *
 * Uses the SDK's onEvent listener for event-driven ack detection
 * instead of polling. Falls back to timeout if no ack arrives.
 */
async function sendAndWaitForAck(
  client: AgentRelayClient,
  to: string,
  text: string,
  timeoutMs = 60_000
): Promise<{ eventId: string }> {
  const result = await client.sendMessage({ to, from: 'system', text });
  assert.ok(result.event_id, `message to ${to} should get event_id`);

  return new Promise<{ eventId: string }>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsub();
      reject(
        new Error(
          `Timed out waiting for delivery_ack for ${to} (event ${result.event_id}) after ${timeoutMs}ms`
        )
      );
    }, timeoutMs);

    const unsub = client.onEvent((event: BrokerEvent) => {
      if (settled) return;
      if (
        event.kind === 'delivery_ack' &&
        'event_id' in event &&
        (event as any).event_id === result.event_id
      ) {
        settled = true;
        clearTimeout(timer);
        unsub();
        resolve({ eventId: result.event_id });
      }
      if (
        event.kind === 'delivery_failed' &&
        'event_id' in event &&
        (event as any).event_id === result.event_id
      ) {
        settled = true;
        clearTimeout(timer);
        unsub();
        reject(new Error(`Delivery to ${to} failed: ${(event as any).reason ?? 'unknown'}`));
      }
    });

    // Check if ack already in buffer
    const existing = client.queryEvents({ kind: 'delivery_ack' });
    for (const e of existing) {
      if ('event_id' in e && (e as any).event_id === result.event_id) {
        settled = true;
        clearTimeout(timer);
        unsub();
        resolve({ eventId: result.event_id });
        return;
      }
    }
  });
}

/**
 * Run a 3-turn tic-tac-toe game between two agents using the given CLI.
 */
async function playTicTacToe(cli: string): Promise<void> {
  const harness = new BrokerHarness();
  await harness.start();
  const suffix = uniqueSuffix();
  const playerX = `player-x-${suffix}`;
  const playerO = `player-o-${suffix}`;

  try {
    // Spawn both players and let them fully initialize
    await harness.spawnAgent(playerX, cli, ['general']);
    await harness.spawnAgent(playerO, cli, ['general']);
    await sleep(25_000);

    await assertAgentExists(harness, playerX);
    await assertAgentExists(harness, playerO);

    // ── Turn 1: → Player X (opening move) ─────────────────────────────────
    await sendAndWaitForAck(harness.client, playerX, 'X plays 5');

    // ── Turn 2: → Player O (response) ─────────────────────────────────────
    await sendAndWaitForAck(harness.client, playerO, 'O plays 1');

    // ── Turn 3: → Player X again ──────────────────────────────────────────
    await sendAndWaitForAck(harness.client, playerX, 'X plays 9');

    // ── Verify the full game ──────────────────────────────────────────────
    const allEvents = harness.getEvents();

    // Player X: 2 deliveries (turns 1 and 3)
    const xAcks = eventsForAgent(allEvents, playerX, 'delivery_ack');
    assert.ok(xAcks.length >= 2, `Player X should have >= 2 delivery_acks, got ${xAcks.length}`);

    // Player O: 1 delivery (turn 2)
    const oAcks = eventsForAgent(allEvents, playerO, 'delivery_ack');
    assert.ok(oAcks.length >= 1, `Player O should have >= 1 delivery_ack, got ${oAcks.length}`);

    // Both agents had messages injected into their PTY
    const xInjected = eventsForAgent(allEvents, playerX, 'delivery_injected');
    const oInjected = eventsForAgent(allEvents, playerO, 'delivery_injected');
    assert.ok(xInjected.length >= 2, `Player X injections: expected >= 2, got ${xInjected.length}`);
    assert.ok(oInjected.length >= 1, `Player O injections: expected >= 1, got ${oInjected.length}`);

    // No dropped deliveries across the whole game
    assertNoDroppedDeliveries(allEvents);

    // Clean up
    await harness.releaseAgent(playerX);
    await harness.releaseAgent(playerO);
    await sleep(1_000);
  } finally {
    await harness.stop();
  }
}

// ── Tic-Tac-Toe: Per-CLI Tests ──────────────────────────────────────────────

test('tic-tac-toe: claude — two agents alternate moves', { timeout: 240_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;
  if (skipIfCliMissing(t, 'claude')) return;

  await playTicTacToe('claude');
});

test('tic-tac-toe: codex — two agents alternate moves', { timeout: 240_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  if (skipIfNotRealCli(t)) return;
  if (skipIfCliMissing(t, 'codex')) return;

  await playTicTacToe('codex');
});
