# Feature Development Template

**Pattern:** hub-spoke | **Timeout:** 1 hour | **Channel:** swarm-feature-dev

## Overview

Blueprint-style feature development with deterministic quality gates. Combines agent intelligence for planning and implementation with deterministic shell commands for git operations, linting, and testing.

## Step Types

This template uses both step types:

- **Agent steps** (blue): LLM-powered for planning, implementation, review
- **Deterministic steps** (green): Shell commands for git, lint, test, commit

## Agents

| Agent     | CLI    | Role                                         |
| --------- | ------ | -------------------------------------------- |
| lead      | claude | Lead engineer coordinating delivery          |
| planner   | codex  | Plans implementation and acceptance criteria |
| developer | codex  | Implements planned changes                   |
| reviewer  | claude | Reviews code quality and release risk        |

## Workflow Steps

```
[preflight] → plan → create-branch → implement → lint → test → fix-failures → commit → review → push → finalize
```

### Preflight Checks

- `git status --porcelain` — Ensures clean working directory
- `npm run type-check` — Runs type checking if available

### Steps

| Step          | Type          | Description                                  |
| ------------- | ------------- | -------------------------------------------- |
| plan          | agent         | Analyze request, produce implementation plan |
| create-branch | deterministic | `git checkout -b feature/{{branch-name}}`    |
| implement     | agent         | Implement the approved plan                  |
| lint          | deterministic | `npm run lint:fix`                           |
| test          | deterministic | `npm test`                                   |
| fix-failures  | agent         | Fix any test failures (max 2 iterations)     |
| commit        | deterministic | `git add -A && git commit`                   |
| review        | agent         | Review implementation quality                |
| push          | deterministic | `git push origin feature/{{branch-name}}`    |
| finalize      | agent         | Summarize decisions and ship readiness       |

## Usage

```bash
agent-relay run --template feature-dev \
  --task "Add user authentication with OAuth2" \
  --set branch-name=auth-oauth2
```

```typescript
import { TemplateRegistry, WorkflowRunner } from '@agent-relay/sdk/workflows';

const registry = new TemplateRegistry();
const config = await registry.loadTemplate('feature-dev');
const runner = new WorkflowRunner();

await runner.execute(config, undefined, {
  task: 'Add user authentication with OAuth2',
  'branch-name': 'auth-oauth2',
});
```

## Configuration

- **maxConcurrency:** 2
- **onError:** retry (max 2 retries, 5s delay)
- **Barrier:** delivery-ready (waits for plan, implement, review)

## Cost Savings

Blueprint templates save ~30-40% on LLM costs by using deterministic steps for git, lint, and test operations while adding quality gates.

## Customization

Override agents or steps in your own YAML:

```yaml
version: '1.0'
name: my-feature-dev
extends: feature-dev

agents:
  - name: developer
    cli: claude # Use Claude instead of Codex
    constraints:
      model: opus
```
