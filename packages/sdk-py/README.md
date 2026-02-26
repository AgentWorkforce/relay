# Agent Relay Python SDK

Python SDK for defining and running Agent Relay workflows with the same schema and
builder capabilities as the TypeScript workflow SDK.

The SDK builds workflow config and executes it through:

```bash
agent-relay run <workflow.yaml>
```

## Install

```bash
pip install agent-relay
```

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

Built-in template helpers are provided for common patterns:

- `fan_out(...)`
- `pipeline(...)`
- `dag(...)`

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

config = builder.to_config()
```

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

## Event Callbacks

Execution callbacks receive typed workflow events parsed from CLI workflow logs.

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

- `run:started`
- `run:completed`
- `run:failed`
- `run:cancelled`
- `step:started`
- `step:completed`
- `step:failed`
- `step:skipped`
- `step:retrying`
- `step:nudged`
- `step:force-released`

## YAML Workflow Execution

```python
from agent_relay import run_yaml, RunOptions

result = run_yaml(
    "workflows/daytona-migration.yaml",
    RunOptions(
        workflow="main",
        trajectories=False,  # override YAML trajectory config at runtime
        vars={"target": "staging"},
    ),
)
```

## Requirements

- Python 3.10+
- `agent-relay` CLI installed (`npm install -g agent-relay`)

## License

Apache-2.0 -- Copyright 2025-2026 Agent Workforce Incorporated
