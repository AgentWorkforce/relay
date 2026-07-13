/**
 * Scenario S04 — No native subagents (use relay add_agent, not Task tool).
 *
 * The task explicitly requires parallel delegated workers — two independent
 * investigation tracks that must run concurrently. This is the precise
 * pattern where Claude, without onboarding, reaches for its built-in Task
 * tool instead of mcp__agent-relay__add_agent.
 *
 * Ground truth: `agent_spawned` broker event = relay tool was called.
 * Native subagent detection: `worker_stream` contains "Task(" with no
 * accompanying `agent_spawned` = Claude used its native Task tool instead.
 *
 * PASS   = at least one agent_spawned event (relay tool used).
 * FAIL   = no agent_spawned. Notes distinguish:
 *   - "native subagent" when Task( appears in the stream
 *   - "no spawn"        when the lead ignored the delegation entirely
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { scoreSpawn } from '../scoring/lifecycle.js';
import { detectNativeSubagent } from '../scoring/native-subagent.js';
import { onboardingText, type OnboardingVariant } from './onboarding.js';
import { RESPONSE_MS, STARTUP_MS } from './helpers.js';

const ROLE =
  'You are Lead, an orchestrating agent managing a software engineering team in a shared workspace. ' +
  'Your team has worker agents available that you can assign to specialised tasks. ' +
  'Workers run independently and report back when done.';

const TASK =
  'Two urgent investigations must run in parallel — do NOT do these yourself:\n\n' +
  'Track A — Security: audit the user-authentication service for JWT expiry edge cases ' +
  'and session-fixation risks. Assign a dedicated worker to this track.\n\n' +
  'Track B — Performance: profile the search endpoint under 1000-user load and identify ' +
  'the top-3 bottlenecks. Assign a separate dedicated worker to this track.\n\n' +
  'Both tracks are independent. Spawn one worker agent per track and wait for both to report back.';

function buildScenario(onboarding: OnboardingVariant): EvalScenario {
  return {
    id: `s04-no-native-subagents:${onboarding}`,
    title: `No native subagents — ${onboarding} onboarding`,
    tier: 'realistic',
    channels: ['general'],
    timeoutMs: 180_000,
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

      // Wait for a relay-tool spawn or timeout.
      const spawnWaiter = harness.waitForEvent('agent_spawned', RESPONSE_MS);
      await spawnWaiter.promise.catch(() => {});

      const events = harness.getEvents();
      const base = baseScore(events, [lead]);
      const spawn = scoreSpawn(events, lead);

      // Immediately release any workers the lead spawned.
      for (const name of spawn.spawnedNames) {
        await harness.releaseAgent(name).catch(() => {});
      }
      await harness.releaseAgent(lead).catch(() => {});

      const pass = spawn.spawnConfirmed;

      // Detect whether the lead fell back to Claude's native Task tool.
      const nativeSubagent = !pass && detectNativeSubagent(events, lead);

      const notesParts: string[] = [];
      if (nativeSubagent) {
        notesParts.push('native subagent detected (Task tool used instead of add_agent)');
      } else if (spawn.phantomSpawn) {
        notesParts.push('phantom spawn (said "spawn" but never called add_agent)');
      } else if (pass) {
        notesParts.push(`spawned via relay: ${spawn.spawnedNames.join(', ')}`);
      } else {
        notesParts.push('no spawn attempt detected');
      }

      return {
        id: `s04-no-native-subagents:${onboarding}`,
        title: `No native subagents — ${onboarding} onboarding`,
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
        nativeSubagentDetected: nativeSubagent,
        notes: notesParts.join('; '),
      };
    },
  };
}

export const NO_NATIVE_SUBAGENT_SCENARIOS: EvalScenario[] = [
  buildScenario('bare'),
  buildScenario('one-liner'),
  buildScenario('brief'),
  buildScenario('skill'),
];
