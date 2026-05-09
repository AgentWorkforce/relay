---
name: writing-agent-relay-workflows
description: Use when building multi-agent workflows with the relay broker-sdk - covers conversation-shape vs pipeline-shape coordination, the WorkflowBuilder API, DAG step dependencies, agent definitions, step output chaining via {{steps.X.output}}, verification gates, evidence-based completion, owner decisions, dedicated channels, dynamic channel management (subscribe/unsubscribe/mute/unmute), swarm patterns, chat-native coordination recipes (Q/A, broadcast-ack, peer review, standup, hand-off), error handling, event listeners, step sizing rules, authoring best practices, and the lead+workers team pattern for complex steps
---

### Overview

The relay broker-sdk workflow system orchestrates multiple AI agents (Claude, Codex, Gemini, Aider, Goose) through typed DAG-based workflows. Workflows can be written in **TypeScript** (preferred), **Python**, or **YAML**.

**Language preference:** TypeScript > Python > YAML. Use TypeScript unless the project is Python-only or a simple config-driven workflow suits YAML.

**Pattern selection:** Do not default to `dag` blindly. If the job needs a different swarm/workflow type, consult the `choosing-swarm-patterns` skill when available and select the pattern that best matches the coordination problem.

### When to Use

- Building multi-agent workflows with step dependencies
- Orchestrating different AI CLIs (claude, codex, gemini, aider, goose)
- Creating DAG, pipeline, fan-out, or other swarm patterns
- Needing verification gates, retries, or step output chaining
- Dynamic channel management: agents joining/leaving/muting channels mid-workflow

### Choose Your Coordination Style — Conversation vs Pipeline

Before writing the workflow, decide _how the agents will coordinate_. The relay primitive supports two very different shapes, and picking the wrong one wastes the most valuable thing the SDK gives you.

| Shape                          | What it is                                                                                                                                                                                                           | Use when                                                                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------- |
| **Conversation** (chat-native) | Interactive agents share a channel; messages, `@-mentions`, and ambient awareness drive coordination. Lead and workers spawn in parallel and self-organize. The relay is the coordination layer, not just transport. | Multi-file work, peer review loops, cross-agent feedback, dynamic re-planning, multi-PR coordination, anything with a human-in-the-loop escape, swarms where workers pick up each other's output. |
| **Pipeline** (one-shot DAG)    | Each step runs as a one-shot subprocess (`claude -p`, `codex exec`); steps hand off via `{{steps.X.output}}` text injection. No agents are alive at the same time; no chat happens.                                  | Linear, well-specified transformations; deterministic data passing; no review loop expected; the work could be expressed as a `bash                                                               | bash | bash` pipe. |

**Default to Conversation for any non-trivial work.** Pipeline DAGs are simpler to reason about but they do not exercise the relay primitive — they are a Unix pipe with extra steps. If you would happily write the same task as a single shell pipeline, pipeline-shape is fine. Otherwise, you almost certainly want a Conversation shape.

