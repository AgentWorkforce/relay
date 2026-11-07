/**
 * Scenario 01 — DM round-trip.
 *
 * The agent under test (Bob) receives a DM and must reply to the sender using
 * the messaging tool. The counterpart (Alice) is simulated via the harness
 * driver, so only one real CLI is spawned. PASS = Bob actually sent a reply
 * (relay_inbound) with no phantom and clean delivery.
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { RESPONSE_MS, STARTUP_MS, waitForSends } from './helpers.js';

const TASK =
  'You are Bob, an agent in a shared workspace. When you receive a Relay message, ' +
  'reply to the sender using the mcp__agent-relay__send_dm tool (or the agent-relay ' +
  'message dm send CLI). Keep the reply to one short sentence. Important: actually ' +
  'call the tool to send your reply — do not just describe what you would say.';

export const scenario: EvalScenario = {
  id: '01-dm-roundtrip',
  title: 'DM round-trip (A → B)',
  tier: 'smoke',
  channels: ['general'],
  timeoutMs: 120_000,
  run: async (ctx): Promise<ScenarioResult> => {
    const { harness, cli, model, suffix, sleep } = ctx;
    const bob = `bob-${suffix}`;
    const alice = 'Alice';

    await harness.spawnAgent(bob, cli, ['general'], { task: TASK, model });
    await sleep(STARTUP_MS);
    harness.clearEvents();

    await harness.sendMessage({
      to: bob,
      from: alice,
      text: 'Ping — please reply to me with the word PONG.',
    });

    await waitForSends(harness, bob, 1, RESPONSE_MS);

    const events = harness.getEvents();
    const base = baseScore(events, [bob]);
    await harness.releaseAgent(bob).catch(() => {});

    const expected = 1;
    const pass = base.sent >= 1 && base.phantoms.length === 0 && base.deliveryOk;

    return {
      id: scenario.id,
      title: scenario.title,
      pass,
      agents: [{ name: bob, cli, role: 'responder', prompt: TASK }],
      transcript: base.transcript,
      sent: base.sent,
      expected,
      phantoms: base.phantoms,
      totalIntents: base.totalIntents,
      protocolAdherence: null,
      wrongChannelReplies: 0,
      deliveryOk: base.deliveryOk,
      events: base.events,
    };
  },
};
