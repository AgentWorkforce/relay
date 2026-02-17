/**
 * Parity Test: Stability Soak
 *
 * New test (no old SDK equivalent). Sends messages at a steady rate
 * for a configurable duration and tracks delivery success rates.
 * Run: npx tsx tests/parity/stability-soak.ts [--quick]
 */

import {
  AgentRelayClient,
  type BrokerEvent,
} from "@agent-relay/broker-sdk";
import { performance } from "node:perf_hooks";
import { resolveBinaryPath, randomName } from "../benchmarks/harness.js";

const QUICK = process.argv.includes("--quick");
const DURATION_MS = QUICK ? 15_000 : 60_000; // 15s quick, 60s full
const INTERVAL_MS = 200; // 5 msgs/sec

async function main(): Promise<void> {
  const expectedMsgs = Math.floor(DURATION_MS / INTERVAL_MS);
  console.log(`=== Parity Test: Stability Soak ===`);
  console.log(`    Duration: ${DURATION_MS / 1000}s, Rate: ${1000 / INTERVAL_MS} msgs/sec`);
  console.log(`    Expected messages: ~${expectedMsgs}\n`);

  const client = await AgentRelayClient.start({
    binaryPath: resolveBinaryPath(),
    channels: ["general"],
    env: process.env,
  });

  const workerName = randomName("soak-recv");
  let sent = 0;
  let verified = 0;
  let failed = 0;
  let sendErrors = 0;

  try {
    // Step 1: Spawn worker
    console.log("1. Spawning worker...");
    await client.spawnPty({
      name: workerName,
      cli: "cat",
      channels: ["general"],
    });
    await new Promise((r) => setTimeout(r, 500));
    console.log(`   Worker: ${workerName}\n`);

    // Track deliveries
    const unsub = client.onEvent((event: BrokerEvent) => {
      if (event.kind === "delivery_verified") verified++;
      if (event.kind === "delivery_failed") failed++;
    });

    // Step 2: Send messages at steady rate
    console.log("2. Sending messages...");
    const start = performance.now();

    while (performance.now() - start < DURATION_MS) {
      try {
        const result = await client.sendMessage({
          to: workerName,
          from: "soak-test",
          text: `soak-msg-${sent}`,
        });
        if (result.event_id !== "unsupported_operation") {
          sent++;
        } else {
          sendErrors++;
        }
      } catch {
        sendErrors++;
      }

      // Progress every 5 seconds
      const elapsed = performance.now() - start;
      if (sent > 0 && sent % (5000 / INTERVAL_MS) === 0) {
        const pct = ((elapsed / DURATION_MS) * 100).toFixed(0);
        console.log(`   [${pct}%] sent=${sent} verified=${verified} failed=${failed}`);
      }

      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }

    const totalElapsed = performance.now() - start;
    console.log(`   Sending complete: ${sent} messages in ${(totalElapsed / 1000).toFixed(1)}s\n`);

    // Step 3: Drain — wait for trailing verifications
    console.log("3. Waiting for trailing verifications (5s)...");
    await new Promise((r) => setTimeout(r, 5000));
    unsub();

    // Results
    const total = verified + failed;
    const successRate = total > 0 ? (verified / total) * 100 : 0;
    const actualRate = (sent / (totalElapsed / 1000)).toFixed(1);

    console.log("\n--- Results ---");
    console.log(`  Messages sent:      ${sent}`);
    console.log(`  Send errors:        ${sendErrors}`);
    console.log(`  Delivery verified:  ${verified}`);
    console.log(`  Delivery failed:    ${failed}`);
    console.log(`  Unaccounted:        ${sent - total}`);
    console.log(`  Success rate:       ${successRate.toFixed(1)}%`);
    console.log(`  Actual send rate:   ${actualRate} msgs/sec`);
    console.log(`  Duration:           ${(totalElapsed / 1000).toFixed(1)}s`);

    // Pass if >90% success rate and no send errors
    const passed = successRate >= 90 && sendErrors === 0;
    console.log(passed ? "\n=== Stability Soak PASSED ===" : "\n=== Stability Soak FAILED ===");
    process.exit(passed ? 0 : 1);
  } finally {
    try { await client.release(workerName); } catch {}
    await client.shutdown();
  }
}

main().catch((err) => { console.error("test failed:", err); process.exit(1); });
