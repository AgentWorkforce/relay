#!/usr/bin/env npx tsx
/**
 * DAG Workflow Executor for the relay-cloud PR #94 implementation plan.
 *
 * Uses @agent-relay/broker-sdk (AgentRelayClient) to coordinate 9 work nodes
 * with dependency-aware parallel execution.
 *
 * Prerequisites:
 *   - agent-relay daemon running (agent-relay up)
 *   - SDK built: ./node_modules/.bin/tsc -p packages/sdk-ts/tsconfig.json
 *
 * Usage:
 *   npx tsx scripts/run-swarm-implementation.ts --dry-run
 *   npx tsx scripts/run-swarm-implementation.ts
 *   npx tsx scripts/run-swarm-implementation.ts --resume
 *   npx tsx scripts/run-swarm-implementation.ts --max-concurrency 3
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { AgentRelayClient } from "../packages/sdk-ts/dist/client.js";
import { getLogs } from "../packages/sdk-ts/dist/logs.js";
import type { BrokerEvent } from "../packages/sdk-ts/dist/protocol.js";

// ── Configuration ──────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const RESUME = process.argv.includes("--resume");
const MAX_CONCURRENCY = (() => {
  const idx = process.argv.indexOf("--max-concurrency");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 4;
})();
const AGENT_TIMEOUT_MS = 30 * 60_000; // 30 minutes per agent
const STATE_FILE = ".relay/swarm-impl-state.json";
const WORKFLOW_CHANNEL = "swarm-impl";

// ── Types ──────────────────────────────────────────────────────────────────

interface DagNode {
  id: string;
  agent: { name: string; cli: "claude" | "codex" };
  task: string;
  dependsOn: string[];
  readFirst?: string[];
}

interface NodeResult {
  nodeId: string;
  agentName: string;
  output: string;
  status: "completed" | "failed" | "blocked";
  durationMs: number;
}

interface PersistedState {
  completed: string[];
  depsOutput: Record<string, string>;
  results: Record<string, NodeResult>;
  startedAt: string;
}

// ── State Persistence ──────────────────────────────────────────────────────

function ensureDir(filePath: string): void {
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function saveState(
  completed: Set<string>,
  depsOutput: Map<string, string>,
  results: Map<string, NodeResult>,
  startedAt: number,
): void {
  ensureDir(STATE_FILE);
  writeFileSync(STATE_FILE, JSON.stringify({
    completed: [...completed],
    depsOutput: Object.fromEntries(depsOutput),
    results: Object.fromEntries(results),
    startedAt: new Date(startedAt).toISOString(),
  } satisfies PersistedState, null, 2));
}

function loadState(): PersistedState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

// ── Broker SDK Client ────────────────────────────────────────────────────

let client: AgentRelayClient;

async function ensureClient(): Promise<AgentRelayClient> {
  if (!client) {
    client = await AgentRelayClient.start({
      channels: [WORKFLOW_CHANNEL],
      clientName: "swarm-dag-executor",
    });
  }
  return client;
}

/**
 * Watch for DONE or ERROR in agent logs + broker events.
 * Uses both event listener (real-time) and log polling (fallback).
 */
