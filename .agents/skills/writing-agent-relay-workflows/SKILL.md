---
name: writing-agent-relay-workflows
description: Use when building multi-agent workflows with the relay broker-sdk - covers the WorkflowBuilder API, DAG step dependencies, agent definitions, step output chaining via {{steps.X.output}}, verification gates, evidence-based completion, owner decisions, dedicated channels, dynamic channel management (subscribe/unsubscribe/mute/unmute), swarm patterns, error handling, event listeners, step sizing rules, authoring best practices, and the lead+workers team pattern for complex steps
---

### Overview

The relay broker-sdk workflow system orchestrates multiple AI agents (Claude, Codex, Gemini, Aider, Goose) through typed DAG-based workflows. Workflows can be written in **TypeScript** (preferred), **Python**, or **YAML**.

**Language preference:** TypeScript > Python > YAML. Use TypeScript unless the project is Python-only or a simple config-driven workflow suits YAML.

### When to Use

- Building multi-agent workflows with step dependencies
- Orchestrating different AI CLIs (claude, codex, gemini, aider, goose)
- Creating DAG, pipeline, fan-out, or other swarm patterns
- Needing verification gates, retries, or step output chaining
- Dynamic channel management: agents joining/leaving/muting channels mid-workflow

### Quick Reference

#### ```typescript

```typescript
const { workflow } = require('@agent-relay/sdk/workflows');

async function main() {
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
    task: `Analyze the codebase and produce a plan.`,
    retries: 2,
    verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
  })
  .step('implement', {
    agent: 'worker',
    task: `Implement based on this plan:\n{{steps.plan.output}}`,
    dependsOn: ['plan'],
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
  .run({ cwd: process.cwd() });

  console.log('Result:', result.status);
}

main().catch(console.error);
```


### ⚡ Parallelism — Design for Speed

#### Cross-Workflow Parallelism: Wave Planning

```bash
# BAD — sequential (14 hours for 27 workflows at ~30 min each)
agent-relay run workflows/34-sst-wiring.ts
agent-relay run workflows/35-env-config.ts
agent-relay run workflows/36-loading-states.ts
# ... one at a time

# GOOD — parallel waves (3-4 hours for 27 workflows)
# Wave 1: independent infra (parallel)
agent-relay run workflows/34-sst-wiring.ts &
agent-relay run workflows/35-env-config.ts &
agent-relay run workflows/36-loading-states.ts &
agent-relay run workflows/37-responsive.ts &
wait
git add -A && git commit -m "Wave 1"

# Wave 2: testing (parallel — independent test suites)
agent-relay run workflows/40-unit-tests.ts &
agent-relay run workflows/41-integration-tests.ts &
agent-relay run workflows/42-e2e-tests.ts &
wait
git add -A && git commit -m "Wave 2"
```

#### Declare File Scope for Planning

```typescript
workflow('48-comparison-mode')
  .packages(['web', 'core'])                // monorepo packages touched
  .isolatedFrom(['49-feedback-system'])      // explicitly safe to parallelize
  .requiresBefore(['46-admin-dashboard'])    // explicit ordering constraint
```

#### Within-Workflow Parallelism

```typescript
// BAD — unnecessary sequential chain
.step('fix-component-a', { agent: 'worker', dependsOn: ['review'] })
.step('fix-component-b', { agent: 'worker', dependsOn: ['fix-component-a'] })  // why wait?

// GOOD — parallel fan-out, merge at the end
.step('fix-component-a', { agent: 'impl-1', dependsOn: ['review'] })
.step('fix-component-b', { agent: 'impl-2', dependsOn: ['review'] })  // same dep = parallel
.step('verify-all', { agent: 'reviewer', dependsOn: ['fix-component-a', 'fix-component-b'] })
```


### Key Concepts

#### Verification Gates

```typescript
verification: { type: 'exit_code' }                        // preferred for code-editing steps
verification: { type: 'output_contains', value: 'DONE' }   // optional accelerator
verification: { type: 'file_exists', value: 'src/out.ts' } // deterministic file check
```

