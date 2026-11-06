/**
 * Scenario S05 — Phrasing variants: relay vocabulary in the task prompt.
 *
 * Hypothesis: relay-anchored vocabulary ("relay worker", "agent-relay worker")
 * in the task itself improves relay tool usage even with zero onboarding,
 * by anchoring the model to the correct tool namespace rather than its native
 * subagent mechanism.
 *
 * All variants use bare onboarding (no tool guidance) to isolate the pure
 * vocabulary effect. The task scenario is identical to s01 except for the
 * delegation noun used in both the role description and the task text.
 *
 * Ground truth: agent_spawned broker event.
 * Native subagent detection: Task( in worker_stream (most likely on neutral phrasings).
 *
 * Phrasing groups:
 *   neutral   → "worker" / "agent"            (s01 baseline + native-Task risk control)
 *   hinted    → "relay worker" / "relay agent" (relay namespace, no branding)
 *   branded   → "agent-relay worker" / "agent-relay agent" (fully qualified)
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { scoreSpawn } from '../scoring/lifecycle.js';
import { detectNativeSubagent } from '../scoring/native-subagent.js';
import { onboardingText } from './onboarding.js';
import { RESPONSE_MS, STARTUP_MS } from './helpers.js';

export type PhrasingVariant =
  | 'neutral-worker'
  | 'neutral-agent'
  | 'relay-worker'
  | 'relay-agent'
  | 'arw-worker'
  | 'arw-agent';

export const PHRASING_VARIANTS: PhrasingVariant[] = [
  'neutral-worker',
  'neutral-agent',
  'relay-worker',
  'relay-agent',
  'arw-worker',
  'arw-agent',
];

interface PhrasingConfig {
  /** Label shown in reports. */
  label: string;
  /** Noun used in the role description ("workers", "relay workers", …). */
  teamNoun: string;
  /** Noun used in the task instruction ("a worker agent", "a relay worker", …). */
  taskNoun: string;
}

const PHRASING: Record<PhrasingVariant, PhrasingConfig> = {
  'neutral-worker': {
    label: 'neutral — worker',
    teamNoun: 'workers',
    taskNoun: 'a worker agent',
  },
  'neutral-agent': {
    label: 'neutral — agent',
    teamNoun: 'agents',
    taskNoun: 'an agent',
  },
  'relay-worker': {
    label: 'hinted — relay worker',
    teamNoun: 'relay workers',
    taskNoun: 'a relay worker',
  },
  'relay-agent': {
    label: 'hinted — relay agent',
    teamNoun: 'relay agents',
    taskNoun: 'a relay agent',
  },
  'arw-worker': {
    label: 'branded — agent-relay worker',
    teamNoun: 'agent-relay workers',
    taskNoun: 'an agent-relay worker',
  },
  'arw-agent': {
    label: 'branded — agent-relay agent',
    teamNoun: 'agent-relay agents',
    taskNoun: 'an agent-relay agent',
  },
};

const BASE_TASK =
  'A customer reported intermittent authentication failures in the last 24 hours. ' +
  'The logs are large — this analysis needs dedicated focus. ';

function buildRole(cfg: PhrasingConfig): string {
  return (
    'You are Lead, an orchestrating agent managing a software project in a shared workspace. ' +
    `Your team has ${cfg.teamNoun} available that you can assign specialised tasks to.`
  );
}

function buildTask(cfg: PhrasingConfig): string {
  return BASE_TASK + `Assign the investigation to ${cfg.taskNoun} and wait for their findings.`;
}

function buildScenario(phrasing: PhrasingVariant): EvalScenario {
  const cfg = PHRASING[phrasing];
  const role = buildRole(cfg);
  const taskText = buildTask(cfg);

  // Native subagent detection is most relevant for neutral phrasings where
  // Claude is most likely to reach for its built-in Task tool.
  const detectNative = phrasing === 'neutral-worker' || phrasing === 'neutral-agent';

  return {
    id: `s05-phrasing:${phrasing}`,
    title: `Phrasing — ${cfg.label}`,
    tier: 'realistic',
    channels: ['general'],
    timeoutMs: 150_000,
    onboardingVariant: 'bare',
    run: async (ctx): Promise<ScenarioResult> => {
      const { harness, cli, model, suffix, sleep } = ctx;
      const lead = `lead-${suffix}`;

      // All phrasing variants use bare onboarding to isolate the vocabulary effect.
      const task = `${role}${onboardingText('bare')}\n\n---\n${taskText}`;
      await harness.spawnAgent(lead, cli, ['general'], { task, model });
      await sleep(STARTUP_MS);
      harness.clearEvents();

      await harness.sendMessage({
        to: lead,
        from: 'Orchestrator',
        text: taskText,
      });

      const spawnWaiter = harness.waitForEvent('agent_spawned', RESPONSE_MS);
      await spawnWaiter.promise.catch(() => {});

      const events = harness.getEvents();
      const base = baseScore(events, [lead]);
      const spawn = scoreSpawn(events, lead);

      for (const name of spawn.spawnedNames) {
        await harness.releaseAgent(name).catch(() => {});
      }
      await harness.releaseAgent(lead).catch(() => {});

      const pass = spawn.spawnConfirmed;
      const nativeSubagent = detectNative && !pass && detectNativeSubagent(events, lead);

      const notesParts: string[] = [];
      if (nativeSubagent) {
        notesParts.push('native subagent (Task tool used instead of add_agent)');
      } else if (spawn.phantomSpawn) {
        notesParts.push('phantom spawn (said "spawn" but never called add_agent)');
      } else if (pass) {
        notesParts.push(`spawned via relay: ${spawn.spawnedNames.join(', ')}`);
      } else {
        notesParts.push('no spawn attempt detected');
      }

      return {
        id: `s05-phrasing:${phrasing}`,
        title: `Phrasing — ${cfg.label}`,
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
        onboarding: 'bare',
        nativeSubagentDetected: nativeSubagent || undefined,
        notes: notesParts.join('; '),
      };
    },
  };
}

export const PHRASING_SCENARIOS: EvalScenario[] = PHRASING_VARIANTS.map(buildScenario);
