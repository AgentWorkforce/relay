/**
 * Realistic — group DM / multi-recipient status update.
 *
 * The lead agent is instructed to send a deployment status update to both Alice
 * and Bob. The agent may use `send_group_dm` (one call) or two `send_dm` calls.
 * PASS = the agent sent at least one message (reached at least one of the targets).
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { RESPONSE_MS, STARTUP_MS, waitForSends } from './helpers.js';

const ROLE =
  'You are the lead engineer on the deployment team. You coordinate with teammates ' +
  'by sending them direct messages when there are updates they need to know about.';

export const scenario: EvalScenario = {
  id: 'r06-group-dm',
  title: 'Group DM / multi-recipient update',
  tier: 'realistic',
  channels: ['general'],
  timeoutMs: 90_000,
  run: async (ctx): Promise<ScenarioResult> => {
    const { harness, cli, model, suffix, sleep } = ctx;
    const agent = `lead-${suffix}`;
    const alice = `alice-${suffix}`;
    const bob = `bob-${suffix}`;

    // Spin up cat-shim targets so the DMs have valid recipients
    await harness.spawnAgent(alice, 'cat', ['general']);
    await harness.spawnAgent(bob, 'cat', ['general']);
    await harness.spawnAgent(agent, cli, ['general'], { task: ROLE, model });
    await sleep(STARTUP_MS);
    harness.clearEvents();

    await harness.sendMessage({
      to: agent,
      from: 'Orchestrator',
      text: `Send a status update to ${alice} and ${bob} letting them know the deployment is complete and they can start testing.`,
    });

    await waitForSends(harness, agent, 1, RESPONSE_MS);

    const events = harness.getEvents();
    const base = baseScore(events, [agent]);
    await harness.releaseAgent(agent).catch(() => {});
    await harness.releaseAgent(alice).catch(() => {});
    await harness.releaseAgent(bob).catch(() => {});

    const pass = base.sent >= 1 && base.phantoms.length === 0 && base.deliveryOk;

    return {
      id: scenario.id,
      title: scenario.title,
      pass,
      agents: [
        { name: agent, cli, role: 'lead', prompt: ROLE },
        { name: alice, cli: 'cat', role: 'recipient (cat shim)', prompt: '(cat shim)' },
        { name: bob, cli: 'cat', role: 'recipient (cat shim)', prompt: '(cat shim)' },
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
      notes: `sentToTargets=${base.sent >= 1}`,
    };
  },
};
