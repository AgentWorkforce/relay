---
name: writing-agent-relay-workflows
description: Use when building multi-agent workflows with the relay broker-sdk - covers the WorkflowBuilder API, DAG step dependencies, agent definitions, step output chaining via {{steps.X.output}}, verification gates, evidence-based completion, owner decisions, dedicated channels, dynamic channel management (subscribe/unsubscribe/mute/unmute), swarm patterns, error handling, event listeners, step sizing rules, authoring best practices, and the lead+workers team pattern for complex steps
---

# Writing Agent Relay Workflows

## Overview

The relay broker-sdk workflow system orchestrates multiple AI agents (Claude, Codex, Gemini, Aider, Goose) through typed DAG-based workflows. Workflows can be written in **TypeScript** (preferred), **Python**, or **YAML**.

**Language preference:** TypeScript > Python > YAML. Use TypeScript unless the project is Python-only or a simple config-driven workflow suits YAML.

**Pattern selection:** Do not default to `dag` blindly. If the job needs a different swarm/workflow type, consult the `choosing-swarm-patterns` skill when available and select the pattern that best matches the coordination problem.

## When to Use

- Building multi-agent workflows with step dependencies
- Orchestrating different AI CLIs (claude, codex, gemini, aider, goose)
- Creating DAG, pipeline, fan-out, or other swarm patterns
- Needing verification gates, retries, or step output chaining
- Dynamic channel management: agents joining/leaving/muting channels mid-workflow

## Quick Reference

```typescript
import { workflow } from '@agent-relay/sdk/workflows';

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
```

**Critical TypeScript rules:**

1. Check the project's `package.json` for `"type": "module"` — if ESM, use `import` and top-level `await`. If CJS, use `require()` and wrap in `async function main()`.
2. `agent-relay run <file.ts>` executes the file as a standalone subprocess — it does NOT inspect exports. The file MUST call `.run()`.
3. Use `.run({ cwd: process.cwd() })` — `createWorkflowRenderer` does not exist
4. Validate with `--dry-run` before running: `agent-relay run --dry-run workflow.ts`

## ⚡ Parallelism — Design for Speed

**This is the most important design consideration.** Sequential workflows waste hours. Always design for maximum parallelism.

### Cross-Workflow Parallelism: Wave Planning

When a project has multiple workflows, group independent ones into parallel waves:

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

### Wave Planning Heuristics

Two workflows can run in parallel if they don't have write-write or write-read file conflicts:

| Touch Zone                                    | Can Parallelize?                           |
| --------------------------------------------- | ------------------------------------------ |
| Different `packages/*/src/` dirs              | ✅ Yes                                     |
| Different `app/` routes                       | ✅ Yes                                     |
| Same package, different subdirs               | ⚠️ Usually yes                             |
| Same files (shared config, root package.json) | ❌ No — sequential or same wave with merge |
| Explicit dependency                           | ❌ No — ordered waves                      |

### Declare File Scope for Planning

Help wave planners (human or automated) understand what each workflow touches:

```typescript
workflow('48-comparison-mode')
  .packages(['web', 'core']) // monorepo packages touched
  .isolatedFrom(['49-feedback-system']) // explicitly safe to parallelize
  .requiresBefore(['46-admin-dashboard']); // explicit ordering constraint
```

### Within-Workflow Parallelism

Use shared `dependsOn` to fan out independent sub-tasks:

```typescript
// BAD — unnecessary sequential chain
.step('fix-component-a', { agent: 'worker', dependsOn: ['review'] })
.step('fix-component-b', { agent: 'worker', dependsOn: ['fix-component-a'] })  // why wait?

// GOOD — parallel fan-out, merge at the end
.step('fix-component-a', { agent: 'impl-1', dependsOn: ['review'] })
.step('fix-component-b', { agent: 'impl-2', dependsOn: ['review'] })  // same dep = parallel
.step('verify-all', { agent: 'reviewer', dependsOn: ['fix-component-a', 'fix-component-b'] })
```

### Impact

Real-world example (Relayed — 60 workflows):

