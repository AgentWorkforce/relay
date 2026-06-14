/**
 * Realistic — incidental report-back.
 *
 * A generic worker is given real work by the orchestrator in natural language.
 * Nothing tells it which tool to use or that it must reply: the agent must learn
 * to message from the production onboarding (injected skill + broker hints).
 * PASS = it actually reported the result back as a DM, with no phantom.
 * ACK/DONE adherence is recorded but does not gate the pass.
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { scoreAckDone, sentDirectMessage } from '../scoring/protocol.js';
import { RESPONSE_MS, STARTUP_MS, waitForSends } from './helpers.js';

const ROLE =
  'You are a worker agent collaborating with other agents in a shared workspace. ' +
  'Other agents will ask you to do things; handle their requests.';

export const scenario: EvalScenario = {
  id: 'r01-incidental-report',
  title: 'Incidental report-back',
  tier: 'realistic',
  channels: ['general'],
  timeoutMs: 150_000,
  run: async (ctx): Promise<ScenarioResult> => {
    const { harness, cli, model, suffix, sleep } = ctx;
    const worker = `worker-${suffix}`;

    await harness.spawnAgent(worker, cli, ['general'], { task: ROLE, model });
    await sleep(STARTUP_MS);
    harness.clearEvents();

    await harness.sendMessage({
      to: worker,
      from: 'Orchestrator',
      text: 'Can you work out the sum of all prime numbers below 30 and let me know the answer? I need it to continue.',
    });

    await waitForSends(harness, worker, 1, RESPONSE_MS);

    const events = harness.getEvents();
    const base = baseScore(events, [worker]);
    const ackDone = scoreAckDone(events, worker);
    const reported = sentDirectMessage(events, worker);
    await harness.releaseAgent(worker).catch(() => {});

    const pass = reported && base.phantoms.length === 0 && base.deliveryOk;

    return {
      id: scenario.id,
      title: scenario.title,
      pass,
      agents: [{ name: worker, cli, role: 'worker', prompt: ROLE }],
      transcript: base.transcript,
      sent: base.sent,
      expected: 1,
      phantoms: base.phantoms,
      totalIntents: base.totalIntents,
      protocolAdherence: ackDone.score,
      wrongChannelReplies: 0,
      deliveryOk: base.deliveryOk,
      events: base.events,
      notes: `repliedPrivately=${reported} (DM back to requester) · ack=${ackDone.ackPresent} done=${ackDone.donePresent}`,
    };
  },
};
