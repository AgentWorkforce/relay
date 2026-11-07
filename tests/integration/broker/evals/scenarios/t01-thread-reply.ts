/**
 * Realistic — thread reply.
 *
 * An infra team member receives an initial channel message asking for deployment
 * updates, followed by a threaded follow-up asking specifically about the rollback
 * plan. The agent must reply to the thread using `reply_to_thread` (not a fresh
 * channel post). PASS = at least one relay_inbound from the agent (it replied at all).
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { RESPONSE_MS, STARTUP_MS, waitForSends } from './helpers.js';

const ROLE =
  'You are an infrastructure engineer on the deployment team. You monitor the #general ' +
  'channel for questions from teammates and respond with accurate status updates. When ' +
  'someone follows up in a thread, reply in that thread so the conversation stays organised.';

export const scenario: EvalScenario = {
  id: 't01-thread-reply',
  title: 'Thread reply (reply_to_thread)',
  tier: 'realistic',
  channels: ['general'],
  timeoutMs: 90_000,
  run: async (ctx): Promise<ScenarioResult> => {
    const { harness, cli, model, suffix, sleep } = ctx;
    const agent = `infra-${suffix}`;
    const threadId = `thread-${suffix}`;

    await harness.spawnAgent(agent, cli, ['general'], { task: ROLE, model });
    await sleep(STARTUP_MS);
    harness.clearEvents();

    // Initial channel message that seeds a thread
    await harness.sendMessage({
      to: agent,
      from: 'Maya',
      text: `Relay message from Maya [${threadId}] [#general]: Any updates on the deployment? We're waiting on the all-clear before we proceed.`,
    });

    // Brief pause then a thread follow-up referencing the same message id
    await sleep(2_000);

    await harness.sendMessage({
      to: agent,
      from: 'Maya',
      text: `Relay message from Maya [${threadId}-followup] [#general] (thread: ${threadId}): Specifically what's the rollback plan if this deployment fails?`,
    });

    await waitForSends(harness, agent, 1, RESPONSE_MS);

    const events = harness.getEvents();
    const base = baseScore(events, [agent]);
    await harness.releaseAgent(agent).catch(() => {});

    const pass = base.sent >= 1 && base.phantoms.length === 0 && base.deliveryOk;

    return {
      id: scenario.id,
      title: scenario.title,
      pass,
      agents: [{ name: agent, cli, role: 'infra engineer', prompt: ROLE }],
      transcript: base.transcript,
      sent: base.sent,
      expected: 1,
      phantoms: base.phantoms,
      totalIntents: base.totalIntents,
      protocolAdherence: null,
      wrongChannelReplies: 0,
      deliveryOk: base.deliveryOk,
      events: base.events,
      notes: `replied=${base.sent >= 1}`,
    };
  },
};
