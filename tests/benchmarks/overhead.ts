/**
 * Overhead Benchmark
 *
 * Measures broker CPU/memory overhead: RSS before/after spawning agents.
 * Run: npx tsx tests/benchmarks/overhead.ts [--quick]
 */

import { QUICK, startBroker, randomName, performance } from './harness.js';

const AGENT_COUNT = QUICK ? 3 : 5;

function rssKb(): number {
  return Math.round(process.memoryUsage().rss / 1024);
}

async function main(): Promise<void> {
  console.log(`Overhead Benchmark (${AGENT_COUNT} agents)`);

  const baselineRss = rssKb();
  const start = performance.now();

  const client = await startBroker();
  const brokerRss = rssKb();
  const brokerStartMs = performance.now() - start;

  const agents: string[] = [];

  try {
    // Spawn agents and measure RSS growth
    for (let i = 0; i < AGENT_COUNT; i++) {
      const name = randomName(`overhead-${i}`);
      await client.spawnPty({
        name,
        cli: 'cat',
        channels: ['general'],
      });
      agents.push(name);
      // Let process settle
      await new Promise((r) => setTimeout(r, 200));
    }

    const afterAgentsRss = rssKb();
    const perAgentOverhead = (afterAgentsRss - brokerRss) / AGENT_COUNT;

    // Send some messages to exercise the pipeline
    for (let i = 0; i < 10; i++) {
      await client.sendMessage({
        to: agents[0]!,
        from: 'bench',
        text: `overhead-test-${i}`,
      });
    }
    await new Promise((r) => setTimeout(r, 500));
    const afterMessagesRss = rssKb();

    console.log(`\n  Baseline RSS:         ${baselineRss} KB`);
    console.log(`  After broker start:   ${brokerRss} KB (+${brokerRss - baselineRss} KB)`);
    console.log(`  Broker start time:    ${brokerStartMs.toFixed(0)} ms`);
    console.log(
      `  After ${AGENT_COUNT} agents:      ${afterAgentsRss} KB (+${afterAgentsRss - brokerRss} KB)`
    );
    console.log(`  Per-agent overhead:   ~${perAgentOverhead.toFixed(0)} KB`);
    console.log(`  After 10 messages:    ${afterMessagesRss} KB (+${afterMessagesRss - afterAgentsRss} KB)`);
    console.log('\nDONE');
  } finally {
    for (const name of agents) {
      try {
        await client.release(name);
      } catch {}
    }
    await client.shutdown();
  }
}

main().catch((err) => {
  console.error('benchmark failed:', err);
  process.exit(1);
});
