/**
 * node:test wrapper so the eval scenarios can also be run and observed through
 * the standard broker integration test runner. Gated behind
 * RELAY_INTEGRATION_REAL_CLI; uses the first available CLI.
 *
 * Run:
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   RELAY_INTEGRATION_REAL_CLI=1 node --test dist/evals/eval.test.js
 *
 * The standalone runner (dist/evals/runner.js) is the primary entrypoint and is
 * what produces JSON reports + the harness matrix.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { BrokerHarness, checkPrerequisites, uniqueSuffix } from '../utils/broker-harness.js';
import { skipUnlessAnyCli, sleep } from '../utils/cli-helpers.js';
import { SCENARIOS } from './scenarios/index.js';

for (const scenario of SCENARIOS) {
  test(`eval: ${scenario.id} — ${scenario.title}`, { timeout: scenario.timeoutMs }, async (t) => {
    const reason = checkPrerequisites();
    if (reason) return t.skip(reason);
    const cli = skipUnlessAnyCli(t);
    if (!cli) return;

    const harness = new BrokerHarness({ channels: scenario.channels });
    await harness.start();
    try {
      const result = await scenario.run({ harness, cli, suffix: uniqueSuffix(), sleep });
      console.log(
        `  ${result.id}: sent=${result.sent}/${result.expected} ` +
          `phantoms=${result.phantoms.length} ` +
          `adherence=${result.protocolAdherence ?? 'n/a'} ` +
          `wrongChan=${result.wrongChannelReplies} notes=${result.notes ?? ''}`
      );
      for (const p of result.phantoms) {
        console.log(`    phantom: [${p.agent}] ${p.verb} ${p.target ?? ''} — "${p.snippet}"`);
      }
      assert.ok(result.pass, `Scenario ${result.id} failed: ${JSON.stringify(result, null, 2)}`);
    } finally {
      await harness.stop().catch(() => {});
    }
  });
}
