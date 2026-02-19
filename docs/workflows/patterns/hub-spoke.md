# Hub-Spoke Pattern

**Central coordination** — a hub agent coordinates spoke agents.

## Overview

The hub-spoke pattern designates a lead agent that coordinates multiple worker agents. The lead distributes tasks, collects results, and makes final decisions. Worker agents report to the lead.

## When to Use

- Coordinated feature development
- Bug investigation and remediation
- Any workflow needing central coordination

## Configuration

```yaml
swarm:
  pattern: hub-spoke
  maxConcurrency: 2
```

## Example

```yaml
version: "1.0"
name: feature-delivery
swarm:
  pattern: hub-spoke
  maxConcurrency: 2

agents:
  - name: lead
    cli: claude
    role: "Coordinates delivery"
  - name: planner
    cli: codex
    role: "Plans implementation"
  - name: developer
    cli: codex
    role: "Implements changes"
  - name: reviewer
    cli: claude
    role: "Reviews code"

workflows:
  - name: deliver
    steps:
      - name: plan
        agent: planner
        task: "Create implementation plan"

      - name: implement
        agent: developer
        task: "Implement the plan"
        dependsOn: [plan]

      - name: review
        agent: reviewer
        task: "Review implementation"
        dependsOn: [implement]

      - name: finalize
        agent: lead
        task: "Make final delivery decision"
        dependsOn: [review]
```

## Behavior

- Lead agent owns final decisions
- Spoke agents work on specialized tasks
- Results flow back to the lead for consolidation
- Clear accountability and coordination
