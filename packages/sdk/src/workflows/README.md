# Agent Relay Workflows

Orchestrate multi-agent workflows using YAML, TypeScript, or Python. Define agents, wire up dependencies, and let the runner handle execution, retries, and verification.

## Quick Start

### CLI

```bash
# Run a YAML workflow
agent-relay run workflow.yaml

# Run a TypeScript workflow
agent-relay run workflow.ts

# Run a Python workflow
agent-relay run workflow.py

# Run a specific named workflow from a file
agent-relay run workflow.yaml --workflow deploy
```

### TypeScript

```typescript
import { workflow } from "@agent-relay/sdk/workflows";

const result = await workflow("ship-feature")
  .pattern("dag")
  .agent("planner", { cli: "claude", role: "Plans implementation" })
  .agent("developer", { cli: "codex", role: "Writes code" })
  .agent("reviewer", { cli: "claude", role: "Reviews code" })
  .step("plan", {
    agent: "planner",
    task: "Create implementation plan for user authentication",
  })
  .step("implement", {
    agent: "developer",
    task: "Implement the plan",
    dependsOn: ["plan"],
  })
  .step("review", {
    agent: "reviewer",
    task: "Review the implementation",
    dependsOn: ["implement"],
  })
  .run();

console.log(result.status); // "completed" | "failed"
```

### Python

```python
from agent_relay import workflow

result = (
    workflow("ship-feature")
    .pattern("dag")
    .agent("planner", cli="claude", role="Plans implementation")
    .agent("developer", cli="codex", role="Writes code")
    .agent("reviewer", cli="claude", role="Reviews code")
    .step("plan", agent="planner", task="Create implementation plan for user auth")
    .step("implement", agent="developer", task="Implement the plan", depends_on=["plan"])
    .step("review", agent="reviewer", task="Review the implementation", depends_on=["implement"])
    .run()
)
```

## YAML Format

Workflows are defined as `relay.yaml` files:

```yaml
version: "1.0"
name: my-workflow
description: "Optional description"

swarm:
  pattern: dag            # Execution pattern (see Patterns below)
  maxConcurrency: 3       # Max agents running in parallel
  timeoutMs: 3600000      # Global timeout (1 hour)
  channel: my-channel     # Relay channel for agent communication

agents:
  - name: backend
    cli: claude            # claude | codex | gemini | aider | goose | opencode | droid
    role: "Backend engineer"
    constraints:
      model: opus
      timeoutMs: 600000
      retries: 2

  - name: tester
    cli: codex
    role: "Test engineer"
    interactive: false     # Non-interactive: runs as subprocess, no PTY/messaging

workflows:
  - name: build-and-test
    onError: retry         # fail | skip | retry
    steps:
      - name: build-api
        agent: backend
        task: "Build the REST API endpoints for user management"
        verification:
          type: output_contains
          value: "BUILD_COMPLETE"
        retries: 1

      - name: write-tests
        agent: tester
        task: "Write integration tests for: {{steps.build-api.output}}"
        dependsOn: [build-api]

      - name: run-tests
        agent: tester
        task: "Run the test suite and report results"
        dependsOn: [write-tests]
        verification:
          type: exit_code
          value: "0"

errorHandling:
  strategy: retry
  maxRetries: 2
  retryDelayMs: 5000
  notifyChannel: my-channel
```

### Template Variables

Use `{{variable}}` for user-provided values and `{{steps.STEP_NAME.output}}` for previous step outputs:

```yaml
steps:
  - name: plan
    agent: planner
    task: "Plan implementation for: {{task}}"     # User variable

  - name: implement
    agent: developer
    dependsOn: [plan]
    task: "Implement: {{steps.plan.output}}"      # Previous step output
```

User variables are passed via the CLI or programmatically:

```typescript
await runWorkflow("workflow.yaml", {
  vars: { task: "Add OAuth2 support" },
});
```

### Verification Checks

Each step can include a verification check that must pass for the step to be considered complete:

