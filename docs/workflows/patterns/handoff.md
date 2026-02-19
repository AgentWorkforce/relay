# Handoff Pattern

**Sequential handoffs** — agents pass work to each other.

## Overview

The handoff pattern implements sequential agent handoffs where each agent completes their work and explicitly hands off to the next. Unlike pipeline, handoff emphasizes the transfer of artifacts or documents between specialists.

## When to Use

- Document production workflows
- Content creation pipelines
- Sequential specialist reviews

## Configuration

```yaml
swarm:
  pattern: handoff
  maxConcurrency: 1
```

## Example

```yaml
version: "1.0"
name: docs-production
swarm:
  pattern: handoff
  maxConcurrency: 1

agents:
  - name: researcher
    cli: codex
    role: "Gathers technical context"
  - name: writer
    cli: codex
    role: "Drafts documentation"
  - name: editor
    cli: claude
    role: "Edits for clarity"
  - name: lead
    cli: claude
    role: "Final sign-off"

workflows:
  - name: create-docs
    steps:
      - name: research
        agent: researcher
        task: "Gather context and sources"

      - name: draft
        agent: writer
        task: "Draft the documentation"
        dependsOn: [research]

      - name: edit
        agent: editor
        task: "Edit for accuracy and clarity"
        dependsOn: [draft]

      - name: publish
        agent: lead
        task: "Approve and publish"
        dependsOn: [edit]
```

## Behavior

- Clear ownership at each stage
- Artifacts pass from agent to agent
- Each agent completes before handoff
- Natural fit for content workflows
