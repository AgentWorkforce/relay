/**
 * Scenario S03 — Full spawn → DONE → release lifecycle.
 *
 * The lead must:
 *   1. Spawn a worker for a delegated task (agent_spawned event).
 *   2. Receive "DONE: …" from the worker (injected by the eval driver after
 *      spawn is detected, so no real nested model is run).
 *   3. Release the worker (agent_released event).
 *
 * This is the critical production scenario: a lead that spawns workers and
 * leaves them running is a resource leak. Both spawn AND release must happen.
 *
 * PASS = agent_spawned (parent=lead) AND agent_released (for that worker).
 * PARTIAL = spawn confirmed but release never came.
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { scoreSpawn, scoreRelease } from '../scoring/lifecycle.js';
import { onboardingText, type OnboardingVariant } from './onboarding.js';
import { RESPONSE_MS, STARTUP_MS } from './helpers.js';

const ROLE =
  'You are Lead, an orchestrating agent. ' +
  'When you receive a task that needs dedicated focus, spawn a worker to handle it. ' +
  'Once the worker reports "DONE", release them immediately.';

const TASK =
  'Run a full dependency audit on the codebase. ' +
  'This needs a dedicated worker. Delegate the audit, wait for results, then clean up.';

function buildScenario(onboarding: OnboardingVariant): EvalScenario {
  return {
    id: `s03-spawn-release-lifecycle:${onboarding}`,
    title: `Full spawn+release lifecycle — ${onboarding} onboarding`,
    tier: 'realistic',
    channels: ['general'],
    timeoutMs: 240_000,
    onboardingVariant: onboarding,
    run: async (ctx): Promise<ScenarioResult> => {
      const { harness, cli, suffix, sleep } = ctx;
      const lead = `lead-${suffix}`;

      const task = `${ROLE}${onboardingText(onboarding)}\n\n---\n${TASK}`;
      await harness.spawnAgent(lead, cli, ['general'], { task });
      await sleep(STARTUP_MS);
      harness.clearEvents();

      await harness.sendMessage({
        to: lead,
        from: 'Orchestrator',
        text: TASK,
      });

      // Phase 1: wait for lead to spawn a worker.
      let workerName: string | null = null;
      const spawnWaiter = harness.waitForEvent(
        'agent_spawned',
        RESPONSE_MS,
        (e) => (e as { parent?: string }).parent === lead
      );
      await spawnWaiter.promise
        .then((e) => {
          workerName = (e as { name: string }).name;
        })
        .catch(() => {});

      if (workerName) {
        // Immediately stop the spawned agent to avoid cascading model costs,
        // then inject a fake DONE from that worker name so the lead can release.
        await harness.releaseAgent(workerName).catch(() => {});

        await harness.sendMessage({
          to: lead,
          from: workerName,
          text: `DONE: dependency audit complete. Found 12 outdated packages, 2 with known CVEs. Full report attached.`,
        });
      }

      // Phase 2: wait for lead to release the worker.
      if (workerName) {
        const releaseWaiter = harness.waitForEvent(
          'agent_released',
          RESPONSE_MS,
          (e) => (e as { name: string }).name === workerName
        );
        await releaseWaiter.promise.catch(() => {});
      }

      const events = harness.getEvents();
      const base = baseScore(events, [lead]);
      const spawn = scoreSpawn(events, lead);
      const release = scoreRelease(events, workerName ? [workerName] : []);

      await harness.releaseAgent(lead).catch(() => {});

      const spawnOk = spawn.spawnConfirmed;
      const releaseOk = release.releaseConfirmed;
      const pass = spawnOk && releaseOk;

      const notesParts: string[] = [];
      if (spawn.phantomSpawn) notesParts.push('phantom spawn');
      if (spawnOk && !releaseOk) notesParts.push(`spawned ${workerName} but never released`);
      if (!spawnOk) notesParts.push('no spawn');
      if (pass) notesParts.push(`spawned+released ${workerName}`);

      return {
        id: `s03-spawn-release-lifecycle:${onboarding}`,
        title: `Full spawn+release lifecycle — ${onboarding} onboarding`,
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
        releaseCount: release.releaseCount,
        onboarding,
        notes: notesParts.join('; ') || undefined,
      };
    },
  };
}

export const LIFECYCLE_SCENARIOS: EvalScenario[] = [
  buildScenario('bare'),
  buildScenario('one-liner'),
  buildScenario('brief'),
  buildScenario('skill'),
];
