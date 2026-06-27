/**
 * Realistic — channel-vs-DM judgment.
 *
 * A question arrives in a channel. The agent is NOT told whether to reply in the
 * channel or by DM; the correct behaviour (reply where the conversation is
 * happening) must come from the onboarding. PASS = it answered in the channel
 * and did not DM the asker instead.
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { scoreChannelReply } from '../scoring/protocol.js';
import { RESPONSE_MS, STARTUP_MS, waitForSends } from './helpers.js';

export const scenario: EvalScenario = {
  id: 'r04-channel-vs-dm',
  title: 'Channel-vs-DM judgment',
  tier: 'realistic',
  channels: ['general'],
  timeoutMs: 150_000,
  run: async (ctx): Promise<ScenarioResult> => {
    const { harness, cli, model, suffix, sleep } = ctx;
    const worker = `teammate-${suffix}`;
    const channel = `standup-${suffix}`;

    const role =
      `You are ${worker}, a member of the #${channel} channel where the team coordinates. ` +
      `Participate in the channel's discussion as a normal team member would.`;

    await harness.spawnAgent(worker, cli, [channel], { task: role, model });
    await sleep(STARTUP_MS);
    harness.clearEvents();

    await harness.sendMessage({
      to: worker,
      from: 'Maya',
      text: `Relay message from Maya [q-${suffix}] [#${channel}]: Quick standup question — what's 12 times 9? Drop the answer here so everyone sees it.`,
    });

    await waitForSends(harness, worker, 1, RESPONSE_MS);

    const events = harness.getEvents();
    const base = baseScore(events, [worker]);
    const ch = scoreChannelReply(events, worker, channel);
    await harness.releaseAgent(worker).catch(() => {});

    const pass =
      ch.repliedToShownChannel &&
      ch.wrongChannelReplies === 0 &&
      base.phantoms.length === 0 &&
      base.deliveryOk;

    return {
      id: scenario.id,
      title: scenario.title,
      pass,
      agents: [{ name: worker, cli, role: `member of #${channel}`, prompt: role }],
      transcript: base.transcript,
      sent: base.sent,
      expected: 1,
      phantoms: base.phantoms,
      totalIntents: base.totalIntents,
      protocolAdherence: ch.repliedToShownChannel ? 1 : 0,
      wrongChannelReplies: ch.wrongChannelReplies,
      deliveryOk: base.deliveryOk,
      events: base.events,
      notes: `inChannel=${ch.repliedToShownChannel} wrongChannel=${ch.wrongChannelReplies}`,
    };
  },
};
