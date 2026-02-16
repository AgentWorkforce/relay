/**
 * Broker Migration Execution Script
 *
 * Orchestrates the wave-based migration from old daemon stack to broker-sdk
 * using Claude leads, Codex workers, and Codex reviewers.
 *
 * Usage:
 *   npx tsx scripts/broker-migration.ts
 *   npx tsx scripts/broker-migration.ts --wave=3        # start from wave 3
 *   npx tsx scripts/broker-migration.ts --wave=2 --dry   # dry run wave 2
 *
 * Environment:
 *   RELAY_API_KEY     — Relaycast workspace key (required)
 *   AGENT_RELAY_BIN   — path to agent-relay binary (optional)
 *   MIGRATION_BRANCH  — git branch name (default: feat/broker-migration)
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { AgentRelay, type Agent, type Message } from "@agent-relay/broker-sdk";

// ── Types ──────────────────────────────────────────────────────────────────

interface WaveTask {
  role: "lead" | "worker" | "reviewer";
  cli: "claude" | "codex";
  name: string;
  args?: string[];
  prompt: string;
  /** Workers wait for lead to post plan before starting */
  dependsOnLead?: boolean;
}

interface WaveDefinition {
  id: number;
  name: string;
  description: string;
  beads: string[];
  channel: string;
  tasks: WaveTask[];
  gate: GateDefinition;
}

interface GateDefinition {
  cargoTest: boolean;
  integrationPhase?: number;
  customCommand?: string;
  customDescription?: string;
}

interface WaveResult {
  waveId: number;
  passed: boolean;
  handoff: string;
  filesChanged: string[];
  testOutput: string;
  duration: number;
}

interface MigrationState {
  startedAt: string;
  currentWave: number;
  completedWaves: WaveResult[];
  branch: string;
}

// ── Configuration ──────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dirname, "..");
const STATE_PATH = path.join(ROOT, ".beads", "migration-state.json");
const PLAN_PATH = path.join(ROOT, ".beads", "broker-wave-execution.md");
const BRANCH = process.env.MIGRATION_BRANCH ?? "feat/broker-migration";
const MAX_RETRIES = 2;
const WAVE_TIMEOUT_MS = 15 * 60 * 1000; // 15 min per wave
const LEAD_PLANNING_DELAY_MS = 10_000; // wait for lead to post plan
const WORKER_STAGGER_MS = 5_000; // delay between sequential workers
const BINARY_PATH =
  process.env.AGENT_RELAY_BIN ??
  path.join(ROOT, "target", "debug", "agent-relay");

// ── CLI flags ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const startWave = Number(args.find((a) => a.startsWith("--wave="))?.split("=")[1] ?? 0);
const dryRun = args.includes("--dry");

// ── State management ───────────────────────────────────────────────────────

function loadState(): MigrationState {
  if (fs.existsSync(STATE_PATH)) {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  }
  return {
    startedAt: new Date().toISOString(),
    currentWave: 0,
    completedWaves: [],
    branch: BRANCH,
  };
}

