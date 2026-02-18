# Workflows Module Spec — `packages/sdk-ts/src/workflows.ts`

## Overview

The workflows module provides **opinionated, high-level orchestration patterns** on top of the `AgentRelay` facade. Instead of manually spawning agents, wiring events, and managing lifecycle, users pick a workflow pattern and the SDK handles:

1. **Agent spawning** with the right topology
2. **Convention injection** — each agent's initial task gets augmented with lifecycle instructions (ACK, progress reporting, DONE protocol, coordination rules)
3. **Coordination** — barriers, fan-in collection, pipeline sequencing
4. **Cleanup** — automatic release of agents when the workflow completes or fails

## Design Principles

- **Composable over monolithic** — workflows are functions that return a `WorkflowRun`, not classes with deep inheritance
- **Convention over configuration** — sensible defaults for every option; zero-config should work
- **Transparent augmentation** — the injected instructions are visible (logged) so users can debug what agents receive
- **Existing primitives** — builds on `AgentRelay`, `ConsensusEngine`, `ShadowManager` — no new broker protocol needed

## Dependencies

```
workflows.ts
  ├── relay.ts          (AgentRelay, Agent, Message, HumanHandle)
  ├── consensus.ts      (ConsensusEngine — for consensus workflow)
  ├── shadow.ts         (ShadowManager — for attaching reviewers)
  ├── trajectories.ts   (agent-trajectories SDK — reflection & trajectory tracking)
  └── workflow-yaml.ts  (YAML workflow loader & validator)
```

External dependencies:
- `agent-trajectories` — trajectory recording, reflection events, retrospectives
- `yaml` — YAML parsing for workflow definitions

No broker changes required. Workflows are purely SDK-side orchestration.

---

## Types

```ts
// ── CLI Runtime ─────────────────────────────────────────────────────────────

type AgentCli = "claude" | "codex" | "gemini" | "aider" | "goose";

// ── Task Definition ─────────────────────────────────────────────────────────

interface TaskDefinition {
  /** The task prompt sent to the agent. Convention instructions are appended automatically. */
  task: string;
  /** CLI to use for this agent. Defaults to workflow-level default. */
  cli?: AgentCli;
  /** Agent name. Auto-generated if omitted (e.g., "Worker-1", "Stage-auth"). */
  name?: string;
  /** Channels to join. Defaults to workflow channel. */
  channels?: string[];
  /** Extra CLI args passed to the agent process. */
  args?: string[];
}

// ── Workflow Result ─────────────────────────────────────────────────────────

interface AgentResult {
  name: string;
  exitReason: "exited" | "released" | "timeout";
  /** Messages sent by this agent during the workflow. */
  messages: Message[];
  /** The DONE message text, if the agent followed protocol. */
  summary?: string;
}

interface WorkflowResult {
  pattern: string;
  agents: AgentResult[];
  /** Total wall-clock duration in ms. */
  durationMs: number;
  /** Whether all agents completed successfully (sent DONE). */
  success: boolean;
  /** For pipeline: ordered results per stage. For consensus: the decision. */
  metadata?: Record<string, unknown>;
}

// ── Workflow Run (live handle) ──────────────────────────────────────────────

interface WorkflowRun {
  /** Resolves when all agents complete or the workflow times out. */
  result: Promise<WorkflowResult>;
  /** The AgentRelay instance managing this workflow. */
  relay: AgentRelay;
  /** Live agents (populated after spawn phase). */
  agents: Agent[];
  /** Cancel the workflow early — releases all agents. */
  cancel(): Promise<void>;
  /** Send a message to all workflow agents. */
  broadcast(text: string): Promise<void>;
}

// ── Reflection ──────────────────────────────────────────────────────────────

interface ReflectionContext {
  /** All messages received since the last reflection. */
  recentMessages: Message[];
  /** Current status of each agent. */
  agentStatuses: Map<string, "active" | "done" | "stuck" | "idle">;
  /** Wall-clock time elapsed since workflow start. */
  elapsedMs: number;
  /** Previous reflection summaries from this workflow. */
  priorReflections: ReflectionEvent[];
  /** The trajectory session, if trajectory tracking is enabled. */
  trajectory?: TrajectorySession;
}

interface ReflectionEvent {
  /** ISO timestamp of the reflection. */
  ts: string;
  /** High-level synthesis of recent activity. */
  synthesis: string;
  /** Focal points — the key questions that prompted this reflection. */
  focalPoints: string[];
  /** Course corrections triggered by this reflection. */
  adjustments?: ReflectionAdjustment[];
  /** Confidence in the current trajectory (0-1). */
  confidence: number;
}

interface ReflectionAdjustment {
  agent: string;
  action: "reassign" | "release" | "message" | "spawn";
  /** New task or message content, depending on action. */
  content?: string;
}

// ── Trajectory Integration ──────────────────────────────────────────────────

interface TrajectoryOptions {
  /** Enable trajectory tracking for this workflow. Default: false. */
  enabled: boolean;
  /** Agent name recorded as the trajectory owner. Default: "workflow-orchestrator". */
  agentName?: string;
  /** External task reference (e.g., beads ID, GitHub issue). */
  taskSource?: { system: string; id: string; url?: string };
  /** Base directory for trajectory storage. Default: ".trajectories". */
  dataDir?: string;
  /** Auto-record agent messages as trajectory events. Default: true. */
  autoRecordMessages?: boolean;
  /** Auto-record reflections as trajectory events. Default: true. */
  autoRecordReflections?: boolean;
}

// ── Workflow Options (shared across all patterns) ───────────────────────────

interface WorkflowOptions {
  /** Default CLI for all agents. Default: "claude". */
  cli?: AgentCli;
  /** Workflow-wide timeout in ms. Default: 10 minutes. */
  timeoutMs?: number;
  /** Channel for workflow communication. Default: "workflow-{id}". */
  channel?: string;
  /** AgentRelay options (binary path, cwd, env, etc.). */
  relayOptions?: AgentRelayOptions;
  /** Use an existing AgentRelay instance instead of creating one. */
  relay?: AgentRelay;
  /** Attach a shadow/reviewer agent to all workers. */
  shadow?: { cli?: AgentCli; task: string };
  /** Hook: called when an agent sends a message. */
  onMessage?: (agent: Agent, message: Message) => void;
  /** Hook: called when an agent exits. */
  onAgentDone?: (agent: Agent, summary: string | undefined) => void;
  /** Hook: called with the full augmented task before spawning (for debugging). */
  onTaskAugmented?: (agentName: string, augmentedTask: string) => void;

  // ── Reflection options ──────────────────────────────────────────────────
  /** Trigger reflection after this many agent messages. Default: 10.
   *  Set to 0 to disable automatic reflection. */
  reflectionThreshold?: number;
  /** Hook: called when a reflection is triggered. Return adjustments or null. */
  onReflect?: (context: ReflectionContext) => Promise<ReflectionAdjustment[] | null>;
  /** Hook: called after a reflection completes (for logging/display). */
  onReflectionComplete?: (event: ReflectionEvent) => void;

  // ── Trajectory options ──────────────────────────────────────────────────
  /** Enable trajectory tracking via agent-trajectories SDK. */
  trajectory?: TrajectoryOptions;
}
```

---

## Workflow Patterns

### 1. `fanOut` — Parallel Workers

**Swarm analogy:** Hub & Spoke. One orchestrator (the SDK process) spawns N workers in parallel, collects results, returns when all complete.

**When to use:** Independent subtasks that can run simultaneously (e.g., "review 5 files", "run tests on 3 platforms", "research 4 topics").

```ts
function fanOut(
  tasks: TaskDefinition[],
  options?: WorkflowOptions,
): WorkflowRun;
```

**Behavior:**
1. Create/reuse `AgentRelay`
2. Spawn all agents in parallel via `relay.spawnPty()`
3. Each agent's task is augmented with fan-out conventions (see Convention Injection below)
4. Wait for all agents to exit or timeout
5. Collect DONE messages from each agent
6. Release any remaining agents, shutdown relay (if we created it)

**Convention injected into each agent's task:**
```
## Relay Workflow Protocol
You are Worker-{N} in a fan-out workflow with {total} parallel workers.

When you finish your task:
1. Send a message to #workflow-{id}: "DONE: <one-line summary of what you accomplished>"
2. Then call the relay_release MCP tool to release yourself, or simply exit.

Do NOT wait for other workers. Work independently.
```

**Example:**
```ts
import { fanOut } from "@agent-relay/sdk-ts/workflows";

const run = fanOut([
  { task: "Review src/auth.ts for security issues", name: "AuthReviewer" },
  { task: "Review src/db.ts for SQL injection", name: "DbReviewer" },
  { task: "Review src/api.ts for input validation", name: "ApiReviewer" },
], { cli: "claude", timeoutMs: 5 * 60_000 });

const result = await run.result;
console.log(result.agents.map(a => a.summary));
// ["No security issues found in auth.ts", "Fixed 2 SQL injection...", "Added input validation..."]
```

---

### 2. `pipeline` — Sequential Stages

**Swarm analogy:** Hierarchical Tree (linear variant). Output of stage N is fed as context to stage N+1.

**When to use:** Tasks with natural ordering where each step builds on the previous (e.g., "design → implement → test → deploy").

```ts
interface PipelineStage extends TaskDefinition {
  /** If true, the agent receives the previous stage's DONE summary as context.
   *  Default: true. */
  receivesPreviousOutput?: boolean;
}

function pipeline(
  stages: PipelineStage[],
  options?: WorkflowOptions,
): WorkflowRun;
```

**Behavior:**
1. Spawn stage 0 agent
2. Wait for it to exit (or timeout)
3. Extract its DONE summary
4. Spawn stage 1 agent with augmented task that includes stage 0's output
5. Repeat until all stages complete
6. If any stage fails/times out, the pipeline halts

**Convention injected into each agent's task:**
```
## Relay Workflow Protocol
You are Stage {N}/{total} ("{stage_name}") in a sequential pipeline.

{if N > 0}
### Context from previous stage
The previous stage ("{prev_name}") completed with:
{prev_summary}
{endif}

When you finish:
1. Send a message to #workflow-{id}: "DONE: <detailed summary of your output>"
   IMPORTANT: Your DONE summary will be passed to the next stage as context.
   Include all relevant details, file paths, and decisions.
2. Then release yourself.
```