| Type | Description |
|------|-------------|
| `output_contains` | Step output must contain the specified string |
| `exit_code` | Agent must exit with the specified code |
| `file_exists` | A file must exist at the specified path after the step |
| `custom` | No-op in the runner; handled by external callers |

```yaml
verification:
  type: output_contains
  value: "IMPLEMENTATION_COMPLETE"
  description: "Agent must confirm completion"
```

## Swarm Patterns

The `swarm.pattern` field controls how agents are coordinated:

### Core Patterns

| Pattern | Description |
|---------|-------------|
| `dag` | Directed acyclic graph — steps run based on dependency edges (default) |
| `fan-out` | All agents run in parallel |
| `pipeline` | Sequential chaining of steps |
| `hub-spoke` | Central hub coordinates spoke agents |
| `consensus` | Agents vote on decisions |
| `mesh` | Full communication graph between agents |
| `handoff` | Sequential handoff between agents |
| `cascade` | Waterfall with phase gates |
| `debate` | Agents propose and counter-argue |
| `hierarchical` | Multi-level reporting structure |

### Data Processing Patterns

| Pattern | Description |
|---------|-------------|
| `map-reduce` | Split work into chunks (mappers), process in parallel, aggregate results (reducers) |
| `scatter-gather` | Fan out requests to workers, collect and synthesize responses |

### Supervision & Quality Patterns

| Pattern | Description |
|---------|-------------|
| `supervisor` | Monitor agent monitors workers, restarts on failure, manages health |
| `reflection` | Agent produces output, critic reviews and provides feedback for iteration |
| `verifier` | Producer agents submit work to verifier agents for validation |

### Adversarial & Validation Patterns

| Pattern | Description |
|---------|-------------|
| `red-team` | Attacker agents probe for weaknesses, defender agents respond |
| `auction` | Auctioneer broadcasts tasks, agents bid based on capability/cost |

### Resilience Patterns

| Pattern | Description |
|---------|-------------|
| `escalation` | Start with fast/cheap agents, escalate to more capable on failure |
| `saga` | Distributed transactions with compensating actions on failure |
| `circuit-breaker` | Primary agent with fallback chain, fail fast and recover |

### Collaborative Patterns

| Pattern | Description |
|---------|-------------|
| `blackboard` | Shared workspace where agents contribute incrementally to a solution |
| `swarm` | Emergent behavior from simple agent rules (neighbor communication) |

### Auto-Selection by Role

When `swarm.pattern` is omitted, the coordinator auto-selects based on agent roles.
Patterns are checked in priority order below (first match wins):

| Priority | Pattern | Required Roles/Config |
|----------|---------|----------------------|
| 1 | `dag` | Steps with `dependsOn` |
| 2 | `consensus` | Uses `coordination.consensusStrategy` config |
| 3 | `map-reduce` | `mapper` + `reducer` |
| 4 | `red-team` | (`attacker` OR `red-team`) + (`defender` OR `blue-team`) |
| 5 | `reflection` | `critic` |
| 6 | `escalation` | `tier-1`, `tier-2`, etc. |
| 7 | `auction` | `auctioneer` |
| 8 | `saga` | `saga-orchestrator` OR `compensate-handler` |
| 9 | `circuit-breaker` | `fallback`, `backup`, OR `primary` |
| 10 | `blackboard` | `blackboard` OR `shared-workspace` |
| 11 | `swarm` | `hive-mind` OR `swarm-agent` |
| 12 | `verifier` | `verifier` |
| 13 | `supervisor` | `supervisor` |
| 14 | `hierarchical` | `lead` (with 4+ agents) |
| 15 | `hub-spoke` | `hub` OR `coordinator` |
| 16 | `pipeline` | Unique agents per step, 3+ steps |
| 17 | `fan-out` | Default fallback |

## Error Handling

### Step-Level

```yaml
steps:
  - name: risky-step
    agent: worker
    task: "Do something that might fail"
    retries: 3          # Retry up to 3 times on failure
    timeoutMs: 300000   # 5 minute timeout
```

