---
paths:
  - 'packages/sdk-py/**/*.py'
---

# Python SDK Conventions

## Location

`packages/sdk-py/` — published as `agent-relay` on PyPI.

## API

Builder API mirrors TypeScript workflow types:

```python
from agent_relay import workflow, fan_out, pipeline, dag

# Builder pattern
wf = workflow("my-workflow")
wf.agent("worker", cli="claude")
wf.step("task", agent="worker", task="Do something")
wf.build()
```

## Templates

- `fan_out` — parallel execution across agents
- `pipeline` — sequential stage-based execution
- `dag` — directed acyclic graph with dependencies

## Execution

Delegates to `agent-relay run` CLI for actual execution. The Python SDK is a builder/definition layer, not a runtime.

## Project Structure

```
packages/sdk-py/
├── src/agent_relay/
│   ├── __init__.py    # Public API exports
│   ├── builder.py     # WorkflowBuilder
│   ├── templates.py   # fan_out, pipeline, dag
│   └── types.py       # Type definitions
├── tests/
├── pyproject.toml
└── README.md
```

## Type Parity

Python types in `types.py` must stay in sync with TypeScript types in `packages/sdk/src/workflows/types.ts`. When adding workflow fields, update both.
