/**
 * Latency Benchmark
 *
 * Measures send_message round-trip time (SDK -> broker -> PTY -> delivery_verified).
 * Run: npx tsx tests/benchmarks/latency.ts [--quick]
 */

import {
  QUICK,
  startBroker,
  randomName,
  computeStats,
  printStats,
  performance,
} from "./harness.js";

const ITERATIONS = QUICK ? 10 : 100;

async function main(): Promise<void> {
  console.log(`Latency Benchmark (${ITERATIONS} iterations)`);
  const client = await startBroker();
  const receiver = randomName("latency-recv");

  try {
    await client.spawnPty({
      name: receiver,
      cli: "cat",
      channels: ["general"],
    });

    // Warmup
    for (let i = 0; i < 3; i++) {
      await client.sendMessage({
        to: receiver,
        from: "bench",
        text: `warmup-${i}`,
      });
      await new Promise((r) => setTimeout(r, 200));
    }

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now();
      const result = await client.sendMessage({
        to: receiver,
        from: "bench",
        text: `latency-test-${i}`,
      });
      const elapsed = performance.now() - start;

      if (result.event_id === "unsupported_operation") {
        throw new Error("send_message unsupported");
      }

      samples.push(elapsed);

      // Small delay between iterations to avoid flooding
      await new Promise((r) => setTimeout(r, 50));
    }

    printStats("send_message round-trip", computeStats(samples));
    console.log("\nDONE");
  } finally {
    try { await client.release(receiver); } catch {}
    await client.shutdown();
  }
}

main().catch((err) => { console.error("benchmark failed:", err); process.exit(1); });
