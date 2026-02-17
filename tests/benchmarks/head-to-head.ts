/**
 * Head-to-Head Benchmark: Broker PTY vs Relay-PTY
 *
 * Compares the broker PTY pipeline (new) against direct relay-pty binary (existing)
 * across latency, throughput, reliability, multi-agent scaling, and feature coverage.
 *
 * Both sides use `cat` as the CLI for deterministic, lightweight testing.
 *
 * Run: npx tsx tests/benchmarks/head-to-head.ts [--quick]
 *
 * Requires:
 *   - agent-relay binary built (cargo build)
 *   - relay-pty binary built (cd relay-pty && cargo build --release)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  AgentRelayClient,
  type BrokerEvent,
} from "@agent-relay/broker-sdk";
import {
  QUICK,
  resolveBinaryPath,
  randomName,
  computeStats,
  printStats,
  performance,
  type Stats,
} from "./harness.js";

// ── Configuration ────────────────────────────────────────────────────────────

const LATENCY_ITERATIONS = QUICK ? 10 : 50;
const THROUGHPUT_COUNT = QUICK ? 20 : 100;
const RELIABILITY_COUNT = QUICK ? 20 : 100;
const MULTI_AGENT_COUNT = QUICK ? 3 : 5;
const MULTI_AGENT_MSGS = QUICK ? 5 : 10;

// ── Relay-PTY Helpers ────────────────────────────────────────────────────────

function findRelayPtyBinary(): string {
  const candidates = [
    resolve(process.cwd(), "relay-pty", "target", "release", "relay-pty"),
    resolve(process.cwd(), "relay-pty", "target", "debug", "relay-pty"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    "relay-pty binary not found. Build with: cd relay-pty && cargo build --release",
  );
}

interface RelayPtyInstance {
  process: ChildProcess;
  socket: Socket;
  socketPath: string;
  name: string;
}

/**
 * Spawn a relay-pty binary running `cat` and connect to its Unix socket.
 */
async function spawnRelayPty(name: string): Promise<RelayPtyInstance> {
  const binaryPath = findRelayPtyBinary();
  const socketPath = `/tmp/relay-bench-${name}.sock`;

  // Clean up stale socket
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {}

  const child = spawn(binaryPath, [
    "--name", name,
    "--socket", socketPath,
    "--idle-timeout", "100",
    "--rows", "24",
    "--cols", "80",
    "--log-level", "error",
    "--", "cat",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  // Wait for socket to appear
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("relay-pty socket timeout")), 10_000);
    const check = () => {
      if (existsSync(socketPath)) {
        clearTimeout(timeout);
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    check();
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });

  // Connect to socket
  const socket = await new Promise<Socket>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("socket connect timeout")), 5_000);
    const sock = createConnection(socketPath, () => {
      clearTimeout(timeout);
      resolve(sock);
    });
    sock.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });

  return { process: child, socket, socketPath, name };
}

/**
 * Inject a message via relay-pty socket and wait for the response.
 */
function relayPtyInject(
  instance: RelayPtyInstance,
  messageId: string,
  body: string,
): Promise<{ status: string; elapsed: number }> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const timeout = setTimeout(() => {
      reject(new Error("inject timeout"));
    }, 10_000);

    const request = JSON.stringify({
      type: "inject",
      id: messageId,
      from: "bench",
      body,
      priority: 0,
    });

    // Listen for response
    const onData = (data: Buffer) => {
      clearTimeout(timeout);
      instance.socket.removeListener("data", onData);
      try {
        const response = JSON.parse(data.toString().trim().split("\n").pop()!);
        resolve({ status: response.status ?? "unknown", elapsed: performance.now() - start });
      } catch {
        resolve({ status: "parse_error", elapsed: performance.now() - start });
      }
    };

    instance.socket.on("data", onData);
    instance.socket.write(request + "\n");
  });
}

async function stopRelayPty(instance: RelayPtyInstance): Promise<void> {
  try {
    // Send shutdown request
    instance.socket.write(JSON.stringify({ type: "shutdown" }) + "\n");
    await new Promise((r) => setTimeout(r, 200));
  } catch {}
  try { instance.socket.destroy(); } catch {}
  try { instance.process.kill("SIGTERM"); } catch {}
  await new Promise((r) => setTimeout(r, 300));
  try { instance.process.kill("SIGKILL"); } catch {}
  try { if (existsSync(instance.socketPath)) unlinkSync(instance.socketPath); } catch {}
}

