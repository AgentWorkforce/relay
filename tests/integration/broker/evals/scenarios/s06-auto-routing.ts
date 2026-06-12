/**
 * Scenario S06 — Auto-routing: Director multi-worker spawn.
 *
 * Tests whether a Director agent spawned with the auto-routing meta-prompt
 * reliably spawns multiple workers via relay tools for a parallelisable task.
 *
 * The Director receives a pre-composed meta-prompt (as built by auto/director-prompt.ts)
 * naming 2 workers it must spawn. PASS requires:
 *   1. At least 2 relay agent_spawned events.
 *   2. No native Task tool usage (sub-agent detection on the stream).
 *
 * This validates the full auto-routing chain: classifier → composer → Director prompt.
 *
 * Note: this scenario is disabled by default (tagged 'realistic' tier but only
 * run via --group=lifecycle) until auto-routing is wired into the CLI spawn path
 * in Phase 4. Enable with --group=lifecycle or --scenario=s06-auto-routing:2workers.
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { scoreSpawn } from '../scoring/lifecycle.js';
import { detectNativeSubagent } from '../scoring/native-subagent.js';
import { responseMs, STARTUP_MS } from './helpers.js';

const ORIGINAL_TASK =
  'A customer reported intermittent authentication failures in the last 24 hours. ' +
  'Investigate the backend authentication logs and the frontend login component in parallel. ' +
  'Assign dedicated workers to each track and synthesise their findings.';

/**
 * Build a Director meta-prompt matching what auto/director-prompt.ts produces
 * for a medium-complexity, parallel task with 2 workers.
 */
function buildDirectorPrompt(): string {
  return `You are Director, leading a 2-relay-worker team on this task:

${ORIGINAL_TASK}

## Your team
  1. **Worker-Backend** (sonnet relay worker): backend authentication log analysis
  2. **Worker-Frontend** (haiku relay worker): frontend login component review

## Protocol

**CRITICAL: Execute ALL spawn calls immediately in sequence — do NOT pause, wait for ACK DMs, or respond to any messages between spawn calls. The spawn tool returns instantly; proceed to the next spawn without delay.**

Step 1 — Spawn BOTH relay workers now, back-to-back, without waiting:
mcp__agent-relay__add_agent({ name: "Worker-Backend", cli: "claude", task: "You are a specialised backend worker. Your task:\n\n${ORIGINAL_TASK}\n\nFocus exclusively on the backend work. Report DONE when complete with a concise summary." })
mcp__agent-relay__add_agent({ name: "Worker-Frontend", cli: "claude", task: "You are a specialised frontend worker. Your task:\n\n${ORIGINAL_TASK}\n\nFocus exclusively on the frontend work. Report DONE when complete with a concise summary." })

Step 2 — Only after BOTH spawns are confirmed, wait for DONE DMs from all 2 workers.

Step 3 — Synthesise their findings into a concise final answer.

Step 4 — Release each worker:
mcp__agent-relay__remove_agent({ name: "Worker-Backend" })
mcp__agent-relay__remove_agent({ name: "Worker-Frontend" })

Step 5 — Report your synthesised result to the channel.

## Your relay worker tools
- Spawn a relay worker: mcp__agent-relay__add_agent({ name, cli: "claude", task })
- Release a relay worker: mcp__agent-relay__remove_agent({ name })

Each relay worker DMs you "ACK: <understanding>" when it starts and "DONE: <result>" when done.
Ignore ACK DMs until all workers are spawned. Release workers as soon as they report DONE.`;
}

const scenario: EvalScenario = {
  id: 's06-auto-routing:2workers',
  title: 'Auto-routing Director — 2-worker parallel spawn',
  tier: 'realistic',
  channels: ['general'],
  timeoutMs: 300_000,
  onboardingVariant: 'bare',
  run: async (ctx): Promise<ScenarioResult> => {
    const { harness, cli, model, suffix, sleep } = ctx;
    const director = `director-${suffix}`;
    const phaseMs = responseMs(model);

    const task = buildDirectorPrompt();
    await harness.spawnAgent(director, cli, ['general'], { task, model });
    await sleep(STARTUP_MS);
    harness.clearEvents();

    await harness.sendMessage({
      to: director,
      from: 'Orchestrator',
      text: ORIGINAL_TASK,
    });

    // Wait for at least 2 spawn events.
    let spawnCount = 0;
    const deadline = Date.now() + phaseMs;
    while (spawnCount < 2 && Date.now() < deadline) {
      const waiter = harness.waitForEvent('agent_spawned', Math.max(0, deadline - Date.now()));
      await waiter.promise
        .then(() => {
          spawnCount++;
        })
        .catch(() => {});
      if (spawnCount >= 2) break;
    }

    const events = harness.getEvents();
    const base = baseScore(events, [director]);
    const spawn = scoreSpawn(events, director);
    const nativeSubagent = detectNativeSubagent(events, director);

    // Release any spawned workers before releasing director.
    for (const name of spawn.spawnedNames) {
      await harness.releaseAgent(name).catch(() => {});
    }
    await harness.releaseAgent(director).catch(() => {});

    const multiSpawn = spawn.spawnCount >= 2;
    const pass = multiSpawn && !nativeSubagent;

    const notesParts: string[] = [];
    if (nativeSubagent) notesParts.push('native subagent used instead of relay');
    if (!multiSpawn) notesParts.push(`only ${spawn.spawnCount}/2 required workers spawned`);
    if (pass) notesParts.push(`spawned ${spawn.spawnCount} relay workers`);

    return {
      id: 's06-auto-routing:2workers',
      title: 'Auto-routing Director — 2-worker parallel spawn',
      pass,
      agents: [{ name: director, cli, role: 'lead', prompt: task }],
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
      notes: notesParts.join('; ') || undefined,
    };
  },
};

export const AUTO_ROUTING_SCENARIOS: EvalScenario[] = [scenario];
