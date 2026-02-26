# Fan-Out Pattern

**Parallel execution** — all agents run simultaneously.

## Overview

The fan-out pattern launches all agents at once, running steps in parallel without dependency constraints. Results are typically consolidated by a lead agent after all parallel work completes.

## When to Use

- Independent parallel reviews or assessments
- Gathering multiple perspectives simultaneously
- Tasks that don't depend on each other

## Configuration

```yaml
swarm:
  pattern: fan-out
  maxConcurrency: 4
```

## Example

```yaml
version: '1.0'
name: multi-review
swarm:
  pattern: fan-out
  maxConcurrency: 4

agents:
  - name: lead
    cli: claude
  - name: reviewer-arch
    cli: codex
  - name: reviewer-security
    cli: gemini
  - name: reviewer-perf
    cli: claude

workflows:
  - name: parallel-review
    steps:
      - name: arch-review
        agent: reviewer-arch
        task: 'Review architecture'

      - name: security-review
        agent: reviewer-security
        task: 'Review security'

      - name: perf-review
        agent: reviewer-perf
        task: 'Review performance'

      - name: consolidate
        agent: lead
        task: 'Consolidate findings'
        dependsOn: [arch-review, security-review, perf-review]
```

## Behavior

- All non-dependent steps start immediately
- Maximum parallelism up to `maxConcurrency`
- Consolidation step waits for all parallel work
- Fast feedback from multiple independent reviewers
