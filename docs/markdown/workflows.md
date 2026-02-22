# Workflows

Orchestrate multi-agent workflows using YAML, TypeScript, or Python. Run locally or in the cloud.

## Quick Start

### CLI

```bash
# Run a YAML workflow
agent-relay run workflow.yaml --task "Add user authentication"

# Run in the cloud for 24/7 execution
agent-relay run workflow.yaml --cloud --task "Add user authentication"

# Use a built-in template
agent-relay run --template feature-dev --task "Add OAuth2 support"
```

### TypeScript

```typescript
import { workflow, Models } from '@agent-relay/sdk/workflows';

const result = await workflow('ship-feature')
  .pattern('dag')
  .agent('planner', { cli: 'claude', model: Models.Claude.OPUS })
  .agent('developer', { cli: 'codex', model: Models.Codex.CODEX_5_3 })
  .step('plan', { agent: 'planner', task: 'Create implementation plan' })
  .step('implement', { agent: 'developer', task: 'Build it', dependsOn: ['plan'] })
  .run();
```

### Python

```python
from agent_relay import workflow, Models

result = (
    workflow("ship-feature")
    .pattern("dag")
    .agent("planner", cli="claude", model=Models.Claude.OPUS)
    .agent("developer", cli="codex", model=Models.Codex.CODEX_5_3)
    .step("plan", agent="planner", task="Create implementation plan")
    .step("implement", agent="developer", task="Build it", depends_on=["plan"])
    .run()
)
```

---

## relay.yaml Format

```yaml
version: "1.0"
name: my-workflow

agents:
  - name: planner
    cli: claude
    model: opus
  - name: developer
    cli: codex

workflows:
  - name: default
    steps:
      - name: plan
        agent: planner
        task: "Create implementation plan for: {{task}}"
      - name: implement
        agent: developer
        task: "Implement: {{steps.plan.output}}"
        dependsOn: [plan]
```

---

## Built-in Templates

| Template | Pattern | Description |
|----------|---------|-------------|
| `feature-dev` | hub-spoke | Plan, implement, review, and finalize a feature |
| `bug-fix` | hub-spoke | Investigate, patch, validate, and document |
| `code-review` | fan-out | Parallel multi-reviewer assessment |
| `security-audit` | pipeline | Scan, triage, remediate, and verify |
| `refactor` | hierarchical | Analyze, plan, execute, and validate |
| `documentation` | handoff | Research, draft, review, and publish |

```bash
agent-relay run --template feature-dev --task "Add WebSocket support"
```

---

## Swarm Patterns

| Category | Patterns |
|----------|----------|
| **Core** | `dag`, `fan-out`, `pipeline`, `hub-spoke`, `consensus`, `mesh` |
| **Data** | `map-reduce`, `scatter-gather` |
| **Quality** | `supervisor`, `reflection`, `verifier` |
| **Adversarial** | `red-team`, `auction` |
| **Resilience** | `escalation`, `saga`, `circuit-breaker` |

---

## TypeScript SDK

### Installation

```bash
npm install @agent-relay/sdk
```

### Model Enums

```typescript
import { Models } from '@agent-relay/sdk';

Models.Claude.OPUS      // 'opus'
Models.Claude.SONNET    // 'sonnet'
Models.Codex.CODEX_5_3  // 'gpt-5.3-codex'
Models.Gemini.PRO_2_5   // 'gemini-2.5-pro'
```

### Full Example

```typescript
import { workflow, Models, SwarmPatterns } from '@agent-relay/sdk/workflows';

async function buildFeature(task: string) {
  const result = await workflow('feature-build')
    .pattern(SwarmPatterns.HUB_SPOKE)
    .agent('lead', { cli: 'claude', model: Models.Claude.OPUS, role: 'Coordinator' })
    .agent('backend', { cli: 'codex', model: Models.Codex.CODEX_5_3, role: 'Backend dev' })
    .agent('frontend', { cli: 'claude', model: Models.Claude.SONNET, role: 'Frontend dev' })
    .agent('reviewer', { cli: 'claude', model: Models.Claude.OPUS, role: 'Reviewer' })
    .step('plan', { agent: 'lead', task: `Break down: ${task}` })
    .step('backend', { agent: 'backend', task: '{{steps.plan.output}}', dependsOn: ['plan'] })
    .step('frontend', { agent: 'frontend', task: '{{steps.plan.output}}', dependsOn: ['plan'] })
    .step('review', { agent: 'reviewer', task: 'Review all', dependsOn: ['backend', 'frontend'] })
    .onError('retry', { maxRetries: 2 })
    .run();

  return result;
}
```

