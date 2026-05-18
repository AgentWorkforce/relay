---
name: choosing-swarm-patterns
description: Use when coordinating multiple AI agents with Agent Relay's workflow engine and need to pick the right orchestration pattern - covers the 10 core patterns (fan-out, pipeline, hub-spoke, consensus, mesh, handoff, cascade, dag, debate, hierarchical) plus 14 specialized ones, with decision framework and accurate SDK/YAML examples.
---

# Choosing Swarm Patterns

## Overview

The Agent Relay SDK (`@agent-relay/sdk`) supports 24 swarm patterns via a single `swarm.pattern` field. Patterns are configured declaratively in YAML or programmatically via the `workflow()` fluent builder — there are no standalone `fanOut(...)` / `hubAndSpoke(...)` helpers. Pick the simplest pattern that solves the problem; add complexity only when the system proves it's insufficient.

## Two ways to run a pattern

**1. YAML (portable):**

```ts
import { runWorkflow } from '@agent-relay/sdk/workflows';

const run = await runWorkflow('workflows/feature-dev.yaml', {
  vars: { task: 'Add OAuth login' },
});
```

**2. Fluent builder (programmatic):**

```ts
import { workflow } from '@agent-relay/sdk/workflows';

const run = await workflow('feature-dev')
  .pattern('hub-spoke')
  .channel('swarm-feature-dev')
  .agent('lead', { cli: 'claude', role: 'lead' })
  .agent('developer', { cli: 'codex', role: 'worker', interactive: false })
  .step('plan', { agent: 'lead', task: 'Plan {{task}}' })
  .step('implement', { agent: 'developer', task: 'Implement: {{steps.plan.output}}', dependsOn: ['plan'] })
  .run();
```

Both paths hit the same `WorkflowRunner`.

## Quick Decision Framework

```
Is the task independent per agent?
  YES → fan-out (parallel workers, hub collects)

Does each step need the previous step's output?
  YES → Is it strictly linear?
    YES → pipeline
    NO  → dag (parallel where possible, `dependsOn` edges)

Does a coordinator need to stay alive and adapt?
  YES → hub-spoke (single-level hub + workers)
        hierarchical (structurally identical in current impl; use for naming/intent)

Is the task about making a decision?
  YES → Do agents need to argue opposing sides?
    YES → debate (adversarial, full mesh)
    NO  → consensus (cooperative, full mesh + coordination.consensusStrategy)

Does the right specialist emerge during processing?
  YES → handoff (sequential chain, one active at a time)

Do all agents need to freely collaborate?
  YES → mesh (full peer-to-peer edges)

Is cost the primary concern?
  YES → cascade (chain of increasingly capable agents; each step's prompt
        decides whether to pass through or redo the prior output)
```

## Pattern Reference (Core 10)

| #   | Pattern          | Topology (actual edges)                                                                                             | Best For                                                                    |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | **fan-out**      | Hub broadcasts to N workers; workers reply to hub only                                                              | Independent subtasks (reviews, research, tests)                             |
| 2   | **pipeline**     | Linear chain (agent*i → agent*{i+1})                                                                                | Ordered stages (design → implement → test)                                  |
| 3   | **hub-spoke**    | Hub ↔ spokes (bidirectional); no spoke-to-spoke                                                                     | Dynamic coordination, lead reviews/adjusts                                  |
| 4   | **consensus**    | Full mesh; decision via `coordination.consensusStrategy`                                                            | Architecture decisions, approval gates                                      |
| 5   | **mesh**         | Full mesh (every agent ↔ every other)                                                                               | Brainstorming, collaborative debugging                                      |
| 6   | **handoff**      | Chain; passes control forward                                                                                       | Triage, specialist routing                                                  |
| 7   | **cascade**      | Chain of `dependsOn` steps; all run on success, downstream skipped on upstream failure (no built-in "fall through") | Cost optimization: cheap first, each step's prompt passes through or redoes |
| 8   | **dag**          | Edges from step `dependsOn`                                                                                         | Mixed dependencies, parallel where possible                                 |
| 9   | **debate**       | Full mesh (same topology as mesh; roles drive behavior)                                                             | Rigorous adversarial examination                                            |
| 10  | **hierarchical** | Hub + subordinates (single-level in current impl)                                                                   | Large teams; semantic distinction from hub-spoke                            |

