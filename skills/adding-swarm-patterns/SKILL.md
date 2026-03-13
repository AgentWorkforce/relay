---
name: adding-swarm-patterns
description: Use when adding new multi-agent coordination patterns to agent-relay - provides checklist for types, schema, templates, and docs updates
tags: agent-relay, swarm, patterns, workflows
---

# Adding Swarm Patterns

## Overview

Add new multi-agent coordination patterns to agent-relay by updating four locations: TypeScript types, JSON schema, YAML template, and markdown docs.

## When to Use

- Adding a new swarm pattern (e.g., "competitive", "auction")
- Extending coordination capabilities for multi-agent workflows
- Responding to user requests for new orchestration strategies

## Quick Reference

| File | Location | What to Add |
|------|----------|-------------|
| types.ts | `packages/broker-sdk/src/workflows/types.ts` | Add to `SwarmPattern` union type |
| schema.json | `packages/broker-sdk/src/workflows/schema.json` | Add to `SwarmPattern.enum` array |
| template.yaml | `packages/broker-sdk/src/workflows/builtin-templates/` | Create `{pattern}.yaml` |
| pattern.md | `docs/workflows/patterns/` | Create `{pattern}.md` |
| template.md | `docs/workflows/templates/` | Create `{pattern}.md` |
| README.md | `docs/workflows/README.md` | Add to patterns and templates tables |

## Implementation Checklist

### 1. Update TypeScript Types

```typescript
// packages/broker-sdk/src/workflows/types.ts
export type SwarmPattern =
  | "fan-out"
  | "pipeline"
  // ... existing patterns ...
  | "your-new-pattern";  // Add here
```

### 2. Update JSON Schema

```json
// packages/broker-sdk/src/workflows/schema.json
"SwarmPattern": {
  "type": "string",
  "enum": [
    "fan-out",
    "pipeline",
    // ... existing patterns ...
    "your-new-pattern"
  ]
}
```

### 3. Create YAML Template

```yaml
# packages/broker-sdk/src/workflows/builtin-templates/{pattern}.yaml
version: "1.0"
name: pattern-name
description: "One-line description"
swarm:
  pattern: pattern-name
  maxConcurrency: N
  timeoutMs: N
  channel: swarm-pattern-name
agents:
  - name: lead
    cli: claude
    role: "Role description"
  # ... more agents
workflows:
  - name: workflow-name
    steps:
      - name: step-name
        agent: agent-name
        task: |
          Task description with {{task}} placeholder
        verification:
          type: output_contains
          value: STEP_COMPLETE
coordination:
  barriers:
    - name: barrier-name
      waitFor: [step1, step2]
state:
  backend: memory
  namespace: pattern-name
errorHandling:
  strategy: fail-fast
```

### 4. Create Pattern Documentation

```markdown
# docs/workflows/patterns/{pattern}.md

# Pattern Name

One-sentence description.

## When to Use
- Use case 1
- Use case 2

## Structure
[ASCII diagram showing agent/step flow]

## Configuration
[YAML snippet]

## Best Practices
- Practice 1
- Practice 2
```

### 5. Create Template Documentation

```markdown
# docs/workflows/templates/{pattern}.md

# Pattern Template

**Pattern:** name | **Timeout:** N minutes | **Channel:** swarm-name

## Overview
What this template does.

## Agents
| Agent | CLI | Role |
|-------|-----|------|

## Workflow Steps
1. **step** (agent) — Description

## Usage
[CLI and TypeScript examples]

## Verification Markers
- `MARKER` — Description
```

### 6. Update README

Add to both tables in `docs/workflows/README.md`:
- Patterns table: `| [pattern](patterns/pattern.md) | Description | Best For |`
- Templates table: `| [pattern](templates/pattern.md) | pattern | Description |`

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Forgetting schema.json | Validation will fail if schema doesn't include the pattern |
| Inconsistent naming | Use same name in types, schema, template filename, and docs |
| Missing verification markers | Each step should have `output_contains` verification |
| Wrong doc links | Use relative paths: `patterns/name.md` not `/docs/workflows/patterns/name.md` |

## Pattern Design Guidelines

**Good patterns have:**
- Clear coordination model (who talks to whom)
- Defined failure handling (what happens if one agent fails)
- Appropriate concurrency (parallel vs sequential)
- Barrier synchronization for convergence points

**Pattern categories:**
- **Parallel**: fan-out, competitive, scatter-gather
- **Sequential**: pipeline, handoff, cascade
- **Hierarchical**: hub-spoke, hierarchical, supervisor
- **Consensus**: consensus, debate, auction
- **Graph**: dag, mesh
