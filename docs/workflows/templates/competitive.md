# Competitive Template

**Pattern:** competitive | **Timeout:** 90 minutes | **Channel:** swarm-competitive

## Overview

Multiple agent teams independently implement solutions to the same problem, then a lead compares outputs and selects the best approach. Useful for exploratory work, architecture decisions, and innovation challenges.

## Agents

| Agent      | CLI    | Role                                                 |
| ---------- | ------ | ---------------------------------------------------- |
| lead       | claude | Defines spec, judges implementations, selects winner |
| team-alpha | claude | Independent implementation team A                    |
| team-beta  | codex  | Independent implementation team B                    |
| team-gamma | gemini | Independent implementation team C                    |

## Workflow Steps

```
define-spec → [implement-alpha, implement-beta, implement-gamma] → compare-solutions → select-winner
```

1. **define-spec** (lead) — Define requirements, acceptance criteria, and evaluation rubric
2. **implement-alpha** (team-alpha) — Build solution independently
3. **implement-beta** (team-beta) — Build solution independently
4. **implement-gamma** (team-gamma) — Build solution independently
5. **compare-solutions** (lead) — Review all outputs against rubric
6. **select-winner** (lead) — Choose best solution or synthesize hybrid

## Usage

```bash
agent-relay run --template competitive --task "Design caching layer for API"
```

```typescript
import { TemplateRegistry, WorkflowRunner } from '@agent-relay/sdk/workflows';

const registry = new TemplateRegistry();
const config = await registry.loadTemplate('competitive');
const runner = new WorkflowRunner();

await runner.execute(config, undefined, {
  task: 'Design and implement a caching strategy for the user API endpoints',
});
```

## Configuration

- **maxConcurrency:** 4 (all teams can run in parallel)
- **onError:** fail (implementations should complete for fair comparison)
- **errorStrategy:** continue (allow partial comparison if one team fails)
- **Barrier:** implementations-complete (waits for all teams)

## Verification Markers

- `SPEC_COMPLETE` — Requirements defined
- `IMPLEMENTATION_COMPLETE` — Team finished their solution
- `COMPARISON_COMPLETE` — Analysis of all solutions done
- `DONE` — Winner selected

## Best Practices

- **Clear rubric**: Define evaluation criteria upfront in the spec step
- **Strict isolation**: Teams must not see each other's work
- **Diverse CLIs**: Use different models to encourage varied approaches
- **Time boxing**: Set appropriate timeouts per team
