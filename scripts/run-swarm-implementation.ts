#!/usr/bin/env npx tsx
/**
 * Broker SDK script to execute the relay-cloud PR #94 implementation plan.
 *
 * Uses a DAG pattern to coordinate 10 agents across 9 work nodes with
 * dependency-aware parallel execution.
 *
 * Usage:
 *   npx tsx scripts/run-swarm-implementation.ts
 *   npx tsx scripts/run-swarm-implementation.ts --dry-run
 *   npx tsx scripts/run-swarm-implementation.ts --max-concurrency 3
 *   npx tsx scripts/run-swarm-implementation.ts --resume
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { AgentRelay } from "@agent-relay/sdk-ts";
import type { Agent, Message } from "@agent-relay/sdk-ts";

// ── Configuration ──────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const RESUME = process.argv.includes("--resume");
const MAX_CONCURRENCY = (() => {
  const idx = process.argv.indexOf("--max-concurrency");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 4;
})();
const WORKFLOW_CHANNEL = "swarm-impl";
const AGENT_TIMEOUT_MS = 30 * 60_000; // 30 minutes per agent
const STATE_FILE = ".relay/swarm-impl-state.json";

// ── Types ──────────────────────────────────────────────────────────────────

interface DagNode {
  id: string;
  agent: AgentSpec;
  task: string;
  dependsOn: string[];
  /** Files the agent should read before starting to understand existing patterns */
  readFirst?: string[];
}

