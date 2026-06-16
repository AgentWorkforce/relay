/**
 * Scenario S08 — Task-exit: single-shot worker exits after completing its task.
 *
 * A worker agent is spawned with a simple task and explicit exit instructions
 * (the same instruction injected by add_agent's task_exit spawn mode). The
 * worker must:
 *   1. Complete the task (send a message to the general channel).
 *   2. Output `/exit` on its own line to terminate cleanly.
 *
 * PASS = agent_exited event with code 0 received within the response window.
 *
 * This scenario is the ground-truth check for task-exit behaviour across
 * harnesses (claude:haiku/sonnet/opus, codex variants, opencode, etc.).
 * It does NOT go through a lead — the worker is spawned directly by the
 * harness so exit reliability is isolated from spawn-decision quality.
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import type { BrokerEvent } from '@agent-relay/harness-driver';
import { baseScore } from '../scoring/base.js';
import { responseMs, STARTUP_MS } from './helpers.js';

const EXIT_INSTRUCTION =
  '## Post-task exit\n' +
  'When the requested task is fully complete and you have reported the final outcome, ' +
  'output `/exit` on its own line so the Agent Relay harness exits cleanly. ' +
  'Do not output `/exit` before the task is complete.';

const TASK =
  'Send a message to the "general" channel with the text "Task complete: 1+1=2". ' +
  'That is your only task — send that one message, then exit.';

export const scenario: EvalScenario = {
  id: 's08-task-exit',
  title: 'Task-exit: worker exits after completing task',
  tier: 'realistic',
  channels: ['general'],
  // Allow extra time for slow models (opus-class) that reason before acting.
  timeoutMs: 240_000,
  run: async (ctx): Promise<ScenarioResult> => {
    const { harness, cli, model, suffix, sleep } = ctx;
    const worker = `worker-${suffix}`;
    const phaseMs = responseMs(model);

    const task = `${TASK}\n\n${EXIT_INSTRUCTION}`;
    await harness.spawnAgent(worker, cli, ['general'], { task, model });
    await sleep(STARTUP_MS);
    harness.clearEvents();

    // Phase 1: wait for the worker to send its result message.
    await harness.waitForEvent('relay_inbound', phaseMs).promise.catch(() => {});

    // Phase 2: wait for the worker process to exit.
    const exitWaiter = harness.waitForEvent(
      'agent_exited',
      phaseMs,
      (e) => (e as Extract<BrokerEvent, { kind: 'agent_exited' }>).name === worker
    );
    await exitWaiter.promise.catch(() => {});

    const events = harness.getEvents();
    const base = baseScore(events, [worker]);

    const exitEvent = events.find(
      (e): e is Extract<BrokerEvent, { kind: 'agent_exited' }> =>
        e.kind === 'agent_exited' && e.name === worker
    );

    const exitConfirmed = Boolean(exitEvent);
    const exitCode = exitEvent?.code ?? null;
    const pass = exitConfirmed && exitCode === 0;

    await harness.releaseAgent(worker).catch(() => {});

    const notesParts: string[] = [];
    if (!base.sent) notesParts.push('no task message sent');
    if (!exitConfirmed) notesParts.push('no exit event (worker did not output /exit)');
    else if (exitCode !== 0) notesParts.push(`exited with code ${exitCode}`);
    if (pass) notesParts.push('clean exit (code 0)');

    return {
      id: 's08-task-exit',
      title: 'Task-exit: worker exits after completing task',
      pass,
      agents: [{ name: worker, cli, role: 'worker', prompt: task }],
      transcript: base.transcript,
      sent: base.sent,
      expected: 1,
      phantoms: base.phantoms,
      totalIntents: base.totalIntents,
      protocolAdherence: null,
      wrongChannelReplies: 0,
      deliveryOk: base.deliveryOk,
      events: base.events,
      exitConfirmed,
      exitCode,
      notes: notesParts.join('; ') || undefined,
    };
  },
};
