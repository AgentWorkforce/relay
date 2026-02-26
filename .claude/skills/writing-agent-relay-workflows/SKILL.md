---
name: writing-agent-relay-workflows
description: Use when building multi-agent workflows with the relay broker-sdk - covers the WorkflowBuilder API, DAG step dependencies, agent definitions, step output chaining via {{steps.X.output}}, verification gates, dedicated channels, swarm patterns, error handling, event listeners, step sizing rules, and the lead+workers team pattern for complex steps
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
  .pattern('dag') // or 'pipeline', 'fan-out', etc.
  .channel('wf-my-workflow') // dedicated channel (auto-generated if omitted)
  .maxConcurrency(3)
  .timeout(3_600_000) // global timeout (ms)

  .agent('lead', { cli: 'claude', role: 'Architect', retries: 2 })
  .agent('worker', { cli: 'codex', role: 'Implementer', retries: 2 })

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
  cli: 'claude' | 'codex' | 'gemini' | 'aider' | 'goose' | 'opencode' | 'droid',
  role?: string,        // describes agent's purpose (used by pattern auto-selection)
  retries?: number,     // default retry count for steps using this agent
  model?: string,       // model override
  interactive?: boolean, // default: true. Set false for non-interactive subprocess mode
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

## Non-Interactive Agents (preset: worker / reviewer / analyst)

Use presets instead of manually setting `interactive: false`. Presets configure interactive mode and inject guardrails automatically:

```typescript
.agent('worker', { cli: 'claude', preset: 'worker', model: 'sonnet' })
// Equivalent to interactive: false + "Do NOT use relay tools" prefix injected
```

| Preset     | Interactive   | Relay access | Use for                                              |
| ---------- | ------------- | ------------ | ---------------------------------------------------- |
| `lead`     | ✅ PTY        | ✅ Full      | Coordination, spawning workers, monitoring channels  |
| `worker`   | ❌ subprocess | ❌ None      | Executing bounded tasks, producing structured stdout |
| `reviewer` | ❌ subprocess | ❌ None      | Reading artifacts, producing verdicts                |
| `analyst`  | ❌ subprocess | ❌ None      | Reading code/files, writing findings                 |

**What changes with non-interactive presets:**

- Agent runs via CLI one-shot mode (`claude -p`, `codex exec`, `gemini -p`)
- stdin is `/dev/null` — the process never blocks waiting for terminal input
- No PTY, no relay messaging, no `/exit` self-termination
- Output captured from stdout, available via `{{steps.X.output}}`

**Critical rule — pre-inject content, never ask non-interactive agents to discover it:**

```yaml
# WRONG — claude -p will try to read the file via tools, may time out on large files
- name: analyze
  agent: analyst
  task: 'Read src/runner.ts and summarize the scrubForChannel method.'

# RIGHT — deterministic step reads the file, injects content directly
- name: read-method
  type: deterministic
  command: sed -n '/scrubForChannel/,/^  \}/p' src/runner.ts
  captureOutput: true

- name: analyze
  agent: analyst
  dependsOn: [read-method]
  task: |
    Summarize this method:
    {{steps.read-method.output}}
```

Non-interactive agents can use tools but it's slow and unreliable on large files.
Deterministic steps are instant. Always pre-read, then inject.

## DAG Deadlock Anti-Pattern

**The lead↔worker deadlock** is the most common DAG mistake. It causes the lead to wait indefinitely for workers that can never start.

```yaml
# WRONG — deadlock: coordinate waits for WORKER_DONE from work-a,
# but work-a can't start until coordinate finishes
steps:
  - name: coordinate   # lead, waits for WORKER_A_DONE signal
    dependsOn: [context]
  - name: work-a       # can't start — blocked by coordinate
    dependsOn: [coordinate]

# RIGHT — workers and lead start in parallel, merge step gates on all three
steps:
  - name: context
    type: deterministic
  - name: work-a        # starts with lead
    dependsOn: [context]
  - name: work-b        # starts with lead
    dependsOn: [context]
  - name: coordinate    # lead monitors channel for worker signals
    dependsOn: [context]
  - name: merge         # gates on everything
    dependsOn: [work-a, work-b, coordinate]
```

The runner will catch obvious cases of this at parse time and throw an error.

**Rule:** if a lead step's task mentions downstream step names alongside waiting keywords (wait, DONE, monitor, check inbox), that's a deadlock.

## Step Sizing: Keep Tasks Focused

**A step's task prompt should be 10–20 lines maximum.** If you find yourself writing a 100-line task prompt, the step is too large for one agent — split it into a team.

### The Rule

One agent, one deliverable. A step should instruct an agent to produce **one specific artifact** (one file, one plan, one review pass). If the step requires reading the whole codebase, coordinating sub-tasks, _and_ reviewing output, it will fail or produce poor results.

### When to Use a Team Instead

Decompose a large step into a **lead + workers** team when:

- The task would require a 50+ line prompt to fully specify
- The deliverable is multiple files that must be consistent with each other
- The work benefits from back-and-forth (questions, corrections, reviews)
- You need one agent to verify another's output before signaling completion

### Team Pattern

All team members run as concurrent steps sharing a dedicated channel. The lead coordinates dynamically via messages; workers receive assignments at runtime, not in their task prompt.

