/**
 * Realistic — proactive hand-off to a named peer.
 *
 * The agent must decide, on its own, to message a teammate it was never told to
 * use a tool to reach. A real `reviewer` (cat shim) is spawned so the hand-off
 * has a valid target. PASS = the author proactively DM'd the reviewer.
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { sentTo } from '../scoring/protocol.js';
import { RESPONSE_MS, STARTUP_MS, waitForSends } from './helpers.js';

export const scenario: EvalScenario = {
  id: 'r03-proactive-handoff',
  title: 'Proactive hand-off to a peer',
  tier: 'realistic',
  channels: ['general'],
  timeoutMs: 160_000,
  run: async (ctx): Promise<ScenarioResult> => {
    const { harness, cli, suffix, sleep } = ctx;
    const author = `author-${suffix}`;
    const reviewer = `reviewer-${suffix}`;

    const role =
      `You are ${author}, working with a teammate named ${reviewer} in a shared workspace. ` +
      `Your job is to draft work and then get ${reviewer} to approve it before it ships.`;

    await harness.spawnAgent(reviewer, 'cat', ['general']);
    await harness.spawnAgent(author, cli, ['general'], { task: role });
    await sleep(STARTUP_MS);
    harness.clearEvents();

    await harness.sendMessage({
      to: author,
      from: 'Orchestrator',
      text: 'Write a one-sentence commit message for a change that adds dark mode, then get it approved before we ship.',
    });

    await waitForSends(harness, author, 1, RESPONSE_MS);

    const events = harness.getEvents();
    const base = baseScore(events, [author]);
    const handedOff = sentTo(events, author, reviewer);
    await harness.releaseAgent(author).catch(() => {});
    await harness.releaseAgent(reviewer).catch(() => {});

    const pass = handedOff && base.phantoms.length === 0 && base.deliveryOk;

    return {
      id: scenario.id,
      title: scenario.title,
      pass,
      agents: [
        { name: author, cli, role: 'author', prompt: role },
        { name: reviewer, cli: 'cat', role: 'reviewer (peer target)', prompt: '(cat shim — hand-off target)' },
      ],
      transcript: base.transcript,
      sent: base.sent,
      expected: 1,
      phantoms: base.phantoms,
      totalIntents: base.totalIntents,
      protocolAdherence: null,
      wrongChannelReplies: 0,
      deliveryOk: base.deliveryOk,
      events: base.events,
      notes: `handedOffTo ${reviewer}=${handedOff}`,
    };
  },
};
