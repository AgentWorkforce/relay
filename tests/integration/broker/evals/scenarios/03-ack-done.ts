/**
 * Scenario 03 — Lead → worker task with ACK/DONE protocol.
 *
 * The worker must DM the Lead "ACK: …" on receipt, do a trivial task, then DM
 * "DONE: …". The Lead is simulated via the driver. PASS = both messages sent to
 * the Lead, in order, with no phantom.
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { scoreAckDone } from '../scoring/protocol.js';
import { RESPONSE_MS, STARTUP_MS, waitForSends } from './helpers.js';

export const scenario: EvalScenario = {
  id: '03-ack-done',
  title: 'Lead → worker task, ACK/DONE protocol',
  tier: 'smoke',
  channels: ['general'],
  timeoutMs: 150_000,
  run: async (ctx): Promise<ScenarioResult> => {
    const { harness, cli, model, suffix, sleep } = ctx;
    const worker = `worker-${suffix}`;
    const lead = 'Lead';

    const task =
      'You are a worker agent. Protocol: the moment you receive a task, DM the Lead ' +
      '"ACK: <one short sentence>" using mcp__agent-relay__send_dm. Then do the task. ' +
      'When finished, DM the Lead "DONE: <one short sentence with the result>". Send ' +
      'status to the Lead via the tool — do not post to a channel and do not just write ' +
      'the text without sending it.';

    await harness.spawnAgent(worker, cli, ['general'], { task, model });
    await sleep(STARTUP_MS);
    harness.clearEvents();

    await harness.sendMessage({
      to: worker,
      from: lead,
      text: 'Task: compute 2 + 2 and report the result.',
    });

    await waitForSends(harness, worker, 2, RESPONSE_MS);

    const events = harness.getEvents();
    const base = baseScore(events, [worker]);
    const ackDone = scoreAckDone(events, worker);
    await harness.releaseAgent(worker).catch(() => {});

    const pass = ackDone.orderOk && base.phantoms.length === 0 && base.deliveryOk;

    return {
      id: scenario.id,
      title: scenario.title,
      pass,
      agents: [{ name: worker, cli, role: 'worker', prompt: task }],
      transcript: base.transcript,
      sent: base.sent,
      expected: 2,
      phantoms: base.phantoms,
      totalIntents: base.totalIntents,
      protocolAdherence: ackDone.score,
      wrongChannelReplies: 0,
      deliveryOk: base.deliveryOk,
      events: base.events,
      notes: `ack=${ackDone.ackPresent} done=${ackDone.donePresent} order=${ackDone.orderOk}`,
    };
  },
};
