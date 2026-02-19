# Mesh Pattern

**Full communication** — all agents can communicate with all others.

## Overview

The mesh pattern creates a fully connected communication graph where any agent can message any other agent. This enables collaborative problem-solving where agents freely exchange information.

## When to Use

- Collaborative problem-solving
- Brainstorming sessions
- Complex debugging requiring multiple perspectives

## Configuration

```yaml
swarm:
  pattern: mesh
  maxConcurrency: 4
  channel: collab-channel  # Shared communication channel
```

## Example

```yaml
version: "1.0"
name: collaborative-debug
swarm:
  pattern: mesh
  maxConcurrency: 3
  channel: debug-session

agents:
  - name: frontend-expert
    cli: claude
    role: "Frontend debugging"
  - name: backend-expert
    cli: codex
    role: "Backend debugging"
  - name: infra-expert
    cli: gemini
    role: "Infrastructure debugging"

workflows:
  - name: debug-issue
    steps:
      - name: investigate-frontend
        agent: frontend-expert
        task: "Investigate frontend aspects"

      - name: investigate-backend
        agent: backend-expert
        task: "Investigate backend aspects"

      - name: investigate-infra
        agent: infra-expert
        task: "Investigate infrastructure aspects"

      - name: synthesize
        agent: frontend-expert
        task: "Synthesize findings from all experts"
        dependsOn: [investigate-frontend, investigate-backend, investigate-infra]
```

## Behavior

- Agents communicate via shared channel
- No strict hierarchy
- Information flows freely between all participants
- Requires clear protocols to avoid confusion
