# Bug Fix Template

**Pattern:** hub-spoke | **Timeout:** 45 minutes | **Channel:** swarm-bug-fix

## Overview

Fast bug investigation and remediation workflow with validation gates. Designed for quick turnaround on production issues with proper verification.

## Agents

| Agent | CLI | Role |
|-------|-----|------|
| lead | claude | Coordinates debugging and release decisions |
| investigator | codex | Reproduces and scopes the defect |
| fixer | codex | Implements and tests the fix |
| verifier | claude | Validates risk, regressions, and completion |

## Workflow Steps

```
investigate → patch → regression-check → closeout
```

1. **investigate** (investigator) — Reproduce the issue and identify root cause
2. **patch** (fixer) — Implement the fix based on investigation
3. **regression-check** (verifier) — Validate patch correctness and regression risk
4. **closeout** (lead) — Prepare incident summary and deployment notes

## Usage

```bash
agent-relay run --template bug-fix --task "Users getting 500 error on login"
```

```typescript
import { TemplateRegistry, WorkflowRunner } from "@agent-relay/broker-sdk/workflows";

const registry = new TemplateRegistry();
const config = await registry.loadTemplate("bug-fix");
const runner = new WorkflowRunner();

await runner.execute(config, undefined, {
  task: "Users getting 500 error on login after password reset",
});
```

## Configuration

- **maxConcurrency:** 2
- **onError:** retry (max 3 retries, 3s delay)
- **patch retries:** 2 (critical step)
- **Barrier:** fix-ready (waits for investigate, patch, regression-check)

## Verification Markers

Each step produces verification markers:
- `ROOT_CAUSE_IDENTIFIED` — Investigation complete
- `PATCH_APPLIED` — Fix implemented
- `VERIFICATION_COMPLETE` — Regression check passed
- `DONE` — Closeout complete