- **Sequential**: ~30 min × 60 = **30 hours**
- **Parallel waves (4-6 per wave)**: ~12 waves × 35 min = **~7 hours** (4x faster)
- **Aggressive parallelism (8-way)**: **~4 hours** (7.5x faster)

---

## Failure Prevention

These workflow files are easy to break in ways that only appear mid-run. Follow these rules when authoring or editing workflow `.ts` files.

### 1. Do not use raw top-level `await`

Executor-driven workflow files may be run through a `tsx`/`esbuild` path that behaves like CJS. Raw top-level `await` can fail with:

- `Top-level await is currently not supported with the "cjs" output format`

Always wrap execution like this:

```ts
async function runWorkflow() {
  const result = await workflow('my-workflow')
    // ...
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

Do not end workflow files with bare top-level `await workflow(...).run(...)`.

### 2. Avoid raw fenced code blocks inside workflow task template literals

Raw triple-backtick code fences inside large inline `task: \`...\``template strings are fragile and can break outer TypeScript parsing, especially when they contain language tags like`swift`or`diff`.

Preferred options, in order:

1. Avoid inline fenced examples entirely
2. Move larger examples to referenced files
3. Use plain indented examples instead of fenced blocks
4. If fenced blocks must exist inside generated inner code, escape them consistently and syntax-check the outer workflow file afterward

### 3. Keep final verification boring and deterministic

Final verification should validate real outputs with simple, portable shell commands. If checking for multiple symbols, use extended regex explicitly:

```bash
grep -Eq "foo|bar|baz" file.ts
```

Do **not** rely on basic `grep` alternation like:

```bash
grep -c "foo\|bar\|baz" file.ts
```

That can silently misbehave and create fake failures even when the generated code is correct.

### 4. Separate durable outputs from execution exhaust

Commit:

- generated product code
- migrations
- tests
- docs
- workflow-definition fixes

Do not commit by default:

- `.logs/`
- transient executor output
- retry artifacts
- temporary step-output files

### 5. Prefer Codex for implementation-heavy roles and Claude for review

Default team split for workflow-authored agent roles:

- **lead / implementer / writer / fixer** → `codex`
- **reviewer** → `claude`

Use Claude as the primary implementer only when there is a specific reason.

### 6. Be explicit about shell requirements

If executor scripts use Bash-only features such as associative arrays, require modern Bash explicitly. On macOS, prefer a known-good Bash path when needed, for example:

```bash
/opt/homebrew/bin/bash workflows/your-workflow/execute.sh --wave 2
```

### 7. Make resume semantics explicit

Document clearly whether the executor supports:

- full-run continuation
- `--wave`
- `--workflow`
- `--resume`

Do not assume users will infer the behavior. In particular, `--wave N` should be understood as "run only this wave" unless the executor explicitly chains onward.

### 8. Syntax-check workflow files after editing

After editing workflow `.ts` files, run a lightweight syntax check before launching a large batch run. This is especially important if the workflow contains:

- large inline `task` template literals
- embedded code examples
- escaped backticks
- wrapper changes around workflow execution

---

## End-to-End Bug Fix Workflows

For bug-fix or reliability workflows, do **not** stop at unit or integration tests. The workflow should explicitly prove that the original user-visible problem is fixed.

### Required phases for fix workflows

1. **Capture the original failure**
   - Reproduce the bug first in a deterministic or evidence-capturing step
   - Save exact commands, logs, status codes, or screenshots/artifacts
2. **State the acceptance contract**
   - Define the exact end-to-end success criteria before implementation
   - Include the real entrypoint a user would run
3. **Implement the fix**
4. **Rebuild / reinstall from scratch**
   - Do not trust dirty local state
   - Prefer a clean environment when install/bootstrap behavior is involved
5. **Run targeted regression checks**
   - Unit/integration tests are helpful but not sufficient by themselves
6. **Run a full end-to-end validation**
   - Use the real CLI / API / install path
   - Prefer a clean environment (Docker, sandbox, cloud workspace, Daytona, etc.) for install/runtime issues
7. **Compare before vs after evidence**
   - Show that the original failure no longer occurs
8. **Record residual risks**
   - Call out what was not covered

### Clean-environment validation guidance