> **Heads up:** `hierarchical` resolves to the same edge structure as `hub-spoke` in `coordinator.ts:313-319`. Multi-level tree topology is not currently implemented — use pattern name for intent, but expect the same runtime graph.

## Additional Patterns (role-driven)

These 14 additional patterns exist in `SwarmPattern` (types.ts:114-139). The coordinator has role-based auto-selection heuristics (`coordinator.ts:51-165`), but they only fire when `swarm.pattern` is **omitted** — YAML validation requires it (`runner.ts:2105-2117`), so auto-selection is effectively a programmatic-API feature. In YAML, set `swarm.pattern` explicitly.

Topology is still resolved per-pattern once selected; the "Triggering roles" column reflects what the coordinator looks for to shape edges (per `coordinator.ts:250-450`):

| Pattern           | Roles the topology keys off                             | Topology                                       |
| ----------------- | ------------------------------------------------------- | ---------------------------------------------- |
| `map-reduce`      | `mapper` + `reducer`                                    | coordinator → mappers → reducers → coordinator |
| `scatter-gather`  | —                                                       | hub → workers → hub                            |
| `supervisor`      | `supervisor`                                            | supervisor ↔ workers                           |
| `reflection`      | `critic` or `reviewer` (auto-select uses `critic` only) | producers → critic → producers (loop)          |
| `red-team`        | `attacker`/`red-team` + `defender`/`blue-team`          | adversarial mesh with optional judges          |
| `verifier`        | `verifier`                                              | producers → verifiers → back to producers      |
| `auction`         | `auctioneer`                                            | auctioneer → bidders → auctioneer              |
| `escalation`      | `tier-*`                                                | tiered chain, escalate up / report down        |
| `saga`            | `saga-orchestrator`, `compensate-handler`               | orchestrator ↔ participants                    |
| `circuit-breaker` | `primary` + `fallback`/`backup`                         | try primary, fallback on failure               |
| `blackboard`      | `blackboard` / `shared-workspace`                       | shared state hub                               |
| `swarm`           | `hive-mind` / `swarm-agent`                             | stigmergy-style                                |
| `competitive`     | — (declared explicitly)                                 | independent parallel implementations + judge   |
| `review-loop`     | `implement*` + 2+ `reviewer*`                           | implementer ↔ reviewers                        |

## Pattern Details

All examples below use real API shapes (`WorkflowBuilder` / YAML), verified against `packages/sdk/src/workflows/builder.ts` and `packages/sdk/src/workflows/types.ts`.

