# Cascade Pattern

**Waterfall with gates** — phase-based execution with approval gates.

## Overview

The cascade pattern implements a waterfall-style workflow with explicit phase gates. Each phase must be approved before proceeding to the next, providing checkpoints for quality control and stakeholder review.

## When to Use

- Gated release processes
- Compliance-heavy workflows
- Phased project delivery

## Configuration

```yaml
swarm:
  pattern: cascade
  maxConcurrency: 2

coordination:
  barriers:
    - name: phase-1-gate
      waitFor: [design, review-design]
      timeoutMs: 600000
```

## Example

```yaml
version: "1.0"
name: release-process
swarm:
  pattern: cascade
  maxConcurrency: 2

agents:
  - name: lead
    cli: claude
    role: "Gate approvals"
  - name: developer
    cli: codex
    role: "Implementation"
  - name: qa
    cli: claude
    role: "Quality assurance"

coordination:
  barriers:
    - name: dev-complete
      waitFor: [implement, unit-tests]
    - name: qa-complete
      waitFor: [integration-tests, regression-tests]

workflows:
  - name: release
    steps:
      # Phase 1: Development
      - name: implement
        agent: developer
        task: "Implement feature"

      - name: unit-tests
        agent: developer
        task: "Write unit tests"
        dependsOn: [implement]

      - name: dev-gate
        agent: lead
        task: "Approve development phase"
        dependsOn: [implement, unit-tests]

      # Phase 2: QA
      - name: integration-tests
        agent: qa
        task: "Run integration tests"
        dependsOn: [dev-gate]

      - name: regression-tests
        agent: qa
        task: "Run regression tests"
        dependsOn: [dev-gate]

      - name: qa-gate
        agent: lead
        task: "Approve QA phase"
        dependsOn: [integration-tests, regression-tests]
```

## Behavior

- Work proceeds in defined phases
- Gates block progression until approved
- Clear visibility into phase completion
- Supports rollback decisions at gates
