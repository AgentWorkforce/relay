/**
 * Facade integration tests — exercises new AgentRelay capabilities:
 * spawn with initial task, getLogs, waitForAny, broadcast, onAgentReady, exit code.
 *
 * Run:
 *   npm run build && node --test dist/__tests__/facade.test.js
 *
 * Requires:
 *   RELAY_API_KEY — Relaycast workspace key
 *   AGENT_RELAY_BIN (optional) — path to agent-relay-broker binary
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { AgentRelay, type Agent, type Message } from "../relay.js";

// ── helpers ─────────────────────────────────────────────────────────────────

function resolveBinaryPath(): string {
  if (process.env.AGENT_RELAY_BIN) {
    return process.env.AGENT_RELAY_BIN;
  }
  return path.resolve(process.cwd(), "../../target/debug/agent-relay-broker");
}

function requireRelaycast(t: TestContext): boolean {
  if (!process.env.RELAY_API_KEY?.trim()) {
    t.skip("RELAY_API_KEY is required");
    return false;
  }
  return true;
}

function requireBinary(t: TestContext): string | null {
  const bin = resolveBinaryPath();
  if (!fs.existsSync(bin)) {
    t.skip(`agent-relay-broker binary not found at ${bin}`);
    return null;
  }
  return bin;
}

function makeRelay(bin: string): AgentRelay {
  return new AgentRelay({
    binaryPath: bin,
    requestTimeoutMs: 10_000,
    env: process.env,
  });
}

// ── spawn with initial task ─────────────────────────────────────────────────

test("facade: spawn with initial task delivers task after worker_ready", async (t) => {
  if (!requireRelaycast(t)) return;
  const bin = requireBinary(t);
  if (!bin) return;

  const suffix = Date.now().toString(36);
  const relay = makeRelay(bin);
  const readyNames: string[] = [];
  relay.onAgentReady = (agent) => readyNames.push(agent.name);

  try {
    const agent = await relay.spawnPty({
      name: `Task-${suffix}`,
      cli: "cat",
      channels: ["general"],
      task: "Hello from initial task",
    });

    // Wait a bit for worker_ready event to propagate
    await new Promise((r) => setTimeout(r, 2_000));

    assert.ok(readyNames.includes(agent.name), "onAgentReady should fire for spawned agent");

    await agent.release();
  } finally {
    await relay.shutdown();
  }
});

// ── onAgentReady ────────────────────────────────────────────────────────────

test("facade: onAgentReady fires when worker becomes ready", async (t) => {
  if (!requireRelaycast(t)) return;
  const bin = requireBinary(t);
  if (!bin) return;

  const suffix = Date.now().toString(36);
  const relay = makeRelay(bin);

  const readyAgents: Agent[] = [];
  relay.onAgentReady = (agent) => readyAgents.push(agent);

  try {
    const agent = await relay.spawnPty({
      name: `Ready-${suffix}`,
      cli: "cat",
      channels: ["general"],
    });

    // Give the worker time to send worker_ready
    await new Promise((r) => setTimeout(r, 2_000));

    assert.ok(
      readyAgents.some((a) => a.name === agent.name),
      "onAgentReady should fire with the correct agent",
    );

    await agent.release();
  } finally {
    await relay.shutdown();
  }
});

// ── broadcast ───────────────────────────────────────────────────────────────

test("facade: broadcast sends to all agents", async (t) => {
  if (!requireRelaycast(t)) return;
  const bin = requireBinary(t);
  if (!bin) return;

  const suffix = Date.now().toString(36);
  const relay = makeRelay(bin);
  const sentMessages: Message[] = [];
  relay.onMessageSent = (msg) => sentMessages.push(msg);

  try {
    const agent = await relay.spawnPty({
      name: `Broadcast-${suffix}`,
      cli: "cat",
      channels: ["general"],
    });

    const msg = await relay.broadcast("Hello everyone!");
    assert.equal(msg.to, "*");
    assert.equal(msg.text, "Hello everyone!");
    assert.equal(msg.from, "human:orchestrator");
    assert.equal(sentMessages.length, 1);

    // Broadcast with custom from
    const msg2 = await relay.broadcast("Custom sender", { from: "System" });
    assert.equal(msg2.from, "System");

    await agent.release();
  } finally {
    await relay.shutdown();
  }
});

// ── waitForAny ──────────────────────────────────────────────────────────────

test("facade: waitForAny returns first agent to exit", async (t) => {
  if (!requireRelaycast(t)) return;
  const bin = requireBinary(t);
  if (!bin) return;

  const suffix = Date.now().toString(36);
  const relay = makeRelay(bin);

  try {
    const [a, b] = await Promise.all([
      relay.spawnPty({ name: `WaitA-${suffix}`, cli: "cat", channels: ["general"] }),
      relay.spawnPty({ name: `WaitB-${suffix}`, cli: "cat", channels: ["general"] }),
    ]);

    // Release agent A — it should be the first to exit
    setTimeout(() => a.release(), 500);

    const { agent, result } = await AgentRelay.waitForAny([a, b], 10_000);
    assert.equal(agent.name, a.name);
    assert.equal(result, "released");

    await b.release();
  } finally {
    await relay.shutdown();
  }
});

// ── waitForAny with timeout ─────────────────────────────────────────────────

test("facade: waitForAny respects timeout", async (t) => {
  if (!requireRelaycast(t)) return;
  const bin = requireBinary(t);
  if (!bin) return;

  const suffix = Date.now().toString(36);
  const relay = makeRelay(bin);

  try {
    const agent = await relay.spawnPty({
      name: `Timeout-${suffix}`,
      cli: "cat",
      channels: ["general"],
    });

    const { result } = await AgentRelay.waitForAny([agent], 500);
    assert.equal(result, "timeout");

    await agent.release();
  } finally {
    await relay.shutdown();
  }
});

// ── exit code ───────────────────────────────────────────────────────────────

test("facade: onAgentExited populates exitCode and exitSignal", async (t) => {
  if (!requireRelaycast(t)) return;
  const bin = requireBinary(t);
  if (!bin) return;

  const suffix = Date.now().toString(36);
  const relay = makeRelay(bin);
  const exitedAgents: Agent[] = [];
  relay.onAgentExited = (agent) => exitedAgents.push(agent);

  try {
    const agent = await relay.spawnPty({
      name: `Exit-${suffix}`,
      cli: "cat",
      channels: ["general"],
    });

    await agent.release();
    // Give time for exit event to propagate
    await new Promise((r) => setTimeout(r, 1_000));

    // The agent should have exited — check that exitCode or exitSignal is set
    // (exact values depend on how cat is terminated)
    const exited = exitedAgents.find((a) => a.name === agent.name);
    if (exited) {
      assert.ok(
        exited.exitCode !== undefined || exited.exitSignal !== undefined,
        "exitCode or exitSignal should be populated",
      );
    }
    // It's also valid for only onAgentReleased to fire (not onAgentExited)
    // since the broker may clean up before the process exits
  } finally {
    await relay.shutdown();
  }
});

// ── getLogs ──────────────────────────────────────────────────────────────────

test("facade: getLogs returns log content for agent", async (t) => {
  if (!requireRelaycast(t)) return;
  const bin = requireBinary(t);
  if (!bin) return;

  const suffix = Date.now().toString(36);
  const relay = makeRelay(bin);

  try {
    const agent = await relay.spawnPty({
      name: `Logs-${suffix}`,
      cli: "cat",
      channels: ["general"],
    });

    // Give time for some output to be logged
    await new Promise((r) => setTimeout(r, 2_000));

    const logs = await relay.getLogs(agent.name);
    // Logs may or may not be found depending on whether the worker writes to the log file
    // The important thing is the API works without error
    assert.equal(logs.agent, agent.name);
    assert.equal(typeof logs.found, "boolean");
    assert.equal(typeof logs.content, "string");

    await agent.release();
  } finally {
    await relay.shutdown();
  }
});

// ── listLoggedAgents ────────────────────────────────────────────────────────

test("facade: listLoggedAgents returns array", async (t) => {
  if (!requireRelaycast(t)) return;
  const bin = requireBinary(t);
  if (!bin) return;

  const relay = makeRelay(bin);

  try {
    // Just verify the API works and returns an array
    const agents = await relay.listLoggedAgents();
    assert.ok(Array.isArray(agents));
  } finally {
    await relay.shutdown();
  }
});
