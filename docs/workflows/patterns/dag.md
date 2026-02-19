# DAG Pattern

**Directed Acyclic Graph** — steps run based on dependency edges.

## Overview

The DAG pattern is the most flexible pattern, allowing you to define complex dependency relationships between steps. Steps run as soon as all their dependencies are complete, maximizing parallelism while respecting ordering constraints.

## When to Use

- Complex workflows with interdependent steps
- When some steps can run in parallel while others must wait
- Default choice when no other pattern fits

## Configuration

```yaml
swarm:
  pattern: dag
  maxConcurrency: 3
```

## Example

```yaml
version: "1.0"
name: parallel-build
swarm:
  pattern: dag
  maxConcurrency: 4

agents:
  - name: backend
    cli: claude
  - name: frontend
    cli: codex
  - name: tester
    cli: claude

workflows:
  - name: build-all
    steps:
      - name: build-api
        agent: backend
        task: "Build the API"

      - name: build-ui
        agent: frontend
        task: "Build the UI"

      - name: integration-tests
        agent: tester
        task: "Run integration tests"
        dependsOn: [build-api, build-ui]  # Waits for both
```

## Behavior

- Steps with no dependencies start immediately
- Steps wait for all `dependsOn` items to complete
- Multiple independent branches run in parallel
- `maxConcurrency` limits simultaneous agent execution
