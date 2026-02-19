# Consensus Pattern

**Voting mechanism** — agents vote on decisions.

## Overview

The consensus pattern enables democratic decision-making among agents. Multiple agents evaluate options and vote, with the outcome determined by the configured consensus strategy (majority, unanimous, or quorum).

## When to Use

- Design decisions requiring multiple perspectives
- Approval workflows
- Quality gates with multiple reviewers

## Configuration

```yaml
swarm:
  pattern: consensus

coordination:
  consensusStrategy: majority  # majority | unanimous | quorum
  votingThreshold: 0.6         # For quorum strategy
```

## Example

```yaml
version: "1.0"
name: design-decision
swarm:
  pattern: consensus
  maxConcurrency: 3

agents:
  - name: lead
    cli: claude
  - name: reviewer-1
    cli: codex
  - name: reviewer-2
    cli: claude
  - name: reviewer-3
    cli: gemini

coordination:
  consensusStrategy: majority

workflows:
  - name: evaluate-design
    steps:
      - name: propose
        agent: lead
        task: "Present design options"

      - name: vote-1
        agent: reviewer-1
        task: "Evaluate and vote on design"
        dependsOn: [propose]

      - name: vote-2
        agent: reviewer-2
        task: "Evaluate and vote on design"
        dependsOn: [propose]

      - name: vote-3
        agent: reviewer-3
        task: "Evaluate and vote on design"
        dependsOn: [propose]

      - name: decide
        agent: lead
        task: "Announce decision based on votes"
        dependsOn: [vote-1, vote-2, vote-3]
```

## Consensus Strategies

| Strategy | Description |
|----------|-------------|
| `majority` | >50% agreement required |
| `unanimous` | 100% agreement required |
| `quorum` | Configurable threshold via `votingThreshold` |