### Workflow-Level

The `onError` field on a workflow controls what happens when a step fails:

| Value | Behavior |
|-------|----------|
| `fail` / `fail-fast` | Stop immediately, skip downstream steps |
| `skip` / `continue` | Skip downstream dependents, continue independent steps |
| `retry` | Retry the step (falls back to fail-fast after retries exhausted) |

### Global

```yaml
errorHandling:
  strategy: retry
  maxRetries: 2
  retryDelayMs: 5000
  notifyChannel: alerts
```

## Built-in Templates

Six pre-built workflow templates are included:

| Template | Pattern | Description |
|----------|---------|-------------|
| `feature-dev` | hub-spoke | Plan, implement, review, and finalize a feature |
| `bug-fix` | hub-spoke | Investigate, patch, validate, and document a bug fix |
| `code-review` | fan-out | Parallel multi-reviewer assessment with consolidated findings |
| `security-audit` | pipeline | Scan, triage, remediate, and verify security issues |
| `refactor` | hierarchical | Analyze, plan, execute, and validate a refactor |
| `documentation` | handoff | Research, draft, review, and publish documentation |

### Using Templates

```typescript
import { TemplateRegistry } from "@agent-relay/sdk/workflows";

const registry = new TemplateRegistry();

// List available templates
const templates = await registry.listTemplates();

// Load and run a template
const config = await registry.loadTemplate("feature-dev");
const runner = new WorkflowRunner();
const result = await runner.execute(config, undefined, {
  task: "Add WebSocket support to the API",
});

// Install a custom template from a URL
await registry.installExternalTemplate(
  "https://example.com/my-template.yaml",
  "my-template"
);
```

## TypeScript Builder API

The builder constructs a `RelayYamlConfig` object and can run it, export it as YAML, or return the raw config.

```typescript
import { workflow } from "@agent-relay/sdk/workflows";

// Build and run
const result = await workflow("my-workflow")
  .pattern("dag")
  .maxConcurrency(3)
  .timeout(60 * 60 * 1000)
  .channel("my-channel")
  .agent("backend", {
    cli: "claude",
    role: "Backend engineer",
    model: "opus",
    retries: 2,
  })
  .agent("frontend", {
    cli: "codex",
    role: "Frontend engineer",
    interactive: false,       // Non-interactive subprocess mode
  })
  .step("api", {
    agent: "backend",
    task: "Build REST API",
    verification: { type: "output_contains", value: "API_READY" },
  })
  .step("ui", {
    agent: "frontend",
    task: "Build the UI",
    dependsOn: ["api"],
  })
  .onError("retry", { maxRetries: 2, retryDelayMs: 5000 })
  .run();

// Or export to YAML
const yaml = workflow("my-workflow")
  .pattern("dag")
  .agent("worker", { cli: "claude" })
  .step("task1", { agent: "worker", task: "Do something" })
  .toYaml();

// Or get the raw config object
const config = workflow("my-workflow")
  .pattern("dag")
  .agent("worker", { cli: "claude" })
  .step("task1", { agent: "worker", task: "Do something" })
  .toConfig();
```

## Python Builder API

Install the Python SDK:

```bash
pip install agent-relay
```

```python
from agent_relay import workflow, run_yaml

# Build and run
result = (
    workflow("my-workflow")
    .pattern("dag")
    .max_concurrency(3)
    .timeout(3600000)
    .agent("backend", cli="claude", role="Backend engineer")
    .agent("frontend", cli="codex", role="Frontend engineer")
    .step("api", agent="backend", task="Build REST API")
    .step("ui", agent="frontend", task="Build the UI", depends_on=["api"])
    .on_error("retry", max_retries=2, retry_delay_ms=5000)
    .run()
)

# Run an existing YAML file
result = run_yaml("workflows/my-workflow.yaml")

# Export to YAML string
yaml_str = (
    workflow("my-workflow")
    .pattern("dag")
    .agent("worker", cli="claude")
    .step("task1", agent="worker", task="Do something")
    .to_yaml()
)

# Get the raw config dict
config = (
    workflow("my-workflow")
    .pattern("dag")
    .agent("worker", cli="claude")
    .step("task1", agent="worker", task="Do something")
    .to_config()
)
```