interface AgentSpec {
  name: string;
  cli: "claude" | "codex";
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

// ── State Persistence (--resume support) ───────────────────────────────────

function saveState(
  completed: Set<string>,
  depsOutput: Map<string, string>,
  results: Map<string, NodeResult>,
  startedAt: number,
): void {
  const state: PersistedState = {
    completed: [...completed],
    depsOutput: Object.fromEntries(depsOutput),
    results: Object.fromEntries(results),
    startedAt: new Date(startedAt).toISOString(),
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): PersistedState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

// ── DAG Definition ─────────────────────────────────────────────────────────

const nodes: DagNode[] = [
  {
    id: "shared-types",
    agent: { name: "TypesWorker", cli: "claude" },
    dependsOn: [],
    readFirst: [
      "packages/sdk-ts/src/protocol.ts",
      "packages/sdk-ts/src/relay.ts",
    ],
    task: `You are implementing the shared TypeScript types for the relay-cloud swarm patterns system (PR #94).

## Before You Start
Read the existing protocol types and relay facade to understand naming conventions, existing patterns, and how types are structured in this project.

## Context
We are building a YAML-based workflow configuration system for Agent Relay that enables pre-built multi-agent coordination patterns via relay.yaml.

## Your Task
Create the file: packages/cloud/src/types/workflow.ts

Define these types:
1. RelayYamlConfig — top-level config with version and swarm field
2. SwarmConfig — pattern, agents, workflow, coordination, errorHandling
3. AgentDefinition — id, name, role (lead/worker/specialist/coordinator), cli, model, reportsTo, constraints
4. WorkflowDefinition — id, name, steps array
5. WorkflowStep — id, agent, prompt, dependsOn, expects, maxRetries, verify, outputs
6. VerificationCheck — command, expectExit, fileExists, fileContains, script, timeout
7. CoordinationConfig — mode (sequential/parallel/dag), barriers, state
8. Barrier — id, waitFor, signal, timeout, type (all/any/majority)
9. StateConfig — enabled, persistence (memory/sqlite/redis), initial, rules
10. ErrorHandlingConfig — maxRetries, retryDelay, escalateTo, onFailure (pause/abort/continue)
11. AgentConstraints — fileScope (include/exclude), readOnly, noCreate, maxTokens, maxDuration, noNetwork, noExec
12. WorkflowRunRow, WorkflowStepRow — DB row types for persistence

Also extend packages/cloud/src/config/relay-yaml-schema.json with the JSON Schema for relay.yaml validation.

Export all types. Follow the existing TypeScript conventions in the project.

When you finish, your DONE message MUST include:
1. The key type names and their fields
2. The file paths created
3. Key interface signatures that downstream agents will need

DONE: <detailed summary including type signatures>`,
  },
  {
    id: "db-migration",
    agent: { name: "DbWorker", cli: "claude" },
    dependsOn: ["shared-types"],
    readFirst: [
      "packages/cloud/src/db/migrations/",
    ],
    task: `You are creating the database migration for the swarm patterns system.

## Before You Start
Read existing migrations in packages/cloud/src/db/migrations/ to understand the naming convention, SQL style, and how existing tables are structured.

## Context
The shared types have been defined. See the dependency output below for the exact type signatures.

## Your Task
Create: packages/cloud/src/db/migrations/0023_workflows.sql

Tables to create:
1. workflow_runs — id (UUID PK), workspace_id (FK to workspaces), workflow_id, task, status (pending/running/completed/failed/paused), config (JSONB), result (JSONB), created_at, updated_at, completed_at
2. workflow_steps — id (UUID PK), run_id (FK to workflow_runs CASCADE), step_id, agent_id, status, input, output, retries, error, verification_results (JSONB), started_at, completed_at. UNIQUE(run_id, step_id)
3. swarm_state — (workspace_id, key) composite PK, value (JSONB), updated_by, updated_at
4. workflow_barriers — id (UUID PK), run_id (FK), barrier_id, status (waiting/signaled/timeout), signaled_by (TEXT[]), created_at, signaled_at. UNIQUE(run_id, barrier_id)

Add indexes:
- idx_workflow_runs_workspace ON workflow_runs(workspace_id, status)
- idx_workflow_runs_status ON workflow_runs(status)
- idx_workflow_steps_run ON workflow_steps(run_id)
- idx_workflow_barriers_run ON workflow_barriers(run_id)

When you finish, your DONE message MUST include the table names, column names, and any FK relationships so downstream agents can write queries correctly.

DONE: <detailed summary including table schemas>`,
  },
  {
    id: "workflow-runner",
    agent: { name: "RunnerWorker", cli: "claude" },
    dependsOn: ["shared-types", "db-migration"],
    readFirst: [
      "packages/sdk-ts/src/relay.ts",
      "packages/sdk-ts/src/client.ts",
    ],
    task: `You are implementing the core WorkflowRunner service.

## Before You Start
Read the AgentRelay class and client to understand how agents are spawned and messaged. Pay attention to spawnPty(), sendMessage(), and event hooks.

## Context
Shared types and DB migration are complete. See dependency output below for the exact types and table schemas.

## Your Task
Create: packages/cloud/src/services/workflow-runner.ts

The WorkflowRunner class should:
1. Parse relay.yaml configs using the yaml npm package
2. Validate configs against the JSON schema
3. Resolve template references (e.g., "swarm: feature-dev" -> full config from templates)
4. Resolve template variables: {{task}}, {{steps.<id>.output}}, {{git.diff}}, {{git.branch}}
5. Execute steps in order based on coordination mode:
   - sequential: one at a time
   - parallel: all at once
   - dag: topological sort, run parallel where dependencies allow
6. Run verification checks after each step (command + expectExit, fileExists, fileContains)
7. Extract outputs from agent responses using regex patterns
8. Persist run/step state to database (create run, update step status, store output)
9. Support pause/resume/abort lifecycle
10. Handle retries with configurable delay and max attempts
11. Escalate failures to the lead agent per errorHandling config

Integration with broker SDK:
- Use AgentRelay from @agent-relay/sdk-ts for spawning agents
- Use agent.sendMessage() to inject step prompts
- Listen for DONE messages to determine step completion
- Parse output from DONE messages

When you finish, your DONE message MUST include the class name, key method signatures, and how it integrates with AgentRelay.

DONE: <detailed summary>`,
  },
  {
    id: "swarm-coordinator",
    agent: { name: "CoordinatorWorker", cli: "claude" },
    dependsOn: ["shared-types", "db-migration"],
    readFirst: [
      "packages/sdk-ts/src/consensus.ts",
      "packages/sdk-ts/src/shadow.ts",
    ],
    task: `You are implementing the SwarmCoordinator, BarrierManager, and StateStore services.

## Before You Start
Read the ConsensusEngine and ShadowManager to understand existing coordination primitives you can reuse.

## Context
Shared types and DB migration are complete. See dependency output for details.

## Your Task
Create three files:

### 1. packages/cloud/src/services/swarm-coordinator.ts
SwarmCoordinator class:
- Select pattern based on config or auto-detect from command type
- Auto-mapping: feature->hub-spoke, fix->hub-spoke, review->consensus, refactor->hierarchical, brainstorm->mesh, decide->consensus
- Map pattern to agent topology and spawn order
- Coordinate agent lifecycle via broker SDK (AgentRelay)
- Handle error escalation per errorHandling config

### 2. packages/cloud/src/services/barrier-manager.ts
BarrierManager class:
- Create barriers in workflow_barriers table
- Track which agents have signaled
- Support "all" (wait for everyone), "any" (first signal), "majority" (>50%)
- Timeout barriers after configured duration
- Signal barriers when agents complete

### 3. packages/cloud/src/services/state-store.ts
StateStore class:
- CRUD on swarm_state table (workspace-scoped)
- Consensus-required updates: check if key has a rule requiring votes from specific agents
- Optimistic locking via updated_at timestamp
- Get/set/delete operations

When you finish, your DONE message MUST include class names, key method signatures, and how pattern auto-selection works.

DONE: <detailed summary>`,
  },
  {
    id: "templates",
    agent: { name: "TemplateWorker", cli: "codex" },
    dependsOn: ["shared-types"],
    task: `You are creating the built-in workflow templates and template registry.

## Your Task

### Template files (YAML)
Create 6 template files in packages/cloud/src/templates/:

1. feature-dev.yaml — hub-spoke pattern, 4 agents (lead, planner, developer, reviewer), steps: plan->implement->review->finalize, verify build+lint after implement
2. bug-fix.yaml — hub-spoke pattern, 3 agents (lead, investigator, fixer), steps: investigate->fix->verify, verify tests pass
3. code-review.yaml — fan-out pattern, N reviewers, parallel analysis->report
4. security-audit.yaml — pipeline, 4 agents (scanner, analyst, fixer, verifier), steps: scan->prioritize->fix->verify
5. refactor.yaml — pipeline, 3 agents (analyst, planner, implementer), steps: analyze->plan->execute
6. documentation.yaml — pipeline, 2 agents (extractor, writer), steps: extract->write

### Template Registry
Create: packages/cloud/src/services/template-registry.ts
- Load built-in templates from src/templates/
- Load custom templates from .relay/workflows/
- Resolve template by name
- Apply overrides (dot-notation paths like "steps.plan.maxRetries")
- List available templates

When you finish, your DONE message MUST include the template names and the TemplateRegistry method signatures.

DONE: <detailed summary>`,
  },
  {
    id: "cloud-api",
    agent: { name: "ApiWorker", cli: "claude" },
    dependsOn: ["workflow-runner", "swarm-coordinator"],
    readFirst: [
      "packages/cloud/src/api/",
    ],
    task: `You are implementing the REST API endpoints for workflows, swarm state, and dashboard.

## Before You Start
Read existing API route files in packages/cloud/src/api/ to understand routing patterns, middleware, error handling, and response format conventions.

## Context
WorkflowRunner and SwarmCoordinator are complete. See dependency output for their class signatures and methods.

## Your Task
Create three route files:

### 1. packages/cloud/src/api/workflows.ts
- POST /api/workflows/run — start a workflow run (body: { workflow, task, overrides? })
- GET /api/workflows/runs — list runs (query: status, limit, offset)
- GET /api/workflows/runs/:id — get run details
- POST /api/workflows/runs/:id/pause — pause
- POST /api/workflows/runs/:id/resume — resume
- POST /api/workflows/runs/:id/abort — abort
- GET /api/workflows/runs/:id/steps — list steps
- GET /api/workflows/runs/:id/steps/:stepId — step details

### 2. packages/cloud/src/api/swarm.ts
- GET /api/swarm/state — get all state
- GET /api/swarm/state/:key — get by key
- PUT /api/swarm/state/:key — update (body: { value, voter? })
- DELETE /api/swarm/state/:key — delete
- POST /api/swarm/barriers/:id/signal — signal barrier (body: { agent })
- GET /api/swarm/barriers/:id/status — check barrier

### 3. packages/cloud/src/api/dashboard-swarms.ts
- GET /api/dashboard/swarms — list active swarms
- POST /api/dashboard/swarms — start swarm from dashboard
- GET /api/dashboard/swarms/:id — get swarm details
- DELETE /api/dashboard/swarms/:id — stop swarm
- GET /api/dashboard/swarms/:id/output — SSE stream of agent output
- GET /api/dashboard/swarms/:id/topology — agent connection graph
- GET /api/dashboard/swarms/history — past runs
- GET /api/dashboard/workflows — available workflows
- GET /api/dashboard/patterns — available patterns

Add WebSocket event emissions for: swarm:started, swarm:step:started, swarm:step:completed, swarm:agent:message, swarm:completed, swarm:failed.

Follow existing API patterns in the project. Add proper auth middleware and workspace scoping.

DONE: <detailed summary>`,
  },
  {
    id: "cli-commands",
    agent: { name: "CliWorker", cli: "claude" },
    dependsOn: ["shared-types", "templates"],
    readFirst: [
      "src/commands/",
    ],
    task: `You are implementing the CLI subcommands for agent-relay swarm.

## Before You Start
Read existing CLI command files in src/commands/ to understand argument parsing patterns, output formatting, and how commands are registered.

## Your Task
Create: packages/cli/src/commands/workflow.ts (or in the relay repo if that's where CLI lives)

Implement the "agent-relay swarm" command group:

### Core subcommands
- agent-relay swarm run <workflow> [task] — run a workflow
- agent-relay swarm list — list available workflows (built-in + custom)
- agent-relay swarm status [run-id] — check run status
- agent-relay swarm stop [run-id] — stop a running swarm
- agent-relay swarm logs [run-id] — view agent output logs
- agent-relay swarm history — list past runs

### Shorthand aliases
- agent-relay swarm feature "..." → run feature-dev
- agent-relay swarm fix "..." → run bug-fix
- agent-relay swarm review → run code-review
- agent-relay swarm audit → run security-audit
- agent-relay swarm refactor "..." → run refactor
- agent-relay swarm docs "..." → run documentation

### Template management
- agent-relay swarm templates — list templates
- agent-relay swarm templates show <name> — show template YAML
- agent-relay swarm validate — validate .relay/relay.yaml

### CLI flags
- --pattern <name> — override pattern
- --agents <n> — override agent count
- --timeout <duration> — max run time (e.g., "30m")
- --dry-run — validate without executing
- --verbose — detailed output
- --json — JSON output format

### Top-level aliases (register at root level)
- agent-relay feature "..." → shorthand for swarm feature
- agent-relay fix "..." → shorthand for swarm fix

Use the relay.yaml config resolution order:
1. .relay/relay.yaml (project root)
2. relay.yaml (project root, legacy)
3. ~/.config/agent-relay/relay.yaml (user defaults)

Show progress in real-time: step name, agent status, duration.

DONE: <detailed summary>`,
  },
  {
    id: "dashboard-panel",
    agent: { name: "DashboardWorker", cli: "claude" },
    dependsOn: ["cloud-api"],
    task: `You are building the swarm panel UI for the relay dashboard.

## Context
API endpoints are complete. See dependency output for exact endpoint paths and response shapes.

## Your Task
Create React components in the relay-dashboard repo (or packages/dashboard if it exists):

1. SwarmPanel.tsx — main panel component
   - List active and recent swarms
   - "New Swarm" button with workflow selector
   - Status badges (running, completed, failed, paused)
   - Click to expand details

2. TopologyView.tsx — live agent connection graph
   - Hub-spoke: star layout with hub center
   - Hierarchical: tree layout
   - Mesh: force-directed graph
   - Consensus: circle layout
   - Nodes show agent name + status
   - Edges show message flow
   - Update in real-time via WebSocket events

3. StepProgress.tsx — step timeline
   - Horizontal timeline of workflow steps
   - Status indicators: pending (gray), running (blue pulse), completed (green), failed (red)
   - Step name, agent name, duration
   - Expandable to show step output

4. AgentOutputStream.tsx — live agent output
   - SSE connection to /api/dashboard/swarms/:id/output
   - Tabbed view (one tab per agent)
   - Auto-scroll with pause button
   - Syntax highlighting for code blocks

Follow existing dashboard design patterns. Use Tailwind CSS.

DONE: <detailed summary>`,
  },
  {
    id: "integration-tests",
    agent: { name: "TestWorker", cli: "claude" },
    dependsOn: ["cloud-api", "cli-commands"],
    task: `You are writing integration tests for the swarm patterns system.

## Context
All API endpoints and CLI commands are implemented. See dependency output for details.

## Your Task
Create test files:

### 1. packages/cloud/tests/workflow-runner.test.ts
- Sequential workflow executes steps in order
- DAG workflow runs parallel nodes and joins correctly
- Verification checks gate step completion
- Template variable resolution ({{task}}, {{steps.plan.output}})
- Retry logic on step failure
- Pause/resume workflow

### 2. packages/cloud/tests/swarm-coordinator.test.ts
- Hub-spoke: lead spawns first, workers report to lead
- Hierarchical: multi-level spawn order correct
- Mesh: all agents on same channel
- Consensus: votes collected and tallied
- Auto-pattern selection by command type

### 3. packages/cloud/tests/api-endpoints.test.ts
- POST /api/workflows/run creates a run
- GET /api/workflows/runs returns paginated list
- Pause/resume/abort lifecycle
- State store CRUD operations
- Barrier signaling
- SSE streaming test

### 4. packages/cli/tests/swarm-commands.test.ts (or appropriate location)
- "swarm run feature-dev" resolves template
- "swarm validate" checks relay.yaml
- --dry-run flag prevents agent spawning
- Shorthand aliases map correctly
- --json flag outputs valid JSON

### 5. packages/cloud/tests/error-scenarios.test.ts
- Agent crash mid-workflow triggers retry
- All retries exhausted escalates to lead
- Barrier timeout triggers failure
- Invalid relay.yaml rejected with helpful error
- Missing template returns 404

Use the project's existing test framework. Mock the broker SDK for unit tests.

DONE: <detailed summary>`,
  },
];

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
Before writing any code, read these files to understand existing patterns and conventions:
${node.readFirst.map((f) => `- \`${f}\``).join("\n")}
`
    : "";

  return `## Relay Workflow Protocol

You are agent **${node.agent.name}** in a DAG workflow implementing relay-cloud PR #94.

**Channel:** #${WORKFLOW_CHANNEL}
**Your node:** ${node.id}
**Dependencies:** ${node.dependsOn.length > 0 ? node.dependsOn.join(", ") : "none (root node)"}

### Protocol
- When you finish, send a message starting with: DONE: <detailed summary>
- Your DONE message is critical — downstream agents depend on it for context. Include key type signatures, file paths created, method names, and anything a dependent agent needs to write correct code.
- If you encounter a blocking error, send: ERROR: <description>
- Work only on your assigned task. Do not modify files outside your scope.

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

function getRootNodes(dagNodes: DagNode[]): DagNode[] {
  return dagNodes.filter((n) => n.dependsOn.length === 0);
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

/** Mark all downstream nodes as blocked when a dependency fails */
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

// ── DONE Message Parser ────────────────────────────────────────────────────

const DONE_REGEX = /^DONE:\s*(.+)/ms;
const ERROR_REGEX = /^ERROR:\s*(.+)/ms;

function parseDone(text: string): string | undefined {
  const match = text.match(DONE_REGEX);
  return match?.[1]?.trim();
}

function parseError(text: string): string | undefined {
  const match = text.match(ERROR_REGEX);
  return match?.[1]?.trim();
}

// ── Main Execution ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Swarm Patterns Implementation — DAG Workflow Executor      ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();

  // Validate DAG
  const order = topologicalSort(nodes);
  console.log(`DAG validated. Execution order: ${order.join(" → ")}`);
  console.log(`Max concurrency: ${MAX_CONCURRENCY}`);
  console.log(`Agent timeout: ${AGENT_TIMEOUT_MS / 60_000}m`);
  console.log();

  if (DRY_RUN) {
    console.log("── DRY RUN MODE ──");
    console.log();
    console.log("Execution plan:");

    const simCompleted = new Set<string>();
    const simFailed = new Set<string>();
    let wave = 1;

    let ready = getRootNodes(nodes);
    while (ready.length > 0) {
      console.log(`  Wave ${wave}: ${ready.map((n) => `${n.id} (${n.agent.name}/${n.agent.cli})`).join(", ")}`);
      if (ready[0]?.readFirst?.length) {
        console.log(`    reads: ${ready[0].readFirst.join(", ")}`);
      }
      for (const n of ready) simCompleted.add(n.id);
      wave++;
      ready = getReadyNodes(nodes, simCompleted, new Set(), simFailed);
    }

    console.log();
    console.log(`Total waves: ${wave - 1}`);
    console.log("Dry run complete. No agents were spawned.");
    return;
  }

  // Initialize relay
  const relay = new AgentRelay();
  const agents = new Map<string, Agent>();
  const completed = new Set<string>();
  const running = new Set<string>();
  const failed = new Set<string>();
  const results = new Map<string, NodeResult>();
  const depsOutput = new Map<string, string>();
  let startTime = Date.now();

  // Resume from persisted state if --resume flag
  if (RESUME) {
    const state = loadState();
    if (state) {
      for (const id of state.completed) completed.add(id);
      for (const [k, v] of Object.entries(state.depsOutput)) depsOutput.set(k, v);
      for (const [k, v] of Object.entries(state.results)) results.set(k, v);
      startTime = new Date(state.startedAt).getTime();
      console.log(`Resumed from ${STATE_FILE}: ${completed.size} nodes already completed`);
      console.log(`  Completed: ${[...completed].join(", ")}`);
      console.log();
    } else {
      console.log("No state file found, starting fresh.");
      console.log();
    }
  }

  // Track messages per agent for DONE detection
  const agentMessages = new Map<string, string[]>();

  relay.onMessageReceived = (message: Message) => {
    const msgs = agentMessages.get(message.from) ?? [];
    msgs.push(message.text);
    agentMessages.set(message.from, msgs);

    // Check for DONE or ERROR
    const done = parseDone(message.text);
    const error = parseError(message.text);
    if (done || error) {
      console.log(
        `  ${done ? "✓" : "✗"} ${message.from}: ${(done ?? error ?? "").slice(0, 120)}`,
      );
    }
  };

  relay.onAgentSpawned = (agent: Agent) => {
    console.log(`  ↑ Spawned: ${agent.name}`);
  };

  relay.onAgentExited = (data: { name: string; exitCode: number }) => {
    console.log(`  ↓ Exited: ${data.name} (code ${data.exitCode})`);
  };

  console.log("Starting workflow...\n");

  // ── Execute DAG ────────────────────────────────────────────────────────

  async function executeNode(node: DagNode): Promise<NodeResult> {
    const nodeStart = Date.now();
    running.add(node.id);
    console.log(`\n── Starting: ${node.id} (${node.agent.name}/${node.agent.cli}) ──`);

    // Build task with convention injection + dependency context
    const conventions = buildConventions(node, depsOutput);
    const fullTask = conventions + node.task;

    // Spawn agent
    const agent = await relay.spawnPty({
      name: node.agent.name,
      cli: node.agent.cli,
      channels: [WORKFLOW_CHANNEL],
    });
    agents.set(node.id, agent);

    // Send task via human handle
    const system = relay.human({ name: "Orchestrator" });
    await system.sendMessage({
      to: agent.name,
      text: fullTask,
    });

    // Wait for DONE message or timeout
    const result = await new Promise<NodeResult>((resolve) => {
      let resolved = false;

      const checkInterval = setInterval(() => {
        if (resolved) return;
        const msgs = agentMessages.get(agent.name) ?? [];
        for (const msg of msgs) {
          const done = parseDone(msg);
          if (done) {
            resolved = true;
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve({
              nodeId: node.id,
              agentName: agent.name,
              output: done,
              status: "completed",
              durationMs: Date.now() - nodeStart,
            });
            return;
          }
          const error = parseError(msg);
          if (error) {
            resolved = true;
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve({
              nodeId: node.id,
              agentName: agent.name,
              output: error,
              status: "failed",
              durationMs: Date.now() - nodeStart,
            });
            return;
          }
        }
      }, 2000);

      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        clearInterval(checkInterval);
        resolve({
          nodeId: node.id,
          agentName: agent.name,
          output: "Agent timed out after " + (AGENT_TIMEOUT_MS / 60_000) + " minutes",
          status: "failed",
          durationMs: Date.now() - nodeStart,
        });
      }, AGENT_TIMEOUT_MS);
    });

    // Release agent
    try {
      await agent.release();
    } catch {
      // Agent may have already exited
    }

    return result;
  }

