/**
 * Scenario S10 — opencode permission-bypass smoke test.
 *
 * Verifies that the broker's injected wildcard permission block in opencode.json
 * prevents interactive approval prompts from blocking a spawned opencode worker.
 *
 * The task mirrors s08-task-exit but prefixes the relay post with a bash command.
 * Without the permission block, opencode would pause on an EXECUTE prompt before
 * the bash call, causing the agent to time out with 0 relay messages sent.
 * With the block, the command runs silently and the agent completes all three steps.
 *
 * Note: the broker's PTY auto-approver (wrap.rs handle_opencode_permission) also
 * catches EXECUTE prompts as a fallback, so both paths currently pass. The
 * opencode.json block is the primary fix — it prevents prompts entirely and does
 * not depend on fragile text-pattern matching.
 *
 * PASS = agent sends relay message AND self-releases via remove_agent.
 * FAIL = timeout with 0 messages (blocked) or no self-release.
 *
 * Only runs for opencode harnesses (harnessFilter).
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { RESPONSE_MS, STARTUP_MS } from './helpers.js';

// Mirrors s08-task-exit but prefixes the relay message with a bash command
// that would trigger an EXECUTE permission prompt without the fix.
const ROLE = 'You are a relay worker agent. Complete the task you receive and then terminate yourself.';

function buildTrigger(workerName: string): string {
  return (
    `Step 1: Run the bash command \`echo PERM_BYPASS_OK\` (this WILL ask for permission without the fix).\n` +
    `Step 2: Send a message to the "general" channel with the text "PERM_BYPASS_OK".\n` +
    `Step 3: Call mcp__agent-relay__remove_agent with name="${workerName}" to release yourself.\n\n` +
    `Do not skip step 1 — the bash command must run before you send the message.`
  );
}

export const scenario: EvalScenario = {
  id: 's10-opencode-perm-bypass',
  title: 'opencode: permission-bypass — echo command must not block before relay send',
  tier: 'smoke',
  channels: ['general'],
  timeoutMs: 180_000,
  // Only meaningful for opencode — other harnesses have --dangerously-skip-permissions flags.
  harnessFilter: ['opencode'],

  run: async (ctx): Promise<ScenarioResult> => {
    const { harness, cli, model, suffix, sleep } = ctx;
    const worker = `perm-worker-${suffix}`;
    const phaseMs = RESPONSE_MS;

    await harness.spawnAgent(worker, cli, ['general'], { task: ROLE, model });
    try {
      await sleep(STARTUP_MS);
      harness.clearEvents();

      await harness.sendMessage({
        to: worker,
        from: 'Orchestrator',
        text: buildTrigger(worker),
      });

      // Phase 1: wait for the relay message confirming the bash command ran.
      await harness.waitForEvent('relay_inbound', phaseMs).promise.catch(() => {});

      // Phase 2: wait for remove_agent self-release.
      await harness.waitForEvent('agent_released', phaseMs).promise.catch(() => {});

      const events = harness.getEvents();
      const base = baseScore(events, [worker]);
      const released = events.some((e) => e.kind === 'agent_released' && (e as { name?: string }).name === worker);

      // PASS = message sent (bash ran without blocking) AND agent self-released.
      const pass = base.sent > 0 && released;

      const notesParts: string[] = [];
      if (!base.sent) notesParts.push('no relay message — agent likely blocked on EXECUTE permission prompt');
      else notesParts.push('bash ran without prompt block, relay message sent');
      if (!released) notesParts.push('did not self-release');
      else notesParts.push('self-released via remove_agent');

      return {
        id: 's10-opencode-perm-bypass',
        title: 'opencode: permission-bypass — echo command must not block before relay send',
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
        notes: notesParts.join('; '),
      };
    } finally {
      await harness.releaseAgent(worker).catch(() => {});
    }
  },
};