When the bug involves install, bootstrap, PATH/shims, auth, brokers, background services, OS-specific packaging, or first-run UX, add a second workflow (or second phase) that validates the fix in a **fresh environment**.

Preferred order of proving environments:

1. disposable sandbox / cloud workspace
2. Docker / containerized environment
3. fresh local shell with isolated paths

### Meta-workflow guidance

If the right proving environment is unclear, first write a **meta-workflow** that:

- compares candidate validation environments
- defines the acceptance contract
- chooses the best swarm pattern
- then authors the final fix/validation workflow

This is often better than jumping straight to implementation.

## Key Concepts

### Step Output Chaining

Use `{{steps.STEP_NAME.output}}` in a downstream step's task to inject the prior step's terminal output.

**Only chain output from clean sources:**

- Deterministic steps (shell commands — always clean)
- Non-interactive agents (`preset: 'worker'` — clean stdout)

**Never chain from interactive agents** (`cli: 'claude'` without preset) — PTY output includes spinners, ANSI codes, and TUI chrome. Instead, have the agent write to a file, then read it in a deterministic step.

### Verification Gates

```typescript
verification: { type: 'exit_code' }                        // preferred for code-editing steps
verification: { type: 'output_contains', value: 'DONE' }   // optional accelerator
verification: { type: 'file_exists', value: 'src/out.ts' } // deterministic file check
```

Only these four types are valid: `exit_code`, `output_contains`, `file_exists`, `custom`. Invalid types are silently ignored and fall through to process-exit auto-pass.

**Verification token gotcha:** If the token appears in the task text, the runner requires it **twice** in output (once from task echo, once from agent). Prefer `exit_code` for code-editing steps to avoid this.

### DAG Dependencies

Steps with `dependsOn` wait for all listed steps. Steps with no dependencies start immediately. Steps sharing the same `dependsOn` run in parallel:

```typescript
.step('fix-types',  { agent: 'worker', dependsOn: ['review'], ... })
.step('fix-tests',  { agent: 'worker', dependsOn: ['review'], ... })
.step('final',      { agent: 'lead',   dependsOn: ['fix-types', 'fix-tests'], ... })
```

### Self-Termination

Do NOT add exit instructions to task strings. The runner handles this automatically.

### Step Completion Model

Steps complete through a multi-signal pipeline (highest priority first):

1. **Deterministic verification** — `exit_code`, `file_exists`, `output_contains` pass → immediate completion
2. **Owner decision** — `OWNER_DECISION: COMPLETE|INCOMPLETE_RETRY|INCOMPLETE_FAIL`
3. **Evidence-based** — channel signals, file artifacts, clean exit code
4. **Marker fast-path** — `STEP_COMPLETE:<step-name>` (optional accelerator)
5. **Process-exit fallback** — agent exits 0 with no signals → completes after grace period

**Key principle:** No single signal is mandatory. Describe the deliverable, not what to print.

### Dynamic Channel Management

Agents can dynamically subscribe, unsubscribe, mute, and unmute channels **after spawn**. This eliminates the need for client-side channel filtering and manual peer fanout.

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

Agent-level methods are also available:

```typescript
const agent = await relay.claude.spawn({ name: 'auditor', channels: ['ch-a'] });
await agent.subscribe(['ch-b']); // now subscribed to ch-a and ch-b
await agent.mute('ch-a'); // ch-a messages silenced (still in history)
await agent.unmute('ch-a'); // ch-a messages resume
await agent.unsubscribe(['ch-b']); // leaves ch-b
console.log(agent.channels); // ['ch-a']
console.log(agent.mutedChannels); // []
```

#### Semantics

| Operation     | Channel membership | PTY injection | History access  |
| ------------- | ------------------ | ------------- | --------------- |
| `subscribe`   | Yes                | Yes           | Yes             |
| `unsubscribe` | No                 | No            | No (leaves)     |
| `mute`        | Yes (stays)        | No (silenced) | Yes (can query) |
| `unmute`      | Yes                | Yes (resumes) | Yes             |

#### Events