The two shapes can mix within one workflow: pipeline-style deterministic preflight → conversation in the middle → pipeline-style commit-and-PR at the end. See **Quick Reference (Conversation)** below and **[Common Patterns → Interactive Team](#interactive-team-lead--workers-on-shared-channel)** for the canonical recipe.

> **A blunt rule of thumb:** if your workflow only uses `agent` steps with `preset: 'worker'` chained by `{{steps.X.output}}`, you are not using the relay — you are using `claude -p | codex exec`. That may still be the right answer; just make it a deliberate choice.

### Quick Reference (Pipeline shape)

#### > Use this when steps are linear, well-specified, and need no agent-to-agent feedback. For anything with iteration, review, or coordination, jump to **Quick Reference (Conversation shape)** below.

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

### Quick Reference (Conversation shape)

#### > Use this for any non-trivial work — peer review, multi-file edits, cross-agent feedback, dynamic re-planning. Lead and workers spawn **in parallel** on a shared channel and self-organize via messages. The relay primitive does the coordinating; verification gates downstream of the lead close the workflow.

```typescript
import { workflow } from '@agent-relay/sdk/workflows';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

const result = await workflow('my-workflow')
  .description('Multi-file change with peer review')
  .pattern('dag')
  .channel('wf-my-feature') // dedicated channel — agents share it
  .maxConcurrency(4)
  .timeout(3_600_000)

  // Interactive agents — no preset, they live on the channel
  .agent('lead', {
    cli: 'claude',
    model: ClaudeModels.OPUS,
    role: 'Architect + reviewer. Plans, assigns, reviews, posts feedback.',
    retries: 1,
  })
  .agent('impl-a', {
    cli: 'codex',
    model: CodexModels.GPT_5_4,
    role: 'Implementer. Listens on channel for assignments and feedback.',
    retries: 2,
  })
  .agent('impl-b', {
    cli: 'codex',
    model: CodexModels.GPT_5_4,
    role: 'Implementer. Listens on channel for assignments and feedback.',
    retries: 2,
  })

  // Deterministic context — pre-reads files once, posts to the channel for everyone
  .step('context', {
    type: 'deterministic',
    command: 'git ls-files src/',
    captureOutput: true,
  })

  // Lead and workers all depend on `context` — they start CONCURRENTLY.
  // They coordinate over #wf-my-feature, not via {{steps.X.output}}.
  .step('lead-coordinate', {
    agent: 'lead',
    dependsOn: ['context'],
    task: `You are the lead on #wf-my-feature. Workers: impl-a, impl-b.
Post the plan. Assign files. Review their PRs/diffs. Post feedback in-channel.
Workers iterate based on your feedback. Exit when both files pass review.`,
  })
  .step('impl-a-work', {
    agent: 'impl-a',
    dependsOn: ['context'], // SAME dep as lead → starts in parallel, no deadlock
    task: `You are impl-a on #wf-my-feature. Wait for the lead's plan.
Implement your assigned file. Post a completion message. Address feedback.`,
  })
  .step('impl-b-work', {
    agent: 'impl-b',
    dependsOn: ['context'], // SAME dep as lead
    task: `You are impl-b on #wf-my-feature. Wait for the lead's plan.
Implement your assigned file. Post a completion message. Address feedback.`,
  })

  // Downstream gates on the lead — lead exits when satisfied.
  .step('verify', {
    type: 'deterministic',
    dependsOn: ['lead-coordinate'],
    command: 'npm run typecheck && npm test',
    failOnError: true,
  })

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
  .run({ cwd: process.cwd() });
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
  .packages(['web', 'core']) // monorepo packages touched
  .isolatedFrom(['49-feedback-system']) // explicitly safe to parallelize
  .requiresBefore(['46-admin-dashboard']); // explicit ordering constraint
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

### Failure Prevention

#### 1. Do not use raw top-level `await`

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

#### 2b. Standard preflight template for resumable workflows

```ts
.step('preflight', {
  type: 'deterministic',
  command: [
    'set -e',
    'BRANCH=$(git rev-parse --abbrev-ref HEAD)',
    'echo "branch: $BRANCH"',
    'if [ "$BRANCH" != "fix/your-branch-name" ]; then echo "ERROR: wrong branch"; exit 1; fi',
    // Files the workflow is allowed to find dirty on entry:
    //   - package-lock.json: npm install is idempotent and often touches it
    //   - every file the workflow's edit steps will rewrite: a prior partial
    //     run may have left them dirty, and the edit step will rewrite
    //     them cleanly before commit
    // Everything else is unexpected drift and must fail preflight.
    'ALLOWED_DIRTY="package-lock.json|path/to/file1\\\\.ts|path/to/file2\\\\.ts"',
    'DIRTY=$(git diff --name-only | grep -vE "^(${ALLOWED_DIRTY})$" || true)',
    'if [ -n "$DIRTY" ]; then echo "ERROR: unexpected tracked drift:"; echo "$DIRTY"; exit 1; fi',
    'if ! git diff --cached --quiet; then echo "ERROR: staging area is dirty"; git diff --cached --stat; exit 1; fi',
    'gh auth status >/dev/null 2>&1 || (echo "ERROR: gh CLI not authenticated"; exit 1)',
    'echo PREFLIGHT_OK',
  ].join(' && '),
  captureOutput: true,
  failOnError: true,
}),
```

#### 2c. Picking the right `.join()` for multi-line shell commands

```ts
command: [
  'set -e',
  'HITS=$(grep -c diag src/cli/commands/setup.ts || true)',
  'if [ "$HITS" -lt 6 ]; then echo "FAIL"; exit 1; fi',
  'echo OK',
].join(' && '),
```

#### 3. Keep final verification boring and deterministic

```bash
grep -Eq "foo|bar|baz" file.ts
```

#### 6. Be explicit about shell requirements

```bash
/opt/homebrew/bin/bash workflows/your-workflow/execute.sh --wave 2
```

#### 9. Factor repo-specific setup into a shared helper

```ts
// workflows/lib/cloud-repo-setup.ts
export interface CloudRepoSetupOptions {
  branch: string;
  committerName?: string;
  extraSetupCommands?: string[];
  skipWorkspaceBuild?: boolean;
}

export function applyCloudRepoSetup<T>(wf: T, opts: CloudRepoSetupOptions): T {
  // adds two steps: setup-branch, install-deps
  // install-deps runs: npm install + workspace prebuilds (build:platform, build:core, etc.)
  // ...
}
```

### End-to-End Bug Fix Workflows

- **Capture the original failure**
- Reproduce the bug first in a deterministic or evidence-capturing step
- Save exact commands, logs, status codes, or screenshots/artifacts
- **State the acceptance contract**
- Define the exact end-to-end success criteria before implementation
- Include the real entrypoint a user would run
- **Implement the fix**
- **Rebuild / reinstall from scratch**
- Do not trust dirty local state
- Prefer a clean environment when install/bootstrap behavior is involved
- **Run targeted regression checks**
- Unit/integration tests are helpful but not sufficient by themselves
- **Run a full end-to-end validation**
- Use the real CLI / API / install path
- Prefer a clean environment (Docker, sandbox, cloud workspace, Daytona, etc.) for install/runtime issues
- **Compare before vs after evidence**
- Show that the original failure no longer occurs
- **Record residual risks**
- Call out what was not covered
- **Ship the result as a PR**
- Open the pull request from the workflow itself with `createGitHubStep`
- See [Shipping the Result — Open a PR via `createGitHubStep`](#shipping-the-result--open-a-pr-via-creategithubstep) below
- A workflow that fixes a bug and stops short of the PR has only done half the loop
- disposable sandbox / cloud workspace
- Docker / containerized environment
- fresh local shell with isolated paths
- compares candidate validation environments
- defines the acceptance contract
- chooses the best swarm pattern
- then authors the final fix/validation workflow

### Shipping the Result — Open a PR via `createGitHubStep`

#### The minimal "open a PR" recipe

```typescript
import { workflow } from '@agent-relay/sdk/workflows';
import { createGitHubStep } from '@agent-relay/sdk/github';

const REPO = 'AgentWorkforce/cloud';
const BRANCH = `agent-relay/run-${Date.now()}`;

await workflow('feature-x')
  // ... your real steps that produce code changes ...
  .step('write-marker', {
    type: 'deterministic',
    command: `echo "fix landed at $(date -u)" >> CHANGELOG.md`,
  })

  // Branch off main on the remote.
  .step(
    'create-branch',
    createGitHubStep({
      dependsOn: ['write-marker'],
      action: 'createBranch',
      repo: REPO,
      params: { branch: BRANCH, source: 'main' },
    })
  )

  // Commit the change to the branch via Contents API.
  .step(
    'commit-change',
    createGitHubStep({
      dependsOn: ['create-branch'],
      action: 'createFile',
      repo: REPO,
      params: {
        path: 'CHANGELOG.md',
        branch: BRANCH,
        content: '<file body here>',
        message: 'chore: changelog entry',
      },
    })
  )

  // Open the PR. This is the load-bearing step.
  .step(
    'open-pr',
    createGitHubStep({
      dependsOn: ['commit-change'],
      action: 'createPR',
      repo: REPO,
      params: {
        title: 'feat: ship feature X',
        head: BRANCH,
        base: 'main',
        body: '## Summary\n\n- ...\n\n## Test plan\n\n- [x] ...',
        draft: false,
      },
      output: { mode: 'data', format: 'json', path: 'html_url' },
    })
  )

  .run({ cwd: process.cwd() });
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

#### Model Constants

```typescript
import { ClaudeModels, CodexModels, GeminiModels } from '@agent-relay/config';

.agent('planner', { cli: 'claude', model: ClaudeModels.OPUS })    // not 'opus'
.agent('worker',  { cli: 'claude', model: ClaudeModels.SONNET })  // not 'sonnet'
.agent('coder',   { cli: 'codex',  model: CodexModels.GPT_5_4 })  // not 'gpt-5.4'
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

#### Interactive Team (lead + workers on shared channel)

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

#### 1. Question / Answer (blocking ask)

```typescript
.step('integrate', {
  agent: 'integrator',
  dependsOn: ['context'],
  task: `You are the integrator on #wf-feature.
Before writing code, post a direct question to @schema-owner asking which
table owns the new field. Do NOT proceed until @schema-owner replies in
channel. If no reply arrives in 5 minutes, @-mention the lead.`,
})
```

#### 2. Broadcast / Ack

```typescript
.step('lead-coordinate', {
  agent: 'lead',
  dependsOn: ['context'],
  task: `Post the plan to #wf-feature, then @impl-a @impl-b @impl-c.
Wait for each to reply with "ACK <agent-name>" before issuing assignments.
If any worker hasn't acked in 3 minutes, re-post and ping again.
Only after all three have acked, post per-worker assignments.`,
})
```

#### 3. Peer Review Handoff

```typescript
.step('impl-a-work', {
  agent: 'impl-a',
  dependsOn: ['context'],
  task: `Implement src/foo.ts per the lead's assignment.
When done, post to #wf-feature: "@reviewer ready: src/foo.ts" — include the
commit SHA. Then wait for @reviewer's verdict in channel.
- If "APPROVED", you're done.
- If "CHANGES_REQUESTED <notes>", apply the notes and re-post.
- If no verdict in 5 min, @-mention the lead.`,
})
```

#### 4. Standup / Status Probe

```typescript
.step('lead-coordinate', {
  agent: 'lead',
  task: `... coordinate the team ...

Every 10 minutes, post a status probe: "@impl-a @impl-b status?"
Each worker should reply with one of:
  - "RUNNING <step>" (still working)
  - "BLOCKED <reason>" (@-mention the lead with the blocker)
  - "DONE <artifact>" (ready for review)

If a worker is silent for two probes in a row, mark them stalled and
reassign their work to a peer.`,
})
```

#### 5. Hand-Off with Context

```typescript
.step('impl-a-work', {
  agent: 'impl-a',
  task: `... finish your part ...

When done, post a handoff to #wf-feature targeting the next worker:
"@impl-b HANDOFF: src/foo.ts ready. Touched: <files>. Open question: <if any>.
Tests: <pass/fail summary>. Commit: <sha>."`,
})
```

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
    dependsOn: [prior-step] # same dep as lead — starts concurrently
    task: |
      Join #my-track. track-lead will post your assignment.
      Implement the file as directed.
    verification:
      type: exit_code

  - name: next-step
    dependsOn: [track-lead-coord] # downstream depends on lead, not workers
```

### Supervisor Pattern

When you set `.pattern('supervisor')` (or `hub-spoke`, `fan-out`), the runner auto-assigns a supervisor agent as owner for worker steps. The supervisor monitors progress, nudges idle workers, and issues `OWNER_DECISION`.

**Auto-hardening only activates for hub patterns** — not `pipeline` or `dag`.

| Use case                  | Pattern             | Why                              |
| ------------------------- | ------------------- | -------------------------------- |
| Sequential, no monitoring | `pipeline`          | Simple, no overhead              |
| Workers need oversight    | `supervisor`        | Auto-owner monitors              |
| Local/small models        | `supervisor`        | Supervisor catches stuck workers |
| All non-interactive       | `pipeline` or `dag` | No PTY = no supervision needed   |

### Concurrency

**Cap `maxConcurrency` at 4-6.** Spawning 10+ agents simultaneously causes broker timeouts.

| Parallel agents | `maxConcurrency` |
| --------------- | ---------------- |
| 2-4             | 4 (default safe) |
| 5-10            | 5                |
| 10+             | 6-8 max          |

### Common Mistakes

| Mistake                                                                                                                            | Fix                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------- |
| Treating relay as transport, not as a coordination layer (every step is `preset: 'worker'`, every handoff is `{{steps.X.output}}`) | Default to **Conversation shape** for non-trivial work — interactive agents on a shared channel. Pipeline-shape is only correct when the work could be expressed as a `bash                                                       | bash | bash` pipe. |
| Interactive agents on a channel whose task strings don't tell them to talk to each other                                           | Pick a [Chat-Native Coordination Recipe](#chat-native-coordination-recipes) (Q/A, Broadcast/Ack, Peer Review, Standup, Hand-Off) and bake it into the task prompt — otherwise you're paying for a chat substrate you're not using |
| All workflows run sequentially                                                                                                     | Group independent workflows into parallel waves (4-7x speedup)                                                                                                                                                                    |
| Every step depends on the previous one                                                                                             | Only add `dependsOn` when there's a real data dependency                                                                                                                                                                          |
| Self-review step with no timeout                                                                                                   | Set `timeout: 300_000` (5 min) — Codex hangs in non-interactive review                                                                                                                                                            |
| One giant workflow per feature                                                                                                     | Split into smaller workflows that can run in parallel waves                                                                                                                                                                       |
| Adding exit instructions to tasks                                                                                                  | Runner handles self-termination automatically                                                                                                                                                                                     |
| Setting `timeoutMs` on agents/steps                                                                                                | Use global `.timeout()` only                                                                                                                                                                                                      |
| Using `general` channel                                                                                                            | Set `.channel('wf-name')` for isolation                                                                                                                                                                                           |
| `{{steps.X.output}}` without `dependsOn: ['X']`                                                                                    | Output won't be available yet                                                                                                                                                                                                     |
| Requiring exact sentinel as only completion gate                                                                                   | Use `exit_code` or `file_exists` verification                                                                                                                                                                                     |
| Writing 100-line task prompts                                                                                                      | Split into lead + workers on a channel                                                                                                                                                                                            |
| `maxConcurrency: 16` with many parallel steps                                                                                      | Cap at 5-6                                                                                                                                                                                                                        |
| Non-interactive agent reading large files via tools                                                                                | Pre-read in deterministic step, inject via `{{steps.X.output}}`                                                                                                                                                                   |
| Workers depending on lead step (deadlock)                                                                                          | Both depend on shared context step                                                                                                                                                                                                |
| `fan-out`/`hub-spoke` for simple parallel workers                                                                                  | Use `dag` instead                                                                                                                                                                                                                 |
| `pipeline` but expecting auto-supervisor                                                                                           | Only hub patterns auto-harden. Use `.pattern('supervisor')`                                                                                                                                                                       |
| Workers without `preset: 'worker'` in one-shot DAG lead+worker flows                                                               | Add preset for clean stdout when chaining `{{steps.X.output}}` (not needed for interactive team patterns)                                                                                                                         |
| Using `_` in YAML numbers (`timeoutMs: 1_200_000`)                                                                                 | YAML doesn't support `_` separators                                                                                                                                                                                               |
| Workflow timeout under 30 min for complex workflows                                                                                | Use `3600000` (1 hour) as default                                                                                                                                                                                                 |
| Using `require()` in ESM projects                                                                                                  | Check `package.json` for `"type": "module"` — use `import` if ESM                                                                                                                                                                 |
| Wrapping in `async function main()` in ESM                                                                                         | ESM supports top-level `await` — no wrapper needed                                                                                                                                                                                |
| Using `createWorkflowRenderer`                                                                                                     | Does not exist. Use `.run({ cwd: process.cwd() })`                                                                                                                                                                                |
| `export default workflow(...)...build()`                                                                                           | No `.build()`. Chain ends with `.run()` — the file must call `.run()`, not just export config                                                                                                                                     |
| Relative import `'../workflows/builder.js'`                                                                                        | Use `import { workflow } from '@agent-relay/sdk/workflows'`                                                                                                                                                                       |
| Hardcoded model strings (`model: 'opus'`)                                                                                          | Use constants: `import { ClaudeModels } from '@agent-relay/config'` → `model: ClaudeModels.OPUS`                                                                                                                                  |
| Thinking `agent-relay run` inspects exports                                                                                        | It executes the file as a subprocess. Only `.run()` invocations trigger steps                                                                                                                                                     |
| `pattern('single')` on cloud runner                                                                                                | Not supported — use `dag`                                                                                                                                                                                                         |
| `pattern('supervisor')` with one agent                                                                                             | Same agent is owner + specialist. Use `dag`                                                                                                                                                                                       |
| Invalid verification type (`type: 'deterministic'`)                                                                                | Only `exit_code`, `output_contains`, `file_exists`, `custom` are valid                                                                                                                                                            |
| Chaining `{{steps.X.output}}` from interactive agents                                                                              | PTY output is garbled. Use deterministic steps or `preset: 'worker'`                                                                                                                                                              |
| Single step editing 4+ files                                                                                                       | Agents modify 1-2 then exit. Split to one file per step with verify gates                                                                                                                                                         |
| Relying on agents to `git commit`                                                                                                  | Agents emit markers without running git. Use deterministic commit step                                                                                                                                                            |
| File-writing steps without `file_exists` verification                                                                              | `exit_code` auto-passes even if no file written                                                                                                                                                                                   |
| Manual peer fanout in `handleChannelMessage()`                                                                                     | Use broker-managed channel subscriptions — broker fans out to all subscribers automatically                                                                                                                                       |
| Client-side `personaNames.has(from)` filtering                                                                                     | Use `relay.subscribe()`/`relay.unsubscribe()` — only subscribed agents receive messages                                                                                                                                           |
| Agents receiving noisy cross-channel messages during focused work                                                                  | Use `relay.mute({ agent, channel })` to silence non-primary channels without leaving them                                                                                                                                         |
| Hardcoding all channels at spawn time                                                                                              | Use `agent.subscribe()` / `agent.unsubscribe()` for dynamic channel membership post-spawn                                                                                                                                         |
| Using `preset: 'worker'` for Codex in _interactive team_ patterns when coordination is needed                                      | Codex interactive mode works fine with PTY channel injection. Drop the preset for interactive team patterns (keep it for one-shot DAG workers where clean stdout matters)                                                         |
| Separate reviewer agent from lead in interactive team                                                                              | Merge lead + reviewer into one interactive Claude agent — reviews between rounds, fewer agents                                                                                                                                    |
| Not printing PR URL after `createGitHubStep({ action: 'createPR' })`                                                               | Capture `html_url` with `output: { mode: 'data', format: 'json', path: 'html_url' }` and echo or write it in a final deterministic step                                                                                           |
| Workflow ending without worktree + PR for cross-repo changes                                                                       | Add `setup-worktree` at start and `push-and-pr` + `cleanup-worktree` at end                                                                                                                                                       |

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
