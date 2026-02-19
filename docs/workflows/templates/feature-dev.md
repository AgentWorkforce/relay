# Feature Development Template

**Pattern:** hub-spoke | **Timeout:** 1 hour | **Channel:** swarm-feature-dev

## Overview

Full feature development lifecycle with planning, implementation, review, and release. A lead engineer coordinates delivery through planning, development, and review phases.

## Agents

| Agent | CLI | Role |
|-------|-----|------|
| lead | claude | Lead engineer coordinating delivery |
| planner | codex | Plans implementation and acceptance criteria |
| developer | codex | Implements planned changes |
| reviewer | claude | Reviews code quality and release risk |

## Workflow Steps

```
plan → implement → review → finalize
```

1. **plan** (planner) — Analyze the feature request and produce implementation plan
2. **implement** (developer) — Implement the approved plan
3. **review** (reviewer) — Review implementation quality and test coverage
4. **finalize** (lead) — Summarize decisions and ship readiness

## Usage

```bash
agent-relay run --template feature-dev --task "Add user authentication with OAuth2"
```

```typescript
import { TemplateRegistry, WorkflowRunner } from "@agent-relay/broker-sdk/workflows";

const registry = new TemplateRegistry();
const config = await registry.loadTemplate("feature-dev");
const runner = new WorkflowRunner();

await runner.execute(config, undefined, {
  task: "Add user authentication with OAuth2",
});
```

## Configuration

- **maxConcurrency:** 2
- **onError:** retry (max 2 retries, 5s delay)
- **Barrier:** delivery-ready (waits for plan, implement, review)

## Customization

Override agents or steps in your own YAML:

```yaml
version: "1.0"
name: my-feature-dev
extends: feature-dev

agents:
  - name: developer
    cli: claude  # Use Claude instead of Codex
    constraints:
      model: opus
```
