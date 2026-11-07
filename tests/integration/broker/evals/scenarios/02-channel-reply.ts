/**
 * Scenario 02 — Channel post + correct-channel reply.
 *
 * The agent must reply IN the channel the message arrived on, using
 * post_message, rather than DMing the sender. PASS = a send targeting the
 * expected channel, no wrong-channel replies, no phantom.
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { scoreChannelReply } from '../scoring/protocol.js';
import { RESPONSE_MS, STARTUP_MS, waitForSends } from './helpers.js';

export const scenario: EvalScenario = {
  id: '02-channel-reply',
  title: 'Channel post + correct-channel reply',
  tier: 'smoke',
  channels: ['general'],
  timeoutMs: 120_000,
  run: async (ctx): Promise<ScenarioResult> => {
    const { harness, cli, model, suffix, sleep } = ctx;
    const worker = `worker-${suffix}`;
    const channel = `proj-${suffix}`;

    const task =
      `You are an agent in channel #${channel}. When a channel message arrives, reply ` +
      `IN THAT CHANNEL using the mcp__agent-relay__post_message tool with channel "${channel}". ` +
      `Reply to the channel shown in the message — do not DM the sender. Keep it short, and ` +
      `actually call the tool to post your reply.`;

    await harness.spawnAgent(worker, cli, [channel], { task, model });
    await sleep(STARTUP_MS);
    harness.clearEvents();

    await harness.sendMessage({
      to: worker,
      from: 'Lead',
      text: `Relay message from Lead [chk-${suffix}] [#${channel}]: Status check — post READY to this channel.`,
    });

    await waitForSends(harness, worker, 1, RESPONSE_MS);

    const events = harness.getEvents();
    const base = baseScore(events, [worker]);
    const channelScore = scoreChannelReply(events, worker, channel);
    await harness.releaseAgent(worker).catch(() => {});

    const pass =
      channelScore.repliedToShownChannel &&
      channelScore.wrongChannelReplies === 0 &&
      base.phantoms.length === 0 &&
      base.deliveryOk;

    return {
      id: scenario.id,
      title: scenario.title,
      pass,
      agents: [{ name: worker, cli, role: `member of #${channel}`, prompt: task }],
      transcript: base.transcript,
      sent: base.sent,
      expected: 1,
      phantoms: base.phantoms,
      totalIntents: base.totalIntents,
      protocolAdherence: channelScore.repliedToShownChannel ? 1 : 0,
      wrongChannelReplies: channelScore.wrongChannelReplies,
      deliveryOk: base.deliveryOk,
      events: base.events,
    };
  },
};
