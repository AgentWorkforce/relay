---
name: writing-agent-relay-workflows
description: Use when building multi-agent workflows with the relay broker-sdk - covers the WorkflowBuilder API, DAG step dependencies, agent definitions, step output chaining via {{steps.X.output}}, verification gates, dedicated channels, swarm patterns, error handling, and event listeners
---

# Writing Agent Relay Workflows

## Overview

The relay broker-sdk workflow system orchestrates multiple AI agents (Claude, Codex, Gemini, Aider, Goose) through typed DAG-based workflows. Workflows are defined via a fluent builder API or YAML files.

## When to Use

- Building multi-agent workflows with step dependencies
- Orchestrating different AI CLIs (claude, codex, gemini, aider, goose)
- Creating DAG, pipeline, fan-out, or other swarm patterns
- Needing verification gates, retries, or step output chaining

## Quick Reference

```typescript
import { workflow } from '../workflows/builder.js';

const result = await workflow('my-workflow')
  .description('What this workflow does')
  .pattern('dag')                          // or 'pipeline', 'fan-out', etc.
  .channel('wf-my-workflow')               // dedicated channel (auto-generated if omitted)
  .maxConcurrency(3)
  .timeout(3_600_000)                      // global timeout (ms)

  .agent('lead',      { cli: 'claude', role: 'Architect', retries: 2 })
  .agent('worker',    { cli: 'codex',  role: 'Implementer', retries: 2 })

  .step('plan', {
    agent: 'lead',
    task: `Analyze the codebase and produce a plan.\nEnd with: PLAN_COMPLETE`,
    retries: 2,
    verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
  })
  .step('implement', {
    agent: 'worker',
    task: `Implement based on this plan:\n{{steps.plan.output}}`,
    dependsOn: ['plan'],
  })

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
  .run({ onEvent: (e) => console.log(e.type), vars: { task: 'Add auth' } });
```

## Key Concepts

### Step Output Chaining
Use `{{steps.STEP_NAME.output}}` in a downstream step's task to inject the prior step's terminal output. The runner captures PTY output automatically.

### Verification Gates
Steps can require specific strings in the agent's output before being marked complete:
```typescript
verification: { type: 'output_contains', value: 'DONE' }
```
Other types: `file_exists`, `exit_code`, `custom`.

### DAG Dependencies
Steps with `dependsOn` wait for all listed steps to complete. Steps with no dependencies start immediately. Steps sharing the same `dependsOn` run in parallel:
```typescript
// These two run in parallel after 'review' completes:
.step('fix-types',  { agent: 'worker', dependsOn: ['review'], ... })
.step('fix-tests',  { agent: 'worker', dependsOn: ['review'], ... })
// This waits for BOTH to finish:
.step('final',      { agent: 'lead',   dependsOn: ['fix-types', 'fix-tests'], ... })
```

### Dedicated Channels
Always set `.channel('wf-my-workflow-name')` for workflow isolation. If omitted, the runner auto-generates `wf-{name}-{id}`. Never rely on `general`.

### Self-Termination
Do NOT add exit instructions to task strings. The runner automatically appends self-termination instructions with the agent's runtime name in `spawnAndWait()`.

### No Per-Agent Timeouts
Avoid `timeoutMs` on agents/steps unless you have a specific reason. The global `.timeout()` is the safety net. Per-agent timeouts cause premature kills on steps that legitimately need more time.

## Agent Definition

```typescript
.agent('name', {
  cli: 'claude' | 'codex' | 'gemini' | 'aider' | 'goose',
  role?: string,        // describes agent's purpose (used by pattern auto-selection)
  retries?: number,     // default retry count for steps using this agent
  model?: string,       // model override
})
```

## Step Definition

```typescript
.step('name', {
  agent: string,                  // must match an .agent() name
  task: string,                   // supports {{var}} and {{steps.NAME.output}}
  dependsOn?: string[],           // DAG edges
  verification?: VerificationCheck,
  retries?: number,               // overrides agent-level retries
})
```

## Event Listener

```typescript
.run({
  onEvent: (event) => {
    // event.type is one of:
    // 'run:started' | 'run:completed' | 'run:failed' | 'run:cancelled'
    // 'step:started' | 'step:completed' | 'step:failed' | 'step:skipped' | 'step:retrying'
  },
  vars: { key: 'value' },  // template variables for {{key}}
})
```

## Common Patterns

### Parallel Review (lead + reviewer run simultaneously)
```typescript
.step('lead-review', { agent: 'lead', dependsOn: ['implement'], ... })
.step('code-review', { agent: 'reviewer', dependsOn: ['implement'], ... })
.step('next-phase', { agent: 'worker', dependsOn: ['lead-review', 'code-review'], ... })
```

### Pipeline (sequential handoff)
```typescript
.pattern('pipeline')
.step('analyze', { agent: 'analyst', task: '...' })
.step('implement', { agent: 'dev', task: '{{steps.analyze.output}}', dependsOn: ['analyze'] })
.step('test', { agent: 'tester', task: '{{steps.implement.output}}', dependsOn: ['implement'] })
```

### Error Handling Strategies
```typescript
.onError('fail-fast')   // stop on first failure (default)
.onError('continue')    // skip failed branches, continue others
.onError('retry', { maxRetries: 3, retryDelayMs: 5000 })
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Adding `withExit()` or exit instructions to tasks | Runner handles this automatically |
| Setting tight `timeoutMs` on agents | Use global `.timeout()` only |
| Using `general` channel | Set `.channel('wf-name')` for isolation |
| Referencing `{{steps.X.output}}` without `dependsOn: ['X']` | Output won't be available yet |
| Making review steps serial when they could be parallel | Both reviewers can depend on the same upstream step |
| Not using verification gates on critical steps | Add `output_contains` with a completion marker |

## YAML Alternative

Workflows can also be defined as `.yaml` files:
```yaml
version: "1.0"
name: my-workflow
swarm:
  pattern: dag
  channel: wf-my-workflow
agents:
  - name: lead
    cli: claude
    role: Architect
  - name: worker
    cli: codex
    role: Implementer
workflows:
  - name: default
    steps:
      - name: plan
        agent: lead
        task: "Produce a plan. End with: PLAN_COMPLETE"
        verification:
          type: output_contains
          value: PLAN_COMPLETE
      - name: implement
        agent: worker
        task: "Implement: {{steps.plan.output}}"
        dependsOn: [plan]
```

Run with: `agent-relay run path/to/workflow.yaml`

## Available Swarm Patterns

`dag` (default), `fan-out`, `pipeline`, `hub-spoke`, `consensus`, `mesh`, `handoff`, `cascade`, `debate`, `hierarchical`, `map-reduce`, `scatter-gather`, `supervisor`, `reflection`, `red-team`, `verifier`, `auction`, `escalation`, `saga`, `circuit-breaker`, `blackboard`, `swarm`

See skill `choosing-swarm-patterns` for pattern selection guidance.
