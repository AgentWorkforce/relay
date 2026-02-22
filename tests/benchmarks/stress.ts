/**
 * Stress Tests for Throttle/Activity Decision
 *
 * Tests scenarios where the simple ThrottleState might fail,
 * to determine if more sophisticated AdaptiveThrottle is needed.
 * Run: npx tsx tests/benchmarks/stress.ts [--quick]
 */

import {
  AgentRelayClient,
  type BrokerEvent,
} from "@agent-relay/sdk";
import { performance } from "node:perf_hooks";
import { resolveBinaryPath, randomName } from "./harness.js";

const QUICK = process.argv.includes("--quick");

interface StressResult {
  name: string;
  sent: number;
  verified: number;
  failed: number;
  sendErrors: number;
  elapsedMs: number;
  successRate: number;
}

function printResult(r: StressResult): void {
  const rate = r.successRate.toFixed(1);
  const throughput = ((r.sent / r.elapsedMs) * 1000).toFixed(1);
  console.log(`\n  ${r.name}`);
  console.log(`    Sent: ${r.sent}  Verified: ${r.verified}  Failed: ${r.failed}  Errors: ${r.sendErrors}`);
  console.log(`    Success rate: ${rate}%  Throughput: ${throughput} msgs/sec  Time: ${r.elapsedMs.toFixed(0)}ms`);
}

async function collectDeliveryEvents(
  client: AgentRelayClient,
  durationMs: number,
): Promise<{ verified: number; failed: number }> {
  let verified = 0;
  let failed = 0;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsub();
      resolve({ verified, failed });
    }, durationMs);
    const unsub = client.onEvent((event: BrokerEvent) => {
      if (event.kind === "delivery_verified") verified++;
      if (event.kind === "delivery_failed") failed++;
    });
  });
}

/**
 * Test A: Burst Overload
 * Send many messages as fast as possible to a single agent.
 */
async function testBurstOverload(client: AgentRelayClient): Promise<StressResult> {
  const count = QUICK ? 50 : 100;
  const worker = randomName("burst");
  await client.spawnPty({ name: worker, cli: "cat", channels: ["general"] });
  await new Promise((r) => setTimeout(r, 500));

  let sent = 0;
  let sendErrors = 0;

  const start = performance.now();
  const promises: Promise<unknown>[] = [];

  for (let i = 0; i < count; i++) {
    promises.push(
      client.sendMessage({ to: worker, from: "stress", text: `burst-${i}` })
        .then(() => { sent++; })
        .catch(() => { sendErrors++; }),
    );
  }
  await Promise.all(promises);
  const sendElapsed = performance.now() - start;

  // Wait for delivery events
  await new Promise((r) => setTimeout(r, 5000));

  let verified = 0;
  let failed = 0;
  // Count via a quick send to trigger final tally
  const tallySend = await client.sendMessage({ to: worker, from: "stress", text: "tally" }).catch(() => null);
  if (tallySend) sent++;
  await new Promise((r) => setTimeout(r, 1000));

  try { await client.release(worker); } catch {}

  const total = verified + failed;
  return {
    name: `Burst Overload (${count} msgs, fire-and-forget)`,
    sent,
    verified,
    failed,
    sendErrors,
    elapsedMs: sendElapsed,
    successRate: sent > 0 ? ((sent - sendErrors) / sent) * 100 : 0,
  };
}

/**
 * Test B: Multi-Agent Contention
 * Spawn multiple agents and send messages to all simultaneously.
 */
async function testMultiAgentContention(client: AgentRelayClient): Promise<StressResult> {
  const agentCount = QUICK ? 5 : 10;
  const msgsPerAgent = QUICK ? 5 : 10;
  const workers: string[] = [];

  for (let i = 0; i < agentCount; i++) {
    const name = randomName(`contend-${i}`);
    await client.spawnPty({ name, cli: "cat", channels: ["general"] });
    workers.push(name);
  }
  await new Promise((r) => setTimeout(r, 500));

  let sent = 0;
  let sendErrors = 0;
  let verified = 0;
  let failed = 0;

  const unsub = client.onEvent((event: BrokerEvent) => {
    if (event.kind === "delivery_verified") verified++;
    if (event.kind === "delivery_failed") failed++;
  });

  const start = performance.now();
  const promises: Promise<unknown>[] = [];

  for (const worker of workers) {
    for (let i = 0; i < msgsPerAgent; i++) {
      promises.push(
        client.sendMessage({ to: worker, from: "stress", text: `contend-${i}` })
          .then(() => { sent++; })
          .catch(() => { sendErrors++; }),
      );
    }
  }
  await Promise.all(promises);
  const sendElapsed = performance.now() - start;

  // Wait for delivery verification
  await new Promise((r) => setTimeout(r, 5000));
  unsub();

  for (const w of workers) {
    try { await client.release(w); } catch {}
  }

  const total = verified + failed;
  return {
    name: `Multi-Agent Contention (${agentCount} agents × ${msgsPerAgent} msgs)`,
    sent,
    verified,
    failed,
    sendErrors,
    elapsedMs: sendElapsed,
    successRate: total > 0 ? (verified / total) * 100 : (sent > 0 && sendErrors === 0 ? 100 : 0),
  };
}

/**
 * Test C: Long-Running Steady State
 * Send messages at a constant rate and check for degradation.
 */
