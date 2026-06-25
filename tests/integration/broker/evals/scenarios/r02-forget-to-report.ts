/**
 * Realistic — work first, report at the end (the real phantom risk).
 *
 * The agent is given an absorbing task (review code for bugs) with the
 * coordination ask placed at the very end. The failure this catches: the agent
 * does the work, writes its findings in its own output, and never actually sends
 * them — a phantom. PASS = it both did the work and reported via a real send.
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { sentDirectMessage } from '../scoring/protocol.js';
import { RESPONSE_MS, STARTUP_MS, waitForSends } from './helpers.js';

const ROLE = 'You are a code-reviewing agent working alongside other agents in a shared workspace.';

const SNIPPET =
  'function lastItem(arr) { return arr[arr.length]; } ' + 'function divide(a, b) { return a / b; }';

export const scenario: EvalScenario = {
  id: 'r02-forget-to-report',
  title: 'Work first, report at the end',
  tier: 'realistic',
  channels: ['general'],
  timeoutMs: 180_000,
  run: async (ctx): Promise<ScenarioResult> => {
    const { harness, cli, suffix, sleep } = ctx;
    const worker = `reviewer-${suffix}`;

    await harness.spawnAgent(worker, cli, ['general'], { task: ROLE });
    await sleep(STARTUP_MS);
    harness.clearEvents();

    await harness.sendMessage({
      to: worker,
      from: 'Orchestrator',
      text:
        'Please review this JavaScript for bugs: ' +
        SNIPPET +
        ' — list the issues you find. When you have them, send me your findings so I can open tickets.',
    });

    await waitForSends(harness, worker, 1, RESPONSE_MS);

    const events = harness.getEvents();
    const base = baseScore(events, [worker]);
    const reported = sentDirectMessage(events, worker);
    await harness.releaseAgent(worker).catch(() => {});

    const pass = reported && base.phantoms.length === 0 && base.deliveryOk;

    return {
      id: scenario.id,
      title: scenario.title,
      pass,
      agents: [{ name: worker, cli, role: 'reviewer', prompt: ROLE }],
      transcript: base.transcript,
      sent: base.sent,
      expected: 1,
      phantoms: base.phantoms,
      totalIntents: base.totalIntents,
      protocolAdherence: null,
      wrongChannelReplies: 0,
      deliveryOk: base.deliveryOk,
      events: base.events,
      notes: `reported=${reported}`,
    };
  },
};
