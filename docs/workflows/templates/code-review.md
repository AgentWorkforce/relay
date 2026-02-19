# Code Review Template

**Pattern:** fan-out | **Timeout:** 40 minutes | **Channel:** swarm-code-review

## Overview

Parallel multi-reviewer code assessment with consolidated findings. Three specialized reviewers evaluate different aspects simultaneously, then findings are merged.

## Agents

| Agent | CLI | Role |
|-------|-----|------|
| lead | claude | Aggregates review output and final recommendations |
| reviewer-architecture | codex | Assesses architecture and maintainability |
| reviewer-correctness | claude | Assesses correctness and testing |
| reviewer-security | gemini | Assesses security posture and abuse resistance |

## Workflow Steps

```
prepare-context
      ↓
  ┌───┴───┐
  ↓       ↓       ↓
arch  correct  security  (parallel)
  └───┬───┘
      ↓
 consolidate
```

1. **prepare-context** (lead) — Summarize change intent and review priorities
2. **architecture-pass** (reviewer-architecture) — Review architecture, coupling, maintainability
3. **correctness-pass** (reviewer-correctness) — Review behavior, tests, regression paths
4. **security-pass** (reviewer-security) — Review attack surface, secrets, input validation
5. **consolidate** (lead) — Produce merged findings with severity levels

## Usage

```bash
agent-relay run --template code-review --task "Review PR #123: Add payment processing"
```

```typescript
import { TemplateRegistry, WorkflowRunner } from "@agent-relay/broker-sdk/workflows";

const registry = new TemplateRegistry();
const config = await registry.loadTemplate("code-review");
const runner = new WorkflowRunner();

await runner.execute(config, undefined, {
  task: "Review PR #123 adding Stripe payment integration",
});
```

## Configuration

- **maxConcurrency:** 4 (all reviewers can run in parallel)
- **onError:** fail (reviews should not be skipped)
- **consensusStrategy:** majority
- **Barrier:** reviews-complete (waits for all three review passes)

## Output

The consolidated review includes:
- Merged findings from all reviewers
- Severity levels (critical, high, medium, low)
- Final recommendation (approve, request changes, reject)