```yaml
agents:
  - name: track-lead
    cli: claude
    channels: [my-track, main-channel]
    role: 'Leads the track. Assigns files to workers, reviews output.'
    constraints:
      model: sonnet

  - name: track-worker-1
    cli: codex
    channels: [my-track]
    role: 'Writes file-a.ts as assigned by track-lead.'
    constraints:
      model: gpt-5.3-codex

  - name: track-worker-2
    cli: codex
    channels: [my-track]
    role: 'Writes file-b.ts as assigned by track-lead.'
    constraints:
      model: gpt-5.3-codex-spark

steps:
  # All three start in the same wave (same dependsOn).
  # Lead posts assignments to #my-track; workers read and implement.
  - name: track-lead-coord
    agent: track-lead
    dependsOn: [prior-step]
    task: |
      Lead the track on #my-track. Workers: track-worker-1, track-worker-2.
      Post assignments to the channel. Review output. Output: TRACK_COMPLETE
    verification:
      type: output_contains
      value: TRACK_COMPLETE

  - name: track-worker-1-impl
    agent: track-worker-1
    dependsOn: [prior-step] # same dep as lead — starts concurrently
    task: |
      Join #my-track. track-lead will post your assignment.
      Implement the file as directed. Post WORKER1_DONE when complete.
      Output: WORKER1_DONE
    verification:
      type: output_contains
      value: WORKER1_DONE

  - name: track-worker-2-impl
    agent: track-worker-2
    dependsOn: [prior-step]
    task: |
      Join #my-track. track-lead will post your assignment.
      Implement the file as directed. Post WORKER2_DONE when complete.
      Output: WORKER2_DONE
    verification:
      type: output_contains
      value: WORKER2_DONE

  # Next step depends only on the lead — lead won't output TRACK_COMPLETE
  # until workers are done and output is verified.
  - name: next-step
    agent: ...
    dependsOn: [track-lead-coord]
```

### Key Points

- **Lead task prompt**: who your workers are, which channel to use, what to assign, when to output the gate signal. ~15 lines.
- **Worker task prompt**: which channel to join, that the lead will post their assignment, what signal to output when done. ~5 lines.
- **Workers don't need the full spec in their prompt** — they get it from the lead at runtime via the channel.
- **Downstream steps depend on the lead**, not the workers — the lead gates the signal after verifying worker output.
- **Separate channels per team** prevent cross-talk: `#harness-track`, `#review-track`, etc.

## Concurrency: Don't Over-Parallelize

**Set `maxConcurrency` to 4–6 for most workflows.** Each agent spawn requires a PTY startup plus a Relaycast registration. Spawning 10+ agents simultaneously overwhelms the broker and causes spawn timeouts.

```yaml
swarm:
  pattern: dag
  maxConcurrency: 5 # good: staggers spawns within each wave
```

Even if a wave has 10 ready steps, the runner will only start 5 at a time and pick up the next as each finishes. This keeps the broker healthy and prevents the `request timed out after 10000ms (type='spawn_agent')` error that occurs when too many agents register with Relaycast concurrently.

**Rule of thumb by workflow size:**

| Parallel agents needed | `maxConcurrency` |
| ---------------------- | ---------------- |
| 2–4                    | 4 (default safe) |
| 5–10                   | 5                |
| 10+                    | 6–8 max          |

## Common Mistakes

| Mistake                                                     | Fix                                                               |
| ----------------------------------------------------------- | ----------------------------------------------------------------- |
| Adding `withExit()` or exit instructions to tasks           | Runner handles this automatically                                 |
| Setting tight `timeoutMs` on agents                         | Use global `.timeout()` only                                      |
| Using `general` channel                                     | Set `.channel('wf-name')` for isolation                           |
| Referencing `{{steps.X.output}}` without `dependsOn: ['X']` | Output won't be available yet                                     |
| Making review steps serial when they could be parallel      | Both reviewers can depend on the same upstream step               |
| Not using verification gates on critical steps              | Add `output_contains` with a completion marker                    |
| Writing 100-line task prompts                               | Split into lead + workers communicating on a channel              |
| Putting the full spec in every worker's task                | Lead posts the spec to the channel at runtime                     |
| `maxConcurrency: 16` with many parallel steps               | Cap at 5–6; broker times out spawning 10+ agents at once          |
| Asking non-interactive agent to read a large file via tools | Pre-read in a deterministic step, inject via `{{steps.X.output}}` |
| Workers depending on the lead step (deadlock)               | Workers and lead both depend on a shared context step             |
| Omitting `agents` field for deterministic-only workflows    | Field is now optional — pure shell pipelines work without it      |

## YAML Alternative

Workflows can also be defined as `.yaml` files:

```yaml
version: '1.0'
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
        task: 'Produce a plan. End with: PLAN_COMPLETE'
        verification:
          type: output_contains
          value: PLAN_COMPLETE
      - name: implement
        agent: worker
        task: 'Implement: {{steps.plan.output}}'
        dependsOn: [plan]
```

Run with: `agent-relay run path/to/workflow.yaml`

## Available Swarm Patterns

`dag` (default), `fan-out`, `pipeline`, `hub-spoke`, `consensus`, `mesh`, `handoff`, `cascade`, `debate`, `hierarchical`, `map-reduce`, `scatter-gather`, `supervisor`, `reflection`, `red-team`, `verifier`, `auction`, `escalation`, `saga`, `circuit-breaker`, `blackboard`, `swarm`

See skill `choosing-swarm-patterns` for pattern selection guidance.
