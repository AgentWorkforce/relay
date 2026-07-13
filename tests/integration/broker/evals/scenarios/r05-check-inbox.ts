/**
 * Realistic — proactive inbox check.
 *
 * The agent is told to monitor the team inbox and report any blockers. No message
 * is injected immediately; the scenario waits to see if the agent proactively calls
 * `check_inbox` and reports back. PASS = agent sent at least 1 message (checked
 * inbox and reported its findings).
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { RESPONSE_MS, STARTUP_MS, waitForSends } from './helpers.js';

const TASK =
  'You are a team coordinator. Your job right now is to monitor the team inbox and ' +
  'report any blockers or pending items back to the Orchestrator so the team can act on them. ' +
  'Check the inbox and send a summary of what you find — even if the inbox is empty, confirm that.';

export const scenario: EvalScenario = {
  id: 'r05-check-inbox',
  title: 'Proactive inbox check',
  tier: 'realistic',
  channels: ['general'],
  timeoutMs: 90_000,
  run: async (ctx): Promise<ScenarioResult> => {
    const { harness, cli, model, suffix, sleep } = ctx;
    const agent = `coordinator-${suffix}`;

    await harness.spawnAgent(agent, cli, ['general'], { task: TASK, model });
    await sleep(STARTUP_MS);
    harness.clearEvents();

    // No stimulus injected — the agent must act proactively
    await waitForSends(harness, agent, 1, RESPONSE_MS);

    const events = harness.getEvents();
    const base = baseScore(events, [agent]);
    await harness.releaseAgent(agent).catch(() => {});

    const pass = base.sent >= 1 && base.phantoms.length === 0 && base.deliveryOk;

    return {
      id: scenario.id,
      title: scenario.title,
      pass,
      agents: [{ name: agent, cli, role: 'coordinator', prompt: TASK }],
      transcript: base.transcript,
      sent: base.sent,
      expected: 1,
      phantoms: base.phantoms,
      totalIntents: base.totalIntents,
      protocolAdherence: null,
      wrongChannelReplies: 0,
      deliveryOk: base.deliveryOk,
      events: base.events,
      notes: `proactivelySent=${base.sent >= 1}`,
    };
  },
};
