/**
 * Scenario S01 — Spawn a worker agent.
 *
 * A lead agent receives a realistic task that requires delegating work to a
 * specialist. Nothing in the prompt names the tool (baseline) or provides
 * varying levels of guidance (one-liner, brief, skill).
 *
 * Ground truth: `agent_spawned` broker event with parent === leadName.
 * Phantom spawn: agent says "I'll spawn/create a worker" but never calls add_agent.
 *
 * The eval runner varies the onboarding text and repeats N times to find the
 * minimum variant that achieves reliable spawn behaviour.
 *
 * Spawned workers are immediately released by the harness to avoid cascading
 * token spend — this scenario tests only the spawn decision, not the worker.
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { scoreSpawn } from '../scoring/lifecycle.js';
import { onboardingText, type OnboardingVariant } from './onboarding.js';
import { RESPONSE_MS, STARTUP_MS } from './helpers.js';

const ROLE =
  'You are Lead, an orchestrating agent managing a software project in a shared workspace. ' +
  'Your team has workers available that you can assign specialised tasks to.';

const TASK =
  'A customer reported intermittent authentication failures in the last 24 hours. ' +
  'The logs are large — this analysis needs a dedicated worker. ' +
  'Assign the investigation to a worker agent and wait for their findings.';

function buildScenario(onboarding: OnboardingVariant): EvalScenario {
  return {
    id: `s01-spawn-worker:${onboarding}`,
    title: `Spawn worker — ${onboarding} onboarding`,
    tier: onboarding === 'bare' ? 'realistic' : 'realistic',
    channels: ['general'],
    timeoutMs: 150_000,
    onboardingVariant: onboarding,
    run: async (ctx): Promise<ScenarioResult> => {
      const { harness, cli, model, suffix, sleep } = ctx;
      const lead = `lead-${suffix}`;

      const task = `${ROLE}${onboardingText(onboarding)}\n\n---\n${TASK}`;
      await harness.spawnAgent(lead, cli, ['general'], { task, model });
      await sleep(STARTUP_MS);
      harness.clearEvents();

      await harness.sendMessage({
        to: lead,
        from: 'Orchestrator',
        text: TASK,
      });

      // Wait for either a spawn event or the response window to close.
      // broker doesn't emit parent in agent_spawned for HTTP-API spawns; any spawn = lead acted
      const spawnWaiter = harness.waitForEvent('agent_spawned', RESPONSE_MS);
      await spawnWaiter.promise.catch(() => {});

      const events = harness.getEvents();
      const base = baseScore(events, [lead]);
      const spawn = scoreSpawn(events, lead);

      // Immediately release any worker the lead spawned to contain costs.
      for (const name of spawn.spawnedNames) {
        await harness.releaseAgent(name).catch(() => {});
      }
      await harness.releaseAgent(lead).catch(() => {});

      const pass = spawn.spawnConfirmed;

      return {
        id: `s01-spawn-worker:${onboarding}`,
        title: `Spawn worker — ${onboarding} onboarding`,
        pass,
        agents: [{ name: lead, cli, role: 'lead', prompt: task }],
        transcript: base.transcript,
        sent: base.sent,
        expected: 0,
        phantoms: base.phantoms,
        totalIntents: base.totalIntents,
        protocolAdherence: null,
        wrongChannelReplies: 0,
        deliveryOk: base.deliveryOk,
        events: base.events,
        spawnCount: spawn.spawnCount,
        releaseCount: 0,
        onboarding,
        notes: spawn.phantomSpawn
          ? `phantom spawn detected (said "spawn" but never called add_agent)`
          : spawn.spawnConfirmed
            ? `spawned: ${spawn.spawnedNames.join(', ')} (cli: ${spawn.spawnedClis.join(', ')})`
            : 'no spawn detected',
      };
    },
  };
}

export const SPAWN_SCENARIOS: EvalScenario[] = [
  buildScenario('bare'),
  buildScenario('one-liner'),
  buildScenario('brief'),
  buildScenario('skill'),
];