#### DAG Dependencies

```typescript
.step('fix-types',  { agent: 'worker', dependsOn: ['review'], ... })
.step('fix-tests',  { agent: 'worker', dependsOn: ['review'], ... })
.step('final',      { agent: 'lead',   dependsOn: ['fix-types', 'fix-tests'], ... })
```

#### SDK API

```typescript
// Subscribe an agent to additional channels post-spawn
relay.subscribe({ agent: 'security-auditor', channels: ['review-pr-456'] });

// Unsubscribe — agent leaves the channel entirely
relay.unsubscribe({ agent: 'security-auditor', channels: ['general'] });

// Mute — agent stays subscribed (history access) but messages are NOT injected into PTY
relay.mute({ agent: 'security-auditor', channel: 'review-pr-123' });

// Unmute — resume PTY injection
relay.unmute({ agent: 'security-auditor', channel: 'review-pr-123' });
```

#### Events

```typescript
relay.onChannelSubscribed = (agent, channels) => { /* ... */ };
relay.onChannelUnsubscribed = (agent, channels) => { /* ... */ };
relay.onChannelMuted = (agent, channel) => { /* ... */ };
relay.onChannelUnmuted = (agent, channel) => { /* ... */ };
```


### Agent Definition

#### ```typescript

```typescript
.agent('name', {
  cli: 'claude' | 'codex' | 'gemini' | 'aider' | 'goose' | 'opencode' | 'droid',
  role?: string,
  preset?: 'lead' | 'worker' | 'reviewer' | 'analyst',
  retries?: number,
  model?: string,
  interactive?: boolean, // default: true
})
```


### Step Definition

#### Agent Steps

```typescript
.step('name', {
  agent: string,
  task: string,                   // supports {{var}} and {{steps.NAME.output}}
  dependsOn?: string[],
  verification?: VerificationCheck,
  retries?: number,
})
```

#### Deterministic Steps (Shell Commands)

```typescript
.step('verify-files', {
  type: 'deterministic',
  command: 'test -f src/auth.ts && echo "FILE_EXISTS"',
  dependsOn: ['implement'],
  captureOutput: true,
  failOnError: true,
})
```


### Common Patterns

#### Pipeline (sequential handoff)

```typescript
.pattern('pipeline')
.step('analyze', { agent: 'analyst', task: '...' })
.step('implement', { agent: 'dev', task: '{{steps.analyze.output}}', dependsOn: ['analyze'] })
.step('test', { agent: 'tester', task: '{{steps.implement.output}}', dependsOn: ['implement'] })
```

#### Error Handling

```typescript
.onError('fail-fast')   // stop on first failure (default)
.onError('continue')    // skip failed branches, continue others
.onError('retry', { maxRetries: 3, retryDelayMs: 5000 })
```


### Multi-File Edit Pattern

#### When a workflow needs to modify multiple existing files, **use one agent step per file** with a deterministic verify gate after each. Agents reliably edit 1-2 files per step but fail on 4+.

```yaml
steps:
  - name: read-types
    type: deterministic
    command: cat src/types.ts
    captureOutput: true

  - name: edit-types
    agent: dev
    dependsOn: [read-types]
    task: |
      Edit src/types.ts. Current contents:
      {{steps.read-types.output}}
      Add 'pending' to the Status union type.
      Only edit this one file.
    verification:
      type: exit_code

  - name: verify-types
    type: deterministic
    dependsOn: [edit-types]
    command: 'if git diff --quiet src/types.ts; then echo "NOT MODIFIED"; exit 1; fi; echo "OK"'
    failOnError: true

  - name: read-service
    type: deterministic
    dependsOn: [verify-types]
    command: cat src/service.ts
    captureOutput: true

  - name: edit-service
    agent: dev
    dependsOn: [read-service]
    task: |
      Edit src/service.ts. Current contents:
      {{steps.read-service.output}}
      Add a handlePending() method.
      Only edit this one file.
    verification:
      type: exit_code

  - name: verify-service
    type: deterministic
    dependsOn: [edit-service]
    command: 'if git diff --quiet src/service.ts; then echo "NOT MODIFIED"; exit 1; fi; echo "OK"'
    failOnError: true

  # Deterministic commit — never rely on agents to commit
  - name: commit
    type: deterministic
    dependsOn: [verify-service]
    command: git add src/types.ts src/service.ts && git commit -m "feat: add pending status"
    failOnError: true
```