**Example:**
```ts
import { pipeline } from "@agent-relay/sdk-ts/workflows";

const run = pipeline([
  { task: "Design the API schema for a todo app. Output the OpenAPI spec.", name: "Designer" },
  { task: "Implement the API endpoints based on the provided design.", name: "Implementer" },
  { task: "Write integration tests for the implemented API.", name: "Tester" },
], { cli: "claude" });

const result = await run.result;
// result.metadata.stages = [
//   { name: "Designer", summary: "Created OpenAPI spec with 5 endpoints..." },
//   { name: "Implementer", summary: "Implemented all endpoints in src/routes/..." },
//   { name: "Tester", summary: "Added 12 integration tests, all passing..." },
// ]
```

---

### 3. `hubAndSpoke` — Persistent Coordinator

**Swarm analogy:** Hub & Spoke with a live hub agent that coordinates workers.

**When to use:** Complex tasks where a lead agent needs to dynamically assign subtasks, review results, and make decisions. The hub agent stays alive and communicates with workers.

```ts
interface HubAndSpokeOptions extends WorkflowOptions {
  /** The hub/lead agent's task. */
  hub: TaskDefinition;
  /** Initial worker tasks. The hub can spawn more workers via relay. */
  workers: TaskDefinition[];
  /** If true, the hub agent is told it can spawn additional workers. Default: true. */
  hubCanSpawn?: boolean;
}

function hubAndSpoke(options: HubAndSpokeOptions): WorkflowRun;
```

**Behavior:**
1. Spawn the hub agent first
2. Wait for hub's `worker_ready` event
3. Spawn all worker agents
4. Hub receives messages from workers, can send tasks, review output
5. Workflow completes when the hub sends DONE (hub decides when the team is finished)
6. All remaining workers are released after hub exits

**Convention injected into hub agent's task:**
```
## Relay Workflow Protocol — You are the Hub/Lead
You are coordinating {N} worker agents: {worker_names}.
Channel: #workflow-{id}

Your workers will check in with you. Coordinate their work:
- Workers will send "ACK: ..." when they start
- Workers will send "DONE: ..." when they finish
- You can send messages to individual workers or broadcast to #workflow-{id}
{if hubCanSpawn}
- You can spawn additional workers using the relay_spawn MCP tool
{endif}

When ALL work is complete and you're satisfied with the results:
1. Send to #workflow-{id}: "DONE: <summary of what the team accomplished>"
2. Then release yourself.
```

**Convention injected into each worker's task:**
```
## Relay Workflow Protocol — You are a Worker
Your lead agent is "{hub_name}". Report to them.

1. First, send to {hub_name}: "ACK: <brief description of your task>"
2. Work on your task. Send progress updates to {hub_name} if the task is long.
3. When done, send to {hub_name}: "DONE: <summary of what you accomplished>"
4. Then release yourself.
```

**Example:**
```ts
import { hubAndSpoke } from "@agent-relay/sdk-ts/workflows";

const run = hubAndSpoke({
  hub: {
    task: "You are the tech lead. Coordinate the team to build a REST API for a blog.",
    name: "Lead",
    cli: "claude",
  },
  workers: [
    { task: "Implement the database models and migrations.", name: "DbWorker" },
    { task: "Implement the API route handlers.", name: "ApiWorker" },
    { task: "Write tests for all endpoints.", name: "TestWorker" },
  ],
});

const result = await run.result;
```

---

### 4. `consensus` — Decision Making

**Swarm analogy:** Consensus Formation. Agents deliberate and vote on a proposal.

**When to use:** Architectural decisions, code review approval, choosing between alternatives.

```ts
interface ConsensusOptions extends WorkflowOptions {
  /** The question/proposal to decide on. */
  proposal: string;
  /** Agents who will deliberate and vote. */
  voters: TaskDefinition[];
  /** Consensus type. Default: "majority". */
  consensusType?: "majority" | "supermajority" | "unanimous";
  /** Supermajority threshold. Default: 0.67. */
  threshold?: number;
}

function consensus(options: ConsensusOptions): WorkflowRun;
```

**Behavior:**
1. Spawn all voter agents
2. Each agent receives the proposal and is instructed to deliberate then vote
3. Votes are collected from DONE messages (parsed for VOTE: approve/reject)
4. ConsensusEngine (from `consensus.ts`) tallies results
5. Result includes the decision and each agent's reasoning

**Convention injected into each voter's task:**
```
## Relay Workflow Protocol — Consensus Vote
You are one of {N} voters deliberating on:

"{proposal}"

1. Research and analyze the proposal.
2. When ready, send to #workflow-{id}:
   "VOTE: approve" or "VOTE: reject"
   followed by your reasoning on the next line.
3. Then send "DONE: <your vote and brief reasoning>"
4. Release yourself.
```

**Example:**
```ts
import { consensus } from "@agent-relay/sdk-ts/workflows";

const run = consensus({
  proposal: "Should we migrate from Express to Fastify for the API layer?",
  voters: [
    { task: "Evaluate from a performance perspective", name: "PerfExpert" },
    { task: "Evaluate from a developer experience perspective", name: "DxExpert" },
    { task: "Evaluate from a maintenance/ecosystem perspective", name: "EcoExpert" },
  ],
  consensusType: "majority",
});

const result = await run.result;
// result.metadata.decision = "approved"
// result.metadata.votes = [
//   { agent: "PerfExpert", vote: "approve", reason: "2x faster..." },
//   { agent: "DxExpert", vote: "reject", reason: "Plugin ecosystem..." },
//   { agent: "EcoExpert", vote: "approve", reason: "Active maintenance..." },
// ]
```

---

### 5. `mesh` — Peer Collaboration

**Swarm analogy:** Mesh Network. All agents can communicate with all others. No hierarchy.

**When to use:** Collaborative tasks where agents need to coordinate dynamically (e.g., pair programming, brainstorming, distributed debugging).

```ts
interface MeshOptions extends WorkflowOptions {
  /** Agents in the mesh. All can message all others. */
  agents: TaskDefinition[];
  /** The shared goal that all agents work toward. */
  goal: string;
  /** Maximum rounds of communication before forcing completion. Default: 10. */
  maxRounds?: number;
}

function mesh(options: MeshOptions): WorkflowRun;
```

**Behavior:**
1. Spawn all agents on the same channel
2. Each agent can message any other agent or the channel
3. Workflow completes when all agents send DONE, or maxRounds is reached, or timeout
4. The SDK monitors message count to detect "rounds" (a round = each agent has sent at least one message since the last round boundary)

**Convention injected into each agent's task:**
```
## Relay Workflow Protocol — Mesh Collaboration
You are part of a {N}-agent mesh working toward a shared goal:

"{goal}"

Your peers: {peer_names}
Channel: #workflow-{id}

Rules:
- Communicate with peers via the channel or direct messages
- Coordinate who does what — avoid duplicate work
- When you believe the shared goal is met, send to #workflow-{id}: "DONE: <your contribution summary>"
- You can reference other agents' work in your messages
```

**Example:**
```ts
import { mesh } from "@agent-relay/sdk-ts/workflows";

const run = mesh({
  goal: "Debug and fix the authentication flow. The login endpoint returns 500 for valid credentials.",
  agents: [
    { task: "Investigate the server logs and error stack traces.", name: "LogAnalyst" },
    { task: "Review the auth middleware and JWT validation code.", name: "CodeReviewer" },
    { task: "Write a reproduction test and verify the fix.", name: "Tester" },
  ],
});

const result = await run.result;
```

---

### 6. `handoff` — Dynamic Routing

**Swarm analogy:** Triage desk. One active agent at a time; control transfers dynamically to the right specialist based on task assessment.

**When to use:** Tasks where the right specialist isn't known upfront and emerges during processing (e.g., customer support routing, intent dispatch, multi-domain queries).

**Key difference from hub-spoke:** No persistent coordinator. The active agent itself decides who handles the task next. Each agent either handles the task or hands off to someone better suited.

```ts
interface HandoffRoute {
  /** Agent definition for this route. */
  agent: TaskDefinition;
  /** When should this agent receive a handoff? Described in natural language
   *  for the routing agent, or as a function for programmatic routing. */
  condition: string | ((message: Message) => boolean);
}

interface HandoffOptions extends WorkflowOptions {
  /** The initial agent that receives the task. */
  entryPoint: TaskDefinition;
  /** Available specialist agents that can receive handoffs. */
  routes: HandoffRoute[];
  /** Maximum number of handoffs before forcing completion. Prevents loops. Default: 5. */
  maxHandoffs?: number;
  /** Fallback agent if no route matches. Default: returns to entryPoint. */
  fallback?: TaskDefinition;
}

function handoff(options: HandoffOptions): WorkflowRun;
```

**Behavior:**
1. Spawn the entry point agent with the task
2. Agent works on the task or decides to hand off
3. On `HANDOFF: <agent-id> <reason>`, the SDK transfers context to the target agent
4. The receiving agent gets the full conversation history + handoff reason
5. Repeat until an agent sends DONE or `maxHandoffs` is reached
6. Circuit breaker: if max handoffs exceeded, force the last agent to complete

**Convention injected into each agent's task:**
```
## Relay Workflow Protocol — Handoff Routing
You are a specialist agent. You have access to these peer specialists:
{route_descriptions}

If this task is better handled by another specialist:
1. Send to #workflow-{id}: "HANDOFF: <agent-id> <reason>"
2. The task will be transferred with full context.

If you can handle it yourself:
1. Complete the work
2. Send "DONE: <summary>"

Maximum handoffs remaining: {remaining}
If this is the last allowed handoff, you MUST complete the task yourself.
```

**Example:**
```ts
import { handoff } from "@agent-relay/sdk-ts/workflows";

const run = handoff({
  entryPoint: { task: "Help the user with their request", name: "Triage", cli: "claude" },
  routes: [
    { agent: { task: "Handle billing and payment issues", name: "Billing" }, condition: "billing, payment, invoice, subscription" },
    { agent: { task: "Handle technical debugging and errors", name: "TechSupport" }, condition: "error, bug, crash, not working" },
    { agent: { task: "Handle account and access issues", name: "AccountMgr" }, condition: "login, password, access, permissions" },
  ],
  maxHandoffs: 3,
});
```

---

### 7. `cascade` — Cost-Aware Escalation

**Swarm analogy:** Tiered support. Start with the cheapest/fastest model; escalate to more capable (and expensive) models only when needed.

**When to use:** Production workloads where most tasks are simple but some require heavy reasoning. Optimizes cost while maintaining quality.

