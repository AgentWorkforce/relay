# Debate Pattern

**Proposal and counter-argument** — agents argue different positions.

## Overview

The debate pattern enables structured argumentation where agents propose solutions and counter-argue. This surfaces trade-offs and edge cases through adversarial analysis, leading to more robust decisions.

## When to Use

- Design exploration with trade-offs
- Risk analysis
- Evaluating competing approaches

## Configuration

```yaml
swarm:
  pattern: debate
  maxConcurrency: 2
```

## Example

```yaml
version: '1.0'
name: architecture-debate
swarm:
  pattern: debate
  maxConcurrency: 2

agents:
  - name: moderator
    cli: claude
    role: 'Moderates debate and synthesizes'
  - name: advocate-monolith
    cli: codex
    role: 'Argues for monolithic architecture'
  - name: advocate-microservices
    cli: claude
    role: 'Argues for microservices'

workflows:
  - name: arch-decision
    steps:
      - name: frame-question
        agent: moderator
        task: 'Frame the architectural decision'

      - name: propose-monolith
        agent: advocate-monolith
        task: 'Present case for monolith'
        dependsOn: [frame-question]

      - name: propose-microservices
        agent: advocate-microservices
        task: 'Present case for microservices'
        dependsOn: [frame-question]

      - name: rebut-monolith
        agent: advocate-microservices
        task: 'Counter monolith arguments'
        dependsOn: [propose-monolith]

      - name: rebut-microservices
        agent: advocate-monolith
        task: 'Counter microservices arguments'
        dependsOn: [propose-microservices]

      - name: synthesize
        agent: moderator
        task: 'Synthesize debate and recommend'
        dependsOn: [rebut-monolith, rebut-microservices]
```

## Behavior

- Structured proposal/rebuttal cycles
- Surfaces hidden assumptions
- Moderator synthesizes final recommendation
- Produces well-reasoned decisions with documented trade-offs