function watchForDone(
  agentName: string,
  timeoutMs: number,
): Promise<{ status: "completed" | "failed"; output: string }> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (status: "completed" | "failed", output: string) => {
      if (resolved) return;
      resolved = true;
      clearInterval(pollInterval);
      clearTimeout(timeoutHandle);
      if (unsubscribe) unsubscribe();
      resolve({ status, output });
    };

    // Listen for broker events (agent_exited, message with DONE/ERROR)
    const unsubscribe = client.onEvent((event: BrokerEvent) => {
      if (resolved) return;
      if (event.kind === "agent_exited" && event.agent === agentName) {
        finish("failed", "Agent exited without sending DONE");
      }
      if (event.kind === "message_sent" && event.from === agentName) {
        const text = (event as unknown as { text: string }).text ?? "";
        const doneMatch = text.match(/^DONE:\s*(.+)/ms);
        if (doneMatch) {
          finish("completed", doneMatch[1].trim());
          return;
        }
        const errorMatch = text.match(/^ERROR:\s*(.+)/ms);
        if (errorMatch) {
          finish("failed", errorMatch[1].trim());
        }
      }
    });

    // Poll logs as fallback (events may not contain full message text)
    const pollInterval = setInterval(async () => {
      if (resolved) return;
      const result = await getLogs(agentName, { lines: 200 });
      if (!result.found || !result.content) return;

      const doneMatch = result.content.match(/^DONE:\s*(.+)/ms);
      if (doneMatch) {
        finish("completed", doneMatch[1].trim());
        return;
      }
      const errorMatch = result.content.match(/^ERROR:\s*(.+)/ms);
      if (errorMatch) {
        finish("failed", errorMatch[1].trim());
        return;
      }

      // Check if agent disappeared (after initial grace period)
      const agents = await client.listAgents();
      if (!agents.some((a) => a.name === agentName)) {
        finish("failed", "Agent exited without sending DONE");
      }
    }, 5000);

    const timeoutHandle = setTimeout(() => {
      finish("failed", `Timed out after ${timeoutMs / 60_000}m`);
    }, timeoutMs);
  });
}

// ── Convention Injection ───────────────────────────────────────────────────

function buildConventions(node: DagNode, depsOutput: Map<string, string>): string {
  const depContext = node.dependsOn
    .map((depId) => {
      const output = depsOutput.get(depId);
      return output ? `### Output from ${depId}:\n${output}` : "";
    })
    .filter(Boolean)
    .join("\n\n");

  const readFirstSection = node.readFirst?.length
    ? `### Files to Read First
Before writing any code, read these files to understand existing patterns:
${node.readFirst.map((f) => `- \`${f}\``).join("\n")}
`
    : "";

  return `## Relay Workflow Protocol

You are agent **${node.agent.name}** in a DAG workflow implementing relay-cloud PR #94.

**Channel:** #${WORKFLOW_CHANNEL}
**Your node:** ${node.id}
**Dependencies:** ${node.dependsOn.length > 0 ? node.dependsOn.join(", ") : "none (root node)"}

### Protocol
- When you finish, send a relay message starting with: DONE: <detailed summary>
- Your DONE message is critical — downstream agents depend on it. Include key type signatures, file paths, method names.
- If blocked, send: ERROR: <description>
- Work only on your assigned task.

${readFirstSection}
${depContext ? `### Context from Dependencies\n\n${depContext}` : ""}

---

`;
}

// ── DAG Scheduler ──────────────────────────────────────────────────────────

function topologicalSort(dagNodes: DagNode[]): string[] {
  const sorted: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const nodeMap = new Map(dagNodes.map((n) => [n.id, n]));

  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Cycle detected: ${id}`);
    visiting.add(id);
    const node = nodeMap.get(id);
    if (!node) throw new Error(`Unknown node: ${id}`);
    for (const dep of node.dependsOn) visit(dep);
    visiting.delete(id);
    visited.add(id);
    sorted.push(id);
  }

  for (const node of dagNodes) visit(node.id);
  return sorted;
}

function getReadyNodes(
  dagNodes: DagNode[],
  completedSet: Set<string>,
  runningSet: Set<string>,
  failedSet: Set<string>,
): DagNode[] {
  return dagNodes.filter(
    (n) =>
      !completedSet.has(n.id) &&
      !runningSet.has(n.id) &&
      !failedSet.has(n.id) &&
      n.dependsOn.every((dep) => completedSet.has(dep)),
  );
}