## Programmatic API

For full control, use the `WorkflowRunner` directly:

```typescript
import { WorkflowRunner } from "@agent-relay/sdk/workflows";

const runner = new WorkflowRunner({
  cwd: "/path/to/project",       // Working directory (default: process.cwd())
  relay: { port: 3000 },         // AgentRelay options (optional)
});

// Listen to events
runner.on((event) => {
  console.log(event.type, event);
});

// Parse and execute
const config = await runner.parseYamlFile("workflow.yaml");
const run = await runner.execute(config, "workflow-name", {
  task: "Build the feature",
});

// Pause / resume / abort
runner.pause();
runner.unpause();
runner.abort();

// Resume a failed run
const resumed = await runner.resume(run.id);
```

### Zero-Config Convenience Function

```typescript
import { runWorkflow } from "@agent-relay/sdk/workflows";

const result = await runWorkflow("workflow.yaml", {
  workflow: "deploy",
  vars: { environment: "staging" },
  onEvent: (event) => console.log(event.type),
});
```

## Coordination

### Barriers

Synchronization points that wait for specific steps to complete:

```yaml
coordination:
  barriers:
    - name: all-reviews-done
      waitFor: [review-arch, review-security, review-correctness]
      timeoutMs: 900000
  consensusStrategy: majority    # majority | unanimous | quorum
```

### Shared State

Agents can share state during execution:

```yaml
state:
  backend: memory    # memory | redis | database
  ttlMs: 86400000
  namespace: my-workflow
```

## Supported Agent CLIs

| CLI | Description |
|-----|-------------|
| `claude` | Claude Code (Anthropic) |
| `codex` | Codex CLI (OpenAI) |
| `gemini` | Gemini CLI (Google) |
| `aider` | Aider coding assistant |
| `goose` | Goose AI assistant |
| `opencode` | OpenCode CLI |
| `droid` | Droid CLI |

## Non-Interactive Agents

By default, agents run in interactive PTY mode with full relay messaging. For workers that just need to execute a task and return output — common in fan-out, map-reduce, and pipeline patterns — set `interactive: false` to run them as lightweight subprocesses.

### YAML

```yaml
agents:
  - name: lead
    cli: claude
    role: "Coordinates work"
    # interactive: true (default) — full PTY, relay messaging, /exit detection

  - name: worker
    cli: codex
    role: "Executes tasks"
    interactive: false    # Runs "codex exec <task>", captures stdout
```

### TypeScript

```typescript
workflow("fan-out-analysis")
  .pattern("fan-out")
  .agent("lead", { cli: "claude", role: "Coordinator" })
  .agent("worker-1", { cli: "codex", interactive: false, role: "Analyst" })
  .agent("worker-2", { cli: "codex", interactive: false, role: "Analyst" })
  .step("analyze-1", { agent: "worker-1", task: "Analyze module A" })
  .step("analyze-2", { agent: "worker-2", task: "Analyze module B" })
  .step("synthesize", {
    agent: "lead",
    task: "Combine: {{steps.analyze-1.output}} + {{steps.analyze-2.output}}",
    dependsOn: ["analyze-1", "analyze-2"],
  })
  .run();
```

### How It Works

| Aspect | Interactive (default) | Non-Interactive |
|--------|----------------------|-----------------|
| Execution | Full PTY with stdin/stdout | `child_process.spawn()` with piped stdio |
| CLI invocation | Standard interactive session | One-shot mode (`claude -p`, `codex exec`, etc.) |
| Relay messaging | Can send/receive messages | No messaging — excluded from topology edges |
| Self-termination | Must output `/exit` | Process exits naturally when done |
| Output capture | PTY output buffer | stdout capture |
| Overhead | Higher (PTY, echo verification, SIGWINCH) | Lower (simple subprocess) |