  // ── DAG Loop ───────────────────────────────────────────────────────────

  const totalNodes = nodes.length;

  try {
    while (completed.size + failed.size < totalNodes) {
      const ready = getReadyNodes(nodes, completed, running, failed);

      if (ready.length === 0 && running.size === 0) {
        // Check if remaining nodes are all blocked
        const remaining = nodes.filter(
          (n) => !completed.has(n.id) && !failed.has(n.id),
        );
        if (remaining.length > 0) {
          console.error(
            `\nDeadlock: ${remaining.length} nodes unreachable: ${remaining.map((n) => n.id).join(", ")}`,
          );
        }
        break;
      }

      if (ready.length === 0) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      // Respect max concurrency
      const slots = MAX_CONCURRENCY - running.size;
      if (slots <= 0) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      const toRun = ready.slice(0, slots);

      // Execute batch with Promise.allSettled for proper error handling
      const promises = toRun.map(async (node) => {
        const result = await executeNode(node);
        running.delete(node.id);

        if (result.status === "completed") {
          completed.add(node.id);
          depsOutput.set(node.id, result.output);
        } else {
          failed.add(node.id);
          // Immediately mark all downstream nodes as blocked
          markBlockedDownstream(node.id, nodes, failed, completed, results);
        }

        results.set(node.id, result);

        // Persist state after each node completion
        saveState(completed, depsOutput, results, startTime);

        return result;
      });

      // Wait for all in this batch to complete
      await Promise.allSettled(promises);
    }
  } finally {
    // Cleanup: release all remaining agents
    for (const [, agent] of agents) {
      try {
        await agent.release();
      } catch {
        // Already released
      }
    }
    await relay.shutdown();

    // Final state save
    saveState(completed, depsOutput, results, startTime);
  }