```ts
interface CascadeTier {
  /** Agent definition for this tier. */
  agent: TaskDefinition;
  /** Confidence threshold — if the agent's confidence is below this, escalate. Default: 0.7. */
  confidenceThreshold?: number;
  /** Cost weight for tracking (relative units). */
  costWeight?: number;
}

interface CascadeOptions extends WorkflowOptions {
  /** Tiers ordered from cheapest to most capable. */
  tiers: CascadeTier[];
  /** Maximum tiers to attempt. Default: all tiers. */
  maxEscalations?: number;
}

function cascade(options: CascadeOptions): WorkflowRun;
```

**Behavior:**
1. Spawn tier 0 (cheapest) agent
2. Agent works on the task and reports confidence in its DONE message
3. Parse confidence: `DONE [confidence=0.4]: <summary>`
4. If confidence < threshold, spawn next tier with previous tier's output as context
5. Repeat until confidence is sufficient or all tiers exhausted
6. Track cost across tiers in `WorkflowResult.metadata`

**Convention injected into each agent's task:**
```
## Relay Workflow Protocol — Cascade Tier {N}/{total}
You are tier {N} in a cascade. {if N > 0}A less capable model attempted this
and was not confident in its answer:{prev_summary}{endif}

When you finish:
1. Assess your confidence in the solution (0.0 to 1.0)
2. Send: "DONE [confidence=X.X]: <your answer>"
   - confidence >= {threshold}: Your answer is accepted
   - confidence < {threshold}: The task escalates to a more capable model

Be honest about confidence. It's better to escalate than to give a wrong answer.
```

**Example:**
```ts
import { cascade } from "@agent-relay/sdk-ts/workflows";

const run = cascade({
  tiers: [
    { agent: { task: "Answer this question", name: "Fast", cli: "claude" }, confidenceThreshold: 0.7, costWeight: 1 },
    { agent: { task: "Answer this question", name: "Strong", cli: "claude" }, confidenceThreshold: 0.85, costWeight: 5 },
    { agent: { task: "Answer this question", name: "Expert", cli: "claude" }, costWeight: 20 },
  ],
});

const result = await run.result;
// result.metadata.tiersUsed = 2
// result.metadata.totalCostWeight = 6
// result.metadata.finalConfidence = 0.92
```

---

### 8. `dag` — Directed Acyclic Graph

**Swarm analogy:** Project plan with dependencies. Tasks execute in parallel where possible, respecting dependency edges.

**When to use:** Complex workflows where some tasks depend on others but many can run in parallel. More flexible than pipeline (which is strictly linear).

```ts
interface DagNode extends TaskDefinition {
  /** Unique node ID. */
  id: string;
  /** IDs of nodes this node depends on. Empty = ready immediately. */
  dependsOn?: string[];
  /** Post-step verification commands. */
  verify?: { command: string; expectExit: number; timeout?: string }[];
  /** Signal that marks this step as done. Default: "DONE". */
  expects?: string;
}

interface DagOptions extends WorkflowOptions {
  /** Nodes in the DAG. */
  nodes: DagNode[];
  /** Maximum concurrent agents. Default: unlimited. */
  maxConcurrency?: number;
}

function dag(options: DagOptions): WorkflowRun;
```

**Behavior:**
1. Build dependency graph, validate it's acyclic (topological sort)
2. Spawn all nodes with no dependencies (root nodes) in parallel
3. As each node completes (DONE), check which downstream nodes are now unblocked
4. Spawn newly unblocked nodes, passing upstream outputs as context
5. Respect `maxConcurrency` — queue excess nodes
6. Workflow completes when all nodes have finished
7. If any node fails, halt its downstream dependents (other branches continue)

**Convention injected into each agent's task:**
```
## Relay Workflow Protocol — DAG Step "{node_id}"
You are step "{node_id}" in a workflow graph.
{if dependsOn.length > 0}
### Upstream context
{for each dep in dependsOn}
Step "{dep.id}" completed with: {dep.summary}
{endfor}
{endif}

When you finish:
1. Send to #workflow-{id}: "DONE: <detailed summary>"
   {if hasDownstream}Your output will be passed to: {downstream_ids}{endif}
2. Then release yourself.
```

**Example:**
```ts
import { dag } from "@agent-relay/sdk-ts/workflows";

const run = dag({
  nodes: [
    { id: "scaffold", task: "Create project scaffold", name: "Scaffolder" },
    { id: "frontend", task: "Build React components", name: "FrontendDev", dependsOn: ["scaffold"] },
    { id: "backend", task: "Build API endpoints", name: "BackendDev", dependsOn: ["scaffold"] },
    { id: "database", task: "Create schema and migrations", name: "DbDev", dependsOn: ["scaffold"] },
    { id: "integrate", task: "Wire frontend to API", name: "Integrator", dependsOn: ["frontend", "backend"] },
    { id: "e2e-tests", task: "Write end-to-end tests", name: "Tester", dependsOn: ["integrate", "database"] },
  ],
  maxConcurrency: 3,
});

// Execution order:
// 1. scaffold (alone)
// 2. frontend + backend + database (parallel, max 3)
// 3. integrate (after frontend + backend)
// 4. e2e-tests (after integrate + database)
```

---

### 9. `debate` — Adversarial Refinement

**Swarm analogy:** Structured debate. Agents take opposing positions through rounds of argumentation until convergence or a judge decides.

**When to use:** Decisions requiring rigorous examination from multiple angles. Different from consensus: debate is adversarial (agents defend positions), consensus is cooperative (agents independently evaluate).

```ts
interface DebateOptions extends WorkflowOptions {
  /** The question or topic to debate. */
  topic: string;
  /** Agents assigned to argue different positions. */
  debaters: (TaskDefinition & { position?: string })[];
  /** Optional judge agent that decides the winner. If omitted, debaters self-converge. */
  judge?: TaskDefinition;
  /** Maximum debate rounds. Default: 3. */
  maxRounds?: number;
  /** End early if debaters converge on same position. Default: true. */
  earlyConvergence?: boolean;
}

function debate(options: DebateOptions): WorkflowRun;
```

**Behavior:**
1. Spawn all debater agents on the same channel
2. **Round 1:** Each debater presents their initial argument
3. **Round N:** Each debater reads opponents' arguments and responds with counterarguments
4. After `maxRounds` or convergence, the judge (if present) reviews all arguments and decides
5. If no judge, the SDK detects convergence (both debaters agree) or reports the split

**Convention injected into debaters:**
```
## Relay Workflow Protocol — Structured Debate
Topic: "{topic}"
Your position: {position}
Opponents: {opponent_names}
Round: {current_round}/{max_rounds}

Rules:
1. Present your strongest argument for your position
2. Address your opponents' points directly — don't ignore them
3. Format: "ARGUMENT: <your argument this round>"
4. If you're convinced by the other side: "CONCEDE: <why you changed your mind>"
5. After the final round: "DONE: <your final position and reasoning>"
```

**Convention injected into judge:**
```
## Relay Workflow Protocol — Debate Judge
Topic: "{topic}"
You will review arguments from {debater_count} debaters.

After all rounds complete, you'll receive the full debate transcript.
Evaluate:
1. Strength of evidence
2. Quality of reasoning
3. How well each side addressed counterarguments

Send: "VERDICT: <winning position>"
Then: "DONE: <detailed reasoning for your decision>"
```

**Example:**
```ts
import { debate } from "@agent-relay/sdk-ts/workflows";

const run = debate({
  topic: "Should we use a monorepo or polyrepo for the new platform?",
  debaters: [
    { task: "Argue for monorepo", name: "MonorepoAdvocate", position: "monorepo" },
    { task: "Argue for polyrepo", name: "PolyrepoAdvocate", position: "polyrepo" },
  ],
  judge: { task: "Judge the debate and decide", name: "ArchJudge" },
  maxRounds: 3,
});

const result = await run.result;
// result.metadata.verdict = "monorepo"
// result.metadata.rounds = [{ round: 1, arguments: [...] }, ...]
// result.metadata.judgeReasoning = "Monorepo wins because..."
```

---

### 10. `hierarchical` — Multi-Level Delegation

**Swarm analogy:** Corporate org chart. Lead delegates to coordinators, who delegate to workers. Multiple levels of management.

**When to use:** Large projects requiring domain separation where a single hub can't effectively manage all workers. Each coordinator manages a sub-team.

```ts
interface HierarchicalAgent extends TaskDefinition {
  /** Unique agent ID for reference in the tree. */
  id: string;
  /** Role in the hierarchy. */
  role: "lead" | "coordinator" | "worker";
  /** ID of the agent this one reports to. Omit for the root lead. */
  reportsTo?: string;
}

interface HierarchicalOptions extends WorkflowOptions {
  /** All agents in the hierarchy. Must form a valid tree with one root. */
  agents: HierarchicalAgent[];
}

function hierarchical(options: HierarchicalOptions): WorkflowRun;
```

**Behavior:**
1. Validate the agent tree (one root, no cycles, every non-root has a parent)
2. Spawn the root lead agent
3. Spawn coordinator agents, each told who their workers are
4. Spawn worker agents, each told who their coordinator is
5. Workers report to coordinators; coordinators synthesize and report to lead
6. Workflow completes when the root lead sends DONE

**Convention injected into lead:**
```
## Relay Workflow Protocol — Hierarchical Lead
You are the top-level lead coordinating {N} sub-teams:
{for each coordinator}
- {coordinator.name}: managing {worker_count} workers ({worker_names})
{endfor}

Coordinators will synthesize their team's work and report to you.
Send directives to coordinators, not directly to workers.

When ALL teams are done: "DONE: <overall summary>"
```

**Convention injected into coordinators:**
```
## Relay Workflow Protocol — Team Coordinator
You manage a sub-team for "{lead_name}":
Workers: {worker_names}
Your domain: {task_summary}

1. Receive tasks from {lead_name}
2. Coordinate your workers
3. Synthesize their outputs
4. Report progress and results to {lead_name}
5. When your team is done: send to {lead_name}: "TEAM_DONE: <synthesis>"
```

**Convention injected into workers:**
```
## Relay Workflow Protocol — Worker
Your coordinator is "{coordinator_name}". Report to them (not the lead).

1. ACK your task to {coordinator_name}
2. Do your work
3. Send results to {coordinator_name}: "DONE: <summary>"
```

