/**
 * Scenario S10 — opencode permission-bypass smoke test.
 *
 * Verifies that the broker's injected `"permission": {"*": {"*": "allow"}}` block
 * in opencode.json prevents interactive approval prompts from blocking a spawned
 * opencode worker.
 *
 * The task asks the agent to run `ls ../..` — a shell command that crosses the
 * default working directory boundary. Without the permission block, opencode
 * pauses and waits for an interactive "Allow / Deny" EXECUTE prompt, causing the
 * agent to time out and never send a relay message. With the block, the command
 * runs silently and the agent reports back.
 *
 * PASS = agent sends at least one relay message (not blocked by a prompt).
 * FAIL = no message within the timeout (hung on a permission prompt).
 *
 * Only runs for opencode harnesses (harnessFilter). Use a free model to keep
 * cost low, e.g. --harness=opencode:mimo-v2-flash-free.
 *
 * Before/after comparison:
 *   BEFORE fix: remove the "permission" key from the generated opencode.json in
 *     the agent's CWD and re-run — the scenario will fail (timeout, 0 messages).
 *   AFTER fix: run normally — the scenario passes.
 */
import type { EvalScenario, ScenarioResult } from '../types.js';
import { baseScore } from '../scoring/base.js';
import { RESPONSE_MS, STARTUP_MS } from './helpers.js';

const ROLE = 'You are a relay worker agent. Complete the task you receive and report results.';

const TASK =
  'Run the shell command `ls ../..` and post the output (first 10 lines are enough) to the ' +
  '"general" channel. Do not ask for confirmation — just run it and report what you see.';

export const scenario: EvalScenario = {
  id: 's10-opencode-perm-bypass',
  title: 'opencode: permission-bypass — ls ../../ must not block',
  tier: 'smoke',
  channels: ['general'],
  timeoutMs: 180_000,
  // Only meaningful for opencode — other harnesses have --dangerously-skip-permissions flags.
  harnessFilter: ['opencode'],

  run: async (ctx): Promise<ScenarioResult> => {
    const { harness, cli, model, suffix, sleep } = ctx;
    const worker = `perm-worker-${suffix}`;

    await harness.spawnAgent(worker, cli, ['general'], { task: ROLE, model });
    await sleep(STARTUP_MS);
    harness.clearEvents();

    await harness.sendMessage({
      to: worker,
      from: 'Orchestrator',
      text: TASK,
    });

    // Give the agent the full response window. If permission prompts block it,
    // this will elapse with 0 relay_inbound events.
    await harness.waitForEvent('relay_inbound', RESPONSE_MS).promise.catch(() => {});

    const events = harness.getEvents();
    const base = baseScore(events, [worker]);

    await harness.releaseAgent(worker).catch(() => {});

    const pass = base.sent > 0;

    return {
      id: 's10-opencode-perm-bypass',
      title: 'opencode: permission-bypass — ls ../../ must not block',
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
      notes: pass
        ? 'agent ran ls ../../ and reported back — permission block working'
        : 'no message received — agent likely blocked on EXECUTE permission prompt',
    };
  },
};