```typescript
relay.onChannelSubscribed = (agent, channels) => {
  /* ... */
};
relay.onChannelUnsubscribed = (agent, channels) => {
  /* ... */
};
relay.onChannelMuted = (agent, channel) => {
  /* ... */
};
relay.onChannelUnmuted = (agent, channel) => {
  /* ... */
};
```

#### When to Use in Workflows

- **Multi-PR chat sessions**: Agents focused on one PR can mute other PR channels to reduce noise
- **Phase transitions**: Subscribe agents to new channels as work progresses between phases
- **Team isolation**: Workers mute the main coordination channel during focused work, unmute for review
- **Dynamic fanout**: A lead subscribes workers to sub-channels at runtime based on task decomposition

#### What This Eliminates

With broker-managed subscriptions, you no longer need:

1. Client-side persona filtering (`personaNames.has(from)` checks)
2. Channel prefix regex for message routing
3. Manual peer fanout (iterating agents to forward messages)
4. Dedup caches for dual-path delivery

## Agent Definition

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

### Model Constants

**Always use model constants from `@agent-relay/config` instead of string literals.** Each CLI has a typed constants object with its available models:

```typescript
import { ClaudeModels, CodexModels, GeminiModels } from '@agent-relay/config';

.agent('planner', { cli: 'claude', model: ClaudeModels.OPUS })    // not 'opus'
.agent('worker',  { cli: 'claude', model: ClaudeModels.SONNET })  // not 'sonnet'
.agent('coder',   { cli: 'codex',  model: CodexModels.GPT_5_4 })  // not 'gpt-5.4'
```

**Post-spawn channel operations** (available on Agent instances and AgentRelay facade):

```typescript
// Agent instance methods
agent.subscribe(channels: string[]): Promise<void>
agent.unsubscribe(channels: string[]): Promise<void>
agent.mute(channel: string): Promise<void>
agent.unmute(channel: string): Promise<void>
agent.channels: string[]          // current subscribed channels
agent.mutedChannels: string[]     // currently muted channels

// AgentRelay facade methods (by agent name)
relay.subscribe({ agent: string, channels: string[] }): Promise<void>
relay.unsubscribe({ agent: string, channels: string[] }): Promise<void>
relay.mute({ agent: string, channel: string }): Promise<void>
relay.unmute({ agent: string, channel: string }): Promise<void>
```

| Preset     | Interactive     | Relay access | Use for                               |
| ---------- | --------------- | ------------ | ------------------------------------- |
| `lead`     | yes (PTY)       | yes          | Coordination, monitoring channels     |
| `worker`   | no (subprocess) | no           | Bounded tasks, structured stdout      |
| `reviewer` | no (subprocess) | no           | Reading artifacts, producing verdicts |
| `analyst`  | no (subprocess) | no           | Reading code/files, writing findings  |

Non-interactive presets run via one-shot mode (`claude -p`, `codex exec`). Output is clean and available via `{{steps.X.output}}`.

**Critical rule:** Pre-inject content into non-interactive agents. Don't ask them to read large files — pre-read in a deterministic step and inject via `{{steps.X.output}}`.

## Step Definition

### Agent Steps

```typescript
.step('name', {
  agent: string,
  task: string,                   // supports {{var}} and {{steps.NAME.output}}
  dependsOn?: string[],
  verification?: VerificationCheck,
  retries?: number,
})
```

### Deterministic Steps (Shell Commands)

```typescript
.step('verify-files', {
  type: 'deterministic',
  command: 'test -f src/auth.ts && echo "FILE_EXISTS"',
  dependsOn: ['implement'],
  captureOutput: true,
  failOnError: true,
})
```

Use for: file checks, reading files for injection, build/test gates, git operations.

## Common Patterns

### Interactive Team (lead + workers on shared channel)

When a task involves creating/modifying multiple files with review feedback, use **interactive agents on a shared channel** instead of non-interactive one-shot workers. The lead coordinates, reviews, and posts feedback; workers implement and iterate.