**Example:**
```ts
import { hierarchical } from "@agent-relay/sdk-ts/workflows";

const run = hierarchical({
  agents: [
    { id: "lead", task: "Coordinate building a full-stack app", name: "Lead", role: "lead" },
    { id: "fe-coord", task: "Manage frontend development", name: "FrontendCoord", role: "coordinator", reportsTo: "lead" },
    { id: "be-coord", task: "Manage backend development", name: "BackendCoord", role: "coordinator", reportsTo: "lead" },
    { id: "fe-dev-1", task: "Build React components", name: "ReactDev", role: "worker", reportsTo: "fe-coord" },
    { id: "fe-dev-2", task: "Build CSS and animations", name: "StyleDev", role: "worker", reportsTo: "fe-coord" },
    { id: "be-dev-1", task: "Build API endpoints", name: "ApiDev", role: "worker", reportsTo: "be-coord" },
    { id: "be-dev-2", task: "Build database layer", name: "DbDev", role: "worker", reportsTo: "be-coord" },
  ],
});
```

---

## Primitives Audit

Every workflow pattern is built from a set of core primitives. This section documents what exists, what's new, and what each pattern requires.

### Existing Primitives (already in SDK)

| Primitive | Module | What It Does |
|-----------|--------|-------------|
| **AgentRelay** | `relay.ts` | Spawn agents (PTY/headless), send messages, release agents, event hooks |
| **Agent** | `relay.ts` | `sendMessage()`, `release()`, `waitForExit()`, channel membership |
| **Message** | `relay.ts` | `from`, `to`, `text`, `threadId`, `eventId` |
| **HumanHandle** | `relay.ts` | Human-in-the-loop message sending |
| **ConsensusEngine** | `consensus.ts` | Proposals, voting (majority/supermajority/unanimous/weighted/quorum), timeouts |
| **ShadowManager** | `shadow.ts` | Bind shadow agents to workers, mirror message streams |
| **Convention Injection** | `workflow-conventions.ts` | Prepend protocol instructions to agent tasks |
| **Message Parsing** | `workflow-conventions.ts` | Regex extraction: DONE, ACK, VOTE |

### New Primitives (needed for new patterns)

| Primitive | Module | What It Does | Required By |
|-----------|--------|-------------|-------------|
| **ReflectionEngine** | `workflow-reflection.ts` | Importance scoring, focal points, synthesis, course correction | All patterns |
| **TrajectoryRecorder** | `workflow-trajectory.ts` | Session management, event recording, auto-retrospective | All patterns |
| **YAML Loader** | `workflow-yaml.ts` | Parse, validate, resolve templates, map to SDK calls | YAML workflows |
| **DAG Scheduler** | `workflow-dag.ts` | Topological sort, parallel dispatch, join tracking, concurrency limits | `dag`, YAML `dependsOn` |
| **Handoff Controller** | `workflow-handoff.ts` | Active agent tracking, context transfer, circuit breaker (max hops) | `handoff` |
| **Round Manager** | `workflow-rounds.ts` | Track debate/discussion rounds, enforce turn order, detect convergence | `debate`, `mesh` |
| **Confidence Parser** | `workflow-conventions.ts` | Extract `[confidence=X.X]` from DONE messages | `cascade` |
| **Tree Validator** | `workflow-hierarchy.ts` | Validate agent tree (one root, no cycles), compute sub-teams | `hierarchical` |

### Extended Primitives (for full 42-technique coverage)

These 5 additional primitives enable coverage of 37 of 42 swarm techniques from the literature (88% coverage). The remaining 5 (Graph of Thoughts cyclic graphs, MARL, Population-Based Training) are fundamentally different execution paradigms and are out of scope for a messaging-based orchestration system.

| Primitive | Module | What It Does | Enables |
|-----------|--------|-------------|---------|
| **Stigmergic State Store** | `workflow-stigmergy.ts` | Shared state with time-based decay (evaporation), importance weighting, and trail reinforcement. Agents modify environment state; other agents read and react. | ACO (pheromone trails), PSO (global best), Social Spider (vibrations), Termite Building, Slime Mold |
| **Agent Pool Manager** | `workflow-pool.ts` | Population-based agent lifecycle: spawn pool of N agents, evaluate fitness, cull lowest performers, clone/mutate top performers. Supports generational iterations. | Artificial Immune (clonal selection), Bacterial Foraging (reproduction/elimination), Evolutionary Swarm (crossover/mutation/selection) |
| **Auction Engine** | `workflow-auction.ts` | Task announcement → bid collection (with timeout) → award to best bidder. Supports sealed-bid, open-bid, and multi-round auctions. Integrates with Agent messaging for bid/award protocol. | Auction/Market-Based Allocation, Contract Net Protocol (CNP) |
| **Branch Pruner** | `workflow-dag.ts` (extension) | Evaluate in-progress DAG branches against fitness criteria. Terminate low-quality branches early and reallocate resources to promising ones. Supports beam search (keep top-K branches). | Tree of Thoughts (pruning), beam search exploration |
| **Gossip Disseminator** | `workflow-gossip.ts` | Random neighbor selection for information spread. Each round, each agent shares state with K random peers (epidemic dissemination). Converges in O(log N) rounds. | Gossip Protocol, epidemic information spread, decentralized consensus |

#### Stigmergic State Store

Extends the shared state store (from relay-cloud PR #94) with decay/evaporation:

```ts
interface StigmergicStateOptions {
  /** Key namespace for this state domain */
  namespace: string;
  /** Decay rate per second (0-1). 0 = no decay, 1 = instant evaporation */
  decayRate: number;
  /** Minimum value before key is garbage-collected */
  minThreshold: number;
  /** How values combine when multiple agents reinforce the same key */
  reinforcement: "additive" | "multiplicative" | "max";
}

interface StigmergicState {
  /** Deposit a value (like pheromone) at a key */
  deposit(key: string, value: number, agent: string): Promise<void>;
  /** Read current value (after decay applied) */
  read(key: string): Promise<number>;
  /** Read all keys above threshold, sorted by value descending */
  readAll(): Promise<Array<{ key: string; value: number; lastUpdatedBy: string }>>;
  /** Manually evaporate (called automatically on timer) */
  evaporate(): Promise<void>;
}
```

#### Agent Pool Manager

Manages a population of agents with evolutionary lifecycle:

```ts
interface PoolOptions {
  /** Initial population size */
  populationSize: number;
  /** How to evaluate agent fitness (parse from DONE message) */
  fitnessExtractor: (output: string) => number;
  /** Fraction of population to cull each generation (0-1) */
  cullRate: number;
  /** Maximum generations before terminating */
  maxGenerations: number;
  /** Minimum fitness to accept solution */
  targetFitness?: number;
  /** How to create variant tasks for new agents */
  mutateTask: (parentTask: string, generation: number) => string;
}

interface AgentPool {
  /** Run evolutionary loop: spawn → evaluate → cull → reproduce → repeat */
  evolve(): Promise<{ bestAgent: string; bestFitness: number; generations: number }>;
  /** Get current population with fitness scores */
  getPopulation(): Array<{ name: string; fitness: number; generation: number }>;
  /** Manually inject a new agent into the pool */
  inject(task: string): Promise<void>;
  /** Stop evolution early */
  halt(): Promise<void>;
}
```

#### Auction Engine

Task allocation via competitive bidding:

```ts
interface AuctionOptions {
  /** Task description to be auctioned */
  task: string;
  /** Agents eligible to bid */
  bidders: TaskDefinition[];
  /** Auction type */
  type: "sealed" | "open" | "dutch" | "vickrey";
  /** How long bidders have to submit (ms) */
  biddingTimeout: number;
  /** Minimum bid required */
  reservePrice?: number;
  /** How to evaluate bids (default: highest confidence) */
  evaluator?: (bids: Bid[]) => Bid;
}

interface Bid {
  agent: string;
  confidence: number;
  estimatedCost: number;
  estimatedTime: string;
  approach: string;
}

interface AuctionResult {
  winner: Bid;
  allBids: Bid[];
  awardedAt: string;
}

// Convention injection adds:
// BID: [confidence=0.85] [cost=3] [time=10m] I'll implement using...
const BID_REGEX = /^BID:\s*\[confidence=(\d+\.?\d*)\]\s*\[cost=(\d+\.?\d*)\]\s*\[time=(\S+)\]\s*(.+)/m;
// AWARD: <agent-name>
const AWARD_REGEX = /^AWARD:\s*(\S+)/m;
```

#### Branch Pruner (DAG extension)

```ts
interface BranchPrunerOptions {
  /** Evaluate branch quality from agent's in-progress messages */
  evaluator: (messages: Message[], branch: DagNode) => number;
  /** Kill branches scoring below this threshold */
  pruneThreshold: number;
  /** Maximum concurrent branches (beam width) */
  beamWidth?: number;
  /** How often to evaluate (ms) */
  evaluationInterval: number;
}
```

#### Gossip Disseminator

```ts
interface GossipOptions {
  /** Number of random peers to share with each round */
  fanout: number;
  /** Time between gossip rounds (ms) */
  roundInterval: number;
  /** Maximum rounds before termination */
  maxRounds: number;
  /** What state each agent shares (extracted from messages) */
  stateExtractor: (messages: Message[]) => string;
  /** How to merge received state with local state */
  stateMerger: (local: string, received: string) => string;
  /** Convergence test: stop when all agents agree */
  convergenceTest?: (states: Map<string, string>) => boolean;
}
```

### New Message Protocol Signals (Extended)

```ts
// Extended primitives add these signals:
const BID_REGEX = /^BID:\s*\[confidence=(\d+\.?\d*)\]\s*\[cost=(\d+\.?\d*)\]\s*\[time=(\S+)\]\s*(.+)/m;
const AWARD_REGEX = /^AWARD:\s*(\S+)/m;
const DEPOSIT_REGEX = /^DEPOSIT:\s*(\S+)\s+(\d+\.?\d*)/m;           // stigmergy
const FITNESS_REGEX = /^FITNESS:\s*(\d+\.?\d*)/m;                    // pool evaluation
const GOSSIP_REGEX = /^GOSSIP:\s*(.+)/m;                             // gossip state share
```

### Extended Coverage Matrix (42 Techniques)

| Technique Category | Count | Covered | Partially | Gap | Coverage |
|--------------------|-------|---------|-----------|-----|----------|
| Bio-Inspired | 22 | 17 | 3 | 2 | 91% |
| LLM-Specific | 8 | 7 | 1 | 0 | 94% |
| Decision-Making | 6 | 4 | 0 | 2 | 67% → 100% with Auction Engine |
| Distributed Architecture | 3 | 2 | 0 | 1 | 67% → 100% with Gossip |
| Hybrid/Advanced | 3 | 0 | 1 | 2 | 33% with Agent Pool |
| **Total** | **42** | **30** | **5** | **7** | **67% → 88% with 5 new primitives** |

Techniques **not covered** (fundamentally different paradigms):
- Graph of Thoughts (requires cyclic execution graphs — conflicts with DAG model)
- Multi-Agent Reinforcement Learning (requires reward signals + policy gradient)
- Population-Based Training (requires hyperparameter evolution framework)

### New Message Protocol Signals

```ts
const DONE_REGEX = /^DONE:\s*(.+)/m;                          // existing
const ACK_REGEX = /^ACK:\s*(.+)/m;                             // existing
const VOTE_REGEX = /^VOTE:\s*(approve|reject)\b/mi;            // existing
const REFLECT_REGEX = /^REFLECT:\s*(.+)/m;                     // new (reflection)
const HANDOFF_REGEX = /^HANDOFF:\s*(\S+)\s*(.*)/m;             // new (handoff)
const CONFIDENCE_REGEX = /\[confidence=(\d+\.?\d*)\]/;         // new (cascade)
const ARGUMENT_REGEX = /^ARGUMENT:\s*(.+)/m;                   // new (debate)
const CONCEDE_REGEX = /^CONCEDE:\s*(.+)/m;                     // new (debate)
const VERDICT_REGEX = /^VERDICT:\s*(.+)/m;                     // new (debate)
const TEAM_DONE_REGEX = /^TEAM_DONE:\s*(.+)/m;                // new (hierarchical)
```

### Pattern × Primitive Matrix

| Pattern | AgentRelay | Convention Injection | Message Parsing | ConsensusEngine | ReflectionEngine | DAG Scheduler | Handoff Controller | Round Manager | Confidence Parser | Tree Validator | Trajectory |
|---------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `fanOut` | x | x | DONE, ACK | | x | | | | | | x |
| `pipeline` | x | x | DONE | | x | | | | | | x |
| `hubAndSpoke` | x | x | DONE, ACK | | x | | | | | | x |
| `consensus` | x | x | DONE, VOTE | x | x | | | | | | x |
| `mesh` | x | x | DONE | | x | | | x | | | x |
| `handoff` | x | x | DONE, HANDOFF | | x | | x | | | | x |
| `cascade` | x | x | DONE | | x | | | | x | | x |
| `dag` | x | x | DONE | | x | x | | | | | x |
| `debate` | x | x | DONE, ARGUMENT, CONCEDE, VERDICT | | x | | | x | | | x |
| `hierarchical` | x | x | DONE, ACK, TEAM_DONE | | x | | | | | x | x |

### Updated Implementation Structure

```
packages/sdk-ts/src/
  workflows.ts              — Main module: types + all 10 workflow functions
  workflow-conventions.ts   — Convention templates, augmentation, ALL message parsing
  workflow-reflection.ts    — ReflectionEngine: importance scoring, focal points, synthesis
  workflow-trajectory.ts    — Trajectory integration: session management, event recording
  workflow-yaml.ts          — YAML loader, validator, template resolver, SDK mapper
  workflow-dag.ts           — DAG scheduler: topological sort, parallel dispatch, join + branch pruning
  workflow-handoff.ts       — Handoff controller: active agent tracking, context transfer, circuit breaker
  workflow-rounds.ts        — Round manager: debate rounds, turn order, convergence detection
  workflow-hierarchy.ts     — Tree validator: structural validation, sub-team computation
  workflow-stigmergy.ts     — Stigmergic state: decay/evaporation, reinforcement, pheromone trails
  workflow-pool.ts          — Agent pool: population lifecycle, fitness eval, cull/reproduce
  workflow-auction.ts       — Auction engine: bid collection, evaluation, award cycle
  workflow-gossip.ts        — Gossip disseminator: random peer selection, epidemic spread
```

---

## Convention Injection

Convention injection is the core mechanism. Each workflow pattern prepends a `## Relay Workflow Protocol` section to the agent's task. This section tells the agent:

1. **What pattern it's in** (fan-out, pipeline, hub-spoke, etc.)
2. **Who its peers are** (names, roles)
3. **What channel to use** for coordination
4. **How to signal completion** (DONE protocol)
5. **Pattern-specific rules** (report to hub, pass output to next stage, vote, etc.)

### Augmentation Function

```ts
function augmentTask(
  task: string,
  conventions: string,
): string {
  return `${conventions}\n\n---\n\n## Your Task\n\n${task}`;
}
```

The conventions block is always prepended, so it appears in the agent's system context before their specific task. This ensures agents follow the protocol regardless of their task complexity.

### DONE Message Parsing

All workflows parse agent messages for protocol signals:

```ts
const DONE_REGEX = /^DONE:\s*(.+)/m;
const ACK_REGEX = /^ACK:\s*(.+)/m;
const VOTE_REGEX = /^VOTE:\s*(approve|reject)\b/mi;