### File Materialization: Verify Before Proceeding

#### After any step that creates files, add a deterministic `file_exists` check before proceeding. Non-interactive agents may exit 0 without writing anything (wrong cwd, stdout instead of disk).

```yaml
- name: verify-files
  type: deterministic
  dependsOn: [impl-auth, impl-storage]
  command: |
    missing=0
    for f in src/auth/credentials.ts src/storage/client.ts; do
      if [ ! -f "$f" ]; then echo "MISSING: $f"; missing=$((missing+1)); fi
    done
    if [ $missing -gt 0 ]; then echo "$missing files missing"; exit 1; fi
    echo "All files present"
  failOnError: true
```


### DAG Deadlock Anti-Pattern

#### ```yaml

```yaml
# WRONG — deadlock: coordinate depends on context, work-a depends on coordinate
steps:
  - name: coordinate
    dependsOn: [context]    # lead waits for WORKER_DONE...
  - name: work-a
    dependsOn: [coordinate] # ...but work-a can't start until coordinate finishes

# RIGHT — workers and lead start in parallel
steps:
  - name: context
    type: deterministic
  - name: work-a
    dependsOn: [context]    # starts with lead
  - name: coordinate
    dependsOn: [context]    # starts with workers
  - name: merge
    dependsOn: [work-a, coordinate]
```


### Step Sizing

#### **One agent, one deliverable.** A step's task prompt should be 10-20 lines max.

```yaml
# Team pattern: lead + workers on a shared channel
steps:
  - name: track-lead-coord
    agent: track-lead
    dependsOn: [prior-step]
    task: |
      Lead the track on #my-track. Workers: track-worker-1, track-worker-2.
      Post assignments to the channel. Review worker output.

  - name: track-worker-1-impl
    agent: track-worker-1
    dependsOn: [prior-step]  # same dep as lead — starts concurrently
    task: |
      Join #my-track. track-lead will post your assignment.
      Implement the file as directed.
    verification:
      type: exit_code

  - name: next-step
    dependsOn: [track-lead-coord]  # downstream depends on lead, not workers
```


### Supervisor Pattern

When you set `.pattern('supervisor')` (or `hub-spoke`, `fan-out`), the runner auto-assigns a supervisor agent as owner for worker steps. The supervisor monitors progress, nudges idle workers, and issues `OWNER_DECISION`.

**Auto-hardening only activates for hub patterns** — not `pipeline` or `dag`.

| Use case | Pattern | Why |
|----------|---------|-----|
| Sequential, no monitoring | `pipeline` | Simple, no overhead |
| Workers need oversight | `supervisor` | Auto-owner monitors |
| Local/small models | `supervisor` | Supervisor catches stuck workers |
| All non-interactive | `pipeline` or `dag` | No PTY = no supervision needed |

### Concurrency

**Cap `maxConcurrency` at 4-6.** Spawning 10+ agents simultaneously causes broker timeouts.

| Parallel agents | `maxConcurrency` |
|-----------------|-------------------|
| 2-4             | 4 (default safe)  |
| 5-10            | 5                 |
| 10+             | 6-8 max           |

### Common Mistakes

