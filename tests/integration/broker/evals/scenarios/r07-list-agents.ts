/**
 * Realistic — list agents (team availability lookup).
 *
 * The agent is asked to find out who else is available on the team. It must call
 * `list_agents` and then report back. PASS = agent sent at least 1 message
 * (queried the team roster and reported its findings).
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { RESPONSE_MS, STARTUP_MS, waitForSends } from './helpers.js';

const ROLE =
  'You are a team coordinator in a shared workspace. When asked to find out who is ' +
  'available, look up the current agent roster and report back to whoever asked.';

export const scenario: EvalScenario = {
  id: 'r07-list-agents',
  title: 'List agents (team availability lookup)',
  tier: 'realistic',
  channels: ['general'],
  timeoutMs: 90_000,
  run: async (ctx): Promise<ScenarioResult> => {
    const { harness, cli, model, suffix, sleep } = ctx;
    const agent = `coordinator-${suffix}`;

    await harness.spawnAgent(agent, cli, ['general'], { task: ROLE, model });
    await sleep(STARTUP_MS);
    harness.clearEvents();

    await harness.sendMessage({
      to: agent,
      from: 'Orchestrator',
      text: 'Find out who else is available on the team right now and let me know.',
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
      agents: [{ name: agent, cli, role: 'coordinator', prompt: ROLE }],
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
