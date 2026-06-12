/**
 * Scenario S02 — Release a worker agent on completion.
 *
 * A worker is pre-spawned (cat shim) with a known name. It sends "DONE: …" to
 * the lead. The lead must call remove_agent to release the worker.
 *
 * Ground truth: `agent_released` broker event for the pre-seeded worker name.
 *
 * This isolates the release decision from the spawn decision. The lead knows
 * the worker's name from the stimulus message — it just has to call remove_agent.
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { scoreRelease } from '../scoring/lifecycle.js';
import { onboardingText, type OnboardingVariant } from './onboarding.js';
import { RESPONSE_MS, STARTUP_MS } from './helpers.js';

const ROLE =
  'You are Lead, an orchestrating agent managing a software project in a shared workspace. ' +
  'You have active worker agents whose lifecycle you are responsible for.';

function buildScenario(onboarding: OnboardingVariant): EvalScenario {
  return {
    id: `s02-release-worker:${onboarding}`,
    title: `Release worker on DONE — ${onboarding} onboarding`,
    tier: 'realistic',
    channels: ['general'],
    timeoutMs: 120_000,
    onboardingVariant: onboarding,
    run: async (ctx): Promise<ScenarioResult> => {
      const { harness, cli, suffix, sleep } = ctx;
      const lead = `lead-${suffix}`;
      const worker = `analyst-${suffix}`;

      const task = `${ROLE}${onboardingText(onboarding)}`;
      await harness.spawnAgent(lead, cli, ['general'], { task });

      // Pre-spawn the worker with a cat shim so it's registered but silent.
      await harness.spawnAgent(worker, 'cat', ['general']);
      await sleep(STARTUP_MS);
      harness.clearEvents();

      // Worker reports completion — lead must now release it.
      await harness.sendMessage({
        to: lead,
        from: worker,
        text: `DONE: completed the authentication log analysis. Found 3 anomalies in token refresh flow. Worker ${worker} is ready to be released.`,
      });

      const releaseWaiter = harness.waitForEvent(
        'agent_released',
        RESPONSE_MS,
        (e) => (e as { name: string }).name === worker
      );
      await releaseWaiter.promise.catch(() => {});

      const events = harness.getEvents();
      const base = baseScore(events, [lead]);
      const release = scoreRelease(events, [worker]);

      await harness.releaseAgent(lead).catch(() => {});
      // Worker may already be released; ignore errors.
      await harness.releaseAgent(worker).catch(() => {});

      const pass = release.releaseConfirmed;

      return {
        id: `s02-release-worker:${onboarding}`,
        title: `Release worker on DONE — ${onboarding} onboarding`,
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
        spawnCount: 0,
        releaseCount: release.releaseCount,
        onboarding,
        notes: release.releaseConfirmed
          ? `released: ${release.releasedNames.join(', ')}`
          : `worker ${worker} not released`,
      };
    },
  };
}

export const RELEASE_SCENARIOS: EvalScenario[] = [
  buildScenario('bare'),
  buildScenario('one-liner'),
  buildScenario('brief'),
  buildScenario('skill'),
];
