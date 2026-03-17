---
name: writing-agent-relay-workflows
description: Use when building multi-agent workflows with the relay broker-sdk - covers the WorkflowBuilder API, DAG step dependencies, agent definitions, step output chaining via {{steps.X.output}}, verification gates, evidence-based completion, owner decisions, dedicated channels, swarm patterns, error handling, event listeners, step sizing rules, authoring best practices, and the lead+workers team pattern for complex steps
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
    task: `Analyze the codebase and produce a plan.`,
    retries: 2,
    verification: { type: 'output_contains', value: 'PLAN_COMPLETE' }, // optional accelerator
  })
  .step('implement', {
    agent: 'worker',
    task: `Implement based on this plan:\n{{steps.plan.output}}`,
    dependsOn: ['plan'],
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
  .run({ onEvent: (e) => console.log(e.type), vars: { task: 'Add auth' } });
```

## Key Concepts

### Step Output Chaining

Use `{{steps.STEP_NAME.output}}` in a downstream step's task to inject the prior step's terminal output. The runner captures PTY output automatically.

### Verification Gates

Steps can include verification checks. These are **one input** to the completion decision — not the only one. The runner uses a multi-signal pipeline: deterministic verification, owner judgment, and evidence collection.

```typescript
verification: { type: 'exit_code' }                        // preferred for code-editing steps
verification: { type: 'output_contains', value: 'DONE' }   // optional accelerator, not mandatory
verification: { type: 'file_exists', value: 'src/out.ts' } // deterministic file check
```

Types: `exit_code` (preferred for implementations), `output_contains`, `file_exists`, `custom`.

**Key principle:** Verification passing is sufficient for step completion — even if no sentinel marker is present. The runner completes steps through evidence, not ceremony.

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

### Step Completion Model

Steps complete through a **multi-signal decision pipeline**, not a single sentinel marker:

1. **Deterministic verification** (highest priority) — if `verification` passes (exit_code, file_exists, output_contains), the step completes immediately
2. **Owner decision** — the step owner (lead or step agent) can issue a structured decision: `OWNER_DECISION: COMPLETE|INCOMPLETE_RETRY|INCOMPLETE_FAIL`
3. **Evidence-based completion** — channel messages (WORKER_DONE signals), file artifacts, and process exit codes are collected as evidence
4. **Marker fast-path** — `STEP_COMPLETE:<step-name>` still works as an accelerator but is never required

**Completion states:**

| State | Meaning |
| --- | --- |
| `completed_verified` | Deterministic verification passed |
| `completed_by_owner_decision` | Owner approved the step |
| `completed_by_evidence` | Evidence-based completion (channel signals, files, exit code) |
| `retry_requested_by_owner` | Owner requested retry via OWNER_DECISION |
| `failed_verification` | Verification explicitly failed |
| `failed_owner_decision` | Owner rejected the step |
| `failed_no_evidence` | No verification, no owner decision, no evidence — hard fail |

**Review parsing is tolerant:** The runner accepts semantically equivalent outputs like "Approved", "Complete — task done", "LGTM", not just exact `REVIEW_DECISION: APPROVE` strings.

### No Per-Agent Timeouts

Avoid `timeoutMs` on agents/steps unless you have a specific reason. The global `.timeout()` is the safety net. Per-agent timeouts cause premature kills on steps that legitimately need more time.

## Agent Definition

```typescript
.agent('name', {
  cli: 'claude' | 'codex' | 'gemini' | 'aider' | 'goose' | 'opencode' | 'droid',
  role?: string,        // describes agent's purpose (used by pattern auto-selection)
  preset?: 'lead' | 'worker' | 'reviewer' | 'analyst', // sets interactive mode + task guardrails
  retries?: number,     // default retry count for steps using this agent
  model?: string,       // model override
  interactive?: boolean, // default: true. Set false for non-interactive subprocess mode
})
```

## Step Definition

### Agent Steps

```typescript
.step('name', {
  agent: string,                  // must match an .agent() name
  task: string,                   // supports {{var}} and {{steps.NAME.output}}
  dependsOn?: string[],           // DAG edges
  verification?: VerificationCheck,
  retries?: number,               // overrides agent-level retries
})
```

### Deterministic Steps (Shell Commands)

```typescript
.step('verify-files', {
  type: 'deterministic',
  command: 'test -f src/auth.ts && echo "FILE_EXISTS"',
  dependsOn: ['implement'],
  captureOutput: true,       // capture stdout for {{steps.verify-files.output}}
  failOnError: true,         // fail workflow if exit code != 0
})
```

Deterministic steps run shell commands without spawning an agent. Use them for:
- File existence checks after implementation waves
- Reading file contents to inject into downstream agent steps via `{{steps.X.output}}`
- Running build/test commands as workflow gates
- Gathering system info or context before agent steps

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
      Post assignments to the channel. Review worker output.
      When all workers are done and output is satisfactory, summarize results.
    # Lead uses OWNER_DECISION or the runner detects completion via evidence

  - name: track-worker-1-impl
    agent: track-worker-1
    dependsOn: [prior-step] # same dep as lead — starts concurrently
    task: |
      Join #my-track. track-lead will post your assignment.
      Implement the file as directed. Post a summary when complete.
    verification:
      type: exit_code  # preferred for code-editing workers

  - name: track-worker-2-impl
    agent: track-worker-2
    dependsOn: [prior-step]
    task: |
      Join #my-track. track-lead will post your assignment.
      Implement the file as directed. Post a summary when complete.
    verification:
      type: exit_code

  # Next step depends only on the lead — lead reviews workers via channel
  # evidence and issues OWNER_DECISION or STEP_COMPLETE when satisfied.
  - name: next-step
    agent: ...
    dependsOn: [track-lead-coord]
```

### Key Points

- **Lead task prompt**: who your workers are, which channel to use, what to assign, what "done" looks like. ~15 lines. Describe the work contract, not output ceremony.
- **Worker task prompt**: which channel to join, that the lead will post their assignment. ~5 lines. Workers post summaries, not mandatory sentinel strings.
- **Workers don't need the full spec in their prompt** — they get it from the lead at runtime via the channel.
- **Downstream steps depend on the lead**, not the workers — the lead reviews worker output via channel evidence and issues completion.
- **Separate channels per team** prevent cross-talk: `#harness-track`, `#review-track`, etc.
- **Channel evidence is first-class** — worker summaries, DONE signals, and file creation events posted to the channel are collected as completion evidence by the runner.

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

## Phase Count: Keep Workflows Compact

**Limit workflows to 3–4 phases.** Each phase is a sequential barrier — the next phase can't start until the previous one finishes. More phases means more serialization, more wall-clock time, and more chances for context drift between agents.

| Phases | Verdict  | Notes                                                       |
| ------ | -------- | ----------------------------------------------------------- |
| 2–3    | Ideal    | Tight feedback loops, agents see recent context              |
| 4      | Okay     | Acceptable for large projects with clear module boundaries   |
| 5+     | Too many | Agents lose context, reviews find "FILE NOT FOUND" errors    |
| 8+     | Never    | Each agent works blind — integration issues multiply         |

**Why fewer phases work better:**

- Non-interactive agents can't see each other's output. Each phase boundary is a hard wall.
- Reflection/review steps only add value if the files actually exist on disk. With many phases, early agents write files that later agents can't find (wrong cwd, wrong paths).
- Consolidating related work into one phase lets parallel workers share a lead who can coordinate and verify.

**How to consolidate:**

Instead of Phase 1 (auth) → Phase 2 (volumes) → Phase 3 (storage) → Phase 4 (executor), group by integration surface:

```yaml
# Phase 1: Foundation (auth + volumes + storage — independent modules)
# Phase 2: Orchestration (executor + bootstrap — depend on Phase 1)
# Phase 3: API + Integration (web routes + reporter + barrel exports)
```

Within each phase, use parallel workers with a shared lead for coordination.

## File Materialization: Verify Before Proceeding

**Always add a deterministic file-check step after implementation waves.** Non-interactive agents (codex, claude -p) may fail silently — the process exits 0 but files weren't written because of a wrong cwd, permission issue, or the agent output code to stdout instead of writing files.

### The pattern

```yaml
# Workers write files in parallel
- name: impl-auth
  agent: worker-1
  task: |
    Create the file src/auth/credentials.ts with the following implementation...
    IMPORTANT: Write the file to disk using your file-writing tools.
    Do NOT just output the code to stdout — the file must exist at src/auth/credentials.ts when you finish.

- name: impl-storage
  agent: worker-2
  task: |
    Create the file src/storage/client.ts with the following implementation...
    IMPORTANT: Write the file to disk. The file must exist at src/storage/client.ts when you finish.

# Deterministic gate: verify all expected files exist before any review/next-phase step
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
  captureOutput: true

# Reviews and next-phase steps depend on verify-files, not directly on workers
- name: review
  agent: reviewer
  dependsOn: [verify-files]
  task: ...
```

### Rules for non-interactive file-writing tasks

1. **Use absolute or explicit relative paths** — always include the full path from the project root in the task prompt. Don't say "implement credentials.ts", say "create the file at `src/auth/credentials.ts`".
2. **Tell the agent to write the file, not output it** — add `IMPORTANT: Write the file to disk using your file-writing tools. Do NOT just output the code to stdout.` Non-interactive agents sometimes default to printing code instead of writing files.
3. **Gate downstream steps on file verification** — never let a review or next-phase step run without first confirming the expected files exist via a deterministic `[ -f ]` check.
4. **Fail fast on missing files** — set `failOnError: true` on the verification step. A missing file early is much cheaper to debug than 30 minutes of "FILE NOT FOUND" reviews.

### Reading files for context injection

When the next phase needs to read files produced by the current phase, use a deterministic step:

```yaml
- name: read-phase1-output
  type: deterministic
  dependsOn: [verify-phase1-files]
  command: |
    echo "=== src/auth/credentials.ts ==="
    cat src/auth/credentials.ts
    echo "=== src/storage/client.ts ==="
    cat src/storage/client.ts
  captureOutput: true

- name: phase2-implement
  agent: worker
  dependsOn: [read-phase1-output]
  task: |
    Here are the files from Phase 1:
    {{steps.read-phase1-output.output}}

    Now implement the executor that uses these modules...
```

## Completion Signals: Required vs Optional

The runner uses a multi-tier completion resolution system. **No single signal is mandatory** — the runner resolves completion from whatever evidence is available.

### Tier 1: Explicit owner decision (strongest)

```
OWNER_DECISION: COMPLETE
REASON: All files written and tests pass
```

The structured `OWNER_DECISION` format is preferred for owner/lead agents. It gives the runner an unambiguous completion signal.

### Tier 2: Legacy completion marker

```
STEP_COMPLETE:step-name
```

Still supported but optional. The runner treats it as equivalent to `OWNER_DECISION: COMPLETE`.

### Tier 3: Verification gate

If `verification` is configured on the step, the runner checks it automatically. A passing verification gate completes the step even without an explicit owner decision.

### Tier 4: Evidence-based completion

When no explicit signal is found, the runner checks collected evidence:
- Coordination signals in output (`WORKER_DONE`, `LEAD_DONE`)
- Process exit code 0 (clean exit)
- Tool side-effects (git diff checks, file inspections)
- Positive-conclusion language in owner output

If both a positive conclusion **and** at least one evidence signal are present, the step completes.

### Tier 5: Process-exit fallback

When the agent exits with code 0 but posts **no** coordination signal at all:
- The runner waits a configurable grace period (`completionGracePeriodMs`, default 5s)
- If verification is configured and passes, the step completes with reason `completed_by_process_exit`
- If no verification is configured, the step completes based on the clean exit alone

This tier is the key mechanism for reducing dependence on exact agent behavior.

### What this means for workflow authors

- **Don't require exact text output** as the only completion signal. Always configure a verification gate (`exit_code`, `file_exists`, or `output_contains`) as a backup.
- **Describe the deliverable, not the ceremony.** Say "implement the auth module" not "implement the auth module and then output IMPL_DONE".
- **Prefer `exit_code` verification** for code-editing workers — it's the most reliable signal because it doesn't depend on the agent printing specific text.
- **Use `completionGracePeriodMs: 0`** in the swarm config to disable the process-exit fallback if you need strict signal compliance.

### Configuring the grace period

```yaml
swarm:
  pattern: dag
  completionGracePeriodMs: 5000  # default: 5s. Set to 0 to disable.
```

## Robust Coordination Best Practices

### Design for agent non-compliance

Agents may not follow instructions perfectly. The runner is designed to handle this gracefully:

1. **Always configure verification gates** — they're the most reliable completion mechanism because they don't depend on agent behavior at all.
2. **Use deterministic steps for critical checks** — `file_exists` checks, test runs, and type checks are deterministic and infallible.
3. **Don't rely on agents posting exact signal text** — use `exit_code` verification instead of `output_contains` when possible.
4. **Let the runner handle self-termination** — it appends `/exit` instructions automatically and detects idle agents.

### Completion strategy by step type

| Step type | Recommended verification | Why |
|---|---|---|
| Code editing (codex worker) | `exit_code` | Agent may not print tokens reliably |
| Analysis/review (claude) | `output_contains` with unique token | Structured output is the deliverable |
| File creation (any worker) | `file_exists` | Deterministic check, zero agent dependency |
| Lead coordination | None (owner decision or evidence) | Lead agents are interactive and monitored |

### Owner steps: structured decisions preferred

For supervised steps with a dedicated owner, the `OWNER_DECISION` format is preferred over legacy `STEP_COMPLETE:` markers because:
- It supports negative outcomes (`INCOMPLETE_RETRY`, `INCOMPLETE_FAIL`) not just success
- It includes a `REASON` field for observability
- The runner can distinguish owner intent from echoed prompt text more reliably

But if the owner doesn't post either format, the runner still resolves completion from evidence.

## Common Mistakes

| Mistake                                                     | Fix                                                               |
| ----------------------------------------------------------- | ----------------------------------------------------------------- |
| Adding `withExit()` or exit instructions to tasks           | Runner handles this automatically                                 |
| Setting tight `timeoutMs` on agents                         | Use global `.timeout()` only                                      |
| Using `general` channel                                     | Set `.channel('wf-name')` for isolation                           |
| Referencing `{{steps.X.output}}` without `dependsOn: ['X']` | Output won't be available yet                                     |
| Making review steps serial when they could be parallel      | Both reviewers can depend on the same upstream step               |
| Requiring exact sentinel strings as the only completion gate | Use deterministic verification (`exit_code`, `file_exists`) or owner judgment |
| Writing 100-line task prompts                               | Split into lead + workers communicating on a channel              |
| Putting the full spec in every worker's task                | Lead posts the spec to the channel at runtime                     |
| `maxConcurrency: 16` with many parallel steps               | Cap at 5–6; broker times out spawning 10+ agents at once          |
| Asking non-interactive agent to read a large file via tools | Pre-read in a deterministic step, inject via `{{steps.X.output}}` |
| Workers depending on the lead step (deadlock)               | Workers and lead both depend on a shared context step             |
| Omitting `agents` field for deterministic-only workflows    | Field is now optional — pure shell pipelines work without it      |
| Designing prompts around output ceremony instead of work    | Describe the deliverable and acceptance criteria, not what to print |
| Treating markers as mandatory truth                          | Markers are optional accelerators; verification and evidence decide completion |
| Using `fan-out`/`hub-spoke` for simple parallel workers     | Use `dag` — hub patterns trigger auto owner/supervisor/reviewer pipeline |
| Workers without `preset: 'worker'` in lead+worker workflows | Add `preset: 'worker'` — it auto-sets `interactive: false` and produces clean stdout for `{{steps.X.output}}` injection |
| Lead running concurrently with workers, monitoring channel  | Make lead `dependsOn` workers — use `{{steps.X.output}}` injection instead of real-time channel monitoring |
| Using `_` in YAML numbers (e.g., `timeoutMs: 1_200_000`)   | YAML doesn't support `_` as a numeric separator — use `1200000`. TypeScript separators don't work in YAML |
| Setting workflow timeout under 30 minutes for complex workflows | Claude leads reading large codebases take 5-15 min per step. Use `3600000` (1 hour) as a safe default |
| Passing too much context in `read-context` deterministic steps | Trim to only the relevant code. Use `grep`, `sed -n`, `head` instead of full `cat`. Large context slows lead design |

## Verification Tokens with Non-Interactive Workers

### The double-occurrence rule

When the verification token appears in the task text, the runner requires it to appear
**twice** in the captured output — once from the task injection echo, once from the agent's
actual response. A single occurrence is treated as the task echo and fails verification.

This means if your task says `Output: DONE` or `REQUIRED: print DONE`, the token `DONE`
is in the task text. The agent must print it a second time, explicitly.

### Preferred: use `exit_code` for code-editing workers

For steps where the real quality gate is downstream (type-check, tests), `exit_code`
verification is simpler and more reliable than `output_contains`:

```yaml
# WRONG for codex code editors — token in task causes double-occurrence requirement
- name: implement
  agent: implementer  # codex, preset: worker
  task: |
    Make these changes to foo.ts...
    Output: IMPL_DONE        # token now in task text → requires 2 occurrences
  verification:
    type: output_contains
    value: IMPL_DONE

# RIGHT — exit 0 means success; tests catch any mistakes
- name: implement
  agent: implementer
  task: |
    Make these changes to foo.ts...
  verification:
    type: exit_code
```

### When you need `output_contains` with a codex worker

Use a token that does **not** appear verbatim anywhere in the task text. A unique sentinel
works well:

```yaml
task: |
  Analyze foo.ts and write a summary report.
  Signal completion by printing: ANALYSIS_DONE
verification:
  type: output_contains
  value: ANALYSIS_DONE   # "ANALYSIS_DONE" does not appear verbatim above → single occurrence is enough
```

If the token must appear in the instructions, instruct the agent to run it as a shell
command so the execution (not the description) produces the second occurrence:

```yaml
task: |
  Make changes to foo.ts...
  When done, run: echo "IMPL_DONE"
verification:
  type: output_contains
  value: IMPL_DONE
```

**Rule of thumb:** Code-editing steps → `exit_code`. Analysis/review steps that produce
structured output → `output_contains` with a token not mentioned verbatim in the task.

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
        task: 'Produce a detailed implementation plan.'
        # No sentinel required — owner judgment + evidence complete the step
      - name: implement
        agent: worker
        task: 'Implement: {{steps.plan.output}}'
        dependsOn: [plan]
        verification:
          type: exit_code  # deterministic: exit 0 = success
```

Run with: `agent-relay run path/to/workflow.yaml`

## Workflow Authoring Rules

Follow these principles when designing workflow step prompts:

### 1. Prefer verification over sentinel-only prompts

Use deterministic checks (`exit_code`, `file_exists`) as the primary completion signal. Don't rely solely on agents printing magic strings.

```yaml
# GOOD — deterministic verification
verification:
  type: exit_code  # or file_exists: src/auth.ts

# OKAY — sentinel as optional accelerator alongside verification
verification:
  type: output_contains
  value: PLAN_COMPLETE

# BAD — no verification, relying only on agent printing a string
task: "Do X. You MUST print STEP_COMPLETE when done."
```

### 2. Use owners/reviewers to interpret ambiguous outputs

The step owner (lead or step agent) can approve or reject a step via `OWNER_DECISION`. This is useful when automated verification isn't sufficient — the owner reads evidence and makes a judgment call.

```yaml
# Owner reviews worker output and decides
task: |
  Review worker output on #my-track.
  If satisfactory, approve. If not, request retry.
  # Runner accepts: OWNER_DECISION: COMPLETE, or tolerant variants like "Approved", "LGTM"
```

### 3. For channel workflows, define required channel events explicitly

When coordination happens via channel messages, tell agents what to post and what the lead should observe:

```yaml
# Worker prompt — describe what to communicate
task: |
  Implement auth module. Post a summary of changes to #my-track when done.

# Lead prompt — describe what to observe
task: |
  Monitor #my-track for worker summaries. When all workers have posted summaries,
  review the changes and approve the step.
```

### 4. Treat exact completion strings as optional accelerators only

`STEP_COMPLETE:<name>` and `REVIEW_DECISION: APPROVE` still work as fast-paths but are never required. The runner's completion pipeline will find evidence even without them.

### 5. Ensure prompts describe work contract, not output ceremony

**Bad:** "You MUST end your response with exactly: IMPLEMENTATION_DONE"
**Good:** "Implement the auth module. Write the file to src/auth.ts. The step is complete when the file exists and compiles."

The prompt should describe what the agent should deliver, not what it should print.

## Available Swarm Patterns

`dag` (default), `fan-out`, `pipeline`, `hub-spoke`, `consensus`, `mesh`, `handoff`, `cascade`, `debate`, `hierarchical`, `map-reduce`, `scatter-gather`, `supervisor`, `reflection`, `red-team`, `verifier`, `auction`, `escalation`, `saga`, `circuit-breaker`, `blackboard`, `swarm`

See skill `choosing-swarm-patterns` for pattern selection guidance.
