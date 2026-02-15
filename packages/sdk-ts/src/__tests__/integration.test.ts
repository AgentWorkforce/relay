import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { AgentRelayClient, AgentRelayProcessError } from "../client.js";

function resolveBinaryPath(): string {
  if (process.env.AGENT_RELAY_BIN) {
    return process.env.AGENT_RELAY_BIN;
  }
  return path.resolve(process.cwd(), "../../target/debug/agent-relay");
}

function resolveBundledBinaryPath(): string {
  const exe = process.platform === "win32" ? "agent-relay.exe" : "agent-relay";
  return path.resolve(process.cwd(), "bin", exe);
}

function requireRelaycast(t: TestContext): boolean {
  const relayKey = process.env.RELAY_API_KEY?.trim();
  if (!relayKey) {
    t.skip("RELAY_API_KEY is required for broker integration tests");
    return false;
  }
  return true;
}

test("sdk can use bundled binary by default", async (t) => {
  if (!requireRelaycast(t)) {
    return;
  }
  const bundledBinary = resolveBundledBinaryPath();
  if (!fs.existsSync(bundledBinary)) {
    t.skip(`bundled binary not found at ${bundledBinary}`);
    return;
  }

  const client = await AgentRelayClient.start({
    env: process.env,
  });

  try {
    const agents = await client.listAgents();
    assert.ok(Array.isArray(agents), "listAgents should return an array");
  } finally {
    await client.shutdown();
  }
});

test("sdk can start broker and manage agent lifecycle", async (t) => {
  if (!requireRelaycast(t)) {
    return;
  }
  const binaryPath = resolveBinaryPath();
  if (!fs.existsSync(binaryPath)) {
    t.skip(`agent-relay binary not found at ${binaryPath}`);
    return;
  }

  const client = await AgentRelayClient.start({
    binaryPath,
    requestTimeoutMs: 8_000,
    shutdownTimeoutMs: 2_000,
    env: process.env,
  });

  const spawnedName = `sdk-test-${Date.now().toString(36)}`;
  const seenEvents: string[] = [];
  const unsub = client.onEvent((event) => {
    seenEvents.push(event.kind);
  });

  try {
    const spawned = await client.spawnPty({
      name: spawnedName,
      cli: "cat",
      channels: ["general"],
    });
    assert.equal(spawned.name, spawnedName);
    assert.equal(spawned.runtime, "pty");

    const agentsAfterSpawn = await client.listAgents();
    const spawnedAgent = agentsAfterSpawn.find((agent) => agent.name === spawnedName);
    assert.ok(spawnedAgent, "spawned agent should be present in listAgents()");
    assert.equal(spawnedAgent?.runtime, "pty");

    const released = await client.release(spawnedName);
    assert.equal(released.name, spawnedName);

    const agentsAfterRelease = await client.listAgents();
    assert.equal(
      agentsAfterRelease.some((agent) => agent.name === spawnedName),
      false,
      "released agent should not be present in listAgents()",
    );

    assert.ok(seenEvents.includes("agent_spawned"), "expected agent_spawned event");
    assert.ok(seenEvents.includes("agent_released"), "expected agent_released event");
  } finally {
    unsub();
    await client.shutdown();
  }
});

test("sdk can spawn and release headless claude worker", async (t) => {
  if (!requireRelaycast(t)) {
    return;
  }
  const binaryPath = resolveBinaryPath();
  if (!fs.existsSync(binaryPath)) {
    t.skip(`agent-relay binary not found at ${binaryPath}`);
    return;
  }

  const client = await AgentRelayClient.start({
    binaryPath,
    requestTimeoutMs: 8_000,
    shutdownTimeoutMs: 2_000,
    env: process.env,
  });

  const spawnedName = `sdk-headless-${Date.now().toString(36)}`;
  const seenEvents: string[] = [];
  const unsub = client.onEvent((event) => {
    seenEvents.push(event.kind);
  });

  try {
    const spawned = await client.spawnHeadlessClaude({
      name: spawnedName,
      channels: ["general"],
    });
    assert.equal(spawned.name, spawnedName);
    assert.equal(spawned.runtime, "headless_claude");

    const agentsAfterSpawn = await client.listAgents();
    const spawnedAgent = agentsAfterSpawn.find((agent) => agent.name === spawnedName);
    assert.ok(spawnedAgent, "spawned headless agent should be present in listAgents()");
    assert.equal(spawnedAgent?.runtime, "headless_claude");

    const released = await client.release(spawnedName);
    assert.equal(released.name, spawnedName);

    const agentsAfterRelease = await client.listAgents();
    assert.equal(
      agentsAfterRelease.some((agent) => agent.name === spawnedName),
      false,
      "released headless agent should not be present in listAgents()",
    );

    assert.ok(seenEvents.includes("agent_spawned"), "expected agent_spawned event");
    assert.ok(seenEvents.includes("agent_released"), "expected agent_released event");
  } finally {
    unsub();
    await client.shutdown();
  }
});

test("sdk surfaces process error when binary is missing", async () => {
  await assert.rejects(
    AgentRelayClient.start({
      binaryPath: "/definitely/missing/agent-relay",
      requestTimeoutMs: 1_000,
    }),
    (error: unknown) => {
      return error instanceof AgentRelayProcessError || error instanceof Error;
    },
  );
});
