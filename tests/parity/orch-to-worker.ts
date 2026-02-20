/**
 * Parity Test: Orchestrator → Worker Message Delivery
 *
 * Port of tests/integration/sdk/05b2-orch-to-worker.js using broker-sdk.
 * Verifies that the orchestrator can send messages to spawned workers
 * and that PTY injection delivers them successfully.
 * Run: npx tsx tests/parity/orch-to-worker.ts
 */

import {
  AgentRelayClient,
  type BrokerEvent,
} from "@agent-relay/sdk";
import { resolveBinaryPath, randomName } from "../benchmarks/harness.js";

async function main(): Promise<void> {
  console.log("=== Parity Test: Orchestrator → Worker ===\n");

  const client = await AgentRelayClient.start({
    binaryPath: resolveBinaryPath(),
    channels: ["general"],
    env: process.env,
  });

  const workerName = randomName("o2w-recv");

  try {
    // Step 1: Spawn worker
    console.log("1. Spawning worker...");
    await client.spawnPty({
      name: workerName,
      cli: "cat",
      channels: ["general"],
    });
    console.log(`   Worker: ${workerName}\n`);

    await new Promise((r) => setTimeout(r, 500));

    // Step 2: Send message from orchestrator to worker
    console.log("2. Sending message from orchestrator to worker...");
    const testPayload = { type: "ping", data: "Hello from orchestrator!" };
    const result = await client.sendMessage({
      to: workerName,
      from: "orchestrator",
      text: JSON.stringify(testPayload),
    });

    const sendOk = result.event_id !== "unsupported_operation";
    console.log(`   Send result: ${sendOk ? "OK" : "FAILED"} (event_id: ${result.event_id})\n`);

    // Step 3: Wait for delivery verification
    console.log("3. Waiting for delivery verification...");
    let deliveryVerified = false;
    let deliveryFailed = false;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      const unsub = client.onEvent((event: BrokerEvent) => {
        if (event.kind === "delivery_verified") {
          deliveryVerified = true;
          clearTimeout(timer);
          unsub();
          resolve();
        }
        if (event.kind === "delivery_failed") {
          deliveryFailed = true;
          clearTimeout(timer);
          unsub();
          resolve();
        }
      });
    });

    console.log(`   Delivery verified: ${deliveryVerified}`);
    console.log(`   Delivery failed: ${deliveryFailed}\n`);

    // Step 4: Send multiple messages in sequence
    console.log("4. Sending 5 sequential messages...");
    let seqOk = 0;
    for (let i = 0; i < 5; i++) {
      const r = await client.sendMessage({
        to: workerName,
        from: "orchestrator",
        text: `Sequential message #${i}`,
      });
      if (r.event_id !== "unsupported_operation") seqOk++;
    }
    console.log(`   Sequential sends: ${seqOk}/5\n`);

    await new Promise((r) => setTimeout(r, 2000));

    // Results
    const passed = sendOk && deliveryVerified && seqOk === 5;
    console.log(passed ? "=== Orch-to-Worker Parity Test PASSED ===" : "=== Orch-to-Worker Parity Test FAILED ===");
    process.exit(passed ? 0 : 1);
  } finally {
    try { await client.release(workerName); } catch {}
    await client.shutdown();
  }
}

main().catch((err) => { console.error("test failed:", err); process.exit(1); });
