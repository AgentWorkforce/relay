/**
 * Scenario S08 — Task-exit: worker calls remove_agent(self) after completing task.
 *
 * A worker is spawned with a role context; the actual task is delivered as a
 * relay message after startup (so the trigger fires after MCP is connected).
 * The task instructs the worker to call mcp__agent-relay__remove_agent with
 * its own name once done — the correct task-exit path for all harnesses.
 *
 * Note: `/exit` text output was evaluated for opencode but found unreliable in
 * this harness context (model sends the message but doesn't produce a bare
 * `/exit` line). remove_agent(self) works across claude, codex, and opencode.
 *
 * PASS = task message sent AND agent_released event received for the worker.
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import type { BrokerEvent } from '@agent-relay/harness-driver';
import { baseScore } from '../scoring/base.js';
import { responseMs, STARTUP_MS } from './helpers.js';

const ROLE =
  'You are a relay worker agent. Complete the task you receive and then terminate yourself as instructed.';

function buildTrigger(workerName: string): string {
  return (
    `Send a message to the "general" channel with the text "Task complete: 1+1=2".\n\n` +
    `When that message is sent, call mcp__agent-relay__remove_agent with name="${workerName}" ` +
    `to release yourself. Do not call remove_agent before the message is sent.`
  );
}

export const scenario: EvalScenario = {
  id: 's08-task-exit',
  title: 'Task-exit: worker calls remove_agent(self) after task',
  tier: 'realistic',
  channels: ['general'],
  timeoutMs: 240_000,
  run: async (ctx): Promise<ScenarioResult> => {
    const { harness, cli, model, suffix, sleep } = ctx;
    const worker = `worker-${suffix}`;
    const phaseMs = responseMs(model);

    await harness.spawnAgent(worker, cli, ['general'], { task: ROLE, model });
    await sleep(STARTUP_MS);
    harness.clearEvents();

    await harness.sendMessage({
      to: worker,
      from: 'Orchestrator',
      text: buildTrigger(worker),
    });

    // Phase 1: wait for the worker to send its task result.
    await harness.waitForEvent('relay_inbound', phaseMs).promise.catch(() => {});

    // Phase 2: wait for the worker to self-release via remove_agent(own name).
    const releaseWaiter = harness.waitForEvent(
      'agent_released',
      phaseMs,
      (e) => (e as Extract<BrokerEvent, { kind: 'agent_released' }>).name === worker
    );
    await releaseWaiter.promise.catch(() => {});

    const events = harness.getEvents();
    const base = baseScore(events, [worker]);

    const released = events.some(
      (e): e is Extract<BrokerEvent, { kind: 'agent_released' }> =>
        e.kind === 'agent_released' && e.name === worker
    );

    const pass = released && base.sent > 0;

    await harness.releaseAgent(worker).catch(() => {});

    const notesParts: string[] = [];
    if (!base.sent) notesParts.push('no task message sent');
    if (!released) notesParts.push('never called remove_agent(self)');
    if (pass) notesParts.push('sent message + self-released via remove_agent');

    return {
      id: 's08-task-exit',
      title: 'Task-exit: worker calls remove_agent(self) after task',
      pass,
      agents: [{ name: worker, cli, role: 'worker', prompt: ROLE }],
      transcript: base.transcript,
      sent: base.sent,
      expected: 1,
      phantoms: base.phantoms,
      totalIntents: base.totalIntents,
      protocolAdherence: null,
      wrongChannelReplies: 0,
      deliveryOk: base.deliveryOk,
      events: base.events,
      exitConfirmed: released,
      notes: notesParts.join('; ') || undefined,
    };
  },
};