### Non-Interactive CLI Commands

| CLI | Command | Notes |
|-----|---------|-------|
| `claude` | `claude -p "<task>"` | Print mode, exits after response |
| `codex` | `codex exec "<task>"` | One-shot execution |
| `gemini` | `gemini -p "<task>"` | Prompt mode |
| `opencode` | `opencode --prompt "<task>"` | One-shot prompt |
| `droid` | `droid exec "<task>"` | One-shot execution |
| `aider` | `aider --message "<task>" --yes-always --no-git` | Auto-approve, skip git |
| `goose` | `goose run --text "<task>" --no-session` | Text mode, no session file |

### When to Use

- Fan-out workers that process a task and return results
- Map-reduce mappers that don't need mid-task communication
- Pipeline stages that transform input to output
- Any agent that doesn't need turn-by-turn relay messaging

### When NOT to Use

- Lead/coordinator agents that communicate with others
- Agents in debate, consensus, or reflection patterns
- Agents that need to receive messages during execution

## Agent Slash Commands

Agents running inside a workflow can output slash commands to signal the broker. These are detected in the agent's PTY output at the broker level — the agent simply prints the command on its own line.

### `/exit`

Signals that the agent has completed its current step and is ready to be released.

```
/exit
```

The workflow runner waits for each agent to `/exit` after delivering a step task. When the broker detects `/exit` in the agent's output (exact line match after ANSI stripping), it:

1. Emits an `agent_exit` frame with `reason: "agent_requested"`
2. Triggers graceful PTY shutdown

If an agent does not `/exit` within the step's `timeoutMs`, the runner treats the step as timed out. As a safety net, steps with `file_exists` verification will still pass if the expected file is present despite the timeout.

**Best practice:** Instruct agents to output `/exit` when done in your step task descriptions:

```yaml
steps:
  - name: build-api
    agent: backend
    task: |
      Build the REST API endpoints for user management.
      When finished, output /exit.
```

## Idle Agent Detection and Nudging

Interactive agents sometimes finish their task but forget to `/exit`, sitting idle and blocking downstream steps. The runner can detect idle agents and take action automatically.

### Configuration

Add `idleNudge` to your swarm config:

```yaml
swarm:
  pattern: hub-spoke
  idleNudge:
    nudgeAfterMs: 120000      # 2 min before first nudge (default)
    escalateAfterMs: 120000   # 2 min after nudge before force-release (default)
    maxNudges: 1              # Nudges before escalation (default)
```

All built-in templates include idle nudging with these defaults.

### How It Works

1. **Detection**: The broker tracks agent output timestamps and emits `agent_idle` events when an agent goes silent for the configured threshold
2. **Nudge**: For hub patterns (hub-spoke, fan-out, hierarchical, etc.), the runner tells the hub agent to check on the idle agent. For non-hub patterns, a system message is injected directly into the agent's PTY
3. **Escalation**: If the agent remains idle after `maxNudges` attempts, the runner force-releases it and captures whatever output was produced
4. **No config**: When `idleNudge` is omitted, the runner uses simple `waitForExit` (backward compatible)

### Events

The runner emits two new events for idle nudging:

| Event | Description |
|-------|-------------|
| `step:nudged` | Fired when a nudge message is sent to an idle agent |
| `step:force-released` | Fired when an agent is force-released after exhausting nudges |

## Schema Validation

A JSON Schema is available at `packages/sdk/src/workflows/schema.json` for editor autocompletion and validation of `relay.yaml` files.

## Requirements

- Node.js 22+
- `agent-relay` CLI installed (`npm install -g agent-relay`)
- For Python: Python 3.10+ with `pip install agent-relay`
- For TypeScript workflow files: `tsx` or `ts-node` installed

## License

Apache-2.0 -- Copyright 2025 Agent Workforce Incorporated
