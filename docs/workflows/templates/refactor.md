# Refactor Template

**Pattern:** hierarchical | **Timeout:** 75 minutes | **Channel:** swarm-refactor

## Overview

Hierarchical refactor workflow for safe structural improvement. Analysis and planning precede execution, with validation ensuring behavior preservation.

## Agents

| Agent | CLI | Role |
|-------|-----|------|
| lead | claude | Owns scope, sequencing, and acceptance |
| architect | codex | Designs target architecture and migration plan |
| refactorer | codex | Executes scoped refactor changes |
| tester | claude | Validates behavior parity and risk |

## Workflow Steps

```
analyze → design → refactor-code → validate → handoff
```

1. **analyze** (architect) — Analyze current design and identify opportunities
2. **design** (architect) — Provide incremental refactor plan with rollback notes
3. **refactor-code** (refactorer) — Execute the refactor preserving behavior
4. **validate** (tester) — Validate no regressions, tests pass
5. **handoff** (lead) — Final refactor summary and follow-up items

## Usage

```bash
agent-relay run --template refactor --task "Extract payment logic into separate service"
```

```typescript
import { TemplateRegistry, WorkflowRunner } from "@agent-relay/sdk/workflows";

const registry = new TemplateRegistry();
const config = await registry.loadTemplate("refactor");
const runner = new WorkflowRunner();

await runner.execute(config, undefined, {
  task: "Extract payment processing logic from OrderService into PaymentService",
});
```

## Configuration

- **maxConcurrency:** 2
- **onError:** retry (max 2 retries, 5s delay)
- **refactor-code retries:** 2 (critical step)
- **Barrier:** refactor-ready (waits for analyze, design, refactor-code, validate)

## Safety Features

- Incremental planning with rollback notes
- Validation step ensures behavior parity
- Retry logic for the refactor step
- Lead approval before completion
