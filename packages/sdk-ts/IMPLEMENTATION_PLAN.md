# Implementation Plan: relay-cloud PR #94 (Swarm Patterns for relay.yaml)

> Using the broker SDK (`@agent-relay/sdk-ts`) to coordinate a multi-agent workflow
> implementing the spec from [relay-cloud PR #94](https://github.com/AgentWorkforce/relay-cloud/pull/94).

## Chosen Swarm Pattern: DAG (Directed Acyclic Graph)

### Why DAG?

The PR #94 spec has **clear dependency chains with parallelizable branches** — making it a textbook DAG problem:

- DB migrations must complete before the workflow runner can persist state
- The workflow runner must exist before API endpoints can call it
- CLI commands and cloud API endpoints can develop **in parallel** once shared types exist
- Templates are independent of coordination primitives
- Dashboard work depends on API endpoints being defined

Other patterns considered:
- **Pipeline** — too linear; cloud/CLI/dashboard can parallelize
- **Hub-spoke** — no need for a live coordinator making runtime decisions; the dependency structure is known upfront
- **Hierarchical** — overkill; there's one domain (relay-cloud) not three separate teams

### How to Run This Plan

```yaml
# .relay/workflows/implement-swarm-patterns.yaml
version: "1.0"
name: implement-swarm-patterns
pattern: dag
agents:
  - id: architect
    role: lead
    cli: claude
  - id: cloud-types
    role: worker
    cli: claude
    reportsTo: architect
  - id: cloud-db
    role: worker
    cli: claude
    reportsTo: architect
  - id: cloud-runner
    role: worker
    cli: claude
    reportsTo: architect
  - id: cloud-coordinator
    role: worker
    cli: claude
    reportsTo: architect
  - id: cloud-api
    role: worker
    cli: claude
    reportsTo: architect
  - id: cli-worker
    role: worker
    cli: claude
    reportsTo: architect
  - id: template-worker
    role: worker
    cli: codex
    reportsTo: architect
  - id: dashboard-worker
    role: worker
    cli: claude
    reportsTo: architect
  - id: test-worker
    role: worker
    cli: claude
    reportsTo: architect

nodes:
  - id: shared-types
    agent: cloud-types
    task: "Define shared TypeScript types for relay.yaml schema, workflow runs, steps, barriers, and state"
    dependsOn: []

  - id: db-migration
    agent: cloud-db
    task: "Create database migration 0023_workflows.sql with workflow_runs, workflow_steps, swarm_state, workflow_barriers tables"
    dependsOn: [shared-types]

  - id: workflow-runner
    agent: cloud-runner
    task: "Implement WorkflowRunner service: YAML parsing, step execution, verification, output extraction"
    dependsOn: [shared-types, db-migration]

  - id: swarm-coordinator
    agent: cloud-coordinator
    task: "Implement SwarmCoordinator: pattern selection, agent spawning via broker SDK, barrier management, state store"
    dependsOn: [shared-types, db-migration]

  - id: templates
    agent: template-worker
    task: "Create 6 built-in workflow templates: feature-dev, bug-fix, code-review, security-audit, refactor, documentation"
    dependsOn: [shared-types]

  - id: cloud-api
    agent: cloud-api
    task: "Implement REST API endpoints for /api/workflows/* and /api/swarm/* and /api/dashboard/swarms/*"
    dependsOn: [workflow-runner, swarm-coordinator]

  - id: cli-commands
    agent: cli-worker
    task: "Implement 'agent-relay swarm' CLI subcommands: run, list, status, stop, logs, history, and shorthand aliases"
    dependsOn: [shared-types, templates]

  - id: dashboard-panel
    agent: dashboard-worker
    task: "Build swarm panel UI with live topology view, step progress, agent output streaming via SSE"
    dependsOn: [cloud-api]

  - id: integration-tests
    agent: test-worker
    task: "Write integration tests for all workflow patterns, API endpoints, CLI commands, and error scenarios"
    dependsOn: [cloud-api, cli-commands]

maxConcurrency: 4

reflection:
  enabled: true
  threshold: 15

trajectory:
  enabled: true
```

---

## Implementation Nodes (Detailed)

### Node 1: `shared-types` — Shared TypeScript Types

**No dependencies. Starts immediately.**

**Files to create/modify:**
- `packages/cloud/src/types/workflow.ts` (NEW)
- `packages/cloud/src/config/relay-yaml-schema.json` (EXTEND)

**Deliverables:**

```typescript
// Core types matching PR #94 schema
interface RelayYamlConfig {
  version: "1.0";
  swarm: SwarmConfig | string; // string = template name shorthand
}

interface SwarmConfig {
  pattern: "hub-spoke" | "hierarchical" | "mesh" | "consensus" | "custom";
  agents: AgentDefinition[];
  workflow?: WorkflowDefinition;
  coordination?: CoordinationConfig;
  errorHandling?: ErrorHandlingConfig;
}

interface AgentDefinition {
  id: string;
  name?: string;
  role: "lead" | "worker" | "specialist" | "coordinator";
  cli: "claude" | "codex" | "gemini" | "aider" | "goose";
  model?: string;
  reportsTo?: string;
  constraints?: AgentConstraints;
}

interface WorkflowDefinition {
  id: string;
  name: string;
  steps: WorkflowStep[];
}

interface WorkflowStep {
  id: string;
  agent: string;
  prompt?: string;
  dependsOn?: string[];
  expects?: string;
  maxRetries?: number;
  verify?: VerificationCheck[];
  outputs?: OutputExtraction[];
}

interface VerificationCheck {
  command?: string;
  expectExit?: number;
  fileExists?: string;
  fileContains?: { path: string; pattern: string };
  script?: string;
  timeout?: string;
}

interface CoordinationConfig {
  mode: "sequential" | "parallel" | "dag";
  barriers?: Barrier[];
  state?: StateConfig;
}

interface Barrier {
  id: string;
  waitFor: string[];
  signal?: string;
  timeout?: string;
  type?: "all" | "any" | "majority";
}

interface StateConfig {
  enabled: boolean;
  persistence?: "memory" | "sqlite" | "redis";
  initial?: Record<string, unknown>;
  rules?: StateRule[];
}

// DB row types
interface WorkflowRunRow {
  id: string;          // UUID
  workspace_id: string;
  workflow_id: string;
  task: string;
  status: "pending" | "running" | "completed" | "failed" | "paused";
  config: SwarmConfig; // JSONB
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

interface WorkflowStepRow {
  id: string;
  run_id: string;
  step_id: string;
  agent_id: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  input?: string;
  output?: string;
  retries: number;
  error?: string;
  verification_results?: Record<string, unknown>; // JSONB
  started_at?: string;
  completed_at?: string;
}
```

**Acceptance criteria:**
- All types from PR #94 are represented
- JSON Schema for relay.yaml validation
- Exported from a single module

---

### Node 2: `db-migration` — Database Schema

**Depends on:** `shared-types`

**Files to create:**
- `packages/cloud/src/db/migrations/0023_workflows.sql` (NEW)

**SQL tables (from PR #94 spec):**

```sql
-- Workflow run tracking
CREATE TABLE workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  workflow_id TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'paused')),
  config JSONB NOT NULL,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Individual step execution
CREATE TABLE workflow_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  input TEXT,
  output TEXT,
  retries INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  verification_results JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (run_id, step_id)
);

-- Shared state store for swarm coordination
CREATE TABLE swarm_state (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);

-- Barrier synchronization
CREATE TABLE workflow_barriers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  barrier_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'signaled', 'timeout')),
  signaled_by TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  signaled_at TIMESTAMPTZ,
  UNIQUE (run_id, barrier_id)
);

-- Indexes
CREATE INDEX idx_workflow_runs_workspace ON workflow_runs(workspace_id, status);
CREATE INDEX idx_workflow_runs_status ON workflow_runs(status);
CREATE INDEX idx_workflow_steps_run ON workflow_steps(run_id);
CREATE INDEX idx_workflow_barriers_run ON workflow_barriers(run_id);
```

**Acceptance criteria:**
- Migration runs cleanly against existing schema
- Indexes cover common query patterns
- Foreign keys maintain referential integrity

---

### Node 3: `workflow-runner` — Core Execution Engine

**Depends on:** `shared-types`, `db-migration`

**Files to create:**
- `packages/cloud/src/services/workflow-runner.ts` (NEW)

**Responsibilities:**
1. Parse relay.yaml and resolve template references
2. Validate workflow config against JSON schema
3. Execute steps in order (sequential, parallel, or DAG mode)
4. Run verification checks after each step
5. Extract outputs using regex patterns
6. Persist run/step state to database
7. Handle retries with configurable delay
8. Support pause/resume/abort

**Key integration with broker SDK:**

```typescript
import { AgentRelay } from '@agent-relay/sdk-ts';

class WorkflowRunner {
  private relay: AgentRelay;
  private db: Database;

  async runWorkflow(config: SwarmConfig, task: string): Promise<WorkflowRunRow> {
    // 1. Create run record in DB
    const run = await this.db.createRun(config, task);

    // 2. Spawn agents via broker SDK
    const agents = new Map<string, Agent>();
    for (const agentDef of config.agents) {
      const agent = await this.relay.spawnPty({
        name: agentDef.id,
        cli: agentDef.cli,
        model: agentDef.model,
        task: '', // Task injected per-step
      });
      agents.set(agentDef.id, agent);
    }

    // 3. Execute steps (respecting dependsOn DAG)
    await this.executeSteps(run, config.workflow.steps, agents);

    return run;
  }
}
```

**Acceptance criteria:**
- Sequential step execution works end-to-end
- DAG-based parallel execution respects dependencies
- Verification checks gate step completion
- Output extraction populates `{{steps.<id>.output}}` variables
- All state persisted to DB (survives crashes)

---

### Node 4: `swarm-coordinator` — Pattern Orchestration

**Depends on:** `shared-types`, `db-migration`

**Files to create:**
- `packages/cloud/src/services/swarm-coordinator.ts` (NEW)
- `packages/cloud/src/services/barrier-manager.ts` (NEW)
- `packages/cloud/src/services/state-store.ts` (NEW)

**Responsibilities:**

**SwarmCoordinator:**
- Select pattern based on config or auto-detect from command
- Map pattern to agent topology (hub-spoke, hierarchical, mesh, consensus)
- Coordinate agent lifecycle (spawn order, release on completion)
- Handle error escalation per `errorHandling` config

**BarrierManager:**
- Track barrier state in `workflow_barriers` table
- Support `all`, `any`, `majority` barrier types
- Timeout barriers after configured duration
- Signal barriers when agents report completion

**StateStore:**
- CRUD operations on `swarm_state` table
- Consensus-required state updates (check voter rules)
- Optimistic locking via `updated_at` timestamp

**Pattern → command auto-mapping (from PR #94):**

| Command | Auto-Selected Pattern |
|---------|----------------------|
| `feature` | hub-spoke |
| `fix` | hub-spoke |
| `review` | consensus |
| `refactor` | hierarchical |
| `brainstorm` | mesh |
| `decide` | consensus |

**Acceptance criteria:**
- All 4 patterns selectable and functional
- Barriers synchronize multi-agent joins
- State store supports consensus-gated writes
- Error escalation routes failures to lead agent

---

### Node 5: `templates` — Built-in Workflow Templates

**Depends on:** `shared-types`

**Files to create:**
- `packages/cloud/src/templates/feature-dev.yaml` (NEW)
- `packages/cloud/src/templates/bug-fix.yaml` (NEW)
- `packages/cloud/src/templates/code-review.yaml` (NEW)
- `packages/cloud/src/templates/security-audit.yaml` (NEW)
- `packages/cloud/src/templates/refactor.yaml` (NEW)
- `packages/cloud/src/templates/documentation.yaml` (NEW)
- `packages/cloud/src/services/template-registry.ts` (NEW)

**Template structure (example: feature-dev):**

```yaml
version: "1.0"
name: feature-dev
description: "Full feature development lifecycle"
pattern: hub-spoke
agents:
  - id: lead
    role: lead
    cli: claude
  - id: planner
    role: specialist
    cli: claude
    reportsTo: lead
  - id: developer
    role: worker
    cli: claude
    reportsTo: lead
  - id: reviewer
    role: specialist
    cli: claude
    reportsTo: lead
workflow:
  steps:
    - id: plan
      agent: planner
      prompt: |
        Analyze this feature request and create a development plan:
        {{task}}
      expects: "PLAN_COMPLETE"
      maxRetries: 2
    - id: implement
      agent: developer
      dependsOn: [plan]
      prompt: |
        Implement the following plan:
        {{steps.plan.output}}
      expects: "IMPLEMENTATION_COMPLETE"
      verify:
        - command: "npm run build"
          expectExit: 0
        - command: "npm run lint"
          expectExit: 0
    - id: review
      agent: reviewer
      dependsOn: [implement]
      prompt: |
        Review the implementation for:
        {{steps.plan.output}}
      expects: "REVIEW_COMPLETE"
    - id: finalize
      agent: lead
      dependsOn: [review]
      expects: "DONE"
```

**TemplateRegistry:**
- Load built-in templates from `src/templates/`
- Load custom templates from `.relay/workflows/`
- Resolve template by name (`swarm: feature-dev` → full config)
- Support template overrides (`overrides: { steps.plan.maxRetries: 5 }`)
- Install external templates from URL

**Acceptance criteria:**
- All 6 templates parse and validate
- `swarm: feature-dev` shorthand resolves correctly
- Override system works for agent swaps and parameter changes

---

### Node 6: `cloud-api` — REST API Endpoints

**Depends on:** `workflow-runner`, `swarm-coordinator`

**Files to create/modify:**
- `packages/cloud/src/api/workflows.ts` (NEW)
- `packages/cloud/src/api/swarm.ts` (NEW)
- `packages/cloud/src/api/dashboard-swarms.ts` (NEW)

**Endpoints (from PR #94):**

```
# Workflow lifecycle
POST   /api/workflows/run           → Start a workflow run
GET    /api/workflows/runs          → List runs (with filters)
GET    /api/workflows/runs/:id      → Get run details
POST   /api/workflows/runs/:id/pause  → Pause run
POST   /api/workflows/runs/:id/resume → Resume run
POST   /api/workflows/runs/:id/abort  → Abort run
GET    /api/workflows/runs/:id/steps  → List steps for a run
GET    /api/workflows/runs/:id/steps/:stepId → Get step details

# Swarm state & barriers
GET    /api/swarm/state             → Get all state
GET    /api/swarm/state/:key        → Get state by key
PUT    /api/swarm/state/:key        → Update state
DELETE /api/swarm/state/:key        → Delete state key
POST   /api/swarm/barriers/:id/signal → Signal a barrier
GET    /api/swarm/barriers/:id/status → Check barrier status

# Dashboard
GET    /api/dashboard/swarms        → List active swarms
POST   /api/dashboard/swarms        → Start swarm from dashboard
GET    /api/dashboard/swarms/:id    → Get swarm details
DELETE /api/dashboard/swarms/:id    → Stop swarm
GET    /api/dashboard/swarms/:id/output → SSE stream of agent output
GET    /api/dashboard/swarms/:id/topology → Agent topology graph
GET    /api/dashboard/swarms/history → Past swarm runs
GET    /api/dashboard/workflows     → Available workflows
GET    /api/dashboard/patterns      → Available patterns
```

**WebSocket events:**
```
swarm:started, swarm:step:started, swarm:step:completed,
swarm:agent:message, swarm:completed, swarm:failed
```

**Acceptance criteria:**
- All endpoints return correct status codes
- SSE streaming works for live agent output
- WebSocket events fire for all lifecycle transitions
- Proper auth/workspace scoping on all endpoints

---

### Node 7: `cli-commands` — CLI Interface

**Depends on:** `shared-types`, `templates`

**Files to create/modify:**
- `packages/cli/src/commands/workflow.ts` (NEW) — or in the relay repo

**Commands (from PR #94):**

```bash
# Core
agent-relay swarm run <workflow> [task]   # Run a workflow
agent-relay swarm list                     # List available workflows
agent-relay swarm status [run-id]          # Check run status
agent-relay swarm stop [run-id]            # Stop a run
agent-relay swarm logs [run-id]            # View logs
agent-relay swarm history                  # Past runs

# Shorthand
agent-relay swarm feature "Add auth"       # → run feature-dev
agent-relay swarm fix "Login bug"          # → run bug-fix
agent-relay swarm review                   # → run code-review
agent-relay swarm audit                    # → run security-audit
agent-relay swarm refactor "Extract auth"  # → run refactor
agent-relay swarm docs "Update API ref"    # → run documentation

# Template management
agent-relay swarm templates                # List templates
agent-relay swarm templates show <name>    # Show template details
agent-relay swarm validate                 # Validate relay.yaml
agent-relay swarm graph --output swarm.png # Visualize DAG

# Top-level aliases
agent-relay feature "Add dark mode"        # Shorthand for swarm feature
agent-relay fix "Bug in checkout"          # Shorthand for swarm fix
```

**CLI flags:**
- `--pattern <name>` — override pattern
- `--agents <n>` — override agent count
- `--timeout <duration>` — max run time
- `--dry-run` — validate without executing
- `--verbose` — detailed output
- `--json` — JSON output format

**Acceptance criteria:**
- All commands parse arguments correctly
- Shorthand commands map to correct templates
- `--dry-run` validates config without spawning agents
- Progress reporting shows step completion in real-time

---

### Node 8: `dashboard-panel` — Dashboard UI

**Depends on:** `cloud-api`

**Files to create:**
- `packages/dashboard/src/components/SwarmPanel.tsx` (NEW) — or in relay-dashboard repo
- `packages/dashboard/src/components/TopologyView.tsx` (NEW)
- `packages/dashboard/src/components/StepProgress.tsx` (NEW)

**UI components:**
1. **Swarm Panel** — list active/past swarms, start new swarm
2. **Topology View** — live graph of agents and their connections (hub-spoke, hierarchical, mesh)
3. **Step Progress** — step-by-step timeline with status indicators
4. **Agent Output Stream** — SSE-fed live output from each agent
5. **Config Editor** — YAML editor for relay.yaml with validation

**Acceptance criteria:**
- Live topology updates as agents spawn/release
- Step progress reflects real-time status
- Agent output streams without lag
- YAML editor validates on save

---

### Node 9: `integration-tests` — End-to-End Testing

**Depends on:** `cloud-api`, `cli-commands`

**Files to create:**
- `packages/cloud/tests/workflows.test.ts` (NEW)
- `packages/cloud/tests/swarm-coordinator.test.ts` (NEW)
- `packages/cli/tests/swarm-commands.test.ts` (NEW)

**Test scenarios:**
1. **Sequential workflow**: feature-dev template runs plan → implement → review → finalize
2. **DAG parallelism**: Two independent steps run concurrently, join step waits for both
3. **Barrier synchronization**: Multiple agents hit barrier, all released when last signals
4. **State store consensus**: Write requires majority vote before accepting
5. **Error handling**: Step failure triggers retry, then escalation to lead
6. **Pause/resume**: Running workflow pauses cleanly, resumes from correct step
7. **CLI dry-run**: Validates config without spawning agents
8. **Template resolution**: `swarm: feature-dev` resolves to full config with correct defaults
9. **Verification checks**: Build/lint commands gate step completion
10. **Pattern auto-selection**: `agent-relay feature` selects hub-spoke

**Acceptance criteria:**
- All 10 scenarios pass
- Tests run in CI (no external dependencies needed)
- Mock broker SDK for unit tests, real broker for integration

---

## Execution Timeline

```
Week 1:  shared-types ──┬── db-migration ──┬── workflow-runner ─┐
                        │                  │                    │
                        ├── templates      └── swarm-coordinator┤
                        │                                       │
Week 2:  templates ─────┤                                       ├── cloud-api
                        │                                       │
                        └── cli-commands ───────────────────────┤
                                                                │
Week 3:                                          cloud-api ─────┼── dashboard-panel
                                                                │
                                                 cli-commands ──┴── integration-tests
```

**Critical path:** shared-types → db-migration → workflow-runner → cloud-api → integration-tests

**Parallelizable:** templates + cli-commands can run alongside workflow-runner + swarm-coordinator

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Broker SDK doesn't support all spawn options needed | Extend `SpawnPtyInput` type if needed; the SDK already supports cli, model, task |
| YAML parsing edge cases | Use `yaml` npm package + JSON Schema validation before execution |
| Step verification timeouts | Default 60s timeout per check, configurable per step |
| Agent crashes mid-workflow | WorkflowRunner checks agent exit events, marks step as failed, triggers retry |
| Barrier deadlock | Timeout all barriers (default 5m), escalate to lead on timeout |
| State store race conditions | Optimistic locking via `updated_at` column + retry on conflict |

---

## Repositories and Branches

| Repository | Branch | Key Changes |
|------------|--------|-------------|
| relay-cloud | `feature/swarm-patterns` | WorkflowRunner, SwarmCoordinator, API endpoints, DB migration, templates |
| relay | `feature/swarm-cli` | CLI subcommands, relay.yaml loading |
| relay-dashboard | `feature/swarm-panel` | Swarm panel UI, topology view, SSE streaming |
| relay (sdk-ts) | `sdk-workflows` | WORKFLOWS_SPEC.md (already done), workflow primitives |