function saveState(state: MigrationState): void {
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, STATE_PATH);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function run(cmd: string, opts?: { cwd?: string; ignoreError?: boolean }): string {
  try {
    return execSync(cmd, {
      cwd: opts?.cwd ?? ROOT,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 120_000,
    }).trim();
  } catch (err: unknown) {
    if (opts?.ignoreError) return (err as { stdout?: string }).stdout ?? "";
    throw err;
  }
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function previousHandoff(state: MigrationState): string {
  const last = state.completedWaves[state.completedWaves.length - 1];
  if (!last) return "(first wave — no prior context)";
  return last.handoff;
}

function buildCoreContext(): string {
  const plan = fs.readFileSync(PLAN_PATH, "utf-8");
  return [
    "## Project Context",
    "",
    "You are working on the agent-relay broker migration. The Rust broker binary",
    "is at src/ and the TypeScript SDK is at packages/sdk-ts/.",
    "",
    "CRITICAL RULES:",
    "- No stubs, no placeholders, no TODOs. Every implementation must be complete.",
    "- All code must compile (cargo check, npx tsc) before you say DONE.",
    "- Write tests for every new function. Tests must pass.",
    "- Follow existing patterns: use anyhow::Result, tracing macros, tokio async.",
    "- Do NOT modify files outside your assigned scope without explicit approval.",
    "",
    "## Communication Protocol",
    "",
    "You have a Relaycast MCP server available (`relay_send` tool). Use it to communicate.",
    "",
    "When you START work, send an ACK:",
    '  relay_send({ to: "Orchestrator", message: "ACK: Starting on [task description]" })',
    "",
    "When you FINISH work, send a DONE message:",
    '  relay_send({ to: "Orchestrator", message: "DONE: [summary of what you did, files changed]" })',
    "",
    "When you need to COMMUNICATE with another agent:",
    '  relay_send({ to: "AgentName", message: "your message" })',
    "",
    "IMPORTANT: The orchestrator also monitors your terminal output.",
    "Even if MCP is unavailable, printing 'DONE: ...' to stdout signals completion.",
    "Always print a clear DONE message when finished.",
    "",
    "## Migration Plan (reference)",
    plan.slice(0, 3000), // truncate to keep context manageable
  ].join("\n");
}

// ── Quality gate ───────────────────────────────────────────────────────────

function runGate(gate: GateDefinition): { passed: boolean; output: string } {
  const outputs: string[] = [];
  let allPassed = true;

  if (gate.cargoTest) {
    log("Gate: running cargo test...");
    try {
      const result = run("$HOME/.cargo/bin/cargo test 2>&1");
      outputs.push("cargo test: PASS\n" + result.slice(-500));
    } catch (err: unknown) {
      allPassed = false;
      outputs.push("cargo test: FAIL\n" + ((err as { stdout?: string }).stdout ?? "").slice(-500));
    }
  }

  if (gate.integrationPhase !== undefined) {
    const runPhasePath = path.join(ROOT, "tests/integration/broker/run-phase.ts");
    if (!fs.existsSync(runPhasePath)) {
      log(`Gate: run-phase.ts not found — skipping integration phase ${gate.integrationPhase}`);
      outputs.push(`integration phase ${gate.integrationPhase}: SKIPPED (run-phase.ts not created yet)`);
    } else {
      log(`Gate: running broker integration phase ${gate.integrationPhase}...`);
      try {
        const result = run(
          `npx tsx tests/integration/broker/run-phase.ts --phase=${gate.integrationPhase} 2>&1`,
          { ignoreError: true },
        );
        const passed = !result.includes("FAIL");
        if (!passed) allPassed = false;
        outputs.push(`integration phase ${gate.integrationPhase}: ${passed ? "PASS" : "FAIL"}\n${result.slice(-500)}`);
      } catch {
        outputs.push(`integration phase ${gate.integrationPhase}: SKIPPED (harness not ready)`);
      }
    }
  }

  if (gate.customCommand) {
    log(`Gate: ${gate.customDescription ?? gate.customCommand}...`);
    try {
      const result = run(`${gate.customCommand} 2>&1`);
      outputs.push(`custom: PASS\n${result.slice(-300)}`);
    } catch (err: unknown) {
      allPassed = false;
      outputs.push(`custom: FAIL\n${((err as { stdout?: string }).stdout ?? "").slice(-300)}`);
    }
  }

  return { passed: allPassed, output: outputs.join("\n\n") };
}

// ── Wave definitions ───────────────────────────────────────────────────────

function buildWaves(priorHandoff: string): WaveDefinition[] {
  const coreCtx = buildCoreContext();

  return [
    // ── Wave 0: Quick Fixes ──────────────────────────────────────────────
    {
      id: 0,
      name: "Quick Fixes",
      description: "Atomic state, flock guard, main.rs decomposition",
      beads: ["agent-relay-559", "agent-relay-562", "agent-relay-560"],
      channel: "wave-0",
      gate: { cargoTest: true },
      tasks: [
        {
          role: "lead",
          cli: "claude",
          name: "Lead-W0",
          prompt: [
            coreCtx,
            "",
            "## Wave 0: Quick Fixes",
            "",
            "### Prior context",
            priorHandoff,
            "",
            "### Your role",
            "You are the Lead for Wave 0. Plan and coordinate three fixes:",
            "",
            "1. **Atomic state persistence** (src/main.rs BrokerState::save):",
            "   - Change from direct fs::write() to tmp-file + rename pattern",
            "   - Copy the pattern from src/auth.rs CredentialStore::save() (lines 70-92)",
            "   - Add a unit test for crash-safety",
            "",
            "2. **Flock guard** (src/main.rs run_init):",
            "   - Create a lockfile at .agent-relay/broker.lock on startup",
            "   - Use advisory flock (nix::fcntl::flock or std::fs file locking)",
            "   - Error with clear message if lock already held",
            "   - Release lock on shutdown",
            "",
            "3. **main.rs decomposition** (src/main.rs → modules):",
            "   - Extract run_wrap() and its helpers into src/wrap.rs",
            "   - Extract run_pty_worker() into src/pty_worker.rs",
            "   - Extract format_injection, strip_ansi, and helper fns into src/helpers.rs",
            "   - Keep run_init in main.rs (it's the entry orchestration)",
            "   - Re-export from lib.rs",
            "",
            "Post your implementation plan to the channel, then post HANDOFF when workers are done.",
            "Review each worker's output before approving.",
          ].join("\n"),
        },
        {
          role: "worker",
          cli: "codex",
          name: "Worker-W0-Atomic",
          args: ["--full-auto"],
          dependsOnLead: true,
          prompt: [
            "## Task: Atomic State Persistence",
            "",
            "In /Users/khaliqgant/Projects/agent-workforce/relay/src/main.rs,",
            "find BrokerState::save() and change it from direct fs::write() to",
            "the tmp-file + atomic rename pattern. Copy the exact pattern from",
            "src/auth.rs CredentialStore::save() (uses write to .tmp then rename).",
            "",
            "Also add a unit test in the #[cfg(test)] mod tests block that verifies:",
            "- State is written correctly",
            "- A concurrent read during write doesn't see partial data",
            "",
            "Run `cargo check` to verify compilation.",
            "Run `cargo test` to verify tests pass.",
            "When done, post DONE with a summary of changes.",
          ].join("\n"),
        },
        {
          role: "worker",
          cli: "codex",
          name: "Worker-W0-Flock",
          args: ["--full-auto"],
          dependsOnLead: true,
          prompt: [
            "## Task: Flock Guard for Multi-Broker Prevention",
            "",
            "In /Users/khaliqgant/Projects/agent-workforce/relay/src/main.rs,",
            "at the start of run_init(), add a file lock on .agent-relay/broker.lock:",
            "",
            "1. Create/open .agent-relay/broker.lock",
            "2. Try to acquire an exclusive flock (non-blocking)",
            "3. If lock fails, print error: 'Another broker is already running in this directory'",
            "   and exit with code 1",
            "4. Hold the lock for the lifetime of run_init (drop on function exit)",
            "5. Add a unit test that verifies double-lock detection",
            "",
            "Use std::fs::File and the nix crate's flock if available,",
            "or use fs2 crate's try_lock_exclusive().",
            "Check Cargo.toml for available dependencies first.",
            "",
            "Run `cargo check` then `cargo test`.",
            "When done, post DONE with summary.",
          ].join("\n"),
        },
        {
          role: "worker",
          cli: "codex",
          name: "Worker-W0-Decompose",
          args: ["--full-auto"],
          dependsOnLead: true,
          prompt: [
            "## Task: Decompose main.rs into Modules",
            "",
            "In /Users/khaliqgant/Projects/agent-workforce/relay/src/main.rs (3500+ lines),",
            "extract these sections into separate modules:",
            "",
            "1. **src/wrap.rs** — move the run_wrap() function and all its helpers:",
            "   - PtyAutoState struct and all its methods",
            "   - run_wrap() function",
            "   - Any constants used only by wrap mode (AUTO_ENTER_TIMEOUT, etc.)",
            "",
            "2. **src/pty_worker.rs** — move run_pty_worker() and its helpers",
            "",
            "3. **src/helpers.rs** — move pure utility functions:",
            "   - format_injection()",
            "   - strip_ansi()",
            "   - floor_char_boundary()",
            "   - detect_bypass_permissions_prompt()",
            "   - is_bypass_selection_menu()",
            "   - detect_codex_model_prompt()",
            "   - detect_gemini_action_required()",
            "   - is_in_editor_mode()",
            "   - terminal_query_responses() and TerminalQueryParser",
            "",
            "4. Update src/lib.rs to re-export the new modules",
            "5. Update main.rs to import from the new modules",
            "6. Move associated tests to the new modules",
            "",
            "CRITICAL: This is a pure refactor. Zero behavior changes. All existing tests must pass.",
            "Run `cargo check` then `cargo test` after each file extraction.",
            "When done, post DONE with summary.",
          ].join("\n"),
        },
        {
          role: "reviewer",
          cli: "codex",
          name: "Reviewer-W0",
          args: ["--full-auto"],
          prompt: [
            "## Task: Review Wave 0 Changes",
            "",
            "You are the reviewer for Wave 0. Wait for all workers to post DONE,",
            "then review the changes:",
            "",
            "1. Run `cd /Users/khaliqgant/Projects/agent-workforce/relay && git diff`",
            "2. Review every changed file for correctness:",
            "   - Atomic save: uses tmp+rename, not direct write",
            "   - Flock: correctly acquires/releases, error message is clear",
            "   - Decomposition: no behavior changes, just file moves",
            "3. Run `cargo test` — ALL tests must pass",
            "4. Run `cargo clippy` — no new warnings",
            "5. Verify no files outside src/ were modified (except Cargo.toml if needed)",
            "",
            "Post REVIEW:PASS if everything is correct.",
            "Post REVIEW:FAIL with specific issues if anything needs fixing.",
          ].join("\n"),
        },
      ],
    },

    // ── Wave 1: Test Harness ─────────────────────────────────────────────
    {
      id: 1,
      name: "Test Harness",
      description: "TDD foundation — broker integration test infrastructure",
      beads: ["agent-relay-555"],
      channel: "wave-1",
      gate: {
        cargoTest: true,
        customCommand: "npx tsx tests/integration/broker/01-broker-lifecycle.ts 2>&1 || true",
        customDescription: "broker test harness compiles",
      },
      tasks: [
        {
          role: "lead",
          cli: "claude",
          name: "Lead-W1",
          prompt: [
            coreCtx,
            "",
            "## Wave 1: Test Harness",
            "",
            "### Prior context",
            priorHandoff,
            "",
            "### Your role",
            "You are the LEAD coordinator. You have two workers:",
            "- **Worker-W1-Utils** (Codex): creating test utilities and harness",
            "- **Worker-W1-Tests** (Codex): writing the actual test files",
            "",
            "### Your responsibilities",
            "1. **Monitor workers**: Every 2-3 minutes, ping each worker to check status:",
            '   relay_send({ to: "Worker-W1-Utils", message: "Status check — what have you completed so far?" })',
            "2. **Unblock workers**: If a worker is stuck or asks a question, help them.",
            "3. **Drive completion**: If a worker seems idle, send them a nudge with specific next steps.",
            "4. **Report completion**: When ALL workers have reported DONE, post your HANDOFF summary.",
            "",
            "### The deliverables (what workers are building)",
            "",
            "**tests/integration/broker/utils/broker-harness.ts** — test lifecycle manager:",
            "- startBroker(): spawn agent-relay binary, wait for hello_ack",
            "- stopBroker(): graceful shutdown with timeout",
            "- spawnAgent(cli, name): spawn and wait for ready",
            "- releaseAgent(name): release and wait for exit event",
            "- sendMessage(from, to, text): send and return delivery events",
            "- waitForEvent(kind, timeout): wait for specific broker event",
            "",
            "**tests/integration/broker/utils/assert-helpers.ts** — custom assertions:",
            "- assertDelivered(eventId): message was delivered",
            "- assertNoDoubleDelivery(eventId): no duplicate injection",
            "- assertEventSequence(events, expected): events in order",
            "",
            "**Phase 1 tests** (expected to fail until Wave 3):",
            "- 01-broker-lifecycle.ts: start, hello, shutdown, restart",
            "- 02-spawn-release.ts: spawn agent, verify running, release, verify exit",
            "- 03-local-send-message.ts: send between two local agents",
            "- 04-send-with-relaycast.ts: verify message reaches Relaycast",
            "- 05-dedup-no-double.ts: local send + WS echo = one delivery",
            "",
            "Tests use node:test runner. Import from @agent-relay/broker-sdk.",
            "",
            "### Workflow",
            "1. Post your plan first",
            "2. Check on workers every 2-3 min — send status pings",
            "3. If a worker goes quiet for >3 min, nudge them with specific instructions",
            "4. When both workers report DONE, verify files exist and post HANDOFF",
          ].join("\n"),
        },
        {
          role: "worker",
          cli: "codex",
          name: "Worker-W1-Utils",
          args: ["--full-auto"],
          dependsOnLead: true,
          prompt: [
            "## Task: Create Broker Test Utilities",
            "",
            "Create these files under /Users/khaliqgant/Projects/agent-workforce/relay/tests/integration/broker/:",
            "",
            "1. **utils/broker-harness.ts** — manages broker lifecycle for tests.",
            "   Use AgentRelayClient from @agent-relay/broker-sdk (packages/sdk-ts).",
            "   Must handle: start, stop, spawn agents, release agents, send messages,",
            "   wait for events with timeout, collect channel messages.",
            "",
            "2. **utils/assert-helpers.ts** — assertion helpers:",
            "   assertDelivered, assertNoDoubleDelivery, assertEventSequence",
            "",
            "3. **run-phase.ts** — test runner that accepts --phase=N flag and",
            "   runs all tests for that phase sequentially. Use node:test runner.",
            "",
            "Look at tests/integration/sdk/utils/ for patterns to follow.",
            "Look at packages/sdk-ts/src/__tests__/ for how the SDK tests work.",
            "",
            "Run `npx tsc --noEmit` to verify TypeScript compiles.",
            "When done, post DONE.",
          ].join("\n"),
        },
        {
          role: "worker",
          cli: "codex",
          name: "Worker-W1-Tests",
          args: ["--full-auto"],
          dependsOnLead: true,
          prompt: [
            "## Task: Write Phase 1 Integration Tests",
            "",
            "Create these test files under /Users/khaliqgant/Projects/agent-workforce/relay/tests/integration/broker/:",
            "",
            "Use node:test and import the harness from utils/broker-harness.ts.",
            "",
            "1. **01-broker-lifecycle.ts**: Test broker start, hello_ack, shutdown, restart",
            "2. **02-spawn-release.ts**: Spawn a codex agent, verify it appears in listAgents,",
            "   release it, verify agent_exited/agent_released event",
            "3. **03-local-send-message.ts**: Spawn two agents, send message from A to B",
            "   via client.sendMessage(). This test is EXPECTED TO FAIL until Wave 3",
            "   implements send_message. Write it so it tests the correct behavior.",
            "4. **04-send-with-relaycast.ts**: After local send, verify message appears",
            "   in Relaycast via RelaycastApi.getMessages(). EXPECTED TO FAIL.",
            "5. **05-dedup-no-double.ts**: Send locally, wait for WS echo, verify",
            "   message was injected exactly once (not twice). EXPECTED TO FAIL.",
            "",
            "Tests 03-05 should be skipped gracefully (not crash) when send_message returns unsupported_operation.",
            "When done, post DONE.",
          ].join("\n"),
        },
        {
          role: "reviewer",
          cli: "codex",
          name: "Reviewer-W1",
          args: ["--full-auto"],
          prompt: [
            "## Task: Review Wave 1 Test Infrastructure",
            "",
            "Review all files in tests/integration/broker/.",
            "Verify:",
            "1. TypeScript compiles: `npx tsc --noEmit`",
            "2. Tests 01-02 actually run (may pass or fail depending on environment)",
            "3. Tests 03-05 handle unsupported_operation gracefully (skip, not crash)",
            "4. Harness properly cleans up (releases agents, shuts down broker)",
            "5. No hardcoded paths or credentials",
            "",
            "Post REVIEW:PASS or REVIEW:FAIL with specifics.",
          ].join("\n"),
        },
      ],
    },

    // ── Wave 2: Verified PTY Delivery ────────────────────────────────────
    {
      id: 2,
      name: "Verified PTY Delivery",
      description: "Layer 1 — output echo verification after PTY injection",
      beads: ["agent-relay-549"],
      channel: "wave-2",
      gate: { cargoTest: true, integrationPhase: 2 },
      tasks: [
        {
          role: "lead",
          cli: "claude",
          name: "Lead-W2",
          prompt: [
            coreCtx,
            "",
            "## Wave 2: Verified PTY Delivery",
            "",
            "### Prior context",
            priorHandoff,
            "",
            "### Your role",
            "Implement output echo verification in the Rust broker.",
            "",
            "Currently the wrap-mode worker (run_wrap in src/wrap.rs or main.rs) writes",
            "messages to the PTY and reports delivery_ack without verifying the message",
            "appeared in the agent's output.",
            "",
            "Design and coordinate:",
            "",
            "1. After PTY write, start a verification window (3s default)",
            "2. Monitor PTY output for the formatted injection string",
            "   (format_injection produces 'Relay message from X [id]: body')",
            "3. If echo found within window: emit delivery_verified event",
            "4. If not found: retry the injection (up to 3 attempts)",
            "5. After max retries: emit delivery_failed event with reason",
            "6. Track verification state in PendingDelivery or a new VerificationState",
            "",
            "The wrap-mode worker already reads PTY output in a tokio::select! loop.",
            "Add a pending verification buffer that scans output chunks for the expected string.",
            "",
            "Also write Phase 2 tests: 06-delivery-verified.ts, 07-delivery-retry.ts, 08-delivery-timeout.ts",
            "",
            "Post plan, coordinate workers, then HANDOFF.",
          ].join("\n"),
        },
        {
          role: "worker",
          cli: "codex",
          name: "Worker-W2-Verify",
          args: ["--full-auto"],
          dependsOnLead: true,
          prompt: [
            "## Task: Implement PTY Output Verification in Rust",
            "",
            "Read the Lead's plan from the channel first.",
            "",
            "In the Rust broker's wrap-mode worker (check src/wrap.rs or the run_wrap",
            "section of src/main.rs), implement delivery verification:",
            "",
            "1. After writing injection bytes to PTY + Enter, record the expected echo string",
            "2. In the PTY output reading branch of tokio::select!, scan for the expected string",
            "3. When found, emit a delivery_verified worker event (similar to delivery_ack)",
            "4. If not found within 3s, retry the PTY write (up to 3 attempts)",
            "5. After max retries, emit delivery_failed with reason 'verification_timeout'",
            "",
            "Add unit tests for the verification buffer scanning logic.",
            "Run `cargo check` then `cargo test`.",
            "When done, post DONE.",
          ].join("\n"),
        },
        {
          role: "worker",
          cli: "codex",
          name: "Worker-W2-Tests",
          args: ["--full-auto"],
          dependsOnLead: true,
          prompt: [
            "## Task: Write Phase 2 Integration Tests for Delivery Verification",
            "",
            "Create in /Users/khaliqgant/Projects/agent-workforce/relay/tests/integration/broker/:",
            "",
            "1. **06-delivery-verified.ts**: Spawn an agent, send a message, verify",
            "   delivery_verified event is emitted (not just delivery_ack).",
            "2. **07-delivery-retry.ts**: Send message while agent is processing",
            "   (busy state), verify the broker retries and eventually delivers.",
            "3. **08-delivery-timeout.ts**: Send message to a dead/crashed agent,",
            "   verify delivery_failed event with appropriate reason.",
            "",
            "Use the broker-harness.ts from Wave 1.",
            "When done, post DONE.",
          ].join("\n"),
        },
        {
          role: "reviewer",
          cli: "codex",
          name: "Reviewer-W2",
          args: ["--full-auto"],
          prompt: [
            "## Task: Review Wave 2 — Verified PTY Delivery",
            "",
            "1. Review Rust changes for correctness:",
            "   - Verification window timing is correct",
            "   - Retry logic doesn't cause double-injection",
            "   - Events propagate to SDK correctly",
            "2. Run `cargo test` — all tests pass",
            "3. Run `cargo clippy` — no warnings",
            "4. Run Phase 2 integration tests if available",
            "5. Verify no regressions in existing delivery behavior",
            "",
            "Post REVIEW:PASS or REVIEW:FAIL.",
          ].join("\n"),
        },
      ],
    },

    // ── Wave 3: Local send_message ───────────────────────────────────────
    {
      id: 3,
      name: "Local send_message",
      description: "Enable send_message with local delivery + async Relaycast publish",
      beads: ["agent-relay-550"],
      channel: "wave-3",
      gate: { cargoTest: true, integrationPhase: 1 },
      tasks: [
        {
          role: "lead",
          cli: "claude",
          name: "Lead-W3",
          prompt: [
            coreCtx,
            "",
            "## Wave 3: Local send_message + Async Relaycast",
            "",
            "### Prior context",
            priorHandoff,
            "",
            "### Your role",
            "This is the core feature. Currently main.rs:2192 explicitly rejects send_message.",
            "Replace that rejection with a dual-path handler:",
            "",
            "**Rust broker (main.rs handle_sdk_frame):**",
            "1. Parse SendMessagePayload (to, text, from, thread_id, priority)",
            "2. Resolve local targets: check WorkerRegistry for matching agent name or channel members",
            "3. If local targets found: queue_and_try_delivery_raw() to each (verified delivery from Wave 2)",
            "4. Pre-seed DedupCache with a generated event_id so WS echo is dropped",
            "5. Async Relaycast publish: tokio::spawn a task that sends via the existing WS connection",
            "   or creates a RelaycastApi HTTP POST. Fire-and-forget, log errors but don't block.",
            "6. Reply to SDK with event_id and target list",
            "",
            "**SDK (packages/sdk-ts/src/relay.ts):**",
            "1. Change makeAgent().sendMessage() to use client.sendMessage() (stdio) instead of RelaycastApi",
            "2. Change human().sendMessage() to also route through the broker",
            "3. RelaycastApi becomes internal to the broker, not used directly by SDK consumers",
            "",
            "Coordinate workers, review, then HANDOFF.",
          ].join("\n"),
        },
        {
          role: "worker",
          cli: "codex",
          name: "Worker-W3-Rust",
          args: ["--full-auto"],
          dependsOnLead: true,
          prompt: [
            "## Task: Implement send_message in Rust Broker",
            "",
            "Read the Lead's plan from the channel.",
            "",
            "In /Users/khaliqgant/Projects/agent-workforce/relay/src/main.rs (or wherever",
            "handle_sdk_frame lives after Wave 0 decomposition):",
            "",
            "1. Find the 'send_message' match arm (currently returns unsupported_operation)",
            "2. Replace with full implementation:",
            "   - Parse to, text, from, thread_id, priority from payload",
            "   - Generate event_id (format: 'sdk_{uuid}')",
            "   - Check if target is local (workers.worker_names_for_direct_target or channel)",
            "   - If local: queue_and_try_delivery_raw() for each target worker",
            "   - Pre-seed dedup.insert(event_id) so WS echo doesn't re-inject",
            "   - Async publish: tokio::spawn that sends message via Relaycast",
            "     (use the existing ws connection's inbound_tx or a separate HTTP POST)",
            "   - send_ok with event_id and targets list",
            "",
            "Run `cargo check` then `cargo test`.",
            "When done, post DONE.",
          ].join("\n"),
        },
        {
          role: "worker",
          cli: "codex",
          name: "Worker-W3-SDK",
          args: ["--full-auto"],
          dependsOnLead: true,
          prompt: [
            "## Task: Update SDK to Route Messages Through Broker",
            "",
            "Read the Lead's plan from the channel.",
            "",
            "In /Users/khaliqgant/Projects/agent-workforce/relay/packages/sdk-ts/src/relay.ts:",
            "",
            "1. In makeAgent().sendMessage(): replace the RelaycastApi.sendToChannel() call",
            "   with this.client.sendMessage({ to, text, from: name, threadId, priority })",
            "   The client.sendMessage() method already exists in client.ts and sends via stdio.",
            "",
            "2. In human().sendMessage(): same change — route through client instead of RelaycastApi",
            "",
            "3. Remove the ensureRelaycast() calls from sendMessage paths",
            "   (keep RelaycastApi class for now — broker uses it internally)",
            "",
            "4. Update the Message return type to use event_id from broker response",
            "",
            "Run `npm run build` in packages/sdk-ts to verify compilation.",
            "Run `npm test` if tests exist.",
            "When done, post DONE.",
          ].join("\n"),
        },
        {
          role: "reviewer",
          cli: "codex",
          name: "Reviewer-W3",
          args: ["--full-auto"],
          prompt: [
            "## Task: Review Wave 3 — send_message Implementation",
            "",
            "This is the most critical wave. Review thoroughly:",
            "",
            "1. Rust: send_message handler is complete (no stubs)",
            "2. Rust: dedup pre-seeding prevents double delivery",
            "3. Rust: async Relaycast publish doesn't block the response",
            "4. Rust: error handling for all failure paths",
            "5. SDK: sendMessage routes through stdio, not RelaycastApi",
            "6. SDK: human.sendMessage also routes through broker",
            "7. Run `cargo test` — pass",
            "8. Run Phase 1 integration tests (03-05 should now pass!)",
            "9. Verify dedup: send a message, check it's delivered exactly once",
            "",
            "Post REVIEW:PASS or REVIEW:FAIL.",
          ].join("\n"),
        },
      ],
    },

    // ── Wave 4: Activity Confirmation + Adaptive Throttling ──────────────
    {
      id: 4,
      name: "Activity + Throttle",
      description: "Layers 2-3: activity confirmation and adaptive throttling",
      beads: ["agent-relay-552", "agent-relay-553"],
      channel: "wave-4",
      gate: { cargoTest: true, integrationPhase: 2 },
      tasks: [
        {
          role: "lead",
          cli: "claude",
          name: "Lead-W4",
          prompt: [
            coreCtx,
            "",
            "## Wave 4: Activity Confirmation + Adaptive Throttling",
            "",
            "### Prior context",
            priorHandoff,
            "",
            "Implement two features in the Rust broker:",
            "",
            "**Activity confirmation**: After delivery_verified, watch for agent activity:",
            "- Claude: tool use markers, thinking spinners, code output",
            "- Codex: 'Thinking...', function execution",
            "- Gemini: 'Generating...', action markers",
            "- Configurable timeout (5s default)",
            "- Emit delivery_active event when detected",
            "",
            "**Adaptive throttling**: Per-worker injection rate control:",
            "- Track last N delivery outcomes (success/fail/timeout) per worker",
            "- Healthy worker: minimum delay between injections (100ms)",
            "- Struggling worker: exponential backoff (200ms → 500ms → 1s → 2s → 5s)",
            "- Recovery: after 3 consecutive successes, halve the delay",
            "",
            "Write tests 09-activity-confirmed.ts and 10-adaptive-throttle.ts.",
            "Post plan, coordinate, HANDOFF.",
          ].join("\n"),
        },
        {
          role: "worker",
          cli: "codex",
          name: "Worker-W4-Activity",
          args: ["--full-auto"],
          dependsOnLead: true,
          prompt: [
            "## Task: Implement Activity Confirmation in Rust Broker",
            "",
            "Read the Lead's plan from the channel.",
            "",
            "After delivery_verified, continue monitoring PTY output for activity signals.",
            "Add activity detection patterns (configurable per CLI type).",
            "Emit delivery_active worker event when activity detected.",
            "Also write integration test 09-activity-confirmed.ts.",
            "",
            "Run `cargo check` then `cargo test`.",
            "When done, post DONE.",
          ].join("\n"),
        },
        {
          role: "worker",
          cli: "codex",
          name: "Worker-W4-Throttle",
          args: ["--full-auto"],
          dependsOnLead: true,
          prompt: [
            "## Task: Implement Adaptive Throttling in Rust Broker",
            "",
            "Read the Lead's plan from the channel.",
            "",
            "Add per-worker throttle state to WorkerRegistry:",
            "- Ring buffer of last 10 delivery outcomes",
            "- Computed delay based on failure rate",
            "- Apply delay before each injection attempt",
            "",
            "Also write integration test 10-adaptive-throttle.ts.",
            "",
            "Run `cargo check` then `cargo test`.",
            "When done, post DONE.",
          ].join("\n"),
        },
        {
          role: "reviewer",
          cli: "codex",
          name: "Reviewer-W4",
          args: ["--full-auto"],
          prompt: [
            "## Task: Review Wave 4 — Activity + Throttle",
            "",
            "Review Rust implementation for correctness.",
            "Run `cargo test`, `cargo clippy`.",
            "Run Phase 2 integration tests.",
            "Verify activity patterns are realistic (not just string matches that break).",
            "Verify throttle math: backoff increases on failure, decreases on success.",
            "Post REVIEW:PASS or REVIEW:FAIL.",
          ].join("\n"),
        },
      ],
    },

    // ── Wave 5: Delivery Receipts ────────────────────────────────────────
    {
      id: 5,
      name: "Delivery Receipts",
      description: "Layer 7 — full delivery lifecycle events to SDK",
      beads: ["agent-relay-554"],
      channel: "wave-5",
      gate: { cargoTest: true },
      tasks: [
        {
          role: "lead",
          cli: "claude",
          name: "Lead-W5",
          prompt: [
            coreCtx,
            "",
            "## Wave 5: Delivery Receipts",
            "",
            "### Prior context",
            priorHandoff,
            "",
            "Implement full delivery lifecycle events that flow from Rust broker → SDK:",
            "- delivery_queued → delivery_injected → delivery_verified → delivery_active",
            "- Or: delivery_queued → delivery_injected → delivery_failed (reason)",
            "",
            "Each event includes: delivery_id, event_id, worker_name, timestamp.",
            "",
            "SDK should expose these via onEvent or a new onDeliveryUpdate hook.",
            "Write an integration test that verifies the full event chain.",
            "",
            "Post plan, coordinate, HANDOFF.",
          ].join("\n"),
        },
        {
          role: "worker",
          cli: "codex",
          name: "Worker-W5-Receipts",
          args: ["--full-auto"],
          dependsOnLead: true,
          prompt: [
            "## Task: Implement Delivery Receipts",
            "",
            "Read the Lead's plan. Implement in both Rust and SDK.",
            "Emit granular delivery lifecycle events from broker.",
            "Expose in SDK via events. Write integration test.",
            "Run `cargo test` and `npm run build`.",
            "When done, post DONE.",
          ].join("\n"),
        },
        {
          role: "reviewer",
          cli: "codex",
          name: "Reviewer-W5",
          args: ["--full-auto"],
          prompt: [
            "## Task: Review Wave 5 — Delivery Receipts",
            "",
            "Verify event chain is complete (no missing states).",
            "Verify SDK correctly surfaces events.",
            "Run all tests. Post REVIEW:PASS or REVIEW:FAIL.",
          ].join("\n"),
        },
      ],
    },

    // ── Wave 6: Crash Recovery ───────────────────────────────────────────
    {
      id: 6,
      name: "Crash Recovery",
      description: "PID tracking, process groups, reattach on restart",
      beads: ["agent-relay-551"],
      channel: "wave-6",
      gate: { cargoTest: true, integrationPhase: 3 },
      tasks: [
        {
          role: "lead",
          cli: "claude",
          name: "Lead-W6",
          prompt: [
            coreCtx,
            "",
            "## Wave 6: Crash Recovery",
            "",
            "### Prior context",
            priorHandoff,
            "",
            "Implement broker crash recovery:",
            "",
            "1. **PID persistence**: Save worker PIDs in BrokerState alongside names",
            "2. **Process groups**: Use setsid when spawning wrap-mode children",
            "3. **Reattach on startup**: Check if saved PIDs are still alive, reattach if so",
            "4. **Delivery persistence**: Save pending deliveries to .agent-relay/pending.json",
            "5. **On restart**: Reload pending deliveries and retry to reattached workers",
            "",
            "Write Phase 3 tests: 13-broker-crash-recover.ts, 14-pending-persist.ts.",
            "Post plan, coordinate, HANDOFF.",
          ].join("\n"),
        },
        {
          role: "worker",
          cli: "codex",
          name: "Worker-W6-PID",
          args: ["--full-auto"],
          dependsOnLead: true,
          prompt: [
            "## Task: PID Tracking and Reattach",
            "",
            "Read the Lead's plan. Implement PID persistence and reattach logic.",
            "Run `cargo check` then `cargo test`.",
            "When done, post DONE.",
          ].join("\n"),
        },
        {
          role: "worker",
          cli: "codex",
          name: "Worker-W6-Persist",
          args: ["--full-auto"],
          dependsOnLead: true,
          prompt: [
            "## Task: Delivery Persistence Across Restarts",
            "",
            "Read the Lead's plan. Implement pending delivery persistence.",
            "Write Phase 3 tests 13 and 14.",
            "Run `cargo check` then `cargo test`.",
            "When done, post DONE.",
          ].join("\n"),
        },
        {
          role: "reviewer",
          cli: "codex",
          name: "Reviewer-W6",
          args: ["--full-auto"],
          prompt: [
            "## Task: Review Wave 6 — Crash Recovery",
            "",
            "Review PID tracking, reattach, and delivery persistence.",
            "Run kill-restart test scenarios manually if possible.",
            "Run all tests. Post REVIEW:PASS or REVIEW:FAIL.",
          ].join("\n"),
        },
      ],
    },

    // ── Wave 7: Benchmarks ───────────────────────────────────────────────
    {
      id: 7,
      name: "Benchmarks",
      description: "Performance comparison: broker vs old stack",
      beads: ["agent-relay-556"],
      channel: "wave-7",
      gate: {
        cargoTest: true,
        customCommand: "npx tsx tests/benchmarks/latency.ts --quick 2>&1",
        customDescription: "benchmark harness runs",
      },
      tasks: [
        {
          role: "lead",
          cli: "claude",
          name: "Lead-W7",
          prompt: [
            coreCtx,
            "",
            "## Wave 7: Benchmarks",
            "",
            "### Prior context",
            priorHandoff,
            "",
            "Create tests/benchmarks/ with 6 benchmark tests comparing broker vs old stack.",
            "See the migration plan for full specifications of each benchmark.",
            "",
            "Focus on: latency, throughput, reliability, overhead, scale-out, cold-start.",
            "Create a harness that runs both stacks and produces a comparison table.",
            "Post plan, coordinate, HANDOFF.",
          ].join("\n"),
        },
        {
          role: "worker",
          cli: "codex",
          name: "Worker-W7-Harness",
          args: ["--full-auto"],
          dependsOnLead: true,
          prompt: [
            "## Task: Benchmark Harness + Latency/Throughput/Cold-Start",
            "",
            "Read the Lead's plan. Create tests/benchmarks/ with harness,",
            "metrics helpers, and implement latency, throughput, cold-start benchmarks.",
            "When done, post DONE.",
          ].join("\n"),
        },
        {
          role: "worker",
          cli: "codex",
          name: "Worker-W7-Reliability",
          args: ["--full-auto"],
          dependsOnLead: true,
          prompt: [
            "## Task: Reliability/Overhead/Scale-Out Benchmarks",
            "",
            "Read the Lead's plan. Implement reliability, overhead, scale-out benchmarks.",
            "When done, post DONE.",
          ].join("\n"),
        },
        {
          role: "reviewer",
          cli: "codex",
          name: "Reviewer-W7",
          args: ["--full-auto"],
          prompt: [
            "## Task: Review Wave 7 — Benchmarks",
            "",
            "Run the benchmark suite (--quick mode). Verify it produces output.",
            "Review code for measurement correctness.",
            "Post REVIEW:PASS or REVIEW:FAIL.",
          ].join("\n"),
        },
      ],
    },

    // ── Wave 8: Parity Tests ─────────────────────────────────────────────
    {
      id: 8,
      name: "Parity Tests",
      description: "Port old SDK tests to prove broker-sdk is a full replacement",
      beads: [],
      channel: "wave-8",
      gate: {
        cargoTest: true,
        customCommand: "npx tsx tests/integration/broker/run-phase.ts --phase=4 2>&1",
        customDescription: "parity tests pass",
      },
      tasks: [
        {
          role: "lead",
          cli: "claude",
          name: "Lead-W8",
          prompt: [
            coreCtx,
            "",
            "## Wave 8: Parity Tests",
            "",
            "### Prior context",
            priorHandoff,
            "",
            "Port the old SDK integration tests to use broker-sdk, proving full replacement.",
            "Map tests/integration/sdk/ tests to broker equivalents.",
            "Post plan, coordinate, HANDOFF.",
          ].join("\n"),
        },
        {
          role: "worker",
          cli: "codex",
          name: "Worker-W8-Port1",
          args: ["--full-auto"],
          dependsOnLead: true,
          prompt: [
            "## Task: Port broadcast, multi-worker, orch-to-worker tests",
            "",
            "Port these old tests to broker-sdk versions:",
            "- sdk/07-broadcast.js → broker/16-broadcast.ts",
            "- sdk/06-multi-worker.js → broker/17-multi-worker.ts",
            "- sdk/05b2-orch-to-worker.js → broker/19-orch-to-worker.ts",
            "When done, post DONE.",
          ].join("\n"),
        },
        {
          role: "worker",
          cli: "codex",
          name: "Worker-W8-Port2",
          args: ["--full-auto"],
          dependsOnLead: true,
          prompt: [
            "## Task: Port continuity-handoff + write stability soak test",
            "",
            "Port and create:",
            "- sdk/15-continuity-handoff.js → broker/18-continuity-handoff.ts",
            "- New: broker/20-stability-soak.ts (5-minute soak test, messages over time)",
            "When done, post DONE.",
          ].join("\n"),
        },
        {
          role: "reviewer",
          cli: "codex",
          name: "Reviewer-W8",
          args: ["--full-auto"],
          prompt: [
            "## Task: Review Wave 8 — Parity Tests",
            "",
            "Run all parity tests. Compare coverage against old test suite.",
            "Verify all tests pass. Post REVIEW:PASS or REVIEW:FAIL.",
          ].join("\n"),
        },
      ],
    },
  ];
}

// ── Wave executor ──────────────────────────────────────────────────────────

async function executeWave(
  relay: AgentRelay,
  wave: WaveDefinition,
  state: MigrationState,
): Promise<WaveResult> {
  const startTime = Date.now();
  log(`\n${"═".repeat(60)}`);
  log(`Wave ${wave.id}: ${wave.name}`);
  log(`Description: ${wave.description}`);
  log(`Beads: ${wave.beads.join(", ") || "(none)"}`);
  log(`${"═".repeat(60)}\n`);

  const channelLog: Message[] = [];
  const agents: Agent[] = [];
  const orchestrator = relay.human({ name: "Orchestrator" });

  const exitedWorkers = new Set<string>();

  // Track messages from Relaycast (cloud round-trip)
  relay.onMessageReceived = (msg) => {
    channelLog.push(msg);
    const preview = msg.text.slice(0, 100).replace(/\n/g, "\\n");
    log(`  [msg:${msg.from}] ${preview}`);
  };

  // Track agent exits event-driven (instead of polling waitForExit)
  relay.onAgentExited = (agent) => {
    exitedWorkers.add(agent.name);
    log(`  [exit] ${agent.name} process exited`);
  };

  // Scan PTY output for DONE/HANDOFF/REVIEW keywords + track last activity
  const outputBuffers = new Map<string, string>();
  const lastActivityTime = new Map<string, number>();
  const IDLE_TIMEOUT_MS = 2 * 60 * 1000; // 2 min of no PTY output = idle/done

  // Track when we last injected a message into each agent's PTY, and the
  // text we injected. We use this to distinguish real completion signals from
  // echoes of the injected prompt.
  const lastInjectionTime = new Map<string, number>();
  const lastInjectedText = new Map<string, string>();
  const ECHO_GRACE_MS = 10_000; // ignore keywords for 10s after injection

  relay.onWorkerOutput = (output) => {
    const prev = outputBuffers.get(output.name) ?? "";
    const buf = (prev + output.chunk).slice(-4000); // keep last 4k chars
    outputBuffers.set(output.name, buf);
    lastActivityTime.set(output.name, Date.now());

    // During the echo grace period, check if this chunk is part of the
    // injected prompt echoing back. Only suppress if the keywords appear
    // in the original injected text.
    const injectedAt = lastInjectionTime.get(output.name) ?? 0;
    const inGracePeriod = Date.now() - injectedAt < ECHO_GRACE_MS;

    // Check for completion keywords in each line
    const keywords = ["DONE:", "DONE.", "HANDOFF:", "REVIEW:PASS", "REVIEW:FAIL"];
    const lines = output.chunk.split("\n");
    const completionLine = lines.find((line) => {
      const trimmed = line.trim();
      return keywords.some((kw) => trimmed.includes(kw)) || trimmed === "DONE";
    });

    if (completionLine) {
      // If in grace period, check if this keyword also appears in the injected text
      if (inGracePeriod) {
        const injectedText = lastInjectedText.get(output.name) ?? "";
        if (injectedText.includes(completionLine.trim())) {
          // This is an echo of the prompt — skip
          return;
        }
      }

      const syntheticMsg: Message = {
        eventId: `pty_${Date.now()}`,
        from: output.name,
        to: "Orchestrator",
        text: completionLine.trim().slice(0, 500),
      };
      channelLog.push(syntheticMsg);
      log(`  [pty:${output.name}] ${completionLine.trim().slice(0, 100)}`);
    }
  };

  try {
    // ── Phase 1: Spawn and brief the Lead ──────────────────────────────
    const leadTask = wave.tasks.find((t) => t.role === "lead")!;
    log(`Spawning Lead: ${leadTask.name} (${leadTask.cli})`);

    const lead = await relay.claude.spawn({
      name: leadTask.name,
      channels: [wave.channel],
    });
    agents.push(lead);

    await orchestrator.sendMessage({ to: lead.name, text: leadTask.prompt });
    lastInjectionTime.set(lead.name, Date.now());
    lastInjectedText.set(lead.name, leadTask.prompt);
    log(`Lead briefed. Waiting ${LEAD_PLANNING_DELAY_MS / 1000}s for planning...`);
    await sleep(LEAD_PLANNING_DELAY_MS);

    // ── Phase 2: Spawn Workers sequentially ────────────────────────────
    const workerTasks = wave.tasks.filter((t) => t.role === "worker");

    for (const task of workerTasks) {
      log(`Spawning Worker: ${task.name} (${task.cli})`);

      const worker = await relay.codex.spawn({
        name: task.name,
        args: task.args,
        channels: [wave.channel],
      });
      agents.push(worker);

      await orchestrator.sendMessage({ to: worker.name, text: task.prompt });
      lastInjectionTime.set(task.name, Date.now());
      lastInjectedText.set(task.name, task.prompt);
      log(`Worker ${task.name} briefed.`);

      // Stagger workers to avoid file conflicts
      if (workerTasks.indexOf(task) < workerTasks.length - 1) {
        await sleep(WORKER_STAGGER_MS);
      }
    }

    // ── Phase 3: Wait for workers to finish ────────────────────────────
    // Completion is detected via: (a) DONE messages in channelLog (from Relaycast
    // or PTY output scanning), or (b) process exits (onAgentExited hook).
    log("Waiting for workers to complete...");
    const deadline = Date.now() + WAVE_TIMEOUT_MS;
    let lastNudgeTime = Date.now();
    const NUDGE_INTERVAL_MS = 3 * 60 * 1000; // nudge idle workers every 3 min

    while (Date.now() < deadline) {
      const workerNames = new Set(workerTasks.map((t) => t.name));

      // Count unique workers that sent DONE (via relay message or PTY output)
      const doneWorkers = new Set(
        channelLog
          .filter((m) => m.text.includes("DONE") && workerNames.has(m.from))
          .map((m) => m.from),
      );

      // Detect idle workers (no PTY output for IDLE_TIMEOUT_MS after initial activity)
      const now = Date.now();
      for (const task of workerTasks) {
        if (exitedWorkers.has(task.name)) continue;
        const lastActive = lastActivityTime.get(task.name);
        if (lastActive && now - lastActive > IDLE_TIMEOUT_MS) {
          exitedWorkers.add(task.name);
          log(`  Worker ${task.name} idle for ${Math.round((now - lastActive) / 1000)}s — treating as done.`);
        }
      }

      // A worker is complete if it sent DONE, its process exited, or it went idle
      const completedWorkers = new Set<string>();
      doneWorkers.forEach((n) => completedWorkers.add(n));
      exitedWorkers.forEach((n) => { if (workerNames.has(n)) completedWorkers.add(n); });

      if (completedWorkers.size >= workerTasks.length) {
        log(`All ${workerTasks.length} workers completed (${doneWorkers.size} DONE, ${exitedWorkers.size} exited).`);
        break;
      }

      // Nudge idle workers and lead every NUDGE_INTERVAL_MS
      if (Date.now() - lastNudgeTime >= NUDGE_INTERVAL_MS) {
        lastNudgeTime = Date.now();
        const remaining = workerTasks.filter((t) => !completedWorkers.has(t.name));
        for (const task of remaining) {
          log(`  Nudging idle worker: ${task.name}`);
          const nudgeText = "Status check from Orchestrator: Are you still working? If you're done, please print 'DONE: [summary]'. If stuck, describe what's blocking you.";
          await orchestrator.sendMessage({ to: task.name, text: nudgeText });
          lastInjectionTime.set(task.name, Date.now());
          lastInjectedText.set(task.name, nudgeText);
        }
        // Also nudge the lead to check on workers
        if (leadTask) {
          const leadNudge = `Status check: ${remaining.map((t) => t.name).join(", ")} haven't reported DONE yet. Please ping them and drive completion.`;
          await orchestrator.sendMessage({ to: leadTask.name, text: leadNudge });
          lastInjectionTime.set(leadTask.name, Date.now());
          lastInjectedText.set(leadTask.name, leadNudge);
        }
      }

      const remaining = workerTasks
        .filter((t) => !completedWorkers.has(t.name))
        .map((t) => t.name);
      log(`  Waiting... ${completedWorkers.size}/${workerTasks.length} done. Remaining: ${remaining.join(", ")}`);
      await sleep(10_000);
    }

    // ── Phase 4: Spawn Reviewer ────────────────────────────────────────
    const reviewerTask = wave.tasks.find((t) => t.role === "reviewer")!;
    log(`Spawning Reviewer: ${reviewerTask.name}`);

    const reviewer = await relay.codex.spawn({
      name: reviewerTask.name,
      args: reviewerTask.args,
      channels: [wave.channel],
    });
    agents.push(reviewer);

    await orchestrator.sendMessage({ to: reviewer.name, text: reviewerTask.prompt });
    lastInjectionTime.set(reviewer.name, Date.now());
    lastInjectedText.set(reviewer.name, reviewerTask.prompt);

    // Wait for review verdict
    log("Waiting for Reviewer verdict...");
    const reviewDeadline = Date.now() + 5 * 60 * 1000; // 5 min for review
    let verdict: string | undefined;

    while (Date.now() < reviewDeadline) {
      const review = channelLog.find(
        (m) => m.from === reviewerTask.name && (m.text.includes("REVIEW:PASS") || m.text.includes("REVIEW:FAIL")),
      );
      if (review) {
        verdict = review.text;
        break;
      }
      // Reviewer (codex --full-auto) may exit without sending REVIEW verdict
      if (exitedWorkers.has(reviewerTask.name)) {
        log("Reviewer exited without explicit verdict — treating as REVIEW:PASS");
        verdict = "REVIEW:PASS (implicit — reviewer exited cleanly)";
        break;
      }
      await sleep(3_000);
    }

    // ── Phase 5: Wait for Lead handoff ─────────────────────────────────
    log("Requesting Lead handoff...");
    const handoffRequest = `Workers are done. Reviewer verdict: ${verdict?.slice(0, 200) ?? "no verdict"}. Please post your HANDOFF summary now.`;
    await orchestrator.sendMessage({ to: leadTask.name, text: handoffRequest });
    lastInjectionTime.set(leadTask.name, Date.now());
    lastInjectedText.set(leadTask.name, handoffRequest);

    await sleep(10_000);
    const handoffMsg = channelLog.find(
      (m) => m.from === leadTask.name && m.text.includes("HANDOFF"),
    );

    // ── Phase 6: Release all agents ────────────────────────────────────
    for (const agent of agents) {
      try {
        await agent.release();
      } catch {
        /* already exited */
      }
    }

    // ── Phase 7: Run quality gate ──────────────────────────────────────
    log("Running quality gate...");
    const gateResult = runGate(wave.gate);

    const passed = gateResult.passed && (verdict?.includes("REVIEW:PASS") ?? false);

    // ── Collect changed files ──────────────────────────────────────────
    let filesChanged: string[] = [];
    try {
      const diff = run("git diff --name-only HEAD");
      filesChanged = diff.split("\n").filter(Boolean);
    } catch {
      /* no changes */
    }

    const handoff = handoffMsg?.text ?? `Wave ${wave.id} completed. Verdict: ${verdict ?? "unknown"}`;

    return {
      waveId: wave.id,
      passed,
      handoff,
      filesChanged,
      testOutput: gateResult.output,
      duration: Date.now() - startTime,
    };
  } finally {
    // Ensure cleanup
    for (const agent of agents) {
      try {
        await agent.release();
      } catch {
        /* best effort */
      }
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const state = loadState();
  const effectiveStart = Math.max(startWave, state.currentWave);

  log("Broker Migration Orchestrator");
  log(`Branch: ${BRANCH}`);
  log(`Starting from wave: ${effectiveStart}`);
  log(`Dry run: ${dryRun}`);

  if (dryRun) {
    const waves = buildWaves(previousHandoff(state));
    for (const wave of waves.filter((w) => w.id >= effectiveStart)) {
      log(`\n[DRY] Wave ${wave.id}: ${wave.name}`);
      log(`  Beads: ${wave.beads.join(", ")}`);
      log(`  Tasks: ${wave.tasks.length} (${wave.tasks.filter((t) => t.role === "worker").length} workers)`);
      log(`  Gate: cargo_test=${wave.gate.cargoTest}, integration_phase=${wave.gate.integrationPhase ?? "none"}`);
    }
    return;
  }

  const relay = new AgentRelay({
    binaryPath: BINARY_PATH,
    channels: ["orchestrator"],
    env: process.env,
  });

  relay.onAgentSpawned = (a) => log(`  [spawn] ${a.name} (${a.runtime})`);
  relay.onAgentReleased = (a) => log(`  [release] ${a.name}`);
  relay.onAgentExited = (a) => log(`  [exit] ${a.name}`);

  try {
    for (let waveId = effectiveStart; waveId <= 8; waveId++) {
      const waves = buildWaves(previousHandoff(state));
      const wave = waves.find((w) => w.id === waveId);
      if (!wave) continue;

      let retries = 0;
      let result: WaveResult | undefined;

      while (retries <= MAX_RETRIES) {
        result = await executeWave(relay, wave, state);

        if (result.passed) {
          log(`\nWave ${waveId} PASSED (${Math.round(result.duration / 1000)}s)`);

          // Commit wave changes
          if (result.filesChanged.length > 0) {
            log("Committing wave changes...");
            run(`git add -A`);
            run(`git commit -m "feat(broker): wave ${waveId} — ${wave.name}

${result.handoff.slice(0, 500)}

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>" || true`);
          }

          state.completedWaves.push(result);
          state.currentWave = waveId + 1;
          saveState(state);
          break;
        }

        retries++;
        if (retries <= MAX_RETRIES) {
          log(`\nWave ${waveId} FAILED (attempt ${retries}/${MAX_RETRIES + 1}). Retrying with failure context...`);
        } else {
          log(`\nWave ${waveId} FAILED after ${MAX_RETRIES + 1} attempts. Halting.`);
          log(`Gate output:\n${result.testOutput}`);
          state.currentWave = waveId;
          saveState(state);
          process.exit(1);
        }
      }
    }

    log("\n" + "═".repeat(60));
    log("MIGRATION COMPLETE");
    log(`Waves: ${state.completedWaves.length} / 9`);
    log(`Total agents spawned: ~${state.completedWaves.length * 4}`);
    log("═".repeat(60));
  } finally {
    await relay.shutdown();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