```typescript
.agent('lead', {
  cli: 'claude',
  model: ClaudeModels.OPUS,
  role: 'Architect and reviewer — assigns work, reviews, posts feedback',
  retries: 1,
  // No preset — interactive by default
})

.agent('impl-new', {
  cli: 'codex',
  model: CodexModels.O3,
  role: 'Creates new files. Listens on channel for assignments and feedback.',
  retries: 2,
  // No preset — interactive, receives channel messages
})

.agent('impl-modify', {
  cli: 'codex',
  model: CodexModels.O3,
  role: 'Edits existing files. Listens on channel for assignments and feedback.',
  retries: 2,
})

// All three share the same dependsOn — they start concurrently (no deadlock)
.step('lead-coordinate', {
  agent: 'lead',
  dependsOn: ['context'],
  task: `You are the lead on #channel. Workers: impl-new, impl-modify.
Post the plan. Assign files. Review their work. Post feedback if needed.
Workers iterate based on your feedback. Exit when all files are correct.`,
})
.step('impl-new-work', {
  agent: 'impl-new',
  dependsOn: ['context'],   // same dep as lead = parallel start
  task: `You are impl-new on #channel. Wait for the lead's plan.
Create files as assigned. Report completion. Fix issues from feedback.`,
})
.step('impl-modify-work', {
  agent: 'impl-modify',
  dependsOn: ['context'],   // same dep as lead = parallel start
  task: `You are impl-modify on #channel. Wait for the lead's plan.
Edit files as assigned. Report completion. Fix issues from feedback.`,
})
// Downstream gates on lead (lead exits when satisfied)
.step('verify', { type: 'deterministic', dependsOn: ['lead-coordinate'], ... })
```

**Key behaviors observed in production:**

- **Workers self-organize from channel context.** Workers read each other's completion messages and start dependent work without waiting for the lead to relay. The shared channel gives them ambient awareness.
- **Lead-as-reviewer is more efficient than a separate reviewer agent.** The lead reads actual files and runs typecheck between rounds — one agent doing coordination + review eliminates a step.
- **Codex interactive mode works well with PTY channel injection.** Don't default to `preset: 'worker'` — interactive Codex agents receive and act on channel messages reliably.
- **Workers may outpace the lead.** If the lead is reviewing while workers are fast, the lead's "proceed" message may arrive after the worker already started from channel context. This is harmless but worth knowing.
- **No feedback loop needed = fast path.** If workers get it right first try, the interactive pattern completes just as fast as one-shot. The feedback loop is insurance, not overhead.

**When to use interactive team vs one-shot DAG:**

| Scenario                           | Pattern                              |
| ---------------------------------- | ------------------------------------ |
| 4+ files, likely needs iteration   | Interactive team                     |
| Simple edits, well-specified       | One-shot DAG with `preset: 'worker'` |
| Cross-agent review feedback loop   | Interactive team                     |
| Independent tasks, no coordination | Fan-out with non-interactive workers |

### Pipeline (sequential handoff)

```typescript
.pattern('pipeline')
.step('analyze', { agent: 'analyst', task: '...' })
.step('implement', { agent: 'dev', task: '{{steps.analyze.output}}', dependsOn: ['analyze'] })
.step('test', { agent: 'tester', task: '{{steps.implement.output}}', dependsOn: ['implement'] })
```

### Error Handling

```typescript
.onError('fail-fast')   // stop on first failure (default)
.onError('continue')    // skip failed branches, continue others
.onError('retry', { maxRetries: 3, retryDelayMs: 5000 })
```

## Multi-File Edit Pattern

When a workflow needs to modify multiple existing files, **use one agent step per file** with a deterministic verify gate after each. Agents reliably edit 1-2 files per step but fail on 4+.

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

**Key rules:**

- Read the file in a deterministic step right before the edit (not all files upfront)
- Tell the agent "Only edit this one file" to prevent it touching other files
- Verify with `git diff --quiet` after each edit — fail fast if the agent didn't write
- Always commit with a deterministic step, never an agent step

## File Materialization: Verify Before Proceeding

After any step that creates files, add a deterministic `file_exists` check before proceeding. Non-interactive agents may exit 0 without writing anything (wrong cwd, stdout instead of disk).

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

**Rules for file-writing tasks:**