> **YAML fragments vs complete configs:** The per-pattern YAML snippets below are fragments that show only the pattern-relevant shape. A runnable YAML file also requires `version: "1.0"` and `name: <id>` at the top (`runner.ts:2105-2117`). See the [Complete YAML Example](#complete-yaml-example) for the full structure.
>
> **Topology edges exclude `interactive: false` agents.** `resolveTopology` (`coordinator.ts:218-237`) drops non-interactive agents from the message graph — they run as one-shot subprocesses with no relay connection. Topology claims like "hub ↔ spokes" describe the interactive-agent edges; workers marked `interactive: false` are spawned and collected via stdout, not via relay messages.

### 1. fan-out — Parallel Workers

```ts
await workflow('review')
  .pattern('fan-out')
  .agent('lead', { cli: 'claude', role: 'lead' })
  .agent('auth-rev', { cli: 'claude', role: 'worker', interactive: false })
  .agent('db-rev', { cli: 'claude', role: 'worker', interactive: false })
  .step('review-auth', { agent: 'auth-rev', task: 'Review auth.ts' })
  .step('review-db', { agent: 'db-rev', task: 'Review db.ts' })
  .run();
```

Workers run independently; hub aggregates. No inter-worker edges.

### 2. pipeline — Sequential Stages

```yaml
swarm: { pattern: pipeline }
agents:
  - { name: designer, cli: claude }
  - { name: implementer, cli: codex, interactive: false }
  - { name: tester, cli: codex, interactive: false }
workflows:
  - name: build
    steps:
      - {
          name: design,
          agent: designer,
          task: 'Design the API schema',
          verification: { type: output_contains, value: DONE },
        }
      - {
          name: implement,
          agent: implementer,
          dependsOn: [design],
          task: 'Implement: {{steps.design.output}}',
        }
      - { name: test, agent: tester, dependsOn: [implement], task: 'Write integration tests' }
```

Each stage receives the previous stage's output via `{{steps.<name>.output}}`. Halts on step failure unless `onError: retry` / `continue`.

### 3. hub-spoke — Persistent Coordinator

```ts
await workflow('api-build')
  .pattern('hub-spoke')
  .channel('swarm-api')
  .agent('lead', { cli: 'claude', role: 'lead' })
  .agent('db-worker', { cli: 'claude', role: 'worker' }) // interactive by default — hub DMs it
  .agent('api-worker', { cli: 'claude', role: 'worker' }) // interactive by default — hub DMs it
  .step('models', { agent: 'db-worker', task: 'Build database models' })
  .step('routes', { agent: 'api-worker', task: 'Build route handlers', dependsOn: ['models'] })
  .step('review', { agent: 'lead', task: 'Review everything', dependsOn: ['routes'] })
  .run();
```

Hub (picked via `role: lead` or first agent) stays on the channel and direct-messages interactive workers via `mcp__relaycast__message_dm_send`.

> **Don't set `interactive: false` on a hub-spoke worker** if you want it to receive coordination DMs — `resolveTopology` strips non-interactive agents from the message graph (`coordinator.ts:218-237`). Use `interactive: false` only when the worker is a one-shot subprocess whose stdout you collect via `{{steps.X.output}}` without any mid-run coordination.

### 4. consensus — Cooperative Voting

```yaml
swarm: { pattern: consensus }
agents:
  - { name: perf, cli: claude, role: reviewer }
  - { name: dx, cli: claude, role: reviewer }
  - { name: sec, cli: claude, role: reviewer }
coordination:
  consensusStrategy: majority # declarative marker: majority | unanimous | quorum
  votingThreshold: 0.66
workflows:
  - name: decide
    steps:
      - { name: evaluate-perf, agent: perf, task: 'Evaluate perf of Fastify migration' }
      - { name: evaluate-dx, agent: dx, task: 'Evaluate DX of Fastify migration' }
      - { name: evaluate-sec, agent: sec, task: 'Evaluate security of Fastify migration' }
```

Full-mesh topology. **Caveat:** `coordination.consensusStrategy` and `votingThreshold` are declared in `CoordinationConfig` (`types.ts:768-772`) but the runner has **no built-in vote-tallying logic** — the fields only influence coordinator auto-selection (`coordinator.ts:63-64`). To implement voting, aggregate the step outputs in a downstream lead/judge step that reads `{{steps.evaluate-*.output}}`.

### 5. mesh — Peer Collaboration

```ts
await workflow('debug-auth')
  .pattern('mesh')
  .channel('swarm-debug')
  .agent('logs', { cli: 'claude' })
  .agent('code', { cli: 'claude' })
  .agent('repro', { cli: 'claude' })
  .step('logs', { agent: 'logs', task: 'Check server logs' })
  .step('code', { agent: 'code', task: 'Review auth code' })
  .step('repro', { agent: 'repro', task: 'Write repro test' })
  .run();
```

Every agent ↔ every other agent. Use for collaborative exploration without hierarchy.

### 6. handoff — Dynamic Routing

```yaml
swarm: { pattern: handoff }
agents:
  - { name: triage, cli: claude }
  - { name: billing, cli: claude }
  - { name: tech, cli: claude }
workflows:
  - name: support
    steps:
      - { name: triage, agent: triage, task: 'Triage: {{request}}' }
      - { name: billing, agent: billing, dependsOn: [triage], task: 'Handle billing' }
      - { name: tech, agent: tech, dependsOn: [triage], task: 'Handle tech issues' }
```

Chain passes control forward. **Note:** The runner doesn't support "route to one branch and skip the others" declaratively — `dependsOn` steps all run when their dependencies complete, and skipping is only triggered by upstream **failure** (`runner.ts:7057-7088`). For true pick-one routing, have the triage step emit a routing token in its output and let each downstream step's prompt check `{{steps.triage.output}}` and no-op if it doesn't match.

### 7. cascade — Cost-Aware Fallthrough

```ts
await workflow('answer')
  .pattern('cascade')
  .agent('haiku', { cli: 'claude', model: 'claude-haiku-4-5-20251001' })
  .agent('sonnet', { cli: 'claude', model: 'claude-sonnet-4-6' })
  .agent('opus', { cli: 'claude', model: 'claude-opus-4-7' })
  .step('try-haiku', { agent: 'haiku', task: '{{question}}' })
  .step('try-sonnet', {
    agent: 'sonnet',
    task: 'If this is a complete answer, echo it verbatim. Otherwise answer anew:\n{{steps.try-haiku.output}}',
    dependsOn: ['try-haiku'],
  })
  .step('try-opus', {
    agent: 'opus',
    task: 'Final-tier answer, using prior attempts for context:\n{{steps.try-sonnet.output}}',
    dependsOn: ['try-sonnet'],
  })
  .run();
```

**Important:** `cascade` only sets edge topology. The runner has **no skip-on-success logic** for the cascade pattern — a chain of `dependsOn` steps all execute in order on success, and failed upstream steps mark their dependents as **skipped** (`step-executor.ts:329-334`, `runner.ts:7057-7088`). So a verification-gated first step won't "fall through" to later steps on failure, and won't skip them on success either. The idiom above delegates the escalation decision to the prompt of each downstream step (read the upstream answer and pass-through or redo). No confidence-score parsing exists in-engine.

### 8. dag — Directed Acyclic Graph

```ts
await workflow('fullstack')
  .pattern('dag')
  .maxConcurrency(3)
  .agent('dev', { cli: 'codex', role: 'worker' })
  .step('scaffold', { agent: 'dev', task: 'Create project scaffold' })
  .step('frontend', { agent: 'dev', task: 'Build React UI', dependsOn: ['scaffold'] })
  .step('backend', { agent: 'dev', task: 'Build API', dependsOn: ['scaffold'] })
  .step('integrate', { agent: 'dev', task: 'Wire together', dependsOn: ['frontend', 'backend'] })
  .run();
```

Runner derives execution waves from `dependsOn`; independent nodes run in parallel up to `swarm.maxConcurrency`. The `dag` pattern is auto-selected when any step has `dependsOn`.

### 9. debate — Adversarial Refinement

Debate currently shares the **full-mesh** topology with `mesh` and `consensus`. Differentiate via roles + task prompts:

```yaml
swarm: { pattern: debate }
agents:
  - { name: pro, cli: claude, role: debater, task: 'Argue FOR monorepo' }
  - { name: con, cli: claude, role: debater, task: 'Argue FOR polyrepo' }
  - { name: judge, cli: claude, role: judge, task: 'Decide after 3 rounds' }
coordination:
  barriers:
    - { name: debate-done, waitFor: [pro-round-3, con-round-3] }
```

Drive rounds and verdicts through the agent's system prompt/task, not a dedicated `maxRounds` knob — there isn't one at the pattern level.

### 10. hierarchical — Multi-Level (structurally hub-spoke today)

```ts
await workflow('large-team')
  .pattern('hierarchical')
  .agent('lead', { cli: 'claude', role: 'lead' })
  .agent('fe-coord', { cli: 'claude', role: 'coordinator' })
  .agent('be-coord', { cli: 'claude', role: 'coordinator' })
  .agent('fe-dev', { cli: 'codex', role: 'worker', interactive: false })
  .agent('be-dev', { cli: 'codex', role: 'worker', interactive: false })
  .step('plan', { agent: 'lead', task: 'Coordinate full-stack app' })
  .step('fe-plan', { agent: 'fe-coord', task: 'Manage frontend', dependsOn: ['plan'] })
  .step('be-plan', { agent: 'be-coord', task: 'Manage backend', dependsOn: ['plan'] })
  .step('fe-impl', { agent: 'fe-dev', task: 'Build components', dependsOn: ['fe-plan'] })
  .step('be-impl', { agent: 'be-dev', task: 'Build API', dependsOn: ['be-plan'] })
  .run();
```

Coordinator/worker distinction is expressed in step `dependsOn` graph, not topology. Agent edges collapse to single-level hub-spoke.

## Verification & Completion Signals

An agent step can complete in several ways (`runner.ts:5353-5395`, `runner.ts:4527-4538`):

- **Verification pass** — when the step declares a `verification` block and the output satisfies it.
- **Clean process exit** — agent exits 0 with no verification configured.
- **Evidence-based** — channel posts, file changes, or coordination signals trigger completion.
- **Owner decision** — a `lead`-role agent posts `COMPLETE` / `INCOMPLETE_RETRY` / `INCOMPLETE_FAIL` for the step.

Verification block shape:

```yaml
verification:
  type: output_contains # or: exit_code | file_exists | custom
  value: DONE # or: PLAN_COMPLETE, IMPLEMENTATION_COMPLETE, REVIEW_COMPLETE
```

Conventional signals baked into the adapter (`relay-adapter.ts:29-36`):

- `ACK: ...` — received a task
- `DONE: ...` — task complete

The runner captures PTY chunks as step output and also records channel posts + file changes as `StepCompletionEvidence`. Legacy fallback: a file at `.relay/summaries/{stepName}.md` is read if PTY output is empty (`runner.ts:6607`).

## Relaycast MCP — Correct Tool Names

The skill previously referenced `mcp__relaycast__send` / `mcp__relaycast__dm` — those names are wrong. The real tools (the first three are cited in the workflow convention-injection at `relay-adapter.ts:31-35`; the rest are exposed by the live `relaycast` MCP server):

| Purpose                  | Tool                                  | Source                |
| ------------------------ | ------------------------------------- | --------------------- |
| Send DM to another agent | `mcp__relaycast__message_dm_send`     | `relay-adapter.ts:31` |
| Check inbox              | `mcp__relaycast__message_inbox_check` | `relay-adapter.ts:35` |
| List agents              | `mcp__relaycast__agent_list`          | `relay-adapter.ts:35` |
| Post to a channel        | `mcp__relaycast__message_post`        | relaycast MCP server  |
| Reply in a thread        | `mcp__relaycast__message_reply`       | relaycast MCP server  |
| Spawn sub-agent          | `mcp__relaycast__agent_add`           | relaycast MCP server  |
| Remove sub-agent         | `mcp__relaycast__agent_remove`        | relaycast MCP server  |

> `interactive: false` agents run as non-interactive subprocesses with no relay connection — they must NOT call any `mcp__relaycast__*` tool (validator warns on this at `validator.ts:138-150`, check `NONINTERACTIVE_RELAY`).

## Reflection (Trajectories)

Reflection is **not** a `reflectionThreshold` callback. It's configured via the `trajectories:` block:

```yaml
trajectories:
  enabled: true
  reflectOnBarriers: true # config flag exists but runner does NOT currently invoke this path
  reflectOnConverge: true # fires at parallel convergence points (runner.ts:2762-2779)
  autoDecisions: true # record retry/skip/fail decisions
```

**What actually runs today:** only `reflectOnConverge` is wired into the runner (`runner.ts:2762-2779`). `shouldReflectOnBarriers` is defined in `trajectory.ts:486-487` but not called — set the flag if you want forward compatibility, but don't depend on it.

Programmatic equivalent:

```ts
workflow('x').trajectories({ enabled: true, reflectOnConverge: true });
```

For a first-class critic loop, use the `reflection` **pattern** (agents with `role: critic` get wired as reviewers in `coordinator.ts:363-378`).

## Common Mistakes

| Mistake                                      | Why It Fails                                                                  | Fix                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Using mesh/debate for everything             | Full-mesh blows up message volume past ~5 agents                              | Use hub-spoke or dag for most tasks                                                           |
| Pipeline for independent work                | Sequential bottleneck                                                         | Use fan-out or dag                                                                            |
| Hub-spoke for 2 agents                       | Hub is unnecessary overhead                                                   | Use pipeline or fan-out                                                                       |
| Expecting `consensusStrategy` to tally votes | Runner has no vote-tally logic; field only affects coordinator auto-selection | Aggregate votes in a judge/lead step that reads `{{steps.*.output}}`                          |
| Handoff with "routing = skip other branches" | Skipping only fires on upstream **failure**, not routing decisions            | Emit a routing token in triage output; downstream prompts self-no-op if token doesn't match   |
| Cascade expecting skip-on-success            | Runner has no cascade skip logic; failed upstream skips downstream            | Chain downstream prompts to pass-through or redo based on `{{steps.previous.output}}`         |
| Relying on `reflectOnBarriers`               | Config flag exists but runner never calls it                                  | Use `reflectOnConverge` for convergence reflection; use `reflection` pattern for critic loops |
| `interactive: false` agent calling MCP       | Non-interactive subprocess has no relay                                       | Use `interactive: true` (default) or emit output on stdout                                    |
| Relying on multi-level `hierarchical`        | Topology is single-level hub in current impl                                  | Use pattern for naming; model levels via `dependsOn` graph                                    |
| Writing `mcp__relaycast__send(...)`          | Wrong tool name                                                               | Use `mcp__relaycast__message_post` or `message_dm_send`                                       |

## Resume & Re-run

```ts
// Resume a failed run:
await runWorkflow('feature-dev.yaml', { resume: '<runId>' });

// Skip ahead, re-using cached outputs from an earlier run:
await runWorkflow('feature-dev.yaml', {
  startFrom: 'review',
  previousRunId: '<runId>',
});
```

Cached outputs live in `.agent-relay/step-outputs/`; runs in `.agent-relay/workflow-runs.jsonl`. Env vars `RESUME_RUN_ID`, `START_FROM`, `PREVIOUS_RUN_ID` are auto-detected.

## Complete YAML Example

```yaml
version: '1.0'
name: feature-dev
description: 'Blueprint-style feature development with quality gates.'
swarm:
  pattern: hub-spoke
  maxConcurrency: 2
  timeoutMs: 3600000
  channel: swarm-feature-dev
  idleNudge: { nudgeAfterMs: 120000, escalateAfterMs: 120000, maxNudges: 1 }
agents:
  - { name: lead, cli: claude, role: lead, permissions: { access: full } }
  - { name: planner, cli: codex, role: planner, interactive: false, permissions: { access: readonly } }
  - { name: developer, cli: codex, role: worker, interactive: false, permissions: { access: readwrite } }
  - { name: reviewer, cli: claude, role: reviewer, permissions: { access: readonly } }
workflows:
  - name: feature-delivery
    onError: retry
    preflight:
      - { command: 'git status --porcelain', failIf: non-empty, description: 'Clean worktree' }
    steps:
      - name: plan
        agent: planner
        task: 'Plan: {{task}}'
        verification: { type: output_contains, value: PLAN_COMPLETE }
      - name: implement
        agent: developer
        dependsOn: [plan]
        task: 'Implement: {{steps.plan.output}}'
        verification: { type: output_contains, value: IMPLEMENTATION_COMPLETE }
      - name: test
        type: deterministic
        dependsOn: [implement]
        command: npm test
      - name: review
        agent: reviewer
        dependsOn: [test]
        task: 'Review implementation'
        verification: { type: output_contains, value: REVIEW_COMPLETE }
coordination:
  barriers:
    - { name: delivery-ready, waitFor: [plan, implement, review], timeoutMs: 900000 }
trajectories:
  enabled: true
  reflectOnBarriers: true
  reflectOnConverge: true
errorHandling:
  strategy: retry
  maxRetries: 2
  retryDelayMs: 5000
```

Built-in templates: `packages/sdk/src/workflows/builtin-templates/` (feature-dev, bug-fix, code-review, competitive, documentation, refactor, review-loop, security-audit).

## Source of Truth

| Claim                                                             | File                                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Pattern enum (24 patterns)                                        | `packages/sdk/src/workflows/types.ts:114-139`                                |
| Topology resolution per pattern                                   | `packages/sdk/src/workflows/coordinator.ts:240-450`                          |
| Interactive-only topology edges                                   | `packages/sdk/src/workflows/coordinator.ts:218-237`                          |
| Pattern auto-selection heuristics (programmatic API only)         | `packages/sdk/src/workflows/coordinator.ts:51-165`                           |
| `WorkflowBuilder` fluent API                                      | `packages/sdk/src/workflows/builder.ts`                                      |
| `runWorkflow(yamlPath, options)`                                  | `packages/sdk/src/workflows/run.ts`                                          |
| YAML validation requires `version` + `name` + `swarm.pattern`     | `packages/sdk/src/workflows/runner.ts:2105-2117`                             |
| MCP tool names cited in convention-injection                      | `packages/sdk/src/relay-adapter.ts:29-36`                                    |
| Completion modes (verification / evidence / owner / process-exit) | `packages/sdk/src/workflows/runner.ts:5353-5395`, `4527-4538`                |
| Completion via PTY + summary fallback                             | `packages/sdk/src/workflows/runner.ts:6600-6615`                             |
| Downstream skip on upstream failure (not success)                 | `packages/sdk/src/workflows/runner.ts:7057-7088`, `step-executor.ts:329-334` |
| Trajectory reflection (only `reflectOnConverge` wired)            | `packages/sdk/src/workflows/runner.ts:2762-2779`, `trajectory.ts:173-190`    |
