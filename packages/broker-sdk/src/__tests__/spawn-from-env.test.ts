/**
 * Unit tests for spawn-from-env module.
 * Tests env parsing, policy resolution, and bypass flag mapping.
 * No broker binary or RELAY_API_KEY required.
 *
 * Run:
 *   npm run build && node --test dist/__tests__/spawn-from-env.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseSpawnEnv, resolveSpawnPolicy } from "../spawn-from-env.js";
import type { SpawnEnvInput } from "../spawn-from-env.js";

// ── Helper ─────────────────────────────────────────────────────────────────

function makeEnv(overrides: Partial<SpawnEnvInput> = {}): SpawnEnvInput {
  return {
    AGENT_NAME: "test-agent",
    AGENT_CLI: "claude",
    RELAY_API_KEY: "rk_live_test_123",
    ...overrides,
  };
}

// ── parseSpawnEnv ──────────────────────────────────────────────────────────

test("parseSpawnEnv: returns parsed input from valid env", () => {
  const result = parseSpawnEnv({
    AGENT_NAME: "worker-1",
    AGENT_CLI: "codex",
    RELAY_API_KEY: "rk_live_abc",
    AGENT_TASK: "fix bugs",
  });

  assert.equal(result.AGENT_NAME, "worker-1");
  assert.equal(result.AGENT_CLI, "codex");
  assert.equal(result.RELAY_API_KEY, "rk_live_abc");
  assert.equal(result.AGENT_TASK, "fix bugs");
});

test("parseSpawnEnv: throws on missing AGENT_NAME", () => {
  assert.throws(
    () => parseSpawnEnv({ AGENT_CLI: "claude", RELAY_API_KEY: "rk_live_abc" }),
    /AGENT_NAME/,
  );
});

test("parseSpawnEnv: throws on missing AGENT_CLI", () => {
  assert.throws(
    () => parseSpawnEnv({ AGENT_NAME: "test", RELAY_API_KEY: "rk_live_abc" }),
    /AGENT_CLI/,
  );
});

test("parseSpawnEnv: throws on missing RELAY_API_KEY", () => {
  assert.throws(
    () => parseSpawnEnv({ AGENT_NAME: "test", AGENT_CLI: "claude" }),
    /RELAY_API_KEY/,
  );
});

test("parseSpawnEnv: lists all missing keys in error", () => {
  assert.throws(() => parseSpawnEnv({}), /AGENT_NAME.*AGENT_CLI.*RELAY_API_KEY/);
});

test("parseSpawnEnv: optional fields are undefined when absent", () => {
  const result = parseSpawnEnv({
    AGENT_NAME: "a",
    AGENT_CLI: "claude",
    RELAY_API_KEY: "rk_live_x",
  });

  assert.equal(result.AGENT_TASK, undefined);
  assert.equal(result.AGENT_ARGS, undefined);
  assert.equal(result.AGENT_CWD, undefined);
  assert.equal(result.AGENT_CHANNELS, undefined);
  assert.equal(result.AGENT_MODEL, undefined);
  assert.equal(result.AGENT_DISABLE_DEFAULT_BYPASS, undefined);
});

test("parseSpawnEnv: parses all optional fields", () => {
  const result = parseSpawnEnv({
    AGENT_NAME: "a",
    AGENT_CLI: "claude",
    RELAY_API_KEY: "rk_live_x",
    AGENT_TASK: "do stuff",
    AGENT_ARGS: '["--model","opus"]',
    AGENT_CWD: "/workspace",
    AGENT_CHANNELS: "general,dev",
    AGENT_MODEL: "opus",
    RELAY_BASE_URL: "https://api.relaycast.dev",
    BROKER_BINARY_PATH: "/usr/local/bin/agent-relay-broker",
    AGENT_DISABLE_DEFAULT_BYPASS: "1",
  });

  assert.equal(result.AGENT_TASK, "do stuff");
  assert.equal(result.AGENT_ARGS, '["--model","opus"]');
  assert.equal(result.AGENT_CWD, "/workspace");
  assert.equal(result.AGENT_CHANNELS, "general,dev");
  assert.equal(result.AGENT_MODEL, "opus");
  assert.equal(result.RELAY_BASE_URL, "https://api.relaycast.dev");
  assert.equal(result.BROKER_BINARY_PATH, "/usr/local/bin/agent-relay-broker");
  assert.equal(result.AGENT_DISABLE_DEFAULT_BYPASS, "1");
});

// ── resolveSpawnPolicy: bypass flags ───────────────────────────────────────

test("resolveSpawnPolicy: applies --dangerously-skip-permissions for claude", () => {
  const result = resolveSpawnPolicy(makeEnv({ AGENT_CLI: "claude" }));
  assert.ok(result.args.includes("--dangerously-skip-permissions"));
  assert.equal(result.bypassApplied, true);
});

test("resolveSpawnPolicy: applies --dangerously-skip-permissions for claude:opus", () => {
  const result = resolveSpawnPolicy(makeEnv({ AGENT_CLI: "claude:opus" }));
  assert.ok(result.args.includes("--dangerously-skip-permissions"));
  assert.equal(result.bypassApplied, true);
});

test("resolveSpawnPolicy: applies --full-auto for codex", () => {
  const result = resolveSpawnPolicy(makeEnv({ AGENT_CLI: "codex" }));
  assert.ok(result.args.includes("--full-auto"));
  assert.equal(result.bypassApplied, true);
});

test("resolveSpawnPolicy: no bypass for gemini", () => {
  const result = resolveSpawnPolicy(makeEnv({ AGENT_CLI: "gemini" }));
  assert.equal(result.args.length, 0);
  assert.equal(result.bypassApplied, false);
});

test("resolveSpawnPolicy: no bypass for unknown CLI", () => {
  const result = resolveSpawnPolicy(makeEnv({ AGENT_CLI: "aider" }));
  assert.equal(result.args.length, 0);
  assert.equal(result.bypassApplied, false);
});

// ── resolveSpawnPolicy: bypass opt-out ─────────────────────────────────────

test("resolveSpawnPolicy: disables bypass when AGENT_DISABLE_DEFAULT_BYPASS=1", () => {
  const result = resolveSpawnPolicy(
    makeEnv({ AGENT_CLI: "claude", AGENT_DISABLE_DEFAULT_BYPASS: "1" }),
  );
  assert.ok(!result.args.includes("--dangerously-skip-permissions"));
  assert.equal(result.bypassApplied, false);
});

test("resolveSpawnPolicy: does not disable bypass when AGENT_DISABLE_DEFAULT_BYPASS is not 1", () => {
  const result = resolveSpawnPolicy(
    makeEnv({ AGENT_CLI: "claude", AGENT_DISABLE_DEFAULT_BYPASS: "0" }),
  );
  assert.ok(result.args.includes("--dangerously-skip-permissions"));
  assert.equal(result.bypassApplied, true);
});

// ── resolveSpawnPolicy: duplicate flag suppression ─────────────────────────

test("resolveSpawnPolicy: does not duplicate bypass flag if already in AGENT_ARGS", () => {
  const result = resolveSpawnPolicy(
    makeEnv({
      AGENT_CLI: "claude",
      AGENT_ARGS: '["--dangerously-skip-permissions"]',
    }),
  );
  const count = result.args.filter(
    (a) => a === "--dangerously-skip-permissions",
  ).length;
  assert.equal(count, 1, "bypass flag should appear exactly once");
  assert.equal(result.bypassApplied, false, "bypassApplied should be false when already present");
});

test("resolveSpawnPolicy: does not duplicate --full-auto if already in AGENT_ARGS", () => {
  const result = resolveSpawnPolicy(
    makeEnv({ AGENT_CLI: "codex", AGENT_ARGS: '["--full-auto"]' }),
  );
  const count = result.args.filter((a) => a === "--full-auto").length;
  assert.equal(count, 1);
  assert.equal(result.bypassApplied, false);
});

// ── resolveSpawnPolicy: AGENT_ARGS parsing ─────────────────────────────────

test("resolveSpawnPolicy: parses JSON array args", () => {
  const result = resolveSpawnPolicy(
    makeEnv({ AGENT_CLI: "gemini", AGENT_ARGS: '["--reasoning","high","--verbose"]' }),
  );
  assert.deepEqual(result.args, ["--reasoning", "high", "--verbose"]);
});

test("resolveSpawnPolicy: falls back to space-delimited args", () => {
  const result = resolveSpawnPolicy(
    makeEnv({ AGENT_CLI: "gemini", AGENT_ARGS: "--reasoning high --verbose" }),
  );
  assert.deepEqual(result.args, ["--reasoning", "high", "--verbose"]);
});

test("resolveSpawnPolicy: handles invalid JSON gracefully (falls back to split)", () => {
  const result = resolveSpawnPolicy(
    makeEnv({ AGENT_CLI: "gemini", AGENT_ARGS: "[invalid json" }),
  );
  assert.deepEqual(result.args, ["[invalid", "json"]);
});

test("resolveSpawnPolicy: empty AGENT_ARGS produces no extra args", () => {
  const result = resolveSpawnPolicy(makeEnv({ AGENT_CLI: "gemini" }));
  assert.deepEqual(result.args, []);
});

// ── resolveSpawnPolicy: channels ───────────────────────────────────────────

test("resolveSpawnPolicy: defaults channels to [general]", () => {
  const result = resolveSpawnPolicy(makeEnv());
  assert.deepEqual(result.channels, ["general"]);
});

test("resolveSpawnPolicy: parses comma-separated channels", () => {
  const result = resolveSpawnPolicy(
    makeEnv({ AGENT_CHANNELS: "general, dev-team, alerts" }),
  );
  assert.deepEqual(result.channels, ["general", "dev-team", "alerts"]);
});

test("resolveSpawnPolicy: filters empty channel names", () => {
  const result = resolveSpawnPolicy(
    makeEnv({ AGENT_CHANNELS: "general,,dev," }),
  );
  assert.deepEqual(result.channels, ["general", "dev"]);
});

// ── resolveSpawnPolicy: other fields ───────────────────────────────────────

test("resolveSpawnPolicy: passes through task, cwd, model", () => {
  const result = resolveSpawnPolicy(
    makeEnv({
      AGENT_TASK: "fix the auth bug",
      AGENT_CWD: "/workspace/repo",
      AGENT_MODEL: "opus",
    }),
  );
  assert.equal(result.task, "fix the auth bug");
  assert.equal(result.cwd, "/workspace/repo");
  assert.equal(result.model, "opus");
});

test("resolveSpawnPolicy: name and cli come from input", () => {
  const result = resolveSpawnPolicy(
    makeEnv({ AGENT_NAME: "my-worker", AGENT_CLI: "codex" }),
  );
  assert.equal(result.name, "my-worker");
  assert.equal(result.cli, "codex");
});

// ── resolveSpawnPolicy: combined scenario ──────────────────────────────────

test("resolveSpawnPolicy: full scenario with args + bypass + channels", () => {
  const result = resolveSpawnPolicy(
    makeEnv({
      AGENT_NAME: "worker-1",
      AGENT_CLI: "claude",
      AGENT_ARGS: '["--model","opus"]',
      AGENT_CHANNELS: "general,dev",
      AGENT_TASK: "implement feature X",
      AGENT_CWD: "/repos/project",
      AGENT_MODEL: "opus",
    }),
  );

  assert.equal(result.name, "worker-1");
  assert.equal(result.cli, "claude");
  assert.deepEqual(result.channels, ["general", "dev"]);
  assert.equal(result.task, "implement feature X");
  assert.equal(result.cwd, "/repos/project");
  assert.equal(result.model, "opus");
  // --model opus from AGENT_ARGS + bypass flag appended
  assert.deepEqual(result.args, [
    "--model",
    "opus",
    "--dangerously-skip-permissions",
  ]);
  assert.equal(result.bypassApplied, true);
});
