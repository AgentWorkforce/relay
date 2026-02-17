/**
 * Unit tests — no broker binary or RELAY_API_KEY required.
 *
 * Run:
 *   npm run build && node --test dist/__tests__/unit.test.js
 */
import assert from "node:assert/strict";
import { join, sep } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";

import { AgentRelay, type Agent } from "../relay.js";
import { getLogs, listLoggedAgents } from "../logs.js";

// ── waitForAny ──────────────────────────────────────────────────────────────

function makeFakeAgent(
  name: string,
  exitAfterMs?: number,
): Agent {
  let resolveExit: ((reason: "exited" | "released") => void) | undefined;
  const exitPromise = new Promise<"exited" | "released">((resolve) => {
    resolveExit = resolve;
  });

  if (exitAfterMs !== undefined) {
    setTimeout(() => resolveExit?.("exited"), exitAfterMs);
  }

  return {
    name,
    runtime: "pty",
    channels: ["general"],
    exitCode: undefined,
    exitSignal: undefined,
    async release() {
      resolveExit?.("released");
    },
    waitForExit(timeoutMs?: number) {
      if (timeoutMs === 0) return Promise.resolve("timeout" as const);
      if (timeoutMs !== undefined) {
        return Promise.race([
          exitPromise,
          new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), timeoutMs),
          ),
        ]);
      }
      return exitPromise;
    },
    async sendMessage() {
      return { eventId: "fake", from: name, to: "", text: "" };
    },
  };
}

test("waitForAny: returns first agent to exit", async () => {
  const fast = makeFakeAgent("fast", 50);
  const slow = makeFakeAgent("slow", 5_000);

  const { agent, result } = await AgentRelay.waitForAny([fast, slow], 3_000);
  assert.equal(agent.name, "fast");
  assert.equal(result, "exited");
});

test("waitForAny: returns timeout when no agent exits", async () => {
  const a = makeFakeAgent("a");
  const b = makeFakeAgent("b");

  const { result } = await AgentRelay.waitForAny([a, b], 100);
  assert.equal(result, "timeout");
});

test("waitForAny: handles released agent", async () => {
  const agent = makeFakeAgent("releasable");

  // Release after 50ms
  setTimeout(() => agent.release(), 50);

  const { agent: resolved, result } = await AgentRelay.waitForAny([agent], 3_000);
  assert.equal(resolved.name, "releasable");
  assert.equal(result, "released");
});

test("waitForAny: handles empty agents array", async () => {
  const { result } = await AgentRelay.waitForAny([]);
  assert.equal(result, "timeout");
});

// ── getLogs ──────────────────────────────────────────────────────────────────

test("getLogs: rejects path traversal", async () => {
  const result = await getLogs("../../etc/passwd", {
    logsDir: "/tmp/test-logs",
  });
  assert.equal(result.found, false);
  assert.equal(result.content, "");
});

test("getLogs: returns not found for missing agent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-test-logs-"));

  try {
    const result = await getLogs("nonexistent", { logsDir: dir });
    assert.equal(result.found, false);
    assert.equal(result.content, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getLogs: reads content from log file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-test-logs-"));

  try {
    const logContent = "line1\nline2\nline3\n";
    await writeFile(join(dir, "TestAgent.log"), logContent);

    const result = await getLogs("TestAgent", { logsDir: dir, lines: 2 });
    assert.equal(result.found, true);
    assert.equal(result.content, "line2\nline3");
    assert.equal(result.lineCount, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listLoggedAgents: lists agent names from log files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-test-logs-"));

  try {
    await writeFile(join(dir, "Alice.log"), "hello\n");
    await writeFile(join(dir, "Bob.log"), "world\n");
    await writeFile(join(dir, "not-a-log.txt"), "skip\n");

    const agents = await listLoggedAgents(dir);
    assert.ok(agents.includes("Alice"));
    assert.ok(agents.includes("Bob"));
    assert.ok(!agents.includes("not-a-log"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listLoggedAgents: returns empty for missing directory", async () => {
  const agents = await listLoggedAgents("/tmp/definitely-nonexistent-dir");
  assert.deepEqual(agents, []);
});