function parseDoneMessage(text: string): string | undefined {
  const match = text.match(DONE_REGEX);
  return match?.[1]?.trim();
}
```

---

## Implementation Structure

```
packages/sdk-ts/src/
  workflows.ts              — Main module: types + all workflow functions
  workflow-conventions.ts   — Convention templates and augmentation logic
  workflow-reflection.ts    — ReflectionEngine: importance scoring, focal points, synthesis
  workflow-trajectory.ts    — Trajectory integration: session management, event recording
  workflow-yaml.ts          — YAML loader, validator, template resolver, SDK mapper
```

Five files. `workflows.ts` is the public API; the rest are internal modules.

### `workflows.ts` — Public API Surface

```ts
// Workflow functions (10 patterns)
export function fanOut(tasks: TaskDefinition[], options?: WorkflowOptions): WorkflowRun;
export function pipeline(stages: PipelineStage[], options?: WorkflowOptions): WorkflowRun;
export function hubAndSpoke(options: HubAndSpokeOptions): WorkflowRun;
export function consensus(options: ConsensusOptions): WorkflowRun;
export function mesh(options: MeshOptions): WorkflowRun;
export function handoff(options: HandoffOptions): WorkflowRun;
export function cascade(options: CascadeOptions): WorkflowRun;
export function dag(options: DagOptions): WorkflowRun;
export function debate(options: DebateOptions): WorkflowRun;
export function hierarchical(options: HierarchicalOptions): WorkflowRun;

// YAML workflow loading
export function loadWorkflow(path: string): Promise<YamlWorkflow>;
export function runWorkflow(workflow: YamlWorkflow, task: string, overrides?: Partial<WorkflowOptions>): WorkflowRun;

// Types (re-exported)
export type {
  TaskDefinition,
  AgentResult,
  WorkflowResult,
  WorkflowRun,
  WorkflowOptions,
  PipelineStage,
  HubAndSpokeOptions,
  ConsensusOptions,
  MeshOptions,
  HandoffOptions,
  HandoffRoute,
  CascadeOptions,
  CascadeTier,
  DagOptions,
  DagNode,
  DebateOptions,
  HierarchicalOptions,
  HierarchicalAgent,
  ReflectionContext,
  ReflectionEvent,
  ReflectionAdjustment,
  TrajectoryOptions,
  YamlWorkflow,
  YamlAgent,
  YamlStep,
};
```

### Internal `WorkflowRun` Construction

Each workflow function follows the same internal pattern:

```ts
function fanOut(tasks: TaskDefinition[], options?: WorkflowOptions): WorkflowRun {
  const relay = options?.relay ?? new AgentRelay(options?.relayOptions);
  const ownRelay = !options?.relay;
  const channel = options?.channel ?? `workflow-${randomId()}`;
  const agents: Agent[] = [];
  const agentResults = new Map<string, AgentResult>();

  // Track messages per agent
  relay.onMessageReceived = (msg) => {
    // Record messages, check for DONE/ACK/VOTE signals
    // Call options.onMessage if set
  };

  relay.onAgentExited = (agent) => {
    // Record exit, call options.onAgentDone
  };

  const resultPromise = (async () => {
    const start = Date.now();

    // 1. Spawn agents with augmented tasks
    for (const task of tasks) {
      const augmented = augmentTask(task.task, fanOutConvention({ ... }));
      options?.onTaskAugmented?.(task.name ?? "Worker", augmented);
      const agent = await relay.spawnPty({
        name: task.name ?? `Worker-${i}`,
        cli: task.cli ?? options?.cli ?? "claude",
        args: [...(task.args ?? []), "--task", augmented],
        channels: [channel],
      });
      agents.push(agent);
    }

    // 2. Wait for all agents
    const timeout = options?.timeoutMs ?? 10 * 60_000;
    await Promise.all(agents.map(a => a.waitForExit(timeout)));

    // 3. Cleanup
    if (ownRelay) await relay.shutdown();

    return buildResult("fanOut", agentResults, start);
  })();

  return {
    result: resultPromise,
    relay,
    agents,
    async cancel() { /* release all agents, shutdown */ },
    async broadcast(text) { /* send to #channel */ },
  };
}
```

---

## Task Delivery Mechanism

The workflows module passes tasks to agents via the `--task` CLI argument (for Claude Code) or equivalent mechanism per CLI. The broker already supports `initial_task` queuing (implemented in the broker's `main.rs`), which queues the task as the first message delivered to the agent once it sends `worker_ready`.

For CLIs that don't support `--task`:
- The task is sent as the first relay message to the agent after spawn
- The convention instructions tell the agent to treat the first message as their task

```ts
function buildSpawnArgs(cli: AgentCli, task: string, extraArgs: string[]): string[] {
  switch (cli) {
    case "claude":
      // Claude Code supports -p/--print for initial prompt
      return [...extraArgs, "-p", task];
    case "codex":
      // Codex supports positional task argument
      return [...extraArgs, task];
    default:
      // For other CLIs, task is sent via relay message after spawn
      return extraArgs;
  }
}
```

---

## Workflow Lifecycle

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  CREATE   │ ──▶ │  SPAWN   │ ──▶ │  ACTIVE  │ ──▶ │ COMPLETE │ ──▶ │ RECORD   │
│           │     │ Agents   │     │ Monitor  │     │ Collect  │     │          │
│ Load YAML │     │ Wire     │     │ Messages │     │ Results  │     │ Finish   │
│ Augment   │     │ events   │     │ Track    │     │ Cleanup  │     │ traj     │
│ tasks     │     │ Start    │     │ DONE/ACK │     │          │     │ Retro-   │
│           │     │ traj     │     │ Reflect  │     │          │     │ spective │
└──────────┘     └──────────┘     └──────────┘     └──────────┘     └──────────┘
                                       │  ▲
                                       │  │
                                       ▼  │
                                  ┌──────────┐
                                  │ REFLECT  │
                                  │          │
                                  │ Focal    │
                                  │ points   │
                                  │ Synth    │──── course correct ────▶ adjust agents
                                  │ Record   │
                                  └──────────┘
                                       │
                                       ▼
                                  ┌──────────┐
                                  │ TIMEOUT  │
                                  │ or ERROR │
                                  │ Release  │
                                  │ Abandon  │
                                  │ traj     │
                                  └──────────┘
```