1. Use full paths from project root — say `src/auth/credentials.ts`, not `credentials.ts`
2. Add `IMPORTANT: Write the file to disk. Do NOT output to stdout.`
3. Use `file_exists` verification for creation steps (not just `exit_code`)
4. Gate all downstream steps on the verify step

## DAG Deadlock Anti-Pattern

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

**Rule:** if a lead step's task mentions downstream step names alongside waiting keywords, that's a deadlock.

## Step Sizing

**One agent, one deliverable.** A step's task prompt should be 10-20 lines max.

Split into a **lead + workers team** when:

- The task requires a 50+ line prompt
- The deliverable is multiple files that must be consistent
- You need one agent to verify another's output

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
    dependsOn: [prior-step] # same dep as lead — starts concurrently
    task: |
      Join #my-track. track-lead will post your assignment.
      Implement the file as directed.
    verification:
      type: exit_code

  - name: next-step
    dependsOn: [track-lead-coord] # downstream depends on lead, not workers
```

## Supervisor Pattern

When you set `.pattern('supervisor')` (or `hub-spoke`, `fan-out`), the runner auto-assigns a supervisor agent as owner for worker steps. The supervisor monitors progress, nudges idle workers, and issues `OWNER_DECISION`.

**Auto-hardening only activates for hub patterns** — not `pipeline` or `dag`.

| Use case                  | Pattern             | Why                              |
| ------------------------- | ------------------- | -------------------------------- |
| Sequential, no monitoring | `pipeline`          | Simple, no overhead              |
| Workers need oversight    | `supervisor`        | Auto-owner monitors              |
| Local/small models        | `supervisor`        | Supervisor catches stuck workers |
| All non-interactive       | `pipeline` or `dag` | No PTY = no supervision needed   |

## Concurrency

**Cap `maxConcurrency` at 4-6.** Spawning 10+ agents simultaneously causes broker timeouts.

| Parallel agents | `maxConcurrency` |
| --------------- | ---------------- |
| 2-4             | 4 (default safe) |
| 5-10            | 5                |
| 10+             | 6-8 max          |

## Common Mistakes

| Mistake                                                                                       | Fix                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All workflows run sequentially                                                                | Group independent workflows into parallel waves (4-7x speedup)                                                                                                            |
| Every step depends on the previous one                                                        | Only add `dependsOn` when there's a real data dependency                                                                                                                  |
| Self-review step with no timeout                                                              | Set `timeout: 300_000` (5 min) — Codex hangs in non-interactive review                                                                                                    |
| One giant workflow per feature                                                                | Split into smaller workflows that can run in parallel waves                                                                                                               |
| Adding exit instructions to tasks                                                             | Runner handles self-termination automatically                                                                                                                             |
| Setting `timeoutMs` on agents/steps                                                           | Use global `.timeout()` only                                                                                                                                              |
| Using `general` channel                                                                       | Set `.channel('wf-name')` for isolation                                                                                                                                   |
| `{{steps.X.output}}` without `dependsOn: ['X']`                                               | Output won't be available yet                                                                                                                                             |
| Requiring exact sentinel as only completion gate                                              | Use `exit_code` or `file_exists` verification                                                                                                                             |
| Writing 100-line task prompts                                                                 | Split into lead + workers on a channel                                                                                                                                    |
| `maxConcurrency: 16` with many parallel steps                                                 | Cap at 5-6                                                                                                                                                                |
| Non-interactive agent reading large files via tools                                           | Pre-read in deterministic step, inject via `{{steps.X.output}}`                                                                                                           |
| Workers depending on lead step (deadlock)                                                     | Both depend on shared context step                                                                                                                                        |
| `fan-out`/`hub-spoke` for simple parallel workers                                             | Use `dag` instead                                                                                                                                                         |
| `pipeline` but expecting auto-supervisor                                                      | Only hub patterns auto-harden. Use `.pattern('supervisor')`                                                                                                               |
| Workers without `preset: 'worker'` in one-shot DAG lead+worker flows                          | Add preset for clean stdout when chaining `{{steps.X.output}}` (not needed for interactive team patterns)                                                                 |
| Using `_` in YAML numbers (`timeoutMs: 1_200_000`)                                            | YAML doesn't support `_` separators                                                                                                                                       |
| Workflow timeout under 30 min for complex workflows                                           | Use `3600000` (1 hour) as default                                                                                                                                         |
| Using `require()` in ESM projects                                                             | Check `package.json` for `"type": "module"` — use `import` if ESM                                                                                                         |
| Wrapping in `async function main()` in ESM                                                    | ESM supports top-level `await` — no wrapper needed                                                                                                                        |
| Using `createWorkflowRenderer`                                                                | Does not exist. Use `.run({ cwd: process.cwd() })`                                                                                                                        |
| `export default workflow(...)...build()`                                                      | No `.build()`. Chain ends with `.run()` — the file must call `.run()`, not just export config                                                                             |
| Relative import `'../workflows/builder.js'`                                                   | Use `import { workflow } from '@agent-relay/sdk/workflows'`                                                                                                               |
| Hardcoded model strings (`model: 'opus'`)                                                     | Use constants: `import { ClaudeModels } from '@agent-relay/config'` → `model: ClaudeModels.OPUS`                                                                          |
| Thinking `agent-relay run` inspects exports                                                   | It executes the file as a subprocess. Only `.run()` invocations trigger steps                                                                                             |
| `pattern('single')` on cloud runner                                                           | Not supported — use `dag`                                                                                                                                                 |
| `pattern('supervisor')` with one agent                                                        | Same agent is owner + specialist. Use `dag`                                                                                                                               |
| Invalid verification type (`type: 'deterministic'`)                                           | Only `exit_code`, `output_contains`, `file_exists`, `custom` are valid                                                                                                    |
| Chaining `{{steps.X.output}}` from interactive agents                                         | PTY output is garbled. Use deterministic steps or `preset: 'worker'`                                                                                                      |
| Single step editing 4+ files                                                                  | Agents modify 1-2 then exit. Split to one file per step with verify gates                                                                                                 |
| Relying on agents to `git commit`                                                             | Agents emit markers without running git. Use deterministic commit step                                                                                                    |
| File-writing steps without `file_exists` verification                                         | `exit_code` auto-passes even if no file written                                                                                                                           |
| Manual peer fanout in `handleChannelMessage()`                                                | Use broker-managed channel subscriptions — broker fans out to all subscribers automatically                                                                               |
| Client-side `personaNames.has(from)` filtering                                                | Use `relay.subscribe()`/`relay.unsubscribe()` — only subscribed agents receive messages                                                                                   |
| Agents receiving noisy cross-channel messages during focused work                             | Use `relay.mute({ agent, channel })` to silence non-primary channels without leaving them                                                                                 |
| Hardcoding all channels at spawn time                                                         | Use `agent.subscribe()` / `agent.unsubscribe()` for dynamic channel membership post-spawn                                                                                 |
| Using `preset: 'worker'` for Codex in _interactive team_ patterns when coordination is needed | Codex interactive mode works fine with PTY channel injection. Drop the preset for interactive team patterns (keep it for one-shot DAG workers where clean stdout matters) |
| Separate reviewer agent from lead in interactive team                                         | Merge lead + reviewer into one interactive Claude agent — reviews between rounds, fewer agents                                                                            |
| Not printing PR URL after `gh pr create`                                                      | Add a final deterministic step: `echo "PR: $(cat pr-url.txt)"` or capture in the `gh pr create` command                                                                   |
| Workflow ending without worktree + PR for cross-repo changes                                  | Add `setup-worktree` at start and `push-and-pr` + `cleanup-worktree` at end                                                                                               |

## YAML Alternative

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

Run with: `agent-relay run path/to/workflow.yaml`

## Available Swarm Patterns

`dag` (default), `fan-out`, `pipeline`, `hub-spoke`, `consensus`, `mesh`, `handoff`, `cascade`, `debate`, `hierarchical`, `map-reduce`, `scatter-gather`, `supervisor`, `reflection`, `red-team`, `verifier`, `auction`, `escalation`, `saga`, `circuit-breaker`, `blackboard`, `swarm`

See skill `choosing-swarm-patterns` for pattern selection guidance.
