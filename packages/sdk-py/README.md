# Agent Relay Python SDK

Python SDK for defining and running Agent Relay workflows. Provides the same workflow builder API as the TypeScript SDK.

## Installation

```bash
pip install agent-relay
```

## Requirements

- Python 3.10+
- `agent-relay` CLI installed (`npm install -g agent-relay`)

The SDK builds workflow configurations and executes them via the `agent-relay run` CLI.

## Builder API

```python
from agent_relay import workflow, VerificationCheck

result = (
    workflow("ship-feature")
    .description("Plan, build, and verify a feature")
    .pattern("dag")
    .max_concurrency(3)
    .timeout(60 * 60 * 1000)
    .channel("feature-channel")
    .idle_nudge(nudge_after_ms=120_000, escalate_after_ms=120_000, max_nudges=1)
    .trajectories(enabled=True, reflect_on_converge=True)
    .agent("planner", cli="claude", role="Planning lead")
    .agent(
        "builder",
        cli="codex",
        role="Implementation engineer",
        interactive=False,
        idle_threshold_secs=45,
        retries=1,
    )
    .step("plan", agent="planner", task="Create a detailed plan")
    .step(
        "build",
        agent="builder",
        task="Implement the approved plan",
        depends_on=["plan"],
        verification=VerificationCheck(type="output_contains", value="DONE"),
    )
    .run()
)
```

## Workflow Templates

Built-in templates for common multi-agent patterns:

### Fan-Out

Parallel execution across multiple agents with synthesis:

```python
from agent_relay import fan_out

builder = fan_out(
    "parallel-analysis",
    tasks=[
        "Analyze backend modules and summarize risks",
        "Analyze frontend modules and summarize risks",
    ],
    synthesis_task="Synthesize both analyses into one prioritized action plan",
)

result = builder.run()
```

### Pipeline

Sequential stage-based execution:

```python
from agent_relay import pipeline, PipelineStage

builder = pipeline(
    "release-pipeline",
    stages=[
        PipelineStage(name="plan", task="Create release plan"),
        PipelineStage(name="implement", task="Implement planned changes"),
        PipelineStage(name="verify", task="Validate and produce release notes"),
    ],
)
```

### DAG

Direct workflow definition with explicit dependencies:

```python
from agent_relay import dag

builder = dag(
    "complex-workflow",
    agents=[...],
    steps=[...],
)
```

## Event Callbacks

Monitor workflow execution with typed event callbacks:

```python
from agent_relay import run_yaml, RunOptions

def on_event(event):
    print(event.type, event)

result = run_yaml(
    "workflows/release.yaml",
    RunOptions(workflow="release", on_event=on_event),
)
```

Supported event types:

| Event | Description |
|-------|-------------|
| `run:started` | Workflow execution began |
| `run:completed` | Workflow finished successfully |
| `run:failed` | Workflow failed |
| `run:cancelled` | Workflow was cancelled |
| `step:started` | Step execution began |
| `step:completed` | Step finished successfully |
| `step:failed` | Step failed |
| `step:skipped` | Step was skipped |
| `step:retrying` | Step is being retried |
| `step:nudged` | Idle agent was nudged |
| `step:force-released` | Agent was force-released |

## YAML Workflow Execution

Execute workflows defined in YAML files:

```python
from agent_relay import run_yaml, RunOptions

result = run_yaml(
    "workflows/migration.yaml",
    RunOptions(
        workflow="main",
        trajectories=False,
        vars={"target": "staging"},
    ),
)
```

## Configuration Export

Export workflow configuration without executing:

```python
builder = workflow("my-workflow").agent(...).step(...)

# Get as Python dict
config = builder.to_config()

# Get as YAML string
yaml_str = builder.to_yaml()
```

## License

Apache-2.0
