---
name: writing-agent-relay-workflows
description: Use when building multi-agent workflows with relay broker-sdk. Covers conversation vs pipeline coordination, WorkflowBuilder/DAG steps, agents, {{steps.X.output}} chaining, repairable verification gates, evidence-based completion, mandatory Claude-then-Codex fresh-eyes review/fix loops with test hardening, channels, chat-native recipes, error handling, event listeners, step sizing, lead+workers teams, and parallel waves.
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
- Designing product-contract workflows where failing checks should route to agents for repair instead of stopping the run
- Dynamic channel management: agents joining/leaving/muting channels mid-workflow

## Non-Negotiable Workflow Checklist

Every generated workflow should satisfy this checklist before it is considered complete:

1. Start with a deterministic, resumable preflight for repository state, credentials, and declared write scope.
2. Pick the coordination shape deliberately: Conversation for non-trivial coordination, Pipeline only for linear one-shot handoffs.
3. Use repairable validation gates: capture red output with `failOnError: false`, hand it to a repair owner, then rerun the same check.
4. Run the mandatory fresh-eyes loops in order: Claude review/fix/final review/final fix, then Codex review/fix/final review/final fix.
5. Require review fixers to add or update appropriate tests, fixtures, assertions, or deterministic proofs for testable findings.
6. Run final deterministic acceptance after the Codex loop and before commit, PR creation, or handoff.
7. If a real blocker remains, write `BLOCKED_NO_COMMIT` with exact evidence and skip commit/PR creation instead of crashing the workflow.
8. If the workflow owns shipping, model branch, commit, push, PR creation, and PR URL verification as explicit deterministic steps.

## Default Principle: Workflows Repair Before They Fail

The point of an agent team workflow is not to discover a red gate and stop. The point is to capture the failure, route it to the right agent, fix it, and continue toward a shippable result. Author non-trivial workflows as repairable systems:

1. Run deterministic checks as evidence-capturing gates with `captureOutput: true`.
2. Prefer `failOnError: false` for intermediate validation gates so the workflow can pass the output to a repair agent.
3. Add a repair step immediately after each red-prone gate. The repair agent reads `{{steps.<gate>.output}}`, fixes source/tests/config, reruns the same command locally, and exits only after the gate is green or the blocker is external.
4. Keep final acceptance deterministic, but still put an agent repair step before commit/PR creation. If the repair budget is exhausted or a true external blocker remains, write a blocked artifact and skip commit/PR creation; do not let the workflow end as `FAILED`.
5. Use `.reliable()` or `.repairable()` on SDK versions that support it, especially for product-contract workflows. As of AgentWorkforce/relay#827, retry-mode workflows with agents are repair-aware by default, repair agents run before retrying malformed/failed agent steps, and the SDK covers DAG, pipeline, fan-out, worktree-backed, deterministic-only, and agent-plus-gate shapes.

Avoid hard-stop gates (`failOnError: true` with no repair step) in workflows that are supposed to be self-healing. Even cheap preconditions such as missing credentials, wrong repository, or an unsafe dirty worktree should normally write a clear `BLOCKED_*` artifact and exit cleanly. For implementation, build, test, lint, schema, artifact, and review failures, model the fix path in the workflow.

## Mandatory Fresh-Eyes Review Loops

Every workflow must include two comprehensive fresh-eyes review/fix loops before final acceptance, commit, PR creation, or handoff: first Claude, then Codex. This applies even to small workflows and even when deterministic tests pass. Tests prove commands passed; the fresh-eyes loops make independent agents read the actual resulting files and artifacts as if they did not author them.

The required shape is:

1. `claude-review`: Claude reads the spec, repo rules, changed files, artifacts, test evidence, and final diff. It must produce a durable review artifact with either actionable findings or an explicit `NO_ISSUES_FOUND` verdict.
2. `claude-fix`: a fixer repairs every valid Claude finding, adds or updates appropriate tests/proofs for the fix, reruns the relevant checks, and records what changed. If the review found no issues, it records that no fix was needed.
3. `claude-review-final`: Claude reviews the post-fix state from scratch. It must not rely on the first review or the fixer's summary.
4. `claude-fix-final`: if the final Claude review still finds issues, fix them, add or update appropriate tests/proofs, and rerun the checks. If anything cannot be fixed, write a `BLOCKED_NO_COMMIT` artifact with exact evidence.
5. `codex-review`: Codex starts after the Claude loop and reviews the post-Claude-fix state from scratch.
6. `codex-fix`: a fixer repairs every valid Codex finding, adds or updates appropriate tests/proofs for the fix, reruns relevant checks, and records what changed.
7. `codex-review-final`: Codex reviews the post-fix state from scratch.
8. `codex-fix-final`: if the final Codex review still finds issues, fix them, add or update appropriate tests/proofs, and rerun checks. If anything cannot be fixed, write `BLOCKED_NO_COMMIT`.
9. Final acceptance/commit/PR steps depend on the post-Codex-fix review path, not directly on implementation, tests, or the Claude loop.

Because WorkflowBuilder DAGs do not provide an unbounded dynamic `while` loop, model this as explicit bounded review/fix loops plus a final signoff gate. Inside each fix step, instruct the agent to keep iterating locally: review the finding, edit, add or update appropriate regression tests/proofs, rerun targeted checks, review its own fix, and repeat until that round has no remaining valid issues. For high-risk workflows, add more unrolled review/fix rounds or split the reviews into focused reviewers by subsystem.

Use Claude first and Codex second unless one of those CLIs is unavailable in the target environment. If one is unavailable, write that limitation into the workflow artifact and keep the remaining review loop mandatory.

Review artifacts should use a consistent schema so later steps can act on them deterministically:

```text
verdict: FINDINGS | NO_ISSUES_FOUND | BLOCKED
finding_id: short stable id
severity: blocker | high | medium | low
file: path/to/file
issue: what is wrong
fix_required: concrete change needed
test_required: test, fixture, assertion, or proof command needed
status: open | fixed | wontfix | blocked
evidence: commands run, file paths, or blocker details
```

Use `NO_ISSUES_FOUND` only when there are no actionable findings. Use `BLOCKED` only when the blocker is external or unsafe to resolve inside the workflow.

## Choose Your Coordination Style — Conversation vs Pipeline

Before writing the workflow, decide _how the agents will coordinate_. The relay primitive supports two very different shapes, and picking the wrong one wastes the most valuable thing the SDK gives you.

| Shape                          | What it is                                                                                                                                                                                                           | Use when                                                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Conversation** (chat-native) | Interactive agents share a channel; messages, `@-mentions`, and ambient awareness drive coordination. Lead and workers spawn in parallel and self-organize. The relay is the coordination layer, not just transport. | Multi-file work, peer review loops, cross-agent feedback, dynamic re-planning, multi-PR coordination, anything with a human-in-the-loop escape, swarms where workers pick up each other's output.  |
| **Pipeline** (one-shot DAG)    | Each step runs as a one-shot subprocess (`claude -p`, `codex exec`); steps hand off via `{{steps.X.output}}` text injection. No agents are alive at the same time; no chat happens.                                  | Linear, well-specified transformations; deterministic data passing; no live agent-to-agent coordination during implementation. The mandatory final Claude-then-Codex review/fix loops still apply. |

**Default to Conversation for any non-trivial work.** Pipeline DAGs are simpler to reason about but they do not exercise the relay primitive — they are a Unix pipe with extra steps. If you would happily write the same task as a single shell pipeline, pipeline-shape is fine. Otherwise, you almost certainly want a Conversation shape.

