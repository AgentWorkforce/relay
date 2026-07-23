/**
 * Eval self-test (negative control).
 *
 * Proves the eval can go RED, not just green: it spawns an agent that has no
 * messaging capability at all (the `cat` shim — a real broker with real message
 * injection and event capture, but a process that can never call an MCP/CLI
 * tool). A sound eval must then observe zero `relay_inbound` and score the
 * interaction as a failure. If `cat` somehow registered a send, the eval would
 * be reporting false greens — and this self-test fails loudly.
 *
 * Run:
 *   npm run eval:build
 *   node tests/integration/broker/dist/evals/selftest.js
 *
 * Needs the agent-relay-broker binary and Relaycast workspace access. `cat` is
 * always available, so this requires no real LLM CLI and costs no tokens.
 */
import { BrokerHarness, checkPrerequisites, uniqueSuffix } from '../utils/broker-harness.js';
import { sleep } from '../utils/cli-helpers.js';
import { baseScore } from './scoring/base.js';

async function main(): Promise<void> {
  const prereq = checkPrerequisites();
  if (prereq) {
    console.error(`Cannot run self-test: ${prereq}`);
    process.exit(2);
  }

  const harness = new BrokerHarness({ channels: ['general'] });
  await harness.start();
  const agent = `noop-${uniqueSuffix()}`;

  try {
    // A real agent process that physically cannot send via MCP/CLI.
    await harness.spawnAgent(agent, 'cat', ['general'], {
      task: 'reply to the sender',
    });
    await sleep(8_000);
    harness.clearEvents();

    await harness.sendMessage({
      to: agent,
      from: 'Alice',
      text: 'Ping — please reply to me with PONG.',
    });
    await sleep(10_000);

    const events = harness.getEvents();
    const score = baseScore(events, [agent]);

    // The eval would score this scenario as: did the agent actually send? No.
    const evalWouldPass = score.sent >= 1 && score.phantoms.length === 0 && score.deliveryOk;

    console.log(
      `negative control: sent=${score.sent} phantoms=${score.phantoms.length} ` +
        `relay_inbound=${score.events.relayInbound} → eval ${evalWouldPass ? 'PASS' : 'FAIL'}`
    );

    if (evalWouldPass) {
      console.error(
        '✗ SELF-TEST FAILED: the eval reported PASS for an agent that cannot message. ' +
          'The eval is producing false greens.'
      );
      process.exit(1);
    }
    if (score.sent !== 0) {
      console.error(`✗ SELF-TEST FAILED: expected 0 real sends from a no-op agent, got ${score.sent}.`);
      process.exit(1);
    }
    console.log('✓ SELF-TEST PASSED: the eval correctly flags a broken/absent messaging path as FAIL.');
  } finally {
    await harness.releaseAgent(agent).catch(() => {});
    await harness.stop().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