  // ── Summary ────────────────────────────────────────────────────────────

  const totalMs = Date.now() - startTime;
  const completedNodes = [...results.values()].filter((r) => r.status === "completed");
  const failedNodes = [...results.values()].filter((r) => r.status === "failed");
  const blockedNodes = [...results.values()].filter((r) => r.status === "blocked");

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Workflow Complete                                          ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();
  console.log(`Total time: ${(totalMs / 60_000).toFixed(1)} minutes`);
  console.log(`Completed: ${completedNodes.length}/${totalNodes}`);
  console.log(`Failed:    ${failedNodes.length}/${totalNodes}`);
  console.log(`Blocked:   ${blockedNodes.length}/${totalNodes}`);
  console.log();

  console.log("Node Results:");
  console.log("─".repeat(80));
  for (const node of nodes) {
    const result = results.get(node.id);
    if (!result) {
      console.log(`  ? ${node.id.padEnd(20)} not reached`);
      continue;
    }
    const icon = result.status === "completed" ? "✓" : result.status === "blocked" ? "⊘" : "✗";
    const duration = result.durationMs > 0 ? `${(result.durationMs / 60_000).toFixed(1)}m` : "  -";
    console.log(`  ${icon} ${node.id.padEnd(20)} ${duration.padEnd(6)} ${result.output.slice(0, 50)}`);
  }

  if (failedNodes.length > 0 || blockedNodes.length > 0) {
    console.log("\nTo retry, fix the issues and run with --resume to skip completed nodes.");
    process.exit(1);
  }

  // Clean up state file on success
  if (existsSync(STATE_FILE)) {
    console.log(`\nCleaning up ${STATE_FILE}`);
    writeFileSync(STATE_FILE + ".done", readFileSync(STATE_FILE));
    // Don't delete — rename to .done for audit trail
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