---

## Shadow Integration

When `options.shadow` is set, a shadow agent is spawned for each worker:

```ts
if (options.shadow) {
  const shadowMgr = new ShadowManager();
  for (const agent of agents) {
    const shadow = await relay.spawnPty({
      name: `${agent.name}-Shadow`,
      cli: options.shadow.cli ?? "claude",
      args: buildSpawnArgs(options.shadow.cli ?? "claude", options.shadow.task, []),
      channels: [channel],
    });
    shadowMgr.bind(shadow.name, agent.name, {
      receiveIncoming: true,
      receiveOutgoing: true,
      speakOn: ["ALL_MESSAGES"],
    });
  }
}
```

---

## Exports Update

**`packages/sdk-ts/src/index.ts`** — add:
```ts
export * from "./workflows.js";
```

---

## Testing Strategy

### Unit Tests (`__tests__/workflows.test.ts`)

These mock `AgentRelay` to test workflow logic without a real broker:

1. **Convention injection** — verify augmented task text contains correct protocol instructions for each pattern
2. **DONE parsing** — verify regex extraction from various message formats
3. **Pipeline sequencing** — verify stage N+1 receives stage N's summary
4. **Fan-out completion** — verify workflow resolves when all agents exit
5. **Timeout handling** — verify agents are released on timeout
6. **Cancel** — verify `cancel()` releases all agents
7. **Consensus vote parsing** — verify VOTE: approve/reject extraction
8. **Mesh round tracking** — verify round counting logic

### Integration Tests (`__tests__/workflows-integration.test.ts`)

Require `RELAY_API_KEY` + broker binary:

1. **Fan-out with 2 workers** — spawn, send tasks, verify DONE collection
2. **Pipeline 2-stage** — verify stage 2 receives stage 1 output
3. **Hub-and-spoke basic** — verify hub receives worker ACKs
4. **Timeout enforcement** — verify agents released after timeout

---

## Example: Building This Module With Itself

After implementation, the workflows module can be used to build features on itself — a meta-workflow:

```ts
import { pipeline } from "@agent-relay/sdk-ts/workflows";

const run = pipeline([
  {
    task: `Design the workflow-conventions.ts module. Read WORKFLOWS_SPEC.md
           and output the full TypeScript file with convention templates for
           all 5 workflow patterns (fanOut, pipeline, hubAndSpoke, consensus, mesh).
           Write the file to packages/sdk-ts/src/workflow-conventions.ts`,
    name: "ConventionDesigner",
  },
  {
    task: `Implement workflows.ts based on WORKFLOWS_SPEC.md and the convention
           templates from the previous stage. Write to packages/sdk-ts/src/workflows.ts.
           Implement all 5 workflow functions.`,
    name: "Implementer",
  },
  {
    task: `Write comprehensive unit tests in packages/sdk-ts/src/__tests__/workflows.test.ts.
           Mock AgentRelay. Test convention injection, DONE parsing, pipeline sequencing,
           timeout handling, and cancel behavior.`,
    name: "TestWriter",
  },
  {
    task: `Review all files written by previous stages. Check for type errors (run tsc --noEmit),
           verify tests pass (npm test), fix any issues. Ensure exports are added to index.ts.`,
    name: "Reviewer",
  },
], {
  cli: "claude",
  timeoutMs: 15 * 60_000,
});

const result = await run.result;
console.log(result.success ? "Module built successfully!" : "Build failed");
for (const agent of result.agents) {
  console.log(`  ${agent.name}: ${agent.summary}`);
}
```

---

## Reflection Protocol

