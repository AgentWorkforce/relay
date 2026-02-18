# Agent Relay Python SDK

Python SDK for defining and running Agent Relay workflows.

## Install

```bash
pip install agent-relay
```

## Usage

### Builder API

```python
from agent_relay import workflow

result = (
    workflow("my-migration")
    .pattern("dag")
    .agent("backend", cli="claude", role="Backend engineer")
    .agent("tester", cli="claude", role="Test engineer")
    .step("build", agent="backend", task="Build the API endpoints")
    .step("test", agent="tester", task="Write tests", depends_on=["build"])
    .run()
)
```

### Run from YAML

```python
from agent_relay import run_yaml

result = run_yaml("workflows/daytona-migration.yaml")
```

### Export to YAML

```python
config_yaml = (
    workflow("my-workflow")
    .pattern("fan-out")
    .agent("worker", cli="claude")
    .step("task1", agent="worker", task="Do something")
    .to_yaml()
)
```

## Requirements

- Python 3.10+
- `agent-relay` CLI installed (`npm install -g agent-relay`)

## License

Apache-2.0 — Copyright 2025 Agent Workforce Incorporated