| Mistake | Fix |
|---------|-----|
| All workflows run sequentially | Group independent workflows into parallel waves (4-7x speedup) |
| Every step depends on the previous one | Only add `dependsOn` when there's a real data dependency |
| Self-review step with no timeout | Set `timeout: 300_000` (5 min) — Codex hangs in non-interactive review |
| One giant workflow per feature | Split into smaller workflows that can run in parallel waves |
| Adding exit instructions to tasks | Runner handles self-termination automatically |
| Setting `timeoutMs` on agents/steps | Use global `.timeout()` only |
| Using `general` channel | Set `.channel('wf-name')` for isolation |
| `{{steps.X.output}}` without `dependsOn: ['X']` | Output won't be available yet |
| Requiring exact sentinel as only completion gate | Use `exit_code` or `file_exists` verification |
| Writing 100-line task prompts | Split into lead + workers on a channel |
| `maxConcurrency: 16` with many parallel steps | Cap at 5-6 |
| Non-interactive agent reading large files via tools | Pre-read in deterministic step, inject via `{{steps.X.output}}` |
| Workers depending on lead step (deadlock) | Both depend on shared context step |
| `fan-out`/`hub-spoke` for simple parallel workers | Use `dag` instead |
| `pipeline` but expecting auto-supervisor | Only hub patterns auto-harden. Use `.pattern('supervisor')` |
| Workers without `preset: 'worker'` in lead+worker flows | Add preset for clean stdout |
| Using `_` in YAML numbers (`timeoutMs: 1_200_000`) | YAML doesn't support `_` separators |
| Workflow timeout under 30 min for complex workflows | Use `3600000` (1 hour) as default |
| `import { workflow }` (ESM) in TypeScript workflows | Use `require('@agent-relay/sdk/workflows')` — most repos are CJS |
| Top-level `await` in TypeScript | Wrap in `async function main() { ... } main().catch(console.error)` |
| Using `createWorkflowRenderer` | Does not exist. Use `.run({ cwd: process.cwd() })` |
| `export default workflow(...)...build()` | No `.build()`. Chain ends with `.run()` inside async main |
| Relative import `'../workflows/builder.js'` | Use `require('@agent-relay/sdk/workflows')` |
| `pattern('single')` on cloud runner | Not supported — use `dag` |
| `pattern('supervisor')` with one agent | Same agent is owner + specialist. Use `dag` |
| Invalid verification type (`type: 'deterministic'`) | Only `exit_code`, `output_contains`, `file_exists`, `custom` are valid |
| Chaining `{{steps.X.output}}` from interactive agents | PTY output is garbled. Use deterministic steps or `preset: 'worker'` |
| Single step editing 4+ files | Agents modify 1-2 then exit. Split to one file per step with verify gates |
| Relying on agents to `git commit` | Agents emit markers without running git. Use deterministic commit step |
| File-writing steps without `file_exists` verification | `exit_code` auto-passes even if no file written |
| Manual peer fanout in `handleChannelMessage()` | Use broker-managed channel subscriptions — broker fans out to all subscribers automatically |
| Client-side `personaNames.has(from)` filtering | Use `relay.subscribe()`/`relay.unsubscribe()` — only subscribed agents receive messages |
| Agents receiving noisy cross-channel messages during focused work | Use `relay.mute({ agent, channel })` to silence non-primary channels without leaving them |
| Hardcoding all channels at spawn time | Use `agent.subscribe()` / `agent.unsubscribe()` for dynamic channel membership post-spawn |

### YAML Alternative

#### ```yaml

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
        task: 'Produce a detailed implementation plan.'
      - name: implement
        agent: worker
        task: 'Implement: {{steps.plan.output}}'
        dependsOn: [plan]
        verification:
          type: exit_code
```


### Available Swarm Patterns

`dag` (default), `fan-out`, `pipeline`, `hub-spoke`, `consensus`, `mesh`, `handoff`, `cascade`, `debate`, `hierarchical`, `map-reduce`, `scatter-gather`, `supervisor`, `reflection`, `red-team`, `verifier`, `auction`, `escalation`, `saga`, `circuit-breaker`, `blackboard`, `swarm`

See skill `choosing-swarm-patterns` for pattern selection guidance.
