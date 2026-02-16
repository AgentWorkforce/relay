/**
 * Throughput Benchmark
 *
 * Sends N messages in rapid succession and measures msgs/sec delivery rate.
 * Run: npx tsx tests/benchmarks/throughput.ts [--quick]
 */

import {
  QUICK,
  startBroker,
  randomName,
  performance,
} from "./harness.js";

const MESSAGE_COUNT = QUICK ? 20 : 200;

async function main(): Promise<void> {
  console.log(`Throughput Benchmark (${MESSAGE_COUNT} messages)`);
  const client = await startBroker();
  const receiver = randomName("throughput-recv");

  try {
    await client.spawnPty({
      name: receiver,
      cli: "cat",
      channels: ["general"],
    });

    // Warmup
    await client.sendMessage({ to: receiver, from: "bench", text: "warmup" });
    await new Promise((r) => setTimeout(r, 500));

    // Fire all messages as fast as possible
    const start = performance.now();
    const promises: Promise<unknown>[] = [];

    for (let i = 0; i < MESSAGE_COUNT; i++) {
      promises.push(
        client.sendMessage({
          to: receiver,
          from: "bench",
          text: `throughput-${i}`,
        }),
      );
    }

    await Promise.all(promises);
    const elapsed = performance.now() - start;

    const msgsPerSec = (MESSAGE_COUNT / elapsed) * 1000;

    console.log(`\n  Messages sent:    ${MESSAGE_COUNT}`);
    console.log(`  Total time:       ${elapsed.toFixed(2)} ms`);
    console.log(`  Throughput:       ${msgsPerSec.toFixed(1)} msgs/sec`);
    console.log(`  Avg per message:  ${(elapsed / MESSAGE_COUNT).toFixed(2)} ms`);
    console.log("\nDONE");
  } finally {
    try { await client.release(receiver); } catch {}
    await client.shutdown();
  }
}

main().catch((err) => { console.error("benchmark failed:", err); process.exit(1); });
