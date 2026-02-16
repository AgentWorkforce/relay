/**
 * Scale-Out Benchmark
 *
 * Measures how latency degrades as agent count increases.
 * Run: npx tsx tests/benchmarks/scale-out.ts [--quick]
 */

import {
  QUICK,
  startBroker,
  randomName,
  computeStats,
  printStats,
  performance,
} from "./harness.js";

const AGENT_COUNTS = QUICK ? [1, 3] : [1, 3, 5, 10];
const MSGS_PER_LEVEL = QUICK ? 5 : 20;

async function main(): Promise<void> {
  console.log(`Scale-Out Benchmark (levels: ${AGENT_COUNTS.join(", ")} agents)`);
  const client = await startBroker();

  try {
    for (const count of AGENT_COUNTS) {
      const agents: string[] = [];

      // Spawn N agents
      for (let i = 0; i < count; i++) {
        const name = randomName(`scale-${count}-${i}`);
        await client.spawnPty({
          name,
          cli: "cat",
          channels: ["general"],
        });
        agents.push(name);
      }
      await new Promise((r) => setTimeout(r, 500));

      // Measure latency sending to the first agent
      const samples: number[] = [];
      for (let i = 0; i < MSGS_PER_LEVEL; i++) {
        const start = performance.now();
        await client.sendMessage({
          to: agents[0]!,
          from: "bench",
          text: `scale-${count}-msg-${i}`,
        });
        samples.push(performance.now() - start);
        await new Promise((r) => setTimeout(r, 30));
      }

      printStats(`${count} agents`, computeStats(samples));

      // Cleanup this level's agents
      for (const name of agents) {
        try { await client.release(name); } catch {}
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    console.log("\nDONE");
  } finally {
    await client.shutdown();
  }
}

main().catch((err) => { console.error("benchmark failed:", err); process.exit(1); });