The two shapes can mix within one workflow: pipeline-style deterministic preflight → conversation in the middle → pipeline-style commit-and-PR at the end. See **Quick Reference (Conversation)** below and **[Common Patterns → Interactive Team](#interactive-team-lead--workers-on-shared-channel)** for the canonical recipe.

> **A blunt rule of thumb:** if your workflow only uses `agent` steps with `preset: 'worker'` chained by `{{steps.X.output}}`, you are not using the relay — you are using `claude -p | codex exec`. That may still be the right answer; just make it a deliberate choice.

## Quick Reference (Pipeline shape)

> Use this when steps are linear, well-specified, and need no agent-to-agent feedback. For anything with iteration, review, or coordination, jump to **Quick Reference (Conversation shape)** below.
>
> **Note:** examples use ESM `import` syntax, but workflow execution is always wrapped in an async function. See **Failure Prevention → Do not use raw top-level `await`** before copy-pasting into CJS or executor-generated files.

```typescript
import { workflow } from '@agent-relay/sdk/workflows';

async function runWorkflow() {
  const result = await workflow('my-workflow')
    .description('What this workflow does')
    .pattern('dag') // or 'pipeline', 'fan-out', etc.
    .channel('wf-my-workflow') // dedicated channel (auto-generated if omitted)
    .maxConcurrency(3)
    .timeout(3_600_000) // global timeout (ms)
    .repairable()

    .agent('lead', { cli: 'claude', role: 'Architect', retries: 2 })
    .agent('worker', { cli: 'codex', role: 'Implementer', retries: 2 })
    .agent('claude-reviewer', {
      cli: 'claude',
      role: 'First-pass fresh-eyes reviewer',
      retries: 1,
      preset: 'reviewer',
    })
    .agent('claude-fixer', { cli: 'claude', role: 'First-pass review-finding fixer', retries: 2 })
    .agent('codex-reviewer', {
      cli: 'codex',
      role: 'Second-pass fresh-eyes reviewer',
      retries: 1,
      preset: 'reviewer',
    })
    .agent('codex-fixer', { cli: 'codex', role: 'Review-finding fixer', retries: 2 })

    .step('preflight', {
      type: 'deterministic',
      command: 'git rev-parse --show-toplevel >/dev/null && echo PREFLIGHT_OK',
      captureOutput: true,
      failOnError: true,
    })
    .step('plan', {
      agent: 'lead',
      dependsOn: ['preflight'],
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
    .step('claude-review', {
      agent: 'claude-reviewer',
      dependsOn: ['implement'],
      task: `Fresh-eyes review the completed workflow output. Read the actual files, diff, repo rules, and available evidence.
Write findings to .workflow-artifacts/my-workflow/claude-review.md.
If there are no actionable issues, write NO_ISSUES_FOUND.`,
      verification: { type: 'exit_code' },
    })
    .step('claude-fix', {
      agent: 'claude-fixer',
      dependsOn: ['claude-review'],
      task: `Read .workflow-artifacts/my-workflow/claude-review.md.
Fix every valid issue, add or update appropriate tests/proofs for the fix, rerun relevant checks, and update .workflow-artifacts/my-workflow/claude-fix.md.
If the review says NO_ISSUES_FOUND, record that no fix was needed.`,
      verification: { type: 'exit_code' },
    })
    .step('claude-review-final', {
      agent: 'claude-reviewer',
      dependsOn: ['claude-fix'],
      task: `Fresh-eyes review the post-fix state from scratch. Do not rely on the prior review or fix summary.
Write .workflow-artifacts/my-workflow/claude-review-final.md with either actionable findings or NO_ISSUES_FOUND.`,
      verification: { type: 'exit_code' },
    })
    .step('claude-fix-final', {
      agent: 'claude-fixer',
      dependsOn: ['claude-review-final'],
      task: `If .workflow-artifacts/my-workflow/claude-review-final.md contains findings, fix them, add or update appropriate tests/proofs, and rerun relevant checks.
If no fix is possible, write .workflow-artifacts/my-workflow/BLOCKED_NO_COMMIT.md with exact evidence.
If it says NO_ISSUES_FOUND, record Claude review signoff.`,
      verification: { type: 'exit_code' },
    })
    .step('codex-review', {
      agent: 'codex-reviewer',
      dependsOn: ['claude-fix-final'],
      task: `Second-pass fresh-eyes review of the post-Claude-fix state. Read the actual files, diff, repo rules, and available evidence.
Write findings to .workflow-artifacts/my-workflow/codex-review.md.
If there are no actionable issues, write NO_ISSUES_FOUND.`,
      verification: { type: 'exit_code' },
    })
    .step('codex-fix', {
      agent: 'codex-fixer',
      dependsOn: ['codex-review'],
      task: `Read .workflow-artifacts/my-workflow/codex-review.md.
Fix every valid issue, add or update appropriate tests/proofs for the fix, rerun relevant checks, and update .workflow-artifacts/my-workflow/codex-fix.md.
If the review says NO_ISSUES_FOUND, record that no fix was needed.`,
      verification: { type: 'exit_code' },
    })
    .step('codex-review-final', {
      agent: 'codex-reviewer',
      dependsOn: ['codex-fix'],
      task: `Fresh-eyes review the post-Codex-fix state from scratch. Do not rely on the prior review or fix summary.
Write .workflow-artifacts/my-workflow/codex-review-final.md with either actionable findings or NO_ISSUES_FOUND.`,
      verification: { type: 'exit_code' },
    })
    .step('codex-fix-final', {
      agent: 'codex-fixer',
      dependsOn: ['codex-review-final'],
      task: `If .workflow-artifacts/my-workflow/codex-review-final.md contains findings, fix them, add or update appropriate tests/proofs, and rerun relevant checks.
If no fix is possible, write .workflow-artifacts/my-workflow/BLOCKED_NO_COMMIT.md with exact evidence.
If it says NO_ISSUES_FOUND, record final review signoff.`,
      verification: { type: 'exit_code' },
    })
    .step('acceptance-after-review', {
      type: 'deterministic',
      dependsOn: ['codex-fix-final'],
      command: 'test ! -f .workflow-artifacts/my-workflow/BLOCKED_NO_COMMIT.md && echo ACCEPTANCE_OK',
      captureOutput: true,
      failOnError: true,
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Result:', result.status);
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

## Quick Reference (Conversation shape)

> Use this for any non-trivial work — peer review, multi-file edits, cross-agent feedback, dynamic re-planning. Lead and workers spawn **in parallel** on a shared channel and self-organize via messages. The relay primitive does the coordinating; verification gates downstream of the lead close the workflow.

```typescript
import { workflow } from '@agent-relay/sdk/workflows';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

async function runWorkflow() {
  const result = await workflow('my-workflow')
    .description('Multi-file change with peer review')
    .pattern('dag')
    .channel('wf-my-feature') // dedicated channel — agents share it
    .maxConcurrency(4)
    .timeout(3_600_000)
    .repairable()

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
    .agent('claude-reviewer', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      preset: 'reviewer',
      role: 'First-pass fresh-eyes reviewer. Reads the final diff and artifacts from scratch.',
      retries: 1,
    })
    .agent('claude-fixer', {
      cli: 'claude',
      model: ClaudeModels.SONNET,
      role: 'First-pass review-finding fixer. Repairs valid findings, adds tests/proofs, and reruns checks.',
      retries: 2,
    })
    .agent('codex-reviewer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'reviewer',
      role: 'Second-pass fresh-eyes reviewer. Reviews the post-Claude-fix state from scratch.',
      retries: 1,
    })
    .agent('codex-fixer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      role: 'Review-finding fixer. Repairs valid findings, adds tests/proofs, and reruns checks.',
      retries: 2,
    })

    // Deterministic context — pre-reads files once, posts to the channel for everyone
    .step('preflight', {
      type: 'deterministic',
      command: 'git rev-parse --show-toplevel >/dev/null && echo PREFLIGHT_OK',
      captureOutput: true,
      failOnError: true,
    })
    .step('context', {
      type: 'deterministic',
      dependsOn: ['preflight'],
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
    // Capture failures, then hand them to an agent for repair.
    .step('verify', {
      type: 'deterministic',
      dependsOn: ['lead-coordinate'],
      command: 'npm run typecheck && npm test 2>&1',
      captureOutput: true,
      failOnError: false,
    })
    .step('repair-verify', {
      agent: 'lead',
      dependsOn: ['verify'],
      task: `If verification passed, summarize evidence.
If it failed, use this output to assign and fix issues, then rerun the command until green:
{{steps.verify.output}}`,
      verification: { type: 'exit_code' },
    })
    .step('verify-final', {
      type: 'deterministic',
      dependsOn: ['repair-verify'],
      command: 'npm run typecheck && npm test 2>&1',
      captureOutput: true,
      failOnError: false,
    })
    .step('claude-review', {
      agent: 'claude-reviewer',
      dependsOn: ['verify-final'],
      task: `First-pass fresh-eyes review of the post-implementation state.
Read the actual changed files, git diff, repo instructions, task spec, and verification output:
{{steps.verify-final.output}}

Write .workflow-artifacts/my-feature/claude-review.md with:
- actionable findings, each with file paths and required fix
- or NO_ISSUES_FOUND if there are no remaining issues`,
      verification: { type: 'exit_code' },
    })
    .step('claude-fix', {
      agent: 'claude-fixer',
      dependsOn: ['claude-review'],
      task: `Read .workflow-artifacts/my-feature/claude-review.md.
If there are findings, fix every valid one and add or update appropriate tests/proofs. After each fix, rerun the relevant check and review the changed files again.
Keep iterating locally until this round has no remaining valid issues.
Write .workflow-artifacts/my-feature/claude-fix.md with fixes and commands run.
If the review says NO_ISSUES_FOUND, write that no fix was needed.`,
      verification: { type: 'exit_code' },
    })
    .step('claude-review-final', {
      agent: 'claude-reviewer',
      dependsOn: ['claude-fix'],
      task: `Perform a fresh post-fix review from scratch. Do not rely on previous review text or the fixer's summary.
Read files, diff, repo rules, task spec, and evidence. Write .workflow-artifacts/my-feature/claude-review-final.md.
Use NO_ISSUES_FOUND only if there are no actionable issues left.`,
      verification: { type: 'exit_code' },
    })
    .step('claude-fix-final', {
      agent: 'claude-fixer',
      dependsOn: ['claude-review-final'],
      task: `If the final Claude review found issues, fix them, add or update appropriate tests/proofs, and rerun the relevant checks until green.
If no fix is possible, write .workflow-artifacts/my-feature/BLOCKED_NO_COMMIT.md with exact evidence and do not commit.
If the final review says NO_ISSUES_FOUND, record signoff in .workflow-artifacts/my-feature/claude-signoff.md.`,
      verification: { type: 'exit_code' },
    })
    .step('verify-after-claude-review', {
      type: 'deterministic',
      dependsOn: ['claude-fix-final'],
      command:
        'test ! -f .workflow-artifacts/my-feature/BLOCKED_NO_COMMIT.md && npm run typecheck && npm test 2>&1',
      captureOutput: true,
      failOnError: false,
    })
    .step('codex-review', {
      agent: 'codex-reviewer',
      dependsOn: ['verify-after-claude-review'],
      task: `Second-pass fresh-eyes review of the post-Claude-fix state.
Read the actual changed files, git diff, repo instructions, task spec, and verification output:
{{steps.verify-after-claude-review.output}}

Write .workflow-artifacts/my-feature/codex-review.md with:
- actionable findings, each with file paths and required fix
- or NO_ISSUES_FOUND if there are no remaining issues`,
      verification: { type: 'exit_code' },
    })
    .step('codex-fix', {
      agent: 'codex-fixer',
      dependsOn: ['codex-review'],
      task: `Read .workflow-artifacts/my-feature/codex-review.md.
If there are findings, fix every valid one and add or update appropriate tests/proofs. After each fix, rerun the relevant check and review the changed files again.
Keep iterating locally until this round has no remaining valid issues.
Write .workflow-artifacts/my-feature/codex-fix.md with fixes and commands run.
If the review says NO_ISSUES_FOUND, write that no fix was needed.`,
      verification: { type: 'exit_code' },
    })
    .step('codex-review-final', {
      agent: 'codex-reviewer',
      dependsOn: ['codex-fix'],
      task: `Perform a fresh post-Codex-fix review from scratch. Do not rely on previous review text or the fixer's summary.
Read files, diff, repo rules, task spec, and evidence. Write .workflow-artifacts/my-feature/codex-review-final.md.
Use NO_ISSUES_FOUND only if there are no actionable issues left.`,
      verification: { type: 'exit_code' },
    })
    .step('codex-fix-final', {
      agent: 'codex-fixer',
      dependsOn: ['codex-review-final'],
      task: `If the final Codex review found issues, fix them, add or update appropriate tests/proofs, and rerun the relevant checks until green.
If no fix is possible, write .workflow-artifacts/my-feature/BLOCKED_NO_COMMIT.md with exact evidence and do not commit.
If the final review says NO_ISSUES_FOUND, record signoff in .workflow-artifacts/my-feature/codex-signoff.md.`,
      verification: { type: 'exit_code' },
    })
    .step('verify-after-review', {
      type: 'deterministic',
      dependsOn: ['codex-fix-final'],
      command:
        'test ! -f .workflow-artifacts/my-feature/BLOCKED_NO_COMMIT.md && npm run typecheck && npm test 2>&1',
      captureOutput: true,
      failOnError: true,
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Result:', result.status);
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

**What this exercises that pipeline-shape does not:**

- **Ambient awareness** — workers see each other's completion messages and start dependent work without the lead relaying.
- **Lead-as-reviewer** — the lead reads actual files between rounds and posts diff-aware feedback in chat. One agent does coordination + review; no separate reviewer step.
- **Iterative correction** — when the lead pings _"impl-a, the type on line 42 is wrong"_, impl-a fixes and re-posts. No new step, no re-spawn, no `{{output}}` chaining.

**Critical workflow rules for this shape:**

1. Lead and workers MUST share the same `dependsOn` (e.g., both depend on `context`). If a worker depends on the lead, you have a deadlock — the lead is waiting for worker output, the worker is waiting for the lead step to "complete."
2. Drop `preset: 'worker'` on the implementer agents — interactive mode is what lets them receive channel messages via PTY injection.
3. Downstream gates depend on the **lead step**, not the workers. The lead exits when it's satisfied; that's the workflow's signal that implementation is ready for repairable deterministic checks.
4. Use a dedicated `.channel('wf-...')` so the team is isolated from other workflows and the global `general` channel.

See [Common Patterns → Interactive Team](#interactive-team-lead--workers-on-shared-channel) for production notes from real runs and decision criteria for picking this shape over one-shot DAG.

---

## Default For Serious Implementation: Shadowed Squad Review Loop

When a workflow is expected to produce production-quality code, generated workflows, runtime behavior, or shared execution contracts, use a structured squad-review-loop unless the task is clearly small enough for the lighter shape.

The default unit is a **2-3 agent squad**:

- implementer: owns a tight file/subsystem scope and writes the change
- shadow reviewer: follows the implementer in real time, checks drift against the spec, and leaves feedback early
- optional validation owner: owns tests, dry-run proof, or fixture coverage when that is a separate deliverable

Encode the loop explicitly:

1. Deterministically read the spec, AGENTS.md / CLAUDE.md, workflow standards, recent local docs, and declared file targets.
2. Lead splits work into bounded squads with non-overlapping ownership.
3. Squads run in parallel. The shadow reads actual files and channel updates, then posts feedback while the implementer is still active.
4. Each implementer writes a self-reflection artifact before external review. It must answer: what changed, what spec items are satisfied, what tests/proofs ran, what risks remain, and how the work follows repo rules.
5. A fresh self-review agent reads the post-implementation files, recent local conventions, AGENTS.md / CLAUDE.md, and related rules. It should not rely on the implementer's summary.
6. The implementer gets that feedback and performs a repair pass.
7. Deterministic gates run with captured output. Red output goes to a repair owner, then the same gate reruns.
8. Run the mandatory fresh-eyes review loops in sequence: Claude reviews the actual final diff and artifacts, a fixer repairs findings and hardens them with appropriate tests/proofs, Claude reviews the post-fix state again, then Codex repeats the same cycle from scratch over the post-Claude-fix state.
9. Optional extra reviewers can be added for high-stakes work, but they do not replace the sequential Claude-then-Codex loops.
10. Final signoff only happens after post-Codex-fix review and final deterministic gates prove the spec is complete, or a blocker artifact explains why it cannot be completed.

For small doc/spec workflows, a lead + author + the mandatory Claude-then-Codex review/fix loops is enough. For serious implementation workflows, do not collapse implementer self-reflection, shadow review, independent review, final dual review, and repair into one vague "review" step.

**Critical TypeScript rules:**

1. Check the project's `package.json` for `"type": "module"` — if ESM, use `import`; if CJS, use `require()`. In both cases, wrap execution in an async function instead of raw top-level `await`.
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

### 1b. Make commit and PR boundaries explicit

Workflows do **not** get a PR for free just because they pass validation. If the intended deliverable is a branch, commit, push, or GitHub PR, the workflow itself must own that boundary explicitly and document the expected file scope.

Use this pattern only when the workflow is supposed to own repository delivery:

1. Preflight the git state and fail on unexpected staged changes.
2. Create or verify the intended branch.
3. Run implementation, repairable validation, the mandatory sequential Claude-then-Codex review/fix loops, and final acceptance gates.
4. Stage only the declared target files and review/signoff artifacts.
5. Commit with a deterministic message.
6. Push the branch.
7. Use `createGitHubStep({ action: 'createPR', ... })` from `@agent-relay/sdk` to open the PR.
8. Verify the PR URL/state deterministically and write it into the final signoff artifact.

Do not hide commit/PR work in agent prose. Model it as deterministic steps whenever possible. For PR creation, issue updates, file reads, or any GitHub operation, prefer `createGitHubStep` over shelling out to `gh`; import it from the SDK root (`import { createGitHubStep } from '@agent-relay/sdk'`) on SDK versions that include AgentWorkforce/relay#823, or from the legacy subpath only when pinned to an older SDK. The downstream acceptance gate must still verify the PR exists before signoff, and any PR creation failure should route to a repair step before the workflow stops.

If commit or PR creation is intentionally outside the workflow, say that directly in the workflow description and signoff so the operator knows to do it after completion.

### 2. Avoid raw fenced code blocks inside workflow task template literals

Raw triple-backtick code fences inside large inline `task: \`...\``template strings are fragile and can break outer TypeScript parsing, especially when they contain language tags like`swift`or`diff`.

Preferred options, in order:

1. Avoid inline fenced examples entirely
2. Move larger examples to referenced files
3. Use plain indented examples instead of fenced blocks
4. If fenced blocks must exist inside generated inner code, escape them consistently and syntax-check the outer workflow file afterward

### 2b. Standard preflight template for resumable workflows

Every non-trivial workflow should start with a deterministic `preflight` step that validates the environment before any agent runs. A workflow that fails mid-DAG and gets re-run (or resumed via `--start-from`) will re-execute preflight, so preflight must tolerate the partial state left behind by the previous run — specifically, dirty files that the workflow itself is expected to edit.

The battle-tested template:

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

**Rules baked into this template:**

- **Always include `package-lock.json`** in `ALLOWED_DIRTY`. Both `npm install` and `npm ci` can touch it idempotently.
- **Include every file the workflow's edit steps will rewrite.** The commit step uses explicit `git add <path>` (never `git add -A`), so allowing these files to be dirty on entry is safe — unrelated drift in other files still fails preflight.
- **Escape dots in regex paths:** `setup\.ts` not `setup.ts`. In a JS template literal this means four backslashes: `"setup\\\\.ts"`.
- **Use `grep -vE "^(...)$"` for full-line match.** Substring matches bleed across unrelated files (e.g., `setup.ts` would also match `packages/core/src/bootstrap/setup.ts`).
- **Append `|| true` to the grep.** Without it, an empty result triggers `set -e` and the whole preflight fails before the `if` can even run.
- **Check the staging area separately.** A dirty index is different from a dirty working tree and both must be clean (modulo allow-list).
- **Check `gh auth status` early** if downstream GitHub operations will use the local transport. Failing on auth at the end of a long DAG is painful.

**Never use `git diff --quiet` alone as your "clean tree" check.** It fails on any dirty file, including the ones the workflow is expected to rewrite, which causes false failures on every resume / re-run.

### 2c. Picking the right `.join()` for multi-line shell commands

When a `command:` field is a JS array that gets joined into a shell command string, the join delimiter determines what kinds of content the array can contain.

**`.join(' && ')`** — use when every element is a self-contained shell statement. Each element becomes independent and the next one runs only if the previous succeeded. Works for linear scripts with `set -e`.

```ts
command: [
  'set -e',
  'HITS=$(grep -c diag src/cli/commands/setup.ts || true)',
  'if [ "$HITS" -lt 6 ]; then echo "FAIL"; exit 1; fi',
  'echo OK',
].join(' && '),
```

**`.join('\n')`** — use when array elements must be part of a larger compound statement that spans multiple physical lines:

- heredocs (`cat <<EOF ... EOF`)
- multi-line `if` / `while` / `for` bodies
- shell functions defined inline

`&&` is a command separator. It cannot appear between a heredoc's opening line and its body, between a `for` and its body, or inside an `if`'s consequent block. Joining such content with `&&` produces a shell syntax error.

**Never mix heredocs with `&&` joining.** The most common failure mode:

```ts
// ❌ BROKEN — heredoc body gets && inserted between each line
command: [
  'set -e',
  'cat > /tmp/f <<EOF',
  'line 1',
  'line 2',
  'EOF',
  'next-command',
].join(' && '),
```

Results in `set -e && cat > /tmp/f <<EOF && line 1 && line 2 && EOF && next-command` — a shell syntax error because `&&` cannot appear inside a heredoc body. Use `.join('\n')` or (better) sidestep the heredoc entirely.

**The `printf` + `mktemp` alternative — use this for commit messages, raw-CLI fallback PR bodies, and any other multi-line file content.** It avoids heredocs altogether and composes with `.join(' && ')`:

```ts
command: [
  'set -e',
  'BODY=$(mktemp)',
  // Each line of the file is a separate printf argument. No heredoc,
  // no shell metacharacter hazards, no command-substitution nesting.
  'printf "%s\\n" "## Summary" "" "body line 1" "body line 2" > "$BODY"',
  'gh pr create --title "..." --body-file "$BODY"',
  'rm -f "$BODY"',
].join(' && '),
```

This pattern is specifically recommended over `git commit -m "$(cat <<'EOF' ... EOF)"` and raw `gh pr create --body "$(cat <<'BODY' ... BODY)"`. Nesting a heredoc inside `$(...)` forces the shell to match a closing paren across many lines of unparsed body text, and any stray parenthesis in the body text can silently break the match. `--body-file` + `mktemp` + `printf` is immune to that entire class of bug. For workflow-owned PR creation, prefer `createGitHubStep` over raw `gh`; this shell pattern is for raw CLI fallback cases.

### 2d. Template-literal escape sequences are processed once before the string is rendered

If your file generates code as a giant template literal (the pattern used by `packages/core/src/bootstrap/script-generator.ts` in cloud), every backslash in that template gets processed by JavaScript before the string is returned. This silently breaks regexes and escape sequences that are meant to appear in the _generated_ output.

Specifically:

- `\s` is not a recognized string escape → the backslash is stripped → `\s` renders as a literal `s`
- `\b` _is_ a recognized string escape (backspace, U+0008) → `\b` renders as a backspace character in the output
- `\n`, `\t`, `\r`, `\\`, `\0`, `\uXXXX`, `\xXX` all get resolved at template time

The footgun: the outer TypeScript compiles cleanly, the rendered code parses and runs, and the regex/escape just never matches what the author intended. See AgentWorkforce/cloud#113 for the exact incident (`hasConfigExport = /^export\s+.../m` silently became `/^exports+.../m` in the generated bootstrap, making every TS workflow fall through to the standalone-script fallback).

Guidelines:

1. If you want a regex pattern that survives the template-literal pass unchanged, double every backslash in the source: `\\s`, `\\b`, `\\n` (the `\\` renders to `\` in the output, producing a correct regex at runtime).
2. If you want to write a long string-literal newline into the output, `'\\n'` in the template renders to `'\n'` in the output, which the runtime JS interprets as a newline. Using a literal `'\n'` would render an actual newline into the JS source — visually messy and sometimes surprising.
3. If you add anything non-trivial to a generator file that returns a big template literal, add a unit test that calls the generator with canonical inputs and asserts something about the rendered output — either exact string matches or, for regexes, `eval`/construct the regex and test it against known samples. See `tests/orchestrator/script-generator.test.ts` in cloud for prior art.

Task-prompt workaround: for agent-relay workflow _task prompts_ (where the contents go into a template literal but the inner content is plain text for an LLM), it's often cleaner to build the string as an array and `.join('\n')` at the boundary. That sidesteps the "does this backslash survive?" question entirely — no backslashes in the source, no processing to reason about. Several workflows in `cloud/workflows/` use this pattern (see the sage migration PRs).

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

### 5. Prefer Codex for implementation-heavy roles and dual review loops

Default team split for workflow-authored agent roles:

- **lead / implementer / writer / fixer** → `codex`
- **first mandatory fresh-eyes review loop** → `claude`
- **second mandatory fresh-eyes review loop** → `codex`

Use Claude as the primary implementer only when there is a specific reason. Use only one reviewer CLI only when the target environment cannot run the other, and record that limitation in the workflow artifact.

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

### 7a. `--resume` vs `--start-from` when fixing a buggy step

When a workflow fails at step X and you want to re-run it after editing the workflow file, the flag choice matters:

| Flag                                         | Reads workflow file fresh?           | Uses cached step outputs?                |
| -------------------------------------------- | ------------------------------------ | ---------------------------------------- |
| `--resume <id>`                              | ❌ replays **stored config from DB** | ✅ from same run id                      |
| `--start-from <step> --previous-run-id <id>` | ✅ reads fresh file                  | ✅ from previous run id's cached outputs |

**Rule:** if you edited the workflow file to fix the failing step, use `--start-from <failing-step> --previous-run-id <id>`, **not** `--resume <id>`. `--resume` pulls the entire workflow config from the run's DB record and replays it — your edits to the workflow file are ignored, and the step re-runs with its original (broken) definition.

This is counterintuitive because "resume" sounds like "pick up where you left off with whatever I just changed." It does not. It picks up where you left off with the **stored** config from when the run first started.

**When to use each:**

- Transient failure (network hiccup, rate limit, flaky agent), no code edits: `--resume <id>` is fine, fast, and correct.
- You edited the workflow file (any step definition, any prompt, any verify gate): **always** `--start-from <failing-step> --previous-run-id <id>`. Everything upstream of the failing step loads from cache, the fresh file supplies the fixed definition, and downstream steps run as normal.

If the runner complains that `--start-from` can't find cached outputs for the previous run id, fall back to a clean from-scratch run. The workflow's preflight should be forgiving enough (see §2b "Standard preflight template") that a from-scratch re-run succeeds even when a prior partial run left files dirty.

### 8. Syntax-check workflow files after editing

After editing workflow `.ts` files, run a lightweight syntax check before launching a large batch run. This is especially important if the workflow contains:

- large inline `task` template literals
- embedded code examples
- escaped backticks
- wrapper changes around workflow execution

### 9. Factor repo-specific setup into a shared helper

If multiple workflows in the same repo need the same boilerplate before any agent touches code (branch checkout, `npm install`, workspace-package prebuild, language toolchain init, etc.), do **not** copy-paste those steps into every workflow. Put them in `workflows/lib/<repo>-setup.ts` and import from there.

**Why it matters:** without a shared helper, the first workflow that needs a new prerequisite step (e.g. `npm run build:platform` because a workspace package's `package.json` points `types` at `dist/`) adds it locally, and every other workflow silently misses it. In a fresh cloud sandbox that means agents hit `Cannot find module '@cloud/platform'` during typecheck and paper over it with ad-hoc `external-modules.d.ts` shims or `as GetObjectCommandOutput` casts scattered across unrelated files. Those workarounds sync back down with the patch and pollute the PR.

**Pattern:**

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

Consumer workflows break the builder chain once and call through:

```ts
const baseWf = workflow(NAME)
  .description(...)
  .pattern('dag')
  .agent(...)
  .agent(...);

const wf = applyCloudRepoSetup(baseWf, {
  branch: BRANCH,
  committerName: 'My Workflow Bot',
});

await wf
  .step('read-spec', { dependsOn: ['install-deps'], ... })
  ...
  .run(...);
```

**Rules:**

- The helper lives in the **consumer repo**, not in the SDK. Different customer repos have different languages, package managers, and build graphs — `@agent-relay/sdk` should stay agnostic.
- Pre-build any workspace package whose `package.json` `main`/`types` point at a generated `dist/`. Fresh sandboxes don't have that `dist/` yet, and agents will invent workarounds rather than run the build. See the `@cloud/platform` case above.
- Every install step includes `--legacy-peer-deps --no-audit --no-fund 2>&1 | tail -10` (or equivalent noise-trimming) because full install output blows past `captureOutput` size limits.
- Document the helper in the repo's `CLAUDE.md` / `AGENTS.md` so new workflow authors (and agents writing workflows) discover it.

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
9. **Ship the result as a PR**
   - Open the pull request from the workflow itself with `createGitHubStep`
   - See [Shipping the Result — Open a PR via `createGitHubStep`](#shipping-the-result--open-a-pr-via-creategithubstep) below
   - A workflow that fixes a bug and stops short of the PR has only done half the loop

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

## Shipping the Result — Open a PR via `createGitHubStep`

A workflow whose final artifact is "a clean working tree on a sandbox you'll throw away" has not shipped anything. **End every code-changing workflow by opening a pull request, and do it from inside the workflow** using `createGitHubStep` from `@agent-relay/sdk`. Don't tell the operator to follow up with `gh pr create` — make the workflow's own last step the PR.

### Why `createGitHubStep` (and not raw `gh` / `octokit`)

The primitive picks the right transport at runtime:

| Where the workflow runs                         | Transport `createGitHubStep` uses           | What you provide                    |
| ----------------------------------------------- | ------------------------------------------- | ----------------------------------- |
| Local (`agent-relay run`)                       | `gh` CLI                                    | `gh auth status` works              |
| Cloud (`agent-relay cloud run`) — tenant-scoped | Nango → workspace's GitHub App installation | Nothing — cloud injects credentials |
| Cloud — fallback                                | Relay-cloud GitHub proxy                    | Nothing — cloud injects credentials |

You write **one** workflow. The same `createPR` step opens a PR via your local `gh` when you iterate on it on a laptop, and via the workspace's GitHub App when the same file runs in `agent-relay cloud run`. No branching by environment, no env-var sniffing in your task strings, no "this part only works in cloud" caveats. That's the whole point of the adapter.

> **Phase C interaction (cloud only):** `agent-relay cloud run` already auto-pushes per-`paths[]` diffs as separate PRs after the workflow callback when the repos are allowlisted (see `pushedTo` in the run record). Phase C is the _catch-all_ — if your workflow does nothing else, you still get one PR per declared path. Use `createGitHubStep` **on top of** that when you need PRs the catch-all can't produce: cross-cutting issues, follow-up tracking issues, opening one PR that spans multiple paths, draft PRs you want labeled/assigned in specific ways, or PRs against a repo you didn't `paths[]` in.

### The minimal "open a PR" recipe

```typescript
import { workflow } from '@agent-relay/sdk/workflows';
import { createGitHubStep } from '@agent-relay/sdk';

const REPO = 'AgentWorkforce/cloud';
const BRANCH = `agent-relay/run-${Date.now()}`;

async function runWorkflow() {
  await workflow('feature-x')
    // ... your real implementation, repair, review loops, and final acceptance ...
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
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

`createGitHubStep` is bundled with `@agent-relay/sdk`; do not add a separate install. Its actions are stable across runtimes: `getRepo`, `createBranch`, `createFile`, `updateFile`, `createPR`, `updatePR`, `getPR`, `listPRs`, `mergePR`, `createIssue`, etc. See the SDK GitHub primitive docs for the full enum.

### Authoring rules for PR-shipping workflows

1. **Open the PR from the workflow, not from the operator's shell.** "Tell the user to run `gh pr create`" is a regression to a manual step the workflow could have done. The whole point of running this in cloud is that there is no operator's shell.
2. **One PR per workflow, by default.** A workflow that opens five PRs from one run is almost always wrong — humans review one PR at a time. If you genuinely need multiple, prefer a tracking issue + linked PRs, or split into separate workflows.
3. **Branch name encodes the run.** `agent-relay/run-${runId}` or `agent-relay/${workflow-name}-${timestamp}` so reviewers can tell the PR apart from other automation, and so reruns don't clash.
4. **`draft: true` while iterating.** Once the workflow is stable end-to-end, flip to `draft: false`.
5. **Body is a real PR description.** Summary + Test plan, generated from the workflow's own evidence (verification step output, diff stats, test run output). If you find yourself writing a placeholder body, the workflow isn't done — capture the real evidence in an earlier step and template it in.
6. **Don't use `createGitHubStep` to substitute for `paths[]` push-back in cloud.** If the diff lives in a tarballed `paths[]` mount, let cloud's Phase C push-back open that PR (it handles the patch generation, branch lifecycle, and per-repo allowlist). Use `createGitHubStep` when you need a PR against a repo or branch outside the `paths[]` set, or when you want to add an extra PR (e.g. a tracking issue, a follow-up against a sibling repo, a docs-only PR).
7. **PR creation failures route to repair.** If `createPR` errors (auth, permissions, branch conflict), capture the output and give a repair owner a chance to fix auth, branch state, labels, or body generation before stopping. A "successful" workflow that silently failed to open the PR is the worst-case outcome — the human thinks the work shipped.

### Where this fits in the bug-fix phases

[End-to-End Bug Fix Workflows](#end-to-end-bug-fix-workflows) lists "Ship the result as a PR" as phase 9. Concretely that means: after phase 7 (compare before/after evidence) succeeds, the workflow's next step is `createPR` with that evidence templated into the body. The PR opening **is** the ship — there is no further manual step.

## Key Concepts

### Step Output Chaining

Use `{{steps.STEP_NAME.output}}` in a downstream step's task to inject the prior step's terminal output.

> **Mental model:** this is a **Unix pipe**, not agent communication. `{{steps.A.output}}` flowing into step B is `A | B` — A is dead by the time B reads its stdout. There is no chat, no feedback, no addressing. If your workflow's coordination story is _only_ output chaining, you're using the relay as transport, not as a coordination layer. See **[Choose Your Coordination Style](#choose-your-coordination-style--conversation-vs-pipeline)** before defaulting to this.

**Only chain output from clean sources:**

- Deterministic steps (shell commands — always clean)
- Non-interactive agents (`preset: 'worker'` — clean stdout)

**Never chain from interactive agents** (`cli: 'claude'` without preset) — PTY output includes spinners, ANSI codes, and TUI chrome. Instead, have the agent write to a file, then read it in a deterministic step. (Or: don't use chaining at all — let the agents coordinate over the channel.)

### Verification Gates

```typescript
verification: { type: 'exit_code' }                        // preferred for code-editing steps
verification: { type: 'output_contains', value: 'DONE' }   // optional accelerator
verification: { type: 'file_exists', value: 'src/out.ts' } // deterministic file check
verification: { type: 'pr_url', value: 'owner/repo' }      // step must leave behind a PR
```

Only these five types are valid: `exit_code`, `output_contains`, `file_exists`, `custom`, `pr_url`. Invalid types are silently ignored and fall through to process-exit auto-pass.

**Use `pr_url` for any step whose deliverable is a published change** — opening a PR, merging a branch, publishing a package. It blocks the common failure mode where a worker produces green tests and posts `OWNER_DECISION: COMPLETE` but never actually opened a PR. Pair it with `createGitHubStep({ action: 'createPR' })` (see [Shipping the Result — Open a PR via `createGitHubStep`](#shipping-the-result--open-a-pr-via-creategithubstep) above) — that primitive's output naturally contains the PR URL, so the verification gate trips cleanly when the create step is missing or fails. Pass `<owner>/<repo>` to require the URL belongs to a specific repository, or leave `value: ''` to accept any GitHub PR URL in the step output. **Workers should never shell out to `gh pr create` directly** when `createGitHubStep` is available; raw `gh` bypasses the local/cloud runtime detection and the workflow loses its `local-iteration → cloud-run` portability.

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
  failOnError: false,
})
.step('repair-files', {
  agent: 'worker',
  dependsOn: ['verify-files'],
  task: `If verify-files failed, create or fix the missing file and rerun the check.
Output:
{{steps.verify-files.output}}`,
  verification: { type: 'exit_code' },
})
.step('verify-files-final', {
  type: 'deterministic',
  command: 'test -f src/auth.ts && echo "FILE_EXISTS"',
  dependsOn: ['repair-files'],
  captureOutput: true,
  failOnError: true,
})
```

Use for: file checks, reading files for injection, build/test gates, git operations. For anything an agent can fix, follow the deterministic step with a repair step and a final deterministic proof step.

## Common Patterns

### Mandatory Claude-Then-Codex Review/Fix Loops

Place these loops after implementation and repairable verification, before final acceptance, commit, PR creation, or handoff. Claude reviews and fixes first; Codex then reviews and fixes the post-Claude state from scratch. The example uses two unrolled review/fix rounds per CLI because WorkflowBuilder is DAG-shaped; add more rounds for high-risk work.

```typescript
.agent('claude-reviewer', {
  cli: 'claude',
  preset: 'reviewer',
  role: 'First-pass fresh-eyes reviewer. Reads actual files, diffs, rules, and evidence from scratch.',
  retries: 1,
})
.agent('claude-fixer', {
  cli: 'claude',
  role: 'Fixer for valid Claude review findings. Adds or updates tests/proofs for each fix.',
  retries: 2,
})
.agent('codex-reviewer', {
  cli: 'codex',
  preset: 'reviewer',
  role: 'Second-pass fresh-eyes reviewer. Reviews the post-Claude-fix state from scratch.',
  retries: 1,
})
.agent('codex-fixer', {
  cli: 'codex',
  role: 'Fixer for valid Codex review findings. Adds or updates tests/proofs for each fix.',
  retries: 2,
})

.step('claude-review', {
  agent: 'claude-reviewer',
  dependsOn: ['verify-final'],
  task: `First-pass fresh-eyes review.
Read the task spec, AGENTS.md / CLAUDE.md, changed files, final diff, artifacts, and verification evidence:
{{steps.verify-final.output}}

Write .workflow-artifacts/<workflow>/claude-review.md.
Use actionable findings with file paths, severity, and required fixes.
If there are no issues, write NO_ISSUES_FOUND.`,
  verification: { type: 'exit_code' },
})
.step('claude-fix', {
  agent: 'claude-fixer',
  dependsOn: ['claude-review'],
  task: `Read .workflow-artifacts/<workflow>/claude-review.md.
If it contains findings, fix every valid issue and add or update appropriate tests/proofs. After each fix, rerun targeted checks and review the touched files again.
Keep iterating locally until this round has no remaining valid issues.
Write .workflow-artifacts/<workflow>/claude-fix.md with fixes and commands run.
If the review says NO_ISSUES_FOUND, record that no fix was needed.`,
  verification: { type: 'exit_code' },
})
.step('claude-review-final', {
  agent: 'claude-reviewer',
  dependsOn: ['claude-fix'],
  task: `Review the post-Claude-fix state from scratch. Do not rely on prior review text or fixer summaries.
Read the files, diff, rules, spec, and evidence. Write .workflow-artifacts/<workflow>/claude-review-final.md.
Use NO_ISSUES_FOUND only if there are no actionable issues left.`,
  verification: { type: 'exit_code' },
})
.step('claude-fix-final', {
  agent: 'claude-fixer',
  dependsOn: ['claude-review-final'],
  task: `If the final Claude review contains findings, fix them, add or update appropriate tests/proofs, rerun relevant checks, and write .workflow-artifacts/<workflow>/claude-fix-final.md.
If a finding cannot be fixed, write .workflow-artifacts/<workflow>/BLOCKED_NO_COMMIT.md with exact evidence.
If the final review says NO_ISSUES_FOUND, write .workflow-artifacts/<workflow>/claude-signoff.md.`,
  verification: { type: 'exit_code' },
})
.step('verify-after-claude-review', {
  type: 'deterministic',
  dependsOn: ['claude-fix-final'],
  command: 'test ! -f .workflow-artifacts/<workflow>/BLOCKED_NO_COMMIT.md && npm run typecheck && npm test 2>&1',
  captureOutput: true,
  failOnError: false,
})
.step('codex-review', {
  agent: 'codex-reviewer',
  dependsOn: ['verify-after-claude-review'],
  task: `Second-pass fresh-eyes review of the post-Claude-fix state.
Read the task spec, AGENTS.md / CLAUDE.md, changed files, final diff, artifacts, and verification evidence:
{{steps.verify-after-claude-review.output}}

Write .workflow-artifacts/<workflow>/codex-review.md.
Use actionable findings with file paths, severity, and required fixes.
If there are no issues, write NO_ISSUES_FOUND.`,
  verification: { type: 'exit_code' },
})
.step('codex-fix', {
  agent: 'codex-fixer',
  dependsOn: ['codex-review'],
  task: `Read .workflow-artifacts/<workflow>/codex-review.md.
If it contains findings, fix every valid issue and add or update appropriate tests/proofs. After each fix, rerun targeted checks and review the touched files again.
Keep iterating locally until this round has no remaining valid issues.
Write .workflow-artifacts/<workflow>/codex-fix.md with fixes and commands run.
If the review says NO_ISSUES_FOUND, record that no fix was needed.`,
  verification: { type: 'exit_code' },
})
.step('codex-review-final', {
  agent: 'codex-reviewer',
  dependsOn: ['codex-fix'],
  task: `Review the post-fix state from scratch. Do not rely on prior review text or fixer summaries.
Read the files, diff, rules, spec, and evidence. Write .workflow-artifacts/<workflow>/codex-review-final.md.
Use NO_ISSUES_FOUND only if there are no actionable issues left.`,
  verification: { type: 'exit_code' },
})
.step('codex-fix-final', {
  agent: 'codex-fixer',
  dependsOn: ['codex-review-final'],
  task: `If the final review contains findings, fix them, add or update appropriate tests/proofs, rerun relevant checks, and write .workflow-artifacts/<workflow>/codex-fix-final.md.
If a finding cannot be fixed, write .workflow-artifacts/<workflow>/BLOCKED_NO_COMMIT.md with exact evidence.
If the final review says NO_ISSUES_FOUND, write .workflow-artifacts/<workflow>/codex-signoff.md.`,
  verification: { type: 'exit_code' },
})
.step('acceptance-after-codex-review', {
  type: 'deterministic',
  dependsOn: ['codex-fix-final'],
  command: 'test ! -f .workflow-artifacts/<workflow>/BLOCKED_NO_COMMIT.md && npm run typecheck && npm test 2>&1',
  captureOutput: true,
  failOnError: true,
})
```

If the workflow creates a PR or commit, make those steps depend on `acceptance-after-codex-review`. If the workflow does not have tests, replace the acceptance command with deterministic evidence checks for the produced artifacts plus a `test ! -f .workflow-artifacts/<workflow>/BLOCKED_NO_COMMIT.md` guard.

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
  model: CodexModels.GPT_5_4,
  role: 'Creates new files. Listens on channel for assignments and feedback.',
  retries: 2,
  // No preset — interactive, receives channel messages
})

.agent('impl-modify', {
  cli: 'codex',
  model: CodexModels.GPT_5_4,
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

| Scenario                                                             | Pattern                              |
| -------------------------------------------------------------------- | ------------------------------------ |
| 4+ files, likely needs iteration                                     | Interactive team                     |
| Simple edits, well-specified                                         | One-shot DAG with `preset: 'worker'` |
| Cross-agent review feedback loop                                     | Interactive team                     |
| Independent tasks, no coordination                                   | Fan-out with non-interactive workers |
| Anything where the answer to "could this be `cmd1 \| cmd2`?" is _no_ | Interactive team                     |

### Chat-Native Coordination Recipes

Once you're in the Interactive Team shape, the channel is your coordination medium. These are recipes for using it well — they are _prompt-authoring patterns_, not new SDK surface. All of them assume interactive agents (no `preset`) sharing a `.channel('wf-...')`.

#### 1. Question / Answer (blocking ask)

When agent A needs information only agent B has, instruct A to **post a direct question and wait for a reply** rather than guessing or proceeding.

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

**Why it beats `{{steps.X.output}}`:** the answer depends on something only an agent (or human) can decide at runtime; encoding it as a prior step's stdout is wrong.

#### 2. Broadcast / Ack

When a lead needs _N workers to confirm receipt_ before proceeding (e.g., to make sure the plan was actually read), require explicit acks.

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

**Why it matters:** in the Codex history, the most common silent failure is a worker step that started but never read the channel. An ack gate makes "did you actually receive this?" deterministic without a separate verification step.

#### 3. Peer Review Handoff

The substantive form of "review my work." Worker pings reviewer in-channel with a concrete artifact reference; reviewer reads the actual files (not the chat); reviewer replies with a verdict.

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

**Pattern note:** the reviewer must read the files themselves — never let the worker paste the diff into chat. Channel messages are for _coordination_, not _content_. That's also what keeps you under output-token limits.

#### 4. Standup / Status Probe

For long-running workflows, have the lead post periodic `@-mention` probes so silently-stuck workers surface fast.

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

When work flows from agent A to agent B _during_ a workflow (not just between steps), have A post a structured handoff message so B doesn't re-derive context.

```typescript
.step('impl-a-work', {
  agent: 'impl-a',
  task: `... finish your part ...

When done, post a handoff to #wf-feature targeting the next worker:
"@impl-b HANDOFF: src/foo.ts ready. Touched: <files>. Open question: <if any>.
Tests: <pass/fail summary>. Commit: <sha>."`,
})
```

**Vs `{{steps.X.output}}`:** an output-chain forces B to parse A's entire stdout. A handoff message is a curated summary A writes for B — much higher signal, no PTY/ANSI noise.

#### Picking a recipe

| Need                                              | Recipe                    |
| ------------------------------------------------- | ------------------------- |
| One agent needs an answer from another at runtime | **Q/A**                   |
| Lead needs to confirm workers received the plan   | **Broadcast/Ack**         |
| Agent-to-agent code review                        | **Peer Review Handoff**   |
| Long-running team, want stalled-worker visibility | **Standup/Probe**         |
| Sequential agent work that needs context curation | **Hand-Off with Context** |

> **Authoring rule:** if your workflow has interactive agents on a channel but their task strings don't _instruct them to talk to each other_, you're not using the chat primitive — you've just paid the overhead of starting it. Either add an explicit recipe above, or drop to `preset: 'worker'` and pipeline-shape.

### Pipeline (sequential handoff)

Use this only for the linear implementation handoff. Production workflows still need repairable validation gates and the mandatory Claude-then-Codex review/fix loops before final acceptance.

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

For agent-team workflows, prefer `retry` over `fail-fast`, and use `.repairable()` or `.reliable()` when the installed SDK supports it. AgentWorkforce/relay#827 made reliability repair-aware: retry-mode workflows with agents should run repair agents before retrying failed or malformed agent steps, not only deterministic checks. Keep explicit repair steps when the failing output needs to be handed to a specific domain owner.

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
    captureOutput: true
    failOnError: false

  - name: fix-types-verification
    agent: dev
    dependsOn: [verify-types]
    task: |
      If verify-types failed, fix src/types.ts and rerun the verify command.
      Output:
      {{steps.verify-types.output}}
    verification:
      type: exit_code

  - name: verify-types-final
    type: deterministic
    dependsOn: [fix-types-verification]
    command: 'if git diff --quiet src/types.ts; then echo "NOT MODIFIED"; exit 1; fi; echo "OK"'
    captureOutput: true
    failOnError: true

  - name: read-service
    type: deterministic
    dependsOn: [verify-types-final]
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
    captureOutput: true
    failOnError: false

  - name: fix-service-verification
    agent: dev
    dependsOn: [verify-service]
    task: |
      If verify-service failed, fix src/service.ts and rerun the verify command.
      Output:
      {{steps.verify-service.output}}
    verification:
      type: exit_code

  - name: verify-service-final
    type: deterministic
    dependsOn: [fix-service-verification]
    command: 'if git diff --quiet src/service.ts; then echo "NOT MODIFIED"; exit 1; fi; echo "OK"'
    captureOutput: true
    failOnError: true

  # Deterministic commit — never rely on agents to commit
  - name: commit
    type: deterministic
    dependsOn: [verify-service-final]
    command: npm run typecheck && npm test && git add src/types.ts src/service.ts && git commit -m "feat: add pending status"
    captureOutput: true
    failOnError: false

  - name: repair-commit
    agent: dev
    dependsOn: [commit]
    task: |
      If commit failed, fix the blocker, rerun npm run typecheck && npm test, and create the commit.
      If commit passed, confirm the commit subject.
      Output:
      {{steps.commit.output}}
    verification:
      type: exit_code

  - name: verify-commit-created
    type: deterministic
    dependsOn: [repair-commit]
    command: 'git log -1 --pretty=%s | grep -q "^feat: add pending status$" && echo "COMMIT_OK" || (echo "COMMIT_MISSING"; exit 1)'
    captureOutput: true
    failOnError: true
```

**Key rules:**

- Read the file in a deterministic step right before the edit (not all files upfront)
- Tell the agent "Only edit this one file" to prevent it touching other files
- Verify tracked-only edits with `git diff --quiet`, hand failures back to an agent to repair, then rerun the deterministic check as proof
- If the edit may create new files/packages, verify with `git status --short -- <paths>` because `git diff --quiet` ignores untracked files
- Always commit with a deterministic step, never an agent step; rerun acceptance checks in that step, let an agent repair commit blockers, and prove the commit exists

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
  captureOutput: true
  failOnError: false

- name: fix-missing-files
  agent: impl-auth
  dependsOn: [verify-files]
  task: |
    If verify-files found missing files, create/fix them and rerun the check.
    Output:
    {{steps.verify-files.output}}
  verification:
    type: exit_code

- name: verify-files-final
  type: deterministic
  dependsOn: [fix-missing-files]
  command: |
    missing=0
    for f in src/auth/credentials.ts src/storage/client.ts; do
      if [ ! -f "$f" ]; then echo "MISSING: $f"; missing=$((missing+1)); fi
    done
    if [ $missing -gt 0 ]; then echo "$missing files missing"; exit 1; fi
    echo "All files present"
  captureOutput: true
  failOnError: true
```

**Rules for file-writing tasks:**

1. Use full paths from project root — say `src/auth/credentials.ts`, not `credentials.ts`
2. Add `IMPORTANT: Write the file to disk. Do NOT output to stdout.`
3. Use `file_exists` verification for creation steps (not just `exit_code`)
4. Gate all downstream steps on the final deterministic proof step that follows the repair step

### Edit Gates Must See Untracked Files

For gates that validate new files, generated artifacts, tests, or package
directories, do not use only `git diff --quiet -- <paths>`. `git diff` ignores
untracked files, so a valid new package can be misclassified as `NO_CHANGES`.

Use `git status --short -- <paths>` for materialization/edit gates, and keep
the first gate repairable:

```yaml
- name: provider-edit-gate-capture
  type: deterministic
  dependsOn: [implement-providers]
  command: |
    if [ -z "$(git status --short -- packages/new-provider .workflow-artifacts/my-flow)" ]; then
      echo "NO_PROVIDER_CHANGES"
      exit 1
    fi
    echo "PROVIDER_EDIT_GATE_OK"
  captureOutput: true
  failOnError: false

- name: repair-edit-gate
  agent: provider-worker
  dependsOn: [provider-edit-gate-capture]
  task: |
    If provider-edit-gate-capture reported NO_PROVIDER_CHANGES, inspect git
    status including untracked files and add the missing provider artifacts.
    If it already passed, do nothing.
  verification:
    type: exit_code

- name: provider-edit-gate-final
  type: deterministic
  dependsOn: [repair-edit-gate]
  command: |
    if [ -z "$(git status --short -- packages/new-provider .workflow-artifacts/my-flow)" ]; then
      echo "NO_PROVIDER_CHANGES"
      exit 1
    fi
    echo "PROVIDER_EDIT_GATE_FINAL_OK"
  captureOutput: true
  failOnError: false

- name: repair-provider-edit-gate-final
  agent: provider-worker
  dependsOn: [provider-edit-gate-final]
  task: |
    If provider-edit-gate-final is still red, repair the missing provider
    artifacts and rerun the check. If repair is impossible, write
    .workflow-artifacts/my-flow/BLOCKED_NO_COMMIT.md with exact evidence and
    do not commit.
    Output:
    {{steps.provider-edit-gate-final.output}}
  verification:
    type: exit_code
```

Both gates capture evidence and give an agent a chance to fix. A still-red
final gate becomes a blocked/no-commit artifact, not a workflow crash.

## Agent Transport Must Not Be The First Hard Gate

Interactive lead-and-worker teams are useful, but they are still process
sessions. A long-running PTY can go idle, emit noisy terminal output, or fail
to respawn with a transport error before the workflow reaches tests. If every
downstream gate depends directly on that agent step, the workflow can fail
without giving a repair owner command output to fix.

For long rollouts, keep the critical path evidence-based:

```typescript
.step('runtime-implementation', {
  agent: 'impl-runtime',
  dependsOn: ['context'],
  task: 'Implement the runtime slice and write .workflow-artifacts/runtime.md',
})
.step('adapter-implementation', {
  agent: 'impl-adapters',
  dependsOn: ['context'],
  task: 'Implement adapter wiring and write .workflow-artifacts/adapters.md',
})
.step('implementation-reconcile', {
  type: 'deterministic',
  dependsOn: ['context'],
  command: `git status --short -- packages/core packages/*/src/writeback.ts scripts tests .workflow-artifacts
test -f scripts/verify-e2e.mjs || echo "MISSING_E2E"
test -f packages/core/src/runtime/router.ts || echo "MISSING_ROUTER"`,
  captureOutput: true,
  failOnError: false,
})
.step('repair-implementation-reconcile', {
  agent: 'qa',
  dependsOn: ['implementation-reconcile'],
  task: `Finish anything missing before gates run:\n{{steps.implementation-reconcile.output}}`,
  verification: { type: 'exit_code' },
})
.step('run-e2e', {
  type: 'deterministic',
  dependsOn: ['repair-implementation-reconcile'],
  command: 'npm run verify:e2e',
  captureOutput: true,
  failOnError: false,
})
```

Implementation agents may still run and coordinate on a channel, but tests
depend on the reconcile/repair path. That makes transport failures advisory.
If final deterministic evidence is still red after repair, write a blocked
artifact and skip commit/PR creation rather than failing the workflow.

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

| Mistake                                                                                                                            | Fix                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Treating relay as transport, not as a coordination layer (every step is `preset: 'worker'`, every handoff is `{{steps.X.output}}`) | Default to **Conversation shape** for non-trivial work — interactive agents on a shared channel. Pipeline-shape is only correct when the work could be expressed as a `bash \| bash \| bash` pipe.                                       |
| Interactive agents on a channel whose task strings don't tell them to talk to each other                                           | Pick a [Chat-Native Coordination Recipe](#chat-native-coordination-recipes) (Q/A, Broadcast/Ack, Peer Review, Standup, Hand-Off) and bake it into the task prompt — otherwise you're paying for a chat substrate you're not using        |
| All workflows run sequentially                                                                                                     | Group independent workflows into parallel waves (4-7x speedup)                                                                                                                                                                           |
| Every step depends on the previous one                                                                                             | Only add `dependsOn` when there's a real data dependency                                                                                                                                                                                 |
| Self-review step with no timeout                                                                                                   | Set `timeout: 300_000` (5 min) — Codex hangs in non-interactive review                                                                                                                                                                   |
| One giant workflow per feature                                                                                                     | Split into smaller workflows that can run in parallel waves                                                                                                                                                                              |
| Adding exit instructions to tasks                                                                                                  | Runner handles self-termination automatically                                                                                                                                                                                            |
| Setting `timeoutMs` on agents/steps                                                                                                | Use global `.timeout()` only                                                                                                                                                                                                             |
| Using `general` channel                                                                                                            | Set `.channel('wf-name')` for isolation                                                                                                                                                                                                  |
| `{{steps.X.output}}` without `dependsOn: ['X']`                                                                                    | Output won't be available yet                                                                                                                                                                                                            |
| Requiring exact sentinel as only completion gate                                                                                   | Use `exit_code` or `file_exists` verification                                                                                                                                                                                            |
| Writing 100-line task prompts                                                                                                      | Split into lead + workers on a channel                                                                                                                                                                                                   |
| `maxConcurrency: 16` with many parallel steps                                                                                      | Cap at 5-6                                                                                                                                                                                                                               |
| Non-interactive agent reading large files via tools                                                                                | Pre-read in deterministic step, inject via `{{steps.X.output}}`                                                                                                                                                                          |
| Workers depending on lead step (deadlock)                                                                                          | Both depend on shared context step                                                                                                                                                                                                       |
| Validation gates depending directly on long interactive implementation agents                                                      | Add a deterministic implementation-reconcile step and make gates depend on its repair step                                                                                                                                               |
| `fan-out`/`hub-spoke` for simple parallel workers                                                                                  | Use `dag` instead                                                                                                                                                                                                                        |
| `pipeline` but expecting auto-supervisor                                                                                           | Only hub patterns auto-harden. Use `.pattern('supervisor')`                                                                                                                                                                              |
| Workers without `preset: 'worker'` in one-shot DAG lead+worker flows                                                               | Add preset for clean stdout when chaining `{{steps.X.output}}` (not needed for interactive team patterns)                                                                                                                                |
| Using `_` in YAML numbers (`timeoutMs: 1_200_000`)                                                                                 | YAML doesn't support `_` separators                                                                                                                                                                                                      |
| Workflow timeout under 30 min for complex workflows                                                                                | Use `3600000` (1 hour) as default                                                                                                                                                                                                        |
| Using `require()` in ESM projects                                                                                                  | Check `package.json` for `"type": "module"` — use `import` if ESM                                                                                                                                                                        |
| Raw top-level `await` in workflow files                                                                                            | Executor paths may compile as CJS. Wrap `.run()` in `async function runWorkflow()` for both ESM and CJS files                                                                                                                            |
| Using `createWorkflowRenderer`                                                                                                     | Does not exist. Use `.run({ cwd: process.cwd() })`                                                                                                                                                                                       |
| `export default workflow(...)...build()`                                                                                           | No `.build()`. Chain ends with `.run()` — the file must call `.run()`, not just export config                                                                                                                                            |
| Relative import `'../workflows/builder.js'`                                                                                        | Use `import { workflow } from '@agent-relay/sdk/workflows'`                                                                                                                                                                              |
| Hardcoded model strings (`model: 'opus'`)                                                                                          | Use constants: `import { ClaudeModels } from '@agent-relay/config'` → `model: ClaudeModels.OPUS`                                                                                                                                         |
| Thinking `agent-relay run` inspects exports                                                                                        | It executes the file as a subprocess. Only `.run()` invocations trigger steps                                                                                                                                                            |
| `pattern('single')` on cloud runner                                                                                                | Not supported — use `dag`                                                                                                                                                                                                                |
| `pattern('supervisor')` with one agent                                                                                             | Same agent is owner + specialist. Use `dag`                                                                                                                                                                                              |
| Invalid verification type (`type: 'deterministic'`)                                                                                | Only `exit_code`, `output_contains`, `file_exists`, `custom` are valid                                                                                                                                                                   |
| Chaining `{{steps.X.output}}` from interactive agents                                                                              | PTY output is garbled. Use deterministic steps or `preset: 'worker'`                                                                                                                                                                     |
| Single step editing 4+ files                                                                                                       | Agents modify 1-2 then exit. Split to one file per step with verify gates                                                                                                                                                                |
| Relying on agents to `git commit`                                                                                                  | Agents emit markers without running git. Use deterministic commit step                                                                                                                                                                   |
| File-writing steps without `file_exists` verification                                                                              | `exit_code` auto-passes even if no file written                                                                                                                                                                                          |
| Edit gate uses `git diff --quiet` for new files/packages                                                                           | `git diff` ignores untracked files and can fail a valid implementation with `NO_CHANGES`; use `git status --short -- <paths>` for materialization gates                                                                                  |
| Hard-stop validation gates in product workflows                                                                                    | A red check stops the agent team at the exact moment it should fix the problem. Capture gate output with `failOnError: false`, add a repair agent step, rerun, and reserve hard failure for exhausted repair budget or external blockers |
| Final acceptance before repair and dual review                                                                                     | Broken work can stop or commit without giving the team a final chance to fix it. Run repairable gates first, then the Claude-then-Codex review/fix loops, then final deterministic acceptance before commit/PR                           |
| Skipping the mandatory dual review loops                                                                                           | Add sequential Claude-then-Codex fresh-eyes review/fix loops after repairable verification and before final acceptance, commit, PR creation, or handoff                                                                                  |
| Treating optional notification credentials as fatal                                                                                | Workflow progress gets blocked by a non-core side effect. Prefer primitive/runtime fallbacks such as the Slack primitive's `cloud-relay` or `noop` shape from AgentWorkforce/relay#823 when notification is not the product contract     |
| Manual peer fanout in `handleChannelMessage()`                                                                                     | Use broker-managed channel subscriptions — broker fans out to all subscribers automatically                                                                                                                                              |
| Client-side `personaNames.has(from)` filtering                                                                                     | Use `relay.subscribe()`/`relay.unsubscribe()` — only subscribed agents receive messages                                                                                                                                                  |
| Agents receiving noisy cross-channel messages during focused work                                                                  | Use `relay.mute({ agent, channel })` to silence non-primary channels without leaving them                                                                                                                                                |
| Hardcoding all channels at spawn time                                                                                              | Use `agent.subscribe()` / `agent.unsubscribe()` for dynamic channel membership post-spawn                                                                                                                                                |
| Using `preset: 'worker'` for Codex in _interactive team_ patterns when coordination is needed                                      | Codex interactive mode works fine with PTY channel injection. Drop the preset for interactive team patterns (keep it for one-shot DAG workers where clean stdout matters)                                                                |
| Treating the lead's informal review as final signoff                                                                               | The lead may review during implementation, but final signoff still requires the mandatory Claude-then-Codex fresh-eyes review/fix loops                                                                                                  |
| Not printing PR URL after `createGitHubStep({ action: 'createPR' })`                                                               | Capture `html_url` with `output: { mode: 'data', format: 'json', path: 'html_url' }` and echo or write it in a final deterministic step                                                                                                  |
| Workflow ending without worktree + PR for cross-repo changes                                                                       | Add `setup-worktree` at start and `push-and-pr` + `cleanup-worktree` at end                                                                                                                                                              |

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
  - name: claude-reviewer
    cli: claude
    preset: reviewer
    role: First-pass fresh-eyes reviewer
  - name: claude-fixer
    cli: claude
    role: First-pass review fixer
  - name: codex-reviewer
    cli: codex
    preset: reviewer
    role: Second-pass fresh-eyes reviewer
  - name: codex-fixer
    cli: codex
    role: Second-pass review fixer
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
      - name: claude-review
        agent: claude-reviewer
        dependsOn: [implement]
        task: 'Review actual files, diff, rules, and evidence. Write .workflow-artifacts/my-workflow/claude-review.md with findings or NO_ISSUES_FOUND.'
      - name: claude-fix
        agent: claude-fixer
        dependsOn: [claude-review]
        task: 'Fix valid Claude review findings, add or update appropriate tests/proofs, rerun relevant checks, and write .workflow-artifacts/my-workflow/claude-fix.md.'
      - name: claude-review-final
        agent: claude-reviewer
        dependsOn: [claude-fix]
        task: 'Review the post-Claude-fix state from scratch and write .workflow-artifacts/my-workflow/claude-review-final.md.'
      - name: claude-fix-final
        agent: claude-fixer
        dependsOn: [claude-review-final]
        task: 'Fix remaining Claude findings, add/update tests or proofs, or write .workflow-artifacts/my-workflow/BLOCKED_NO_COMMIT.md.'
      - name: codex-review
        agent: codex-reviewer
        dependsOn: [claude-fix-final]
        task: 'Review the post-Claude-fix state from scratch. Write .workflow-artifacts/my-workflow/codex-review.md with findings or NO_ISSUES_FOUND.'
      - name: codex-fix
        agent: codex-fixer
        dependsOn: [codex-review]
        task: 'Fix valid Codex review findings, add or update appropriate tests/proofs, rerun relevant checks, and write .workflow-artifacts/my-workflow/codex-fix.md.'
      - name: codex-review-final
        agent: codex-reviewer
        dependsOn: [codex-fix]
        task: 'Review the post-Codex-fix state from scratch and write .workflow-artifacts/my-workflow/codex-review-final.md.'
      - name: codex-fix-final
        agent: codex-fixer
        dependsOn: [codex-review-final]
        task: 'Fix remaining Codex findings, add/update tests or proofs, or write .workflow-artifacts/my-workflow/BLOCKED_NO_COMMIT.md.'
      - name: acceptance-after-review
        type: deterministic
        dependsOn: [codex-fix-final]
        command: 'test ! -f .workflow-artifacts/my-workflow/BLOCKED_NO_COMMIT.md && echo ACCEPTANCE_OK'
        captureOutput: true
        failOnError: true
```

Run with: `agent-relay run path/to/workflow.yaml`

## Available Swarm Patterns

`dag` (default), `fan-out`, `pipeline`, `hub-spoke`, `consensus`, `mesh`, `handoff`, `cascade`, `debate`, `hierarchical`, `map-reduce`, `scatter-gather`, `supervisor`, `reflection`, `red-team`, `verifier`, `auction`, `escalation`, `saga`, `circuit-breaker`, `blackboard`, `swarm`

See skill `choosing-swarm-patterns` for pattern selection guidance.
