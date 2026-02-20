/**
 * Parity Test: Continuity Handoff (Spawn/Release Cycle)
 *
 * Port of tests/integration/sdk/15-continuity-handoff.js using broker-sdk.
 * Verifies spawn → message → release cycle works cleanly
 * and that the same agent name can be reused after release.
 * Run: npx tsx tests/parity/continuity-handoff.ts
 */

import {
  AgentRelayClient,
  type BrokerEvent,
} from "@agent-relay/sdk";
import { resolveBinaryPath, randomName } from "../benchmarks/harness.js";

async function main(): Promise<void> {
  console.log("=== Parity Test: Continuity Handoff (Spawn/Release Cycle) ===\n");

  const client = await AgentRelayClient.start({
    binaryPath: resolveBinaryPath(),
    channels: ["general"],
    env: process.env,
  });

  const agentName = randomName("handoff");

  try {
    // Step 1: First spawn
    console.log("1. First spawn cycle...");
    await client.spawnPty({
      name: agentName,
      cli: "cat",
      channels: ["general"],
    });
    console.log(`   Spawned: ${agentName}`);

    await new Promise((r) => setTimeout(r, 500));

    // Send message in first session
    const result1 = await client.sendMessage({
      to: agentName,
      from: "orchestrator",
      text: "Session 1 message",
    });
    const send1Ok = result1.event_id !== "unsupported_operation";
    console.log(`   Message sent: ${send1Ok}`);

    // Wait for delivery
    let verified1 = false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      const unsub = client.onEvent((event: BrokerEvent) => {
        if (event.kind === "delivery_verified") {
          verified1 = true;
          clearTimeout(timer);
          unsub();
          resolve();
        }
      });
    });
    console.log(`   Delivery verified: ${verified1}\n`);

    // Step 2: Release
    console.log("2. Releasing agent...");
    await client.release(agentName);
    console.log("   Released\n");

    await new Promise((r) => setTimeout(r, 1000));

    // Step 3: Re-spawn with same name
    console.log("3. Re-spawning with same name...");
    await client.spawnPty({
      name: agentName,
      cli: "cat",
      channels: ["general"],
    });
    console.log(`   Re-spawned: ${agentName}`);

    await new Promise((r) => setTimeout(r, 500));

    // Send message in second session
    const result2 = await client.sendMessage({
      to: agentName,
      from: "orchestrator",
      text: "Session 2 message",
    });
    const send2Ok = result2.event_id !== "unsupported_operation";
    console.log(`   Message sent: ${send2Ok}`);

    // Wait for delivery
    let verified2 = false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      const unsub = client.onEvent((event: BrokerEvent) => {
        if (event.kind === "delivery_verified") {
          verified2 = true;
          clearTimeout(timer);
          unsub();
          resolve();
        }
      });
    });
    console.log(`   Delivery verified: ${verified2}\n`);

    // Step 4: Final release
    console.log("4. Final release...");
    await client.release(agentName);
    console.log("   Released\n");

    // Results
    const passed = send1Ok && verified1 && send2Ok && verified2;
    console.log(passed
      ? "=== Continuity Handoff Parity Test PASSED ==="
      : "=== Continuity Handoff Parity Test FAILED ===");
    process.exit(passed ? 0 : 1);
  } finally {
    try { await client.release(agentName); } catch {}
    await client.shutdown();
  }
}

main().catch((err) => { console.error("test failed:", err); process.exit(1); });