Inspired by the reflection mechanism in [Generative Agents](https://arxiv.org/abs/2304.03442) (Park et al., 2023). Their ablation study showed that removing reflection dropped agent believability by **4.27 standard deviations**. The key insight: agents that periodically synthesize what's happening — not just react to individual events — make dramatically better decisions.

### How It Works

Reflection is **event-driven, not time-driven**. The SDK tracks an importance accumulator for incoming agent messages. When the accumulator crosses a threshold, a reflection cycle fires.

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  OBSERVE     │ ──▶ │  ACCUMULATE  │ ──▶ │  REFLECT     │ ──▶ │  ADJUST      │
│              │     │              │     │              │     │              │
│ Agent msgs   │     │ Score each   │     │ Focal points │     │ Reassign     │
│ come in      │     │ msg by       │     │ Synthesize   │     │ Spawn more   │
│              │     │ importance   │     │ Insights     │     │ Message      │
│              │     │              │     │ Record       │     │ Release      │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
                            │                    │                     │
                            ▼                    ▼                     ▼
                     threshold hit?       trajectory event      course correction
```

### Message Importance Scoring

Each incoming agent message is scored 1-10 for importance:

| Score | Category | Examples |
|-------|----------|----------|
| 1-2 | Routine | ACK messages, heartbeats, "starting work" |
| 3-4 | Progress | "Completed file X", incremental updates |
| 5-6 | Significant | Decisions made, blockers encountered |
| 7-8 | Critical | Errors, conflicting approaches, scope changes |
| 9-10 | Urgent | Agent failures, security findings, architecture conflicts |

The SDK uses a lightweight heuristic to score messages (keyword matching + message type). The `onReflect` hook allows users to override with custom scoring.

Default threshold: **accumulated importance >= 50** (roughly 10 significant messages or 5 critical ones). Configurable via `reflectionThreshold` on `WorkflowOptions`.

### The Reflection Cycle

When the threshold fires, three steps execute (mirroring the Generative Agents algorithm):

**Step 1: Focal Point Generation**

The SDK examines recent messages and generates 2-3 high-level questions:
- "Are workers converging on the same solution or diverging?"
- "Is any agent blocked or spinning without progress?"
- "Have the original requirements been misunderstood?"

**Step 2: Synthesis**

Recent messages + prior reflections are synthesized into a `ReflectionEvent`:

```ts
{
  ts: "2026-02-18T14:30:00Z",
  synthesis: "AuthWorker and ApiWorker are both implementing middleware — duplicated effort. AuthWorker is further along. TestWorker is idle waiting for implementation.",
  focalPoints: [
    "Are workers duplicating effort?",
    "Is the test worker blocked?"
  ],
  adjustments: [
    { agent: "ApiWorker", action: "message", content: "Stop middleware work — AuthWorker owns it. Focus on route handlers only." },
    { agent: "TestWorker", action: "message", content: "Start writing test scaffolding now, AuthWorker will have middleware ready soon." }
  ],
  confidence: 0.75
}
```

**Step 3: Course Correction**

If `onReflect` returns adjustments, the SDK executes them:
- `reassign` — sends a new task to the agent
- `release` — terminates the agent
- `message` — sends a coordination message
- `spawn` — creates a new agent

### REFLECT Message Protocol

Alongside DONE, ACK, and VOTE, reflection adds a new message type:

```ts
const REFLECT_REGEX = /^REFLECT:\s*(.+)/m;
```

Convention injection for hub agents includes:

```
## Reflection Protocol
After receiving several worker updates, periodically pause and reflect:
1. Send to #workflow-{id}: "REFLECT: <your synthesis of overall progress>"
2. Consider: Are workers aligned? Is anyone stuck? Should strategy change?
3. If adjustments needed, message affected workers directly.
4. Record key decisions: trail decision "<what you changed and why>"
```

### Reflection in Each Pattern

| Pattern | Who Reflects | Trigger | What Changes |
|---------|-------------|---------|--------------|
| `fanOut` | SDK orchestrator | N worker messages | Can cancel stuck workers, spawn replacements |
| `pipeline` | SDK between stages | After each stage DONE | Adjusts next stage's task based on synthesis |
| `hubAndSpoke` | Hub agent + SDK | Hub: continuous; SDK: threshold | Hub adjusts worker tasks; SDK monitors hub health |
| `consensus` | SDK after discussion phase | Before voting round | Can extend discussion, add context to voters |
| `mesh` | Each peer + SDK | Per-round | Peers self-coordinate; SDK detects stalls |

### Implementation

```ts
class ReflectionEngine {
  private importanceAccumulator = 0;
  private recentMessages: Message[] = [];
  private reflections: ReflectionEvent[] = [];

  constructor(
    private threshold: number,
    private onReflect?: (ctx: ReflectionContext) => Promise<ReflectionAdjustment[] | null>,
    private trajectory?: TrajectorySession,
  ) {}

  /** Called for every incoming agent message. */
  async observe(agent: Agent, message: Message): Promise<ReflectionEvent | null> {
    const importance = this.scoreImportance(message);
    this.importanceAccumulator += importance;
    this.recentMessages.push(message);

    if (this.importanceAccumulator < this.threshold) return null;

    // Threshold crossed — trigger reflection
    this.importanceAccumulator = 0;
    const event = await this.reflect();
    this.recentMessages = []; // Reset window
    return event;
  }

  private async reflect(): Promise<ReflectionEvent> {
    const context: ReflectionContext = {
      recentMessages: this.recentMessages,
      agentStatuses: this.getAgentStatuses(),
      elapsedMs: Date.now() - this.startTime,
      priorReflections: this.reflections,
      trajectory: this.trajectory,
    };

    const adjustments = await this.onReflect?.(context) ?? null;

    const event: ReflectionEvent = {
      ts: new Date().toISOString(),
      synthesis: this.buildSynthesis(context),
      focalPoints: this.generateFocalPoints(context),
      adjustments: adjustments ?? undefined,
      confidence: this.estimateConfidence(context),
    };

    this.reflections.push(event);

    // Record to trajectory if enabled
    if (this.trajectory) {
      await this.trajectory.event("reflection", event.synthesis, {
        significance: "high",
        raw: event,
      });
    }

    return event;
  }

  private scoreImportance(message: Message): number {
    // Heuristic scoring based on message content
    const text = message.text.toLowerCase();
    if (/error|fail|crash|panic/.test(text)) return 8;
    if (/blocked|stuck|waiting|conflict/.test(text)) return 6;
    if (/done:|complete|finished/.test(text)) return 5;
    if (/decision|chose|decided/.test(text)) return 5;
    if (/progress|update|working on/.test(text)) return 3;
    if (/ack:|starting/.test(text)) return 2;
    return 3; // Default: moderate importance
  }
}
```

---

## Trajectory Integration

The `agent-trajectories` SDK (`agent-trajectories` package, v0.4.0) provides persistent recording of agent work — decisions, events, retrospectives, and (with this integration) reflections. Workflows use it to create a complete audit trail of multi-agent work.

### Why Trajectories in Workflows

Without trajectory tracking, a workflow produces a `WorkflowResult` — a snapshot of what happened. With trajectories, you get a **persistent, searchable narrative** of the entire workflow execution: which agents did what, what decisions were made, what reflections occurred, and what the final retrospective concluded.

This enables:
1. **Post-workflow analysis** — "Why did the auth worker take 8 minutes?"
2. **Cross-workflow learning** — "Last 3 feature workflows had review rejections — why?"
3. **Compliance & attribution** — Agent Trace integration for code attribution
4. **Reflection memory** — Past reflections feed into future workflow planning

### Architecture

```
Workflow Orchestrator
    │
    ├── AgentRelay (messaging)
    │
    ├── ReflectionEngine (synthesis)
    │       │
    │       └──► TrajectorySession.event("reflection", ...)
    │
    └── TrajectorySession (from agent-trajectories SDK)
            │
            ├── chapter("spawn-phase", "orchestrator")
            ├── event("message_received", "AuthWorker: ACK")
            ├── event("reflection", "Workers aligned, on track")
            ├── decision({ question: "...", chosen: "...", ... })
            └── complete({ summary: "...", confidence: 0.85 })
```

### Lifecycle Mapping

| Workflow Phase | Trajectory Action |
|----------------|-------------------|
| Workflow starts | `client.start(workflowName, { source: taskSource })` |
| Agents spawn | `session.chapter("spawn-phase")` + events per agent |
| Agent ACK | `session.event("message_received", "AgentX: ACK: ...")` |
| Agent progress | `session.event("message_received", ...)` |
| Reflection fires | `session.event("reflection", synthesis, { significance: "high" })` |
| Course correction | `session.decision({ question, chosen, reasoning, alternatives })` |
| Agent DONE | `session.event("message_received", "AgentX: DONE: ...")` |
| Stage transition (pipeline) | `session.chapter("stage-N-name")` |
| Workflow completes | `session.complete({ summary, confidence, learnings, challenges })` |
| Workflow fails/times out | `session.abandon(reason)` |

### Usage

```ts
import { hubAndSpoke } from "@agent-relay/sdk-ts/workflows";

const run = hubAndSpoke({
  hub: { task: "Coordinate building a REST API", name: "Lead" },
  workers: [
    { task: "Implement database models", name: "DbWorker" },
    { task: "Implement route handlers", name: "ApiWorker" },
  ],
  trajectory: {
    enabled: true,
    agentName: "workflow-orchestrator",
    taskSource: { system: "beads", id: "beads-abc123" },
  },
  reflectionThreshold: 8,
  onReflect: async (ctx) => {
    // Custom reflection logic — examine worker progress
    const stuckAgents = [...ctx.agentStatuses.entries()]
      .filter(([, status]) => status === "stuck");

    if (stuckAgents.length > 0) {
      return stuckAgents.map(([name]) => ({
        agent: name,
        action: "message" as const,
        content: "You appear stuck. Please report your current status and blockers.",
      }));
    }
    return null;
  },
});

const result = await run.result;
// Trajectory is automatically saved to .trajectories/completed/YYYY-MM/
// Export: trail show traj_xxx --decisions
// Export: trail export traj_xxx --format markdown
```

### Auto-Generated Retrospective

When a workflow completes, the SDK auto-generates a trajectory retrospective from workflow data:

```ts
await session.complete({
  summary: buildWorkflowSummary(result),
  approach: `${result.pattern} workflow with ${result.agents.length} agents`,
  decisions: reflectionEngine.getDecisions(),
  challenges: reflectionEngine.getChallenges(),
  learnings: reflectionEngine.getLearnings(),
  confidence: result.success ? 0.85 : 0.4,
});
```

### Trajectory as Convention Injection

When trajectories are enabled, agents receive additional convention instructions:

```
## Trajectory Protocol
This workflow records a trajectory for future reference.
- Record key decisions: trail decision "<choice>" --reasoning "<why>"
- Record discoveries: trail finding "<what you found>"
- Your work will be attributed via Agent Trace.
```

---

## YAML Workflow Definitions

Workflows can be defined in YAML for easy sharing, version control, and consumption by non-TypeScript tools. This aligns with the `relay.yaml` configuration system defined in [relay-cloud swarm-patterns-spec](https://github.com/AgentWorkforce/relay-cloud/pull/94).

### Design Goals

1. **Portable** — YAML files can be shared across projects, teams, and registries
2. **Human-readable** — Non-developers can understand and modify workflows
3. **Compatible with relay.yaml** — YAML workflows can be embedded in `.relay/relay.yaml` or standalone in `.relay/workflows/`
4. **SDK parity** — Anything expressible in the TypeScript API is expressible in YAML, and vice versa

### Directory Convention

```
.relay/
├── relay.yaml                # Main config (can embed swarm.workflow inline)
└── workflows/                # Standalone workflow definitions
    ├── feature-dev.yaml
    ├── code-review.yaml
    └── my-custom-workflow.yaml
```

### Schema

```yaml
# ── Workflow Definition Schema ────────────────────────────────────────────────
# File: .relay/workflows/<name>.yaml

version: "1.0"

# ── Metadata ──────────────────────────────────────────────────────────────────
name: feature-dev                       # Unique workflow identifier
description: "Plan, implement, review, and finalize a feature"
tags: [feature, development]

# ── Pattern Selection ─────────────────────────────────────────────────────────
# Which orchestration pattern to use.
# Options: fan-out, pipeline, hub-spoke, consensus, mesh, handoff, cascade, dag, debate, hierarchical
pattern: hub-spoke

# ── Agent Definitions ─────────────────────────────────────────────────────────
agents:
  - id: lead
    name: "Tech Lead"
    role: lead                          # lead | worker | reviewer | voter | peer
    cli: claude                         # claude | codex | gemini | aider | goose
    model: claude-sonnet-4-6            # Optional model override

  - id: developer
    name: "Developer"
    role: worker
    cli: claude
    reportsTo: lead                     # For hub-spoke / hierarchical
    constraints:                        # Optional file/execution constraints
      fileScope:
        include: ["src/**"]
        exclude: ["**/*.test.ts"]
      readOnly: ["package.json", "tsconfig.json"]

  - id: reviewer
    name: "Code Reviewer"
    role: reviewer
    cli: claude
    reportsTo: lead

# ── Steps (Ordered Workflow Stages) ───────────────────────────────────────────
# Steps define the execution flow. Supports sequential, parallel (via dependsOn),
# and DAG-based scheduling.
steps:
  - id: plan
    agent: lead
    prompt: |
      Analyze this feature request and create a development plan:
      {{task}}

      Output:
      - Acceptance criteria
      - Files to modify
      - Test requirements
    expects: "PLAN_COMPLETE"            # Signal that marks step as done
    maxRetries: 2

  - id: implement
    agent: developer
    dependsOn: [plan]                   # Runs after plan completes
    prompt: |
      Implement the following plan:
      {{steps.plan.output}}
    expects: "IMPLEMENTATION_COMPLETE"
    verify:                             # Post-step verification commands
      - command: "npm run build"
        expectExit: 0
      - command: "npm test"
        expectExit: 0

  - id: review
    agent: reviewer
    dependsOn: [implement]
    prompt: |
      Review the implementation:
      {{steps.implement.output}}

      Check for: code quality, security issues, test coverage.
    expects: "REVIEW_COMPLETE"

  - id: finalize
    agent: lead
    dependsOn: [review]
    prompt: |
      Finalize based on review feedback:
      {{steps.review.output}}
    expects: "DONE"

# ── Reflection Configuration ──────────────────────────────────────────────────
reflection:
  enabled: true
  threshold: 10                         # Messages before reflection triggers
  reflector: lead                       # Which agent reflects (default: lead or SDK)
  # Convention injected into the reflector's prompt:
  prompt: |
    Pause and reflect on worker progress:
    1. Are workers aligned with the plan?
    2. Is anyone stuck or duplicating effort?
    3. Should the strategy change?
    Send "REFLECT: <your synthesis>" to the workflow channel.

# ── Trajectory Configuration ──────────────────────────────────────────────────
trajectory:
  enabled: true
  agentName: "workflow-orchestrator"
  autoRecordMessages: true
  autoRecordReflections: true

# ── Coordination ──────────────────────────────────────────────────────────────
coordination:
  mode: dag                             # sequential | parallel | dag
  barriers:
    - id: implementation-done
      waitFor: [developer]
      signal: "IMPLEMENTATION_COMPLETE"
      timeout: "10m"

# ── Options ───────────────────────────────────────────────────────────────────
options:
  timeout: "15m"                        # Workflow-wide timeout
  channel: "workflow-{{id}}"            # Channel template
  shadow:                               # Optional shadow/reviewer for all agents
    cli: claude
    task: "Review all code changes for security issues"

# ── Error Handling ────────────────────────────────────────────────────────────
errorHandling:
  maxRetries: 3
  retryDelay: "5s"
  escalateTo: lead
  onFailure: pause                      # pause | abort | continue
```

### Template Variables

YAML workflows support template interpolation:

| Variable | Description | Available In |
|----------|-------------|-------------|
| `{{task}}` | The task string passed at runtime | All step prompts |
| `{{id}}` | Auto-generated workflow run ID | channel, names |
| `{{steps.<id>.output}}` | DONE summary from a previous step | Steps with `dependsOn` |
| `{{git.diff}}` | Current git diff | Any step prompt |
| `{{git.branch}}` | Current git branch | Any step prompt |
| `{{agents.<id>.name}}` | Agent display name | Any step prompt |

### Parallel Steps via DAG

Steps without `dependsOn` pointing to each other run in parallel:

```yaml
steps:
  - id: setup
    agent: lead
    prompt: "Create the project scaffold"
    expects: "SCAFFOLD_READY"

  # These two run in parallel after setup:
  - id: frontend
    agent: fe-dev
    dependsOn: [setup]
    prompt: "Build the frontend: {{steps.setup.output}}"
    expects: "FRONTEND_DONE"

  - id: backend
    agent: be-dev
    dependsOn: [setup]
    prompt: "Build the backend: {{steps.setup.output}}"
    expects: "BACKEND_DONE"

  # This waits for both:
  - id: integration
    agent: lead
    dependsOn: [frontend, backend]
    prompt: "Integrate frontend and backend: {{steps.frontend.output}} + {{steps.backend.output}}"
    expects: "DONE"
```

### Built-In Templates

Users can reference built-in templates with minimal config:

```yaml
# Minimal — just reference the template
version: "1.0"
name: my-feature
template: feature-dev

# Override specific settings
overrides:
  agents.developer.cli: codex
  steps.plan.maxRetries: 5
  options.timeout: "30m"
```

| Template | Pattern | Agents | Steps |
|----------|---------|--------|-------|
| `feature-dev` | hub-spoke | lead, developer, reviewer | plan → implement → review → finalize |
| `bug-fix` | hub-spoke | lead, investigator, fixer | investigate → fix → verify |
| `code-review` | fan-out | reviewer x N | analyze (parallel) → report |
| `security-audit` | pipeline | scanner, analyst, fixer, verifier | scan → prioritize → fix → verify |
| `refactor` | pipeline | analyst, planner, implementer | analyze → plan → execute |
| `brainstorm` | mesh | peer x N | open-ended exploration |

### Loading YAML Workflows

```ts
import { loadWorkflow, runWorkflow } from "@agent-relay/sdk-ts/workflows";

// Load from file
const workflow = await loadWorkflow(".relay/workflows/feature-dev.yaml");

// Run with a task
const run = runWorkflow(workflow, "Add user authentication with OAuth2", {
  // Runtime overrides (merged with YAML config)
  timeoutMs: 20 * 60_000,
  onReflect: async (ctx) => { /* custom reflection logic */ },
});

const result = await run.result;
```

### TypeScript Types for YAML Schema

```ts
interface YamlWorkflow {
  version: "1.0";
  name: string;
  description?: string;
  tags?: string[];

  /** Use a built-in template as the base. */
  template?: string;
  /** Override specific template settings (dot-notation paths). */
  overrides?: Record<string, unknown>;

  pattern: "fan-out" | "pipeline" | "hub-spoke" | "consensus" | "mesh" | "handoff" | "cascade" | "dag" | "debate" | "hierarchical";

  agents: YamlAgent[];
  steps: YamlStep[];

  reflection?: {
    enabled: boolean;
    threshold?: number;
    reflector?: string;
    prompt?: string;
  };

  trajectory?: {
    enabled: boolean;
    agentName?: string;
    autoRecordMessages?: boolean;
    autoRecordReflections?: boolean;
  };

  coordination?: {
    mode?: "sequential" | "parallel" | "dag";
    barriers?: YamlBarrier[];
  };

  options?: {
    timeout?: string;
    channel?: string;
    shadow?: { cli: AgentCli; task: string };
  };

  errorHandling?: {
    maxRetries?: number;
    retryDelay?: string;
    escalateTo?: string;
    onFailure?: "pause" | "abort" | "continue";
  };
}

interface YamlAgent {
  id: string;
  name?: string;
  role: "lead" | "worker" | "reviewer" | "voter" | "peer" | "coordinator";
  cli?: AgentCli;
  model?: string;
  reportsTo?: string;
  constraints?: {
    fileScope?: { include?: string[]; exclude?: string[] };
    readOnly?: string[];
    maxTokens?: number;
    maxDuration?: string;
  };
}

interface YamlStep {
  id: string;
  agent: string;
  prompt: string;
  dependsOn?: string[];
  expects?: string;
  maxRetries?: number;
  verify?: YamlVerification[];
}

interface YamlVerification {
  command: string;
  expectExit: number;
  timeout?: string;
}

interface YamlBarrier {
  id: string;
  waitFor: string[];
  signal?: string;
  type?: "all" | "any" | "majority";
  timeout?: string;
}
```

### YAML ↔ TypeScript SDK Mapping

The YAML loader converts workflow definitions into SDK calls:

```ts
async function runWorkflow(
  workflow: YamlWorkflow,
  task: string,
  overrides?: Partial<WorkflowOptions>,
): WorkflowRun {
  const options = mergeOptions(workflow, overrides);

  // Pattern mapping
  switch (workflow.pattern) {
    case "fan-out":
      return fanOut(stepsToTasks(workflow, task), options);
    case "pipeline":
      return pipeline(stepsToStages(workflow, task), options);
    case "hub-spoke":
      return hubAndSpoke({
        hub: agentToTask(getHub(workflow), task),
        workers: getWorkers(workflow).map(a => agentToTask(a, task)),
        ...options,
      });
    case "consensus":
      return consensus({
        proposal: task,
        voters: getVoters(workflow).map(a => agentToTask(a, task)),
        ...options,
      });
    case "mesh":
      return mesh({
        goal: task,
        agents: workflow.agents.map(a => agentToTask(a, task)),
        ...options,
      });
  }
}
```

### Compatibility with relay.yaml

YAML workflows are designed to work with the relay-cloud `relay.yaml` schema. A workflow defined in `.relay/workflows/feature-dev.yaml` can be referenced from `relay.yaml`:

```yaml
# .relay/relay.yaml
swarm:
  workflow: feature-dev              # References .relay/workflows/feature-dev.yaml
  agents:
    developer: codex                 # Override: use Codex for the developer role
```

Or embedded inline:

```yaml
# .relay/relay.yaml
swarm:
  pattern: hub-spoke
  agents:
    - id: lead
      role: lead
      cli: claude
    - id: developer
      role: worker
      cli: codex
      reportsTo: lead
  workflow:
    steps:
      - id: plan
        agent: lead
        prompt: "..."
        expects: "PLAN_COMPLETE"
  reflection:
    enabled: true
    threshold: 10
  trajectory:
    enabled: true
```

The SDK's `loadWorkflow` function resolves both standalone files and relay.yaml-embedded workflows.

---

## Priority & Scope

### Phase 1 — Core Patterns
- `fanOut` workflow
- `pipeline` workflow
- `dag` workflow (DAG scheduler primitive)
- Convention injection system
- DONE/ACK parsing + new signal regexes (HANDOFF, CONFIDENCE, etc.)
- Unit tests
- Export from index.ts

### Phase 2 — Coordination Patterns
- `hubAndSpoke` workflow
- `consensus` workflow (integrate ConsensusEngine)
- `handoff` workflow (Handoff Controller primitive)
- `cascade` workflow (Confidence Parser primitive)
- Shadow integration
- YAML workflow loader (`loadWorkflow`, `runWorkflow`)
- YAML schema validation
- Built-in templates (feature-dev, bug-fix, code-review)

### Phase 3 — Advanced Patterns
- `mesh` workflow
- `debate` workflow (Round Manager primitive)
- `hierarchical` workflow (Tree Validator primitive)
- Max rounds / round tracking / convergence detection
- `ReflectionEngine` — importance scoring, focal points, synthesis
- REFLECT message protocol
- Reflection convention injection for hub agents
- `onReflect` hook

### Phase 4 — Intelligence Layer
- `agent-trajectories` integration (TrajectoryRecorder primitive)
- Auto-recording of messages, reflections, decisions to trajectory
- Auto-generated retrospective on workflow completion
- Trajectory convention injection (trail commands for agents)
- Workflow composition (nest workflows within workflows)
- `WorkflowBuilder` fluent API for custom patterns
- Cross-workflow learning (query past trajectories before planning)

### Phase 5 — Extended Primitives (42-technique coverage)
- Stigmergic State Store (`workflow-stigmergy.ts`) — decay, reinforcement, pheromone trails
- Agent Pool Manager (`workflow-pool.ts`) — population lifecycle, fitness evaluation, cull/reproduce
- Auction Engine (`workflow-auction.ts`) — bid collection, evaluation, award cycle
- Branch Pruner (extend `workflow-dag.ts`) — beam search, fitness-based pruning
- Gossip Disseminator (`workflow-gossip.ts`) — random peer selection, epidemic spread
- New message signals: BID, AWARD, DEPOSIT, FITNESS, GOSSIP
- Convention injection for all new signals
- Integration tests for ACO, evolutionary, auction, and gossip workflows

---

## Open Questions

1. **Task delivery for non-Claude CLIs** — How do codex/gemini/aider receive the initial task? Need to verify each CLI's argument format. Fallback is always relay message.

2. **Shared file context** — Should workflows support a `sharedFiles` option that makes certain files available to all agents? This maps to the "Shared Workspace Context" primitive from the swarm report.

3. **Progress tracking** — Should there be a formal PROGRESS message protocol beyond DONE/ACK? E.g., `PROGRESS: 50% — finished auth module`. This would enable live progress bars in the SDK consumer.

4. **Reflection intelligence** — The current `scoreImportance` is heuristic-based (keyword matching). Should we offer an LLM-powered scoring option where an LLM rates message importance 1-10 (matching the Generative Agents approach)? Trade-off: latency + cost vs. accuracy.

5. **`trail reflect` CLI command** — The `agent-trajectories` CLI currently has no `reflect` command. Should we add a `trail reflect "<synthesis>"` command to the trajectories repo so agents can record reflections from the CLI, or is the SDK programmatic API sufficient?

6. **YAML workflow registry** — Should there be a central registry (like npm) for sharing workflow templates? Or is git + `.relay/workflows/` sufficient for now?

7. **relay.yaml convergence** — The relay-cloud [swarm-patterns-spec PR #94](https://github.com/AgentWorkforce/relay-cloud/pull/94) defines a relay.yaml schema. This SDK spec should be the canonical consumer of that schema. Need to ensure the YAML types here stay in sync with relay-cloud's schema definition.

---

## References

- [Generative Agents: Interactive Simulacra of Human Behavior](https://arxiv.org/abs/2304.03442) — Park et al., 2023. Source of the reflection mechanism design.
- [relay-cloud swarm-patterns-spec PR #94](https://github.com/AgentWorkforce/relay-cloud/pull/94) — YAML schema for relay.yaml swarm configuration.
- [agent-trajectories](https://github.com/AgentWorkforce/trajectories) — SDK for trajectory recording, v0.4.0.
- [Antfarm](https://github.com/snarktank/antfarm) — Inspiration for deterministic YAML-based workflow definitions.
- [swarm-patterns experiment](https://github.com/AgentWorkforce/swarm-patterns) — Prior art on multi-agent coordination patterns.