function markBlockedDownstream(
  failedNodeId: string,
  dagNodes: DagNode[],
  failedSet: Set<string>,
  completedSet: Set<string>,
  results: Map<string, NodeResult>,
): void {
  const queue = [failedNodeId];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    for (const node of dagNodes) {
      if (
        node.dependsOn.includes(currentId) &&
        !failedSet.has(node.id) &&
        !completedSet.has(node.id)
      ) {
        failedSet.add(node.id);
        results.set(node.id, {
          nodeId: node.id,
          agentName: node.agent.name,
          output: `Blocked: dependency "${currentId}" failed`,
          status: "blocked",
          durationMs: 0,
        });
        console.log(`  ⊘ ${node.id}: blocked by failed dependency "${currentId}"`);
        queue.push(node.id);
      }
    }
  }
}

// ── DAG Node Definitions ──────────────────────────────────────────────────

const nodes: DagNode[] = [
  {
    id: "shared-types",
    agent: { name: "TypesWorker", cli: "claude" },
    dependsOn: [],
    readFirst: ["packages/sdk-ts/src/protocol.ts", "packages/sdk-ts/src/relay.ts"],
    task: `You are implementing the shared TypeScript types for the relay-cloud swarm patterns system (PR #94).

## Before You Start
Read the existing protocol types and relay facade to understand naming conventions and patterns.

## Your Task
Create the file: packages/cloud/src/types/workflow.ts

Define these types: RelayYamlConfig, SwarmConfig, AgentDefinition, WorkflowDefinition, WorkflowStep, VerificationCheck, CoordinationConfig, Barrier, StateConfig, ErrorHandlingConfig, AgentConstraints, WorkflowRunRow, WorkflowStepRow.

Also extend packages/cloud/src/config/relay-yaml-schema.json with the JSON Schema for relay.yaml validation.

Your DONE message MUST include the key type names, their fields, and file paths created.

DONE: <detailed summary including type signatures>`,
  },
  {
    id: "db-migration",
    agent: { name: "DbWorker", cli: "claude" },
    dependsOn: ["shared-types"],
    readFirst: ["packages/cloud/src/db/migrations/"],
    task: `Create database migration: packages/cloud/src/db/migrations/0023_workflows.sql

Tables: workflow_runs, workflow_steps, swarm_state, workflow_barriers (see dependency context for exact column types).

Your DONE message MUST include the table names, column names, and FK relationships.

DONE: <detailed summary including table schemas>`,
  },
  {
    id: "workflow-runner",
    agent: { name: "RunnerWorker", cli: "claude" },
    dependsOn: ["shared-types", "db-migration"],
    readFirst: ["packages/sdk-ts/src/relay.ts", "packages/sdk-ts/src/client.ts"],
    task: `Create: packages/cloud/src/services/workflow-runner.ts

WorkflowRunner class: parse relay.yaml, validate, resolve templates, resolve {{variables}}, execute steps (sequential/parallel/dag), run verification checks, persist state to DB, support pause/resume/abort, handle retries + escalation. Use AgentRelay from @agent-relay/broker-sdk for spawning.

Your DONE message MUST include class name, key method signatures, and AgentRelay integration points.

DONE: <detailed summary>`,
  },
  {
    id: "swarm-coordinator",
    agent: { name: "CoordinatorWorker", cli: "claude" },
    dependsOn: ["shared-types", "db-migration"],
    readFirst: ["packages/sdk-ts/src/consensus.ts", "packages/sdk-ts/src/shadow.ts"],
    task: `Create three files:
1. packages/cloud/src/services/swarm-coordinator.ts — pattern selection, agent topology, lifecycle
2. packages/cloud/src/services/barrier-manager.ts — barrier tracking with all/any/majority support
3. packages/cloud/src/services/state-store.ts — CRUD on swarm_state with consensus-gated writes

Your DONE message MUST include class names, key methods, and pattern auto-selection mapping.

DONE: <detailed summary>`,
  },
  {
    id: "templates",
    agent: { name: "TemplateWorker", cli: "codex" },
    dependsOn: ["shared-types"],
    task: `Create 6 YAML templates in packages/cloud/src/templates/ (feature-dev, bug-fix, code-review, security-audit, refactor, documentation) and a TemplateRegistry class in packages/cloud/src/services/template-registry.ts.

Your DONE message MUST include template names and TemplateRegistry method signatures.

DONE: <detailed summary>`,
  },
  {
    id: "cloud-api",
    agent: { name: "ApiWorker", cli: "claude" },
    dependsOn: ["workflow-runner", "swarm-coordinator"],
    readFirst: ["packages/cloud/src/api/"],
    task: `Create REST API endpoints:
1. packages/cloud/src/api/workflows.ts — CRUD for workflow runs + steps
2. packages/cloud/src/api/swarm.ts — state store + barrier endpoints
3. packages/cloud/src/api/dashboard-swarms.ts — dashboard endpoints + SSE streaming

Plus WebSocket events for swarm lifecycle.

Your DONE message MUST include all endpoint paths and response shapes.

DONE: <detailed summary>`,
  },
  {
    id: "cli-commands",
    agent: { name: "CliWorker", cli: "claude" },
    dependsOn: ["shared-types", "templates"],
    readFirst: ["src/commands/"],
    task: `Implement "agent-relay swarm" CLI command group: run, list, status, stop, logs, history, plus shorthand aliases (feature, fix, review, audit, refactor, docs), template management, and relay.yaml config resolution.

Your DONE message MUST include all command names and flag options.

DONE: <detailed summary>`,
  },
  {
    id: "dashboard-panel",
    agent: { name: "DashboardWorker", cli: "claude" },
    dependsOn: ["cloud-api"],
    task: `Build React components: SwarmPanel.tsx, TopologyView.tsx, StepProgress.tsx, AgentOutputStream.tsx. Use Tailwind CSS, SSE for live output, WebSocket for topology updates.

DONE: <detailed summary>`,
  },
  {
    id: "integration-tests",
    agent: { name: "TestWorker", cli: "claude" },
    dependsOn: ["cloud-api", "cli-commands"],
    task: `Write integration tests: workflow-runner.test.ts, swarm-coordinator.test.ts, api-endpoints.test.ts, swarm-commands.test.ts, error-scenarios.test.ts. Mock the broker SDK for unit tests.

DONE: <detailed summary>`,
  },
];

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Swarm Patterns Implementation — DAG Workflow Executor      ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();

  const order = topologicalSort(nodes);
  console.log(`DAG validated. Execution order: ${order.join(" → ")}`);
  console.log(`Max concurrency: ${MAX_CONCURRENCY}`);
  console.log(`Agent timeout: ${AGENT_TIMEOUT_MS / 60_000}m`);
  console.log();

  if (DRY_RUN) {
    console.log("── DRY RUN MODE ──");
    console.log();
    const simCompleted = new Set<string>();
    let wave = 1;
    let ready = getReadyNodes(nodes, simCompleted, new Set(), new Set());
    while (ready.length > 0) {
      console.log(`  Wave ${wave}: ${ready.map((n) => `${n.id} (${n.agent.name}/${n.agent.cli})`).join(", ")}`);
      for (const n of ready) simCompleted.add(n.id);
      wave++;
      ready = getReadyNodes(nodes, simCompleted, new Set(), new Set());
    }
    console.log();
    console.log(`Total waves: ${wave - 1} | Total nodes: ${nodes.length}`);
    console.log("\nDry run complete. No agents spawned.");
    return;
  }

  // Initialize broker SDK client
  console.log("Connecting to broker...");
  await ensureClient();
  console.log("Connected.\n");

  const completed = new Set<string>();
  const running = new Set<string>();
  const failed = new Set<string>();
  const results = new Map<string, NodeResult>();
  const depsOutput = new Map<string, string>();
  let startTime = Date.now();

  if (RESUME) {
    const state = loadState();
    if (state) {
      for (const id of state.completed) completed.add(id);
      for (const [k, v] of Object.entries(state.depsOutput)) depsOutput.set(k, v);
      for (const [k, v] of Object.entries(state.results)) results.set(k, v);
      startTime = new Date(state.startedAt).getTime();
      console.log(`Resumed: ${completed.size} nodes done (${[...completed].join(", ")})\n`);
    }
  }

  console.log("Starting workflow...\n");

  async function executeNode(node: DagNode): Promise<NodeResult> {
    const nodeStart = Date.now();
    running.add(node.id);
    console.log(`\n── Starting: ${node.id} (${node.agent.name}/${node.agent.cli}) ──`);

    const conventions = buildConventions(node, depsOutput);
    const fullTask = conventions + node.task;

    try {
      await client.spawnPty({
        name: node.agent.name,
        cli: node.agent.cli,
        args: [fullTask],
        channels: [WORKFLOW_CHANNEL],
      });
      console.log(`  ↑ Spawned: ${node.agent.name}`);
    } catch (err) {
      return {
        nodeId: node.id,
        agentName: node.agent.name,
        output: `Spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        status: "failed",
        durationMs: Date.now() - nodeStart,
      };
    }

    const { status, output } = await watchForDone(node.agent.name, AGENT_TIMEOUT_MS);

    try {
      await client.release(node.agent.name);
    } catch {
      // Agent may already be gone
    }
    console.log(`  ${status === "completed" ? "✓" : "✗"} ${node.agent.name}: ${output.slice(0, 100)}`);

    return { nodeId: node.id, agentName: node.agent.name, output, status, durationMs: Date.now() - nodeStart };
  }

  const totalNodes = nodes.length;

  while (completed.size + failed.size < totalNodes) {
    const ready = getReadyNodes(nodes, completed, running, failed);

    if (ready.length === 0 && running.size === 0) {
      const remaining = nodes.filter((n) => !completed.has(n.id) && !failed.has(n.id));
      if (remaining.length > 0) console.error(`\nDeadlock: ${remaining.map((n) => n.id).join(", ")}`);
      break;
    }

    if (ready.length === 0 || MAX_CONCURRENCY - running.size <= 0) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    const toRun = ready.slice(0, MAX_CONCURRENCY - running.size);
    const promises = toRun.map(async (node) => {
      const result = await executeNode(node);
      running.delete(node.id);

      if (result.status === "completed") {
        completed.add(node.id);
        depsOutput.set(node.id, result.output);
      } else {
        failed.add(node.id);
        markBlockedDownstream(node.id, nodes, failed, completed, results);
      }

      results.set(node.id, result);
      saveState(completed, depsOutput, results, startTime);
    });

    await Promise.allSettled(promises);
  }

  // Shutdown client
  await client.shutdown();

  // Summary
  const totalMs = Date.now() - startTime;
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Workflow Complete                                          ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log(`Time: ${(totalMs / 60_000).toFixed(1)}m | Completed: ${completed.size} | Failed: ${failed.size} | Blocked: ${[...results.values()].filter((r) => r.status === "blocked").length}\n`);

  for (const node of nodes) {
    const r = results.get(node.id);
    if (!r) { console.log(`  ? ${node.id.padEnd(20)} not reached`); continue; }
    const icon = r.status === "completed" ? "✓" : r.status === "blocked" ? "⊘" : "✗";
    const dur = r.durationMs > 0 ? `${(r.durationMs / 60_000).toFixed(1)}m` : "  -";
    console.log(`  ${icon} ${node.id.padEnd(20)} ${dur.padEnd(6)} ${r.output.slice(0, 50)}`);
  }

  if (failed.size > 0) {
    console.log("\nTo retry: fix issues, then run with --resume");
    process.exit(1);
  }

  if (existsSync(STATE_FILE)) writeFileSync(STATE_FILE + ".done", readFileSync(STATE_FILE));
}

main().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