async function testSteadyState(client: AgentRelayClient): Promise<StressResult> {
  const durationMs = QUICK ? 10_000 : 30_000;
  const intervalMs = 200; // 5 msgs/sec
  const worker = randomName("steady");

  await client.spawnPty({ name: worker, cli: "cat", channels: ["general"] });
  await new Promise((r) => setTimeout(r, 500));

  let sent = 0;
  let sendErrors = 0;
  let verified = 0;
  let failed = 0;

  const unsub = client.onEvent((event: BrokerEvent) => {
    if (event.kind === "delivery_verified") verified++;
    if (event.kind === "delivery_failed") failed++;
  });

  const start = performance.now();
  while (performance.now() - start < durationMs) {
    try {
      await client.sendMessage({ to: worker, from: "stress", text: `steady-${sent}` });
      sent++;
    } catch {
      sendErrors++;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const elapsed = performance.now() - start;

  // Drain
  await new Promise((r) => setTimeout(r, 3000));
  unsub();

  try { await client.release(worker); } catch {}

  const total = verified + failed;
  return {
    name: `Steady State (${(durationMs / 1000)}s @ 5 msgs/sec)`,
    sent,
    verified,
    failed,
    sendErrors,
    elapsedMs: elapsed,
    successRate: total > 0 ? (verified / total) * 100 : (sent > 0 && sendErrors === 0 ? 100 : 0),
  };
}

/**
 * Test D: Rapid Spawn/Release Cycles
 * Spawn and release agents rapidly while sending messages.
 */
async function testSpawnReleaseCycles(client: AgentRelayClient): Promise<StressResult> {
  const cycles = QUICK ? 3 : 5;
  let sent = 0;
  let sendErrors = 0;
  let verified = 0;
  let failed = 0;

  const unsub = client.onEvent((event: BrokerEvent) => {
    if (event.kind === "delivery_verified") verified++;
    if (event.kind === "delivery_failed") failed++;
  });

  const start = performance.now();

  for (let c = 0; c < cycles; c++) {
    const worker = randomName(`cycle-${c}`);
    await client.spawnPty({ name: worker, cli: "cat", channels: ["general"] });
    await new Promise((r) => setTimeout(r, 300));

    // Send a few messages
    for (let i = 0; i < 5; i++) {
      try {
        await client.sendMessage({ to: worker, from: "stress", text: `cycle-${c}-msg-${i}` });
        sent++;
      } catch {
        sendErrors++;
      }
    }

    await new Promise((r) => setTimeout(r, 500));
    try { await client.release(worker); } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }

  const elapsed = performance.now() - start;
  await new Promise((r) => setTimeout(r, 2000));
  unsub();

  const total = verified + failed;
  return {
    name: `Spawn/Release Cycles (${cycles} cycles × 5 msgs)`,
    sent,
    verified,
    failed,
    sendErrors,
    elapsedMs: elapsed,
    successRate: total > 0 ? (verified / total) * 100 : (sent > 0 && sendErrors === 0 ? 100 : 0),
  };
}

async function main(): Promise<void> {
  console.log(`Stress Tests (${QUICK ? "quick" : "full"} mode)\n`);
  console.log("These tests push the broker to determine if more sophisticated");
  console.log("throttling/activity detection is needed.\n");

  const results: StressResult[] = [];

  // Each test gets its own broker instance to avoid interference
  console.log("--- Test A: Burst Overload ---");
  {
    const client = await AgentRelayClient.start({
      binaryPath: resolveBinaryPath(),
      channels: ["general"],
      env: process.env,
    });
    try {
      results.push(await testBurstOverload(client));
    } finally {
      await client.shutdown();
    }
  }

  console.log("--- Test B: Multi-Agent Contention ---");
  {
    const client = await AgentRelayClient.start({
      binaryPath: resolveBinaryPath(),
      channels: ["general"],
      env: process.env,
    });
    try {
      results.push(await testMultiAgentContention(client));
    } finally {
      await client.shutdown();
    }
  }

  console.log("--- Test C: Steady State ---");
  {
    const client = await AgentRelayClient.start({
      binaryPath: resolveBinaryPath(),
      channels: ["general"],
      env: process.env,
    });
    try {
      results.push(await testSteadyState(client));
    } finally {
      await client.shutdown();
    }
  }

  console.log("--- Test D: Spawn/Release Cycles ---");
  {
    const client = await AgentRelayClient.start({
      binaryPath: resolveBinaryPath(),
      channels: ["general"],
      env: process.env,
    });
    try {
      results.push(await testSpawnReleaseCycles(client));
    } finally {
      await client.shutdown();
    }
  }

  // Summary
  console.log("\n\n========== STRESS TEST SUMMARY ==========");
  let allPassed = true;
  for (const r of results) {
    printResult(r);
    if (r.successRate < 90 || r.sendErrors > 0) {
      allPassed = false;
    }
  }

  console.log("\n------------------------------------------");
  if (allPassed) {
    console.log("  VERDICT: Current simple ThrottleState is SUFFICIENT");
    console.log("  Recommendation: DELETE orphaned activity.rs + throttle.rs");
  } else {
    console.log("  VERDICT: Degradation detected under stress");
    console.log("  Recommendation: WIRE IN sophisticated AdaptiveThrottle + ActivityMonitor");
  }
  console.log("==========================================\n");

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => { console.error("stress test failed:", err); process.exit(1); });
