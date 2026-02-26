# Hierarchical Pattern

**Multi-level structure** — agents organized in reporting hierarchy.

## Overview

The hierarchical pattern organizes agents in a tree structure with clear reporting relationships. Higher-level agents coordinate and approve work from lower-level agents, suitable for large-scale efforts requiring organizational structure.

## When to Use

- Large refactoring efforts
- Multi-team coordination
- Organizational workflows with approval chains

## Configuration

```yaml
swarm:
  pattern: hierarchical
  maxConcurrency: 2
```

## Example

```yaml
version: '1.0'
name: large-refactor
swarm:
  pattern: hierarchical
  maxConcurrency: 2

agents:
  - name: lead
    cli: claude
    role: 'Overall coordination and sign-off'
  - name: architect
    cli: codex
    role: 'Design and planning'
  - name: refactorer
    cli: codex
    role: 'Executes refactor'
  - name: tester
    cli: claude
    role: 'Validates changes'

workflows:
  - name: refactor-execution
    steps:
      # Level 1: Analysis (reports to lead)
      - name: analyze
        agent: architect
        task: 'Analyze current system'

      # Level 2: Planning (reports to architect)
      - name: design
        agent: architect
        task: 'Design refactor plan'
        dependsOn: [analyze]

      # Level 3: Execution (reports to architect)
      - name: refactor
        agent: refactorer
        task: 'Execute refactor'
        dependsOn: [design]

      # Level 3: Validation (reports to architect)
      - name: validate
        agent: tester
        task: 'Validate no regressions'
        dependsOn: [refactor]

      # Level 1: Final approval (lead)
      - name: approve
        agent: lead
        task: 'Final sign-off'
        dependsOn: [validate]
```

## Behavior

- Clear chain of command
- Work flows up for approval
- Decisions flow down for execution
- Scalable to large efforts with many agents