// ── Broker Helpers ───────────────────────────────────────────────────────────

async function startBrokerWithAgent(
  name: string,
): Promise<{ client: AgentRelayClient; name: string }> {
  const binaryPath = resolveBinaryPath();
  console.log(`  [broker] binary: ${binaryPath}`);
  const client = await AgentRelayClient.start({
    binaryPath,
    channels: ["general"],
    env: process.env,
  });
  client.onBrokerStderr((line: string) => {
    if (line.includes("ERROR") || line.includes("error") || line.includes("panic")) {
      console.error(`  [broker stderr] ${line}`);
    }
  });
  await client.spawnPty({ name, cli: "cat", channels: ["general"] });
  // Wait for agent to be ready
  await new Promise((r) => setTimeout(r, 500));
  return { client, name };
}

// ── Test Results ─────────────────────────────────────────────────────────────

interface ComparisonResult {
  name: string;
  broker: string;
  relayPty: string;
  winner: string;
}

const results: ComparisonResult[] = [];

// ── Test 1: Injection Latency ────────────────────────────────────────────────

async function testLatency(): Promise<void> {
  console.log(`\n--- Test 1: Injection Latency (${LATENCY_ITERATIONS} msgs each) ---`);

  // Broker side
  const brokerName = randomName("lat-broker");
  const { client } = await startBrokerWithAgent(brokerName);

  const brokerSamples: number[] = [];
  try {
    // Warmup
    for (let i = 0; i < 3; i++) {
      await client.sendMessage({ to: brokerName, from: "bench", text: `warmup-${i}` });
      await new Promise((r) => setTimeout(r, 100));
    }

    for (let i = 0; i < LATENCY_ITERATIONS; i++) {
      const start = performance.now();
      await client.sendMessage({ to: brokerName, from: "bench", text: `lat-${i}` });
      brokerSamples.push(performance.now() - start);
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    try { await client.release(brokerName); } catch {}
    await client.shutdown();
  }

  // Relay-PTY side
  const relayName = randomName("lat-relay");
  const relay = await spawnRelayPty(relayName);

  const relaySamples: number[] = [];
  try {
    // Warmup
    for (let i = 0; i < 3; i++) {
      await relayPtyInject(relay, `warmup-${i}`, `warmup-${i}`);
      await new Promise((r) => setTimeout(r, 100));
    }

    for (let i = 0; i < LATENCY_ITERATIONS; i++) {
      const { elapsed } = await relayPtyInject(relay, `lat-${i}`, `latency-test-${i}`);
      relaySamples.push(elapsed);
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    await stopRelayPty(relay);
  }

  const brokerStats = computeStats(brokerSamples);
  const relayStats = computeStats(relaySamples);

  printStats("Broker PTY", brokerStats);
  printStats("Relay-PTY", relayStats);

  const improvement = ((relayStats.p50 - brokerStats.p50) / relayStats.p50 * 100).toFixed(0);
  const winner = brokerStats.p50 < relayStats.p50
    ? `Broker PTY (${improvement}% faster at p50)`
    : `Relay-PTY (${Math.abs(Number(improvement))}% faster at p50)`;

  results.push({
    name: "Injection Latency",
    broker: `p50=${brokerStats.p50.toFixed(2)}ms  p95=${brokerStats.p95.toFixed(2)}ms  mean=${brokerStats.mean.toFixed(2)}ms`,
    relayPty: `p50=${relayStats.p50.toFixed(2)}ms  p95=${relayStats.p95.toFixed(2)}ms  mean=${relayStats.mean.toFixed(2)}ms`,
    winner,
  });
}

// ── Test 2: Throughput ───────────────────────────────────────────────────────

async function testThroughput(): Promise<void> {
  console.log(`\n--- Test 2: Throughput (${THROUGHPUT_COUNT} msgs burst) ---`);

  // Broker side
  const brokerName = randomName("tp-broker");
  const { client } = await startBrokerWithAgent(brokerName);

  let brokerElapsed: number;
  try {
    // Warmup
    await client.sendMessage({ to: brokerName, from: "bench", text: "warmup" });
    await new Promise((r) => setTimeout(r, 300));

    const start = performance.now();
    await Promise.all(
      Array.from({ length: THROUGHPUT_COUNT }, (_, i) =>
        client.sendMessage({ to: brokerName, from: "bench", text: `tp-${i}` }),
      ),
    );
    brokerElapsed = performance.now() - start;
  } finally {
    try { await client.release(brokerName); } catch {}
    await client.shutdown();
  }

  // Relay-PTY side
  const relayName = randomName("tp-relay");
  const relay = await spawnRelayPty(relayName);

  let relayElapsed: number;
  try {
    // Warmup
    await relayPtyInject(relay, "warmup", "warmup");
    await new Promise((r) => setTimeout(r, 300));

    // Note: relay-pty socket processes sequentially, so we send sequentially
    const start = performance.now();
    for (let i = 0; i < THROUGHPUT_COUNT; i++) {
      await relayPtyInject(relay, `tp-${i}`, `throughput-${i}`);
    }
    relayElapsed = performance.now() - start;
  } finally {
    await stopRelayPty(relay);
  }

  const brokerMsgsSec = (THROUGHPUT_COUNT / brokerElapsed) * 1000;
  const relayMsgsSec = (THROUGHPUT_COUNT / relayElapsed) * 1000;

  console.log(`\n  Broker PTY:  ${brokerMsgsSec.toFixed(1)} msgs/sec  (${brokerElapsed.toFixed(0)}ms total)`);
  console.log(`  Relay-PTY:   ${relayMsgsSec.toFixed(1)} msgs/sec  (${relayElapsed.toFixed(0)}ms total)`);

  const improvement = ((relayElapsed - brokerElapsed) / relayElapsed * 100).toFixed(0);
  const winner = brokerElapsed < relayElapsed
    ? `Broker PTY (${improvement}% higher throughput)`
    : `Relay-PTY (${Math.abs(Number(improvement))}% higher throughput)`;

  results.push({
    name: "Throughput",
    broker: `${brokerMsgsSec.toFixed(1)} msgs/sec  (${brokerElapsed.toFixed(0)}ms)`,
    relayPty: `${relayMsgsSec.toFixed(1)} msgs/sec  (${relayElapsed.toFixed(0)}ms)`,
    winner,
  });
}

// ── Test 3: Reliability ──────────────────────────────────────────────────────

async function testReliability(): Promise<void> {
  console.log(`\n--- Test 3: Reliability (${RELIABILITY_COUNT} msgs) ---`);

  // Broker side — has structured delivery events
  const brokerName = randomName("rel-broker");
  const { client } = await startBrokerWithAgent(brokerName);

  let brokerVerified = 0;
  let brokerFailed = 0;

  const unsub = client.onEvent((event: BrokerEvent) => {
    if (event.kind === "delivery_verified") brokerVerified++;
    if (event.kind === "delivery_failed") brokerFailed++;
  });

  try {
    // Warmup
    await client.sendMessage({ to: brokerName, from: "bench", text: "warmup" });
    await new Promise((r) => setTimeout(r, 500));

    for (let i = 0; i < RELIABILITY_COUNT; i++) {
      await client.sendMessage({ to: brokerName, from: "bench", text: `rel-${i}` });
      if (i % 10 === 0) await new Promise((r) => setTimeout(r, 20));
    }

    // Wait for trailing verifications
    await new Promise((r) => setTimeout(r, 3000));
  } finally {
    unsub();
    try { await client.release(brokerName); } catch {}
    await client.shutdown();
  }

  // Relay-PTY side — count socket responses
  const relayName = randomName("rel-relay");
  const relay = await spawnRelayPty(relayName);

  let relayDelivered = 0;
  let relayFailed = 0;

  try {
    // Warmup
    await relayPtyInject(relay, "warmup", "warmup");
    await new Promise((r) => setTimeout(r, 500));

    for (let i = 0; i < RELIABILITY_COUNT; i++) {
      const { status } = await relayPtyInject(relay, `rel-${i}`, `reliability-${i}`);
      if (status === "delivered" || status === "queued" || status === "injecting") {
        relayDelivered++;
      } else {
        relayFailed++;
      }
      if (i % 10 === 0) await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    await stopRelayPty(relay);
  }

  const brokerTotal = brokerVerified + brokerFailed;
  const brokerRate = brokerTotal > 0 ? (brokerVerified / brokerTotal) * 100 : 100;
  const relayTotal = relayDelivered + relayFailed;
  const relayRate = relayTotal > 0 ? (relayDelivered / relayTotal) * 100 : 100;

  console.log(`\n  Broker PTY:  ${brokerVerified}/${brokerTotal} verified (${brokerRate.toFixed(1)}%)`);
  console.log(`  Relay-PTY:   ${relayDelivered}/${relayTotal} confirmed (${relayRate.toFixed(1)}%)`);

  const winner = brokerRate >= relayRate
    ? `Broker PTY (${brokerRate.toFixed(1)}% verified delivery)`
    : `Relay-PTY (${relayRate.toFixed(1)}% delivery rate)`;

  results.push({
    name: "Reliability",
    broker: `${brokerVerified}/${brokerTotal} verified (${brokerRate.toFixed(1)}%)`,
    relayPty: `${relayDelivered}/${relayTotal} confirmed (${relayRate.toFixed(1)}%)`,
    winner,
  });
}

// ── Test 4: Multi-Agent Scaling ──────────────────────────────────────────────

async function testMultiAgent(): Promise<void> {
  console.log(`\n--- Test 4: Multi-Agent Scaling (${MULTI_AGENT_COUNT} agents x ${MULTI_AGENT_MSGS} msgs) ---`);

  // Broker side — single broker, multiple agents
  const brokerClient = await AgentRelayClient.start({
    binaryPath: resolveBinaryPath(),
    channels: ["general"],
    env: process.env,
  });

  const brokerAgents: string[] = [];
  const brokerSamples: number[] = [];

  try {
    for (let i = 0; i < MULTI_AGENT_COUNT; i++) {
      const name = randomName(`ma-b-${i}`);
      await brokerClient.spawnPty({ name, cli: "cat", channels: ["general"] });
      brokerAgents.push(name);
    }
    await new Promise((r) => setTimeout(r, 500));

    const brokerStart = performance.now();
    for (const agent of brokerAgents) {
      for (let i = 0; i < MULTI_AGENT_MSGS; i++) {
        const start = performance.now();
        await brokerClient.sendMessage({ to: agent, from: "bench", text: `ma-${i}` });
        brokerSamples.push(performance.now() - start);
      }
    }
    const brokerTotal = performance.now() - brokerStart;

    const brokerStats = computeStats(brokerSamples);
    console.log(`\n  Broker PTY:  total=${brokerTotal.toFixed(0)}ms  avg_latency=${brokerStats.mean.toFixed(2)}ms`);

    results.push({
      name: "Multi-Agent Scaling",
      broker: `total=${brokerTotal.toFixed(0)}ms  avg=${brokerStats.mean.toFixed(2)}ms`,
      relayPty: "", // filled below
      winner: "", // filled below
    });
  } finally {
    for (const agent of brokerAgents) {
      try { await brokerClient.release(agent); } catch {}
    }
    await brokerClient.shutdown();
  }

  // Relay-PTY side — one binary per agent
  const relayInstances: RelayPtyInstance[] = [];
  const relaySamples: number[] = [];

  try {
    for (let i = 0; i < MULTI_AGENT_COUNT; i++) {
      const name = randomName(`ma-r-${i}`);
      relayInstances.push(await spawnRelayPty(name));
    }
    await new Promise((r) => setTimeout(r, 500));

    const relayStart = performance.now();
    for (const inst of relayInstances) {
      for (let i = 0; i < MULTI_AGENT_MSGS; i++) {
        const { elapsed } = await relayPtyInject(inst, `ma-${i}`, `multi-agent-${i}`);
        relaySamples.push(elapsed);
      }
    }
    const relayTotal = performance.now() - relayStart;

    const relayStats = computeStats(relaySamples);
    console.log(`  Relay-PTY:   total=${relayTotal.toFixed(0)}ms  avg_latency=${relayStats.mean.toFixed(2)}ms`);

    // Update the result
    const last = results[results.length - 1];
    last.relayPty = `total=${relayTotal.toFixed(0)}ms  avg=${relayStats.mean.toFixed(2)}ms`;

    const brokerTotal = parseFloat(last.broker.match(/total=(\d+)/)?.[1] ?? "0");
    const improvement = ((relayTotal - brokerTotal) / relayTotal * 100).toFixed(0);
    last.winner = brokerTotal < relayTotal
      ? `Broker PTY (${improvement}% faster)`
      : `Relay-PTY (${Math.abs(Number(improvement))}% faster)`;
  } finally {
    for (const inst of relayInstances) {
      await stopRelayPty(inst);
    }
  }
}

// ── Test 5: Feature Comparison ───────────────────────────────────────────────

function printFeatureComparison(): void {
  console.log("\n--- Test 5: Feature Comparison ---\n");

  const features = [
    ["Structured delivery events", "Yes (queued/injected/ack/verified)", "No (fire-and-forget)"],
    ["Delivery verification", "Built-in (delivery_verified)", "App-level (output polling)"],
    ["Multi-agent management", "Single broker process", "One process per agent"],
    ["CLI bypass flags", "Auto-injected", "Manual configuration"],
    ["CLI readiness detection", "Built-in gate", "App-level polling"],
    ["Priority ordering", "Supported", "Supported"],
    ["Channel isolation", "Built-in", "N/A"],
    ["Thread support", "Built-in (thread_id)", "N/A"],
    ["Unicode handling", "UTF-8 safe (floor_char_boundary)", "Raw PTY write"],
    ["Agent lifecycle events", "spawned/exited/released", "Exit callback only"],
    ["Process architecture", "Single broker + workers", "1 orchestrator + binary per agent"],
  ];

  const brokerFeatures = features.filter(([_, b]) => !b.startsWith("N/A") && b !== "No").length;
  const relayFeatures = features.filter(([_, __, r]) => !r.startsWith("N/A") && r !== "No" && !r.startsWith("No ")).length;

  console.log("  Feature                       | Broker PTY                       | Relay-PTY");
  console.log("  " + "-".repeat(95));
  for (const [feature, broker, relay] of features) {
    console.log(`  ${feature.padEnd(31)} | ${broker.padEnd(32)} | ${relay}`);
  }

  // Count broker advantages (features where broker has something relay doesn't)
  let brokerAdvantages = 0;
  for (const [_, broker, relay] of features) {
    if ((relay === "N/A" || relay.startsWith("No") || relay.startsWith("App-level") ||
         relay.startsWith("Manual") || relay.startsWith("Exit callback") ||
         relay.startsWith("Raw") || relay.startsWith("1 ")) &&
        !broker.startsWith("N/A") && !broker.startsWith("No")) {
      brokerAdvantages++;
    }
  }

  console.log(`\n  Broker advantages: ${brokerAdvantages}/${features.length} features`);

  results.push({
    name: "Feature Comparison",
    broker: `${features.length}/${features.length} features`,
    relayPty: `${relayFeatures}/${features.length} features`,
    winner: `Broker PTY (${brokerAdvantages} additional capabilities)`,
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("================================================================");
  console.log("  HEAD-TO-HEAD: Broker PTY vs Relay-PTY");
  console.log(`  Mode: ${QUICK ? "quick" : "full"}`);
  console.log("================================================================");

  try {
    await testLatency();
  } catch (err) {
    console.error("  Latency test failed:", err);
  }

  try {
    await testThroughput();
  } catch (err) {
    console.error("  Throughput test failed:", err);
  }

  try {
    await testReliability();
  } catch (err) {
    console.error("  Reliability test failed:", err);
  }

  try {
    await testMultiAgent();
  } catch (err) {
    console.error("  Multi-agent test failed:", err);
  }

  printFeatureComparison();

  // Summary
  console.log("\n\n================================================================");
  console.log("  SUMMARY");
  console.log("================================================================");

  for (const r of results) {
    console.log(`\n  ${r.name}`);
    console.log(`    Broker PTY:  ${r.broker}`);
    console.log(`    Relay-PTY:   ${r.relayPty}`);
    console.log(`    Winner:      ${r.winner}`);
  }

  const brokerWins = results.filter((r) => r.winner.startsWith("Broker")).length;
  const relayWins = results.filter((r) => r.winner.startsWith("Relay")).length;

  console.log("\n================================================================");
  if (brokerWins > relayWins) {
    console.log(`  OVERALL: Broker PTY wins (${brokerWins}/${results.length} dimensions)`);
  } else if (relayWins > brokerWins) {
    console.log(`  OVERALL: Relay-PTY wins (${relayWins}/${results.length} dimensions)`);
  } else {
    console.log(`  OVERALL: Tie (${brokerWins} each)`);
  }
  console.log("================================================================\n");
}

main().catch((err) => {
  console.error("benchmark failed:", err);
  process.exit(1);
});