### Builder API

| Method | Description |
|--------|-------------|
| `.pattern(p)` | Set coordination pattern |
| `.agent(name, opts)` | Define an agent |
| `.step(name, opts)` | Define a step |
| `.onError(strategy)` | Error handling |
| `.maxConcurrency(n)` | Limit parallel agents |
| `.timeout(ms)` | Global timeout |
| `.run()` | Execute workflow |
| `.toYaml()` | Export as YAML |

---

## Python SDK

### Installation

```bash
pip install agent-relay
```

### Full Example

```python
from agent_relay import workflow, Models, SwarmPatterns

def build_feature(task: str):
    result = (
        workflow("feature-build")
        .pattern(SwarmPatterns.HUB_SPOKE)
        .agent("lead", cli="claude", model=Models.Claude.OPUS, role="Coordinator")
        .agent("backend", cli="codex", model=Models.Codex.CODEX_5_3, role="Backend dev")
        .agent("frontend", cli="claude", model=Models.Claude.SONNET, role="Frontend dev")
        .agent("reviewer", cli="claude", model=Models.Claude.OPUS, role="Reviewer")
        .step("plan", agent="lead", task=f"Break down: {task}")
        .step("backend", agent="backend", task="{{steps.plan.output}}", depends_on=["plan"])
        .step("frontend", agent="frontend", task="{{steps.plan.output}}", depends_on=["plan"])
        .step("review", agent="reviewer", task="Review all", depends_on=["backend", "frontend"])
        .on_error("retry", max_retries=2)
        .run()
    )
    return result
```

---

## Cloud Execution

Run workflows in isolated sandboxes with 24/7 durability:

```bash
agent-relay run workflow.yaml --cloud --task "Add authentication"
```

### Features

- **Isolated Sandboxes**: Each agent in its own secure container
- **Cross-Sandbox Messaging**: Agents communicate via Relaycast
- **24/7 Durability**: Workflows survive restarts
- **Auto-Scaling**: Sandboxes scale based on load

### Programmatic

```typescript
const result = await workflow('feature')
  .agent('dev', { cli: 'claude' })
  .step('build', { agent: 'dev', task: 'Build it' })
  .cloud()  // Run in cloud
  .run();
```

```python
result = (
    workflow("feature")
    .agent("dev", cli="claude")
    .step("build", agent="dev", task="Build it")
    .cloud()  # Run in cloud
    .run()
)
```

---

## Error Handling

### Step-Level

```yaml
steps:
  - name: risky
    agent: worker
    task: "Might fail"
    retries: 3
    timeoutMs: 300000
```

### Workflow-Level

```yaml
workflows:
  - name: default
    onError: retry  # fail | skip | retry
```

### Global

```yaml
errorHandling:
  strategy: retry
  maxRetries: 2
  retryDelayMs: 5000
```

---

## Template Variables

Use `{{variable}}` for inputs, `{{steps.NAME.output}}` for step outputs:

```yaml
steps:
  - name: plan
    agent: planner
    task: "Plan: {{task}}"
  - name: build
    agent: developer
    task: "Build: {{steps.plan.output}}"
    dependsOn: [plan]
```

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `agent-relay run <file>` | Run a workflow |
| `agent-relay run --template <name>` | Run a template |
| `agent-relay run <file> --cloud` | Run in cloud |
| `agent-relay templates` | List templates |
| `agent-relay cloud workflows` | List cloud runs |
| `agent-relay cloud logs <id>` | Stream logs |
