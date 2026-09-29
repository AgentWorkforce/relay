# Writing Relayflows

Use when authoring a Relayflows flow (@relayflows/surface / @relayflows/sdk, the journal-based v2 engine — the CLI is `flows`, package versions 2.0.x) in TypeScript or YAML/JSON. Covers the three-rung ladder (run/llm/agent), resident verbs, direct child-flow composition with use/dispatch, Cloud dashboard mirroring, verification gates, cli/model selection, flows.json, and `flows check`/`run`/`resume`. Not for the older, unrelated `@relayflows/core` WorkflowBuilder engine (`.pattern('dag')`/.agent()/.step() chains) that `writing-agent-relay-workflows` and `migrating-persona-to-relayflow` cover — that's a different product despite the similar name.

## Overview

Relayflows turns a coding-agent task into steps a journal can inspect, verify, and resume. A flow is data (YAML/JSON) or code (TypeScript) that compiles to the same journal-backed kernel spec. Every effect is journaled before it's treated as real — a journal write that fails fails the step, with no silent fallback.

**Name collision warning.** This repo also has skills for an older, unrelated engine that is _also_ casually called "Relayflow" (singular) — `@relayflows/core`'s `WorkflowBuilder`, a chained builder (`workflow('name').pattern('dag').agent(...).step(...).run()`). That's `writing-agent-relay-workflows` and `migrating-persona-to-relayflow`'s territory. This skill is the **v2** engine: `@relayflows/surface`'s `flow()` function and the YAML/JSON dialect compiled by `@relayflows/sdk`. If you see `.pattern(`, `.agent(` as a chained builder call, or `ctx.workflow.run()`, you're in the other engine — stop and use one of those skills instead.

## When to use this skill

- Writing a new `.flow.ts` or `.flow.yaml`/`.flow.json` for the `flows` CLI (package `@relayflows/sdk`, binary name `flows`).
- Deciding whether a step needs `run` (shell), `llm` (bare model call), or `agent` (harnessed coding agent in a workspace).
- Wiring up `cli`/`model` for an `agent` or `llm` step, in either language.
- Debugging a `REFUSED [...]` message from `flows check` or `flows run`.
- Choosing between TypeScript and YAML for a given flow.

## The ladder

Three step verbs, one per rung — never more (`packages/sdk/src/spec.ts`, `export type StepType = 'deterministic' | 'llm' | 'agent';`):

1. **`run` / `deterministic`** — a shell command. No model. Implicit gate is `exit_code == 0`.
2. **`llm` / `llm`** — a bare model call. Prompt in, verified output out. No workspace, no tool use.
3. **`agent` / `agent`** — a harnessed coding agent in a workspace. Returns `{ summary, artifacts }`, not raw text.

Plus four resident verbs that aren't ladder rungs: `human` (durable approval), `dispatch` (hand off to a child flow), `done` (typed finish), and in YAML, `on`/triggers (event entry points — out of scope for this skill).

Most flows only need `run` and `llm`. Climb to `agent` once a step needs hands on a real workspace.

## Two ways to author the same thing

### TypeScript

```ts
import { flow } from '@relayflows/surface';

export default flow('hello', async (f) => {
  const greeting = await f.run('echo "Hello from Relayflows"');
  console.log(greeting.trim());

  const answer = await f.agent('greeter', {
    task: 'Reply with one short hello sentence. Do not use tools or modify files.',
    cli: 'claude',
    model: 'claude-sonnet-4-6',
  });
  console.log(answer.summary);

  f.done('success');
});
```

### YAML

```yaml
version: '0.1.0'
name: hello
steps:
  - id: greeting
    type: deterministic
    command: 'echo "Hello from Relayflows"'
  - id: greeter
    type: agent
    dependsOn: [greeting]
    instruction: 'Reply with one short hello sentence. Do not use tools or modify files.'
    cli: claude
    model: claude-sonnet-4-6
```

## The real `Ctx` contract (TypeScript)

### `packages/surface/src/context.ts`, current as of `origin/main@86a2ec2`:

```ts
export interface AgentResult {
  summary: string;
  artifacts: string[];
}

export interface AgentOptions {
  task: string;
  workspace?: string;
  cli?: string;
  model?: string;
}

export interface DispatchResult {
  name: string;
  completionReason: 'success';
  completionDetail?: string;
}

export interface Ctx {
  run(command: string): Step<string>;
  llm(strings: TemplateStringsArray, ...values: unknown[]): Step<string>;
  llm(
    prompt: string,
    options: { output: Record<string, unknown>; cli?: string; model?: string }
  ): Step<unknown>;
  agent(name: string, options: AgentOptions): Step<AgentResult>;
  human(question: string, options: { to: string }): Step<boolean>;
  dispatch(flow: string, input: unknown): Step<DispatchResult>;
  done(reason: RunCompletionReason): void;
  cloud: CloudHelper;
  slack: SlackHelper;
}
```

## The real step shapes (YAML/JSON, `packages/sdk/src/spec.ts`)

```ts
interface DeterministicStepSpec {
  type: 'deterministic';
  id: string;
  command: string;
  dependsOn?: string[];
  timeoutMs?: number;
  verification?: VerificationSpec; // omit for implicit exit_code
}

interface LlmStepSpec {
  type: 'llm';
  id: string;
  prompt: string;
  dependsOn?: string[];
  verification?: OutputVerificationSpec;
  model?: string;
  cli?: string;
}

interface AgentStepSpec {
  type: 'agent';
  id: string;
  instruction: string;
  dependsOn?: string[];
  verification?: OutputVerificationSpec;
  agent?: string; // selects a named FlowSpec.agents entry
  cli?: string;
  model?: string;
  surfaces?: { workspace?: { surface: string }[]; streams?: { stream: string }[]; external?: string[] };
  recoveryMode?: 'reset' | 'inspect' | 'manual'; // default 'reset'
  permissions?: {
    fileGlobs?: string[];
    networkAllowlist?: string[];
    accessPreset?: 'readonly' | 'readwrite';
  };
}

interface FlowSpec {
  version: string; // required, e.g. '0.1.0' — not optional
  name?: string;
  cli?: string; // flow-level CLI default
  agents?: Record<string, { cli: string; model: string }>; // both fields required
  steps: StepSpec[];
  budget?: { maxTokensIn?: number; maxTokensOut?: number; maxDollars?: string };
}
```

## Verification gates

### Verification is control flow, not decoration — a gate decides whether a step actually completed, not just whether the process exited cleanly (`packages/sdk/src/spec.ts`, `VerificationGateType`):

```yaml
- id: classify
  type: llm
  prompt: 'Classify this ticket as bug, feature, or question: "the export button does nothing"'
  cli: claude
  model: claude-sonnet-4-6
  verification:
    type: output_contains
    value: bug
```

## `cli` / `model`: what a step actually runs on

### Both YAML and TypeScript agent/llm steps can set `cli` and `model` directly (TypeScript since flows#310, `AgentOptions.cli?`/`.model?`). Resolution order for `cli` — checked once per step by `preflight.ts`'s `resolveCli` (`packages/sdk/src/preflight.ts:265-282`), identical regardless of authoring language because both compile to the same `StepSpec`:

```
$ flows check hello.flow.yaml   # agent step, no cli anywhere
REFUSED [cli_unresolved] Step "greeter" has no CLI at step, flow, or project level. No flows.json was found from "..." to the filesystem root.
```

### `flows.json`

```json
{ "cli": "claude", "executors": ["cron"], "models": ["claude-sonnet-4-6"] }
```

## Human approval and direct child flows (TypeScript resident verbs)

Child-flow composition requires `relayflows` / `@relayflows/sdk` 2.0.35 or
newer. This repository currently locks 2.0.20, whose CLI refuses `use` as an
unsupported header, so upgrade the CLI before running this example.

```ts
// release.flow.ts
import { flow } from '@relayflows/surface';

export default flow(
  'release',
  {
    use: ['./implement.flow.ts'], // static allowlist of direct children
    budget: { tokens: 50_000 }, // the root owns the whole tree's ceiling
  },
  async (f, input: { issue: number }) => {
    const ok = await f.human(`Ship issue ${input.issue}?`, { to: 'khaliq' });
    if (!ok) return f.done('canceled');

    const child = await f.dispatch('implement', { issue: input.issue });
    await f.run('printf %s publish');
    f.done(child.completionReason);
  }
);
```

```ts
// implement.flow.ts
import { flow } from '@relayflows/surface';

export default flow('implement', async (f, input: { issue: number }) => {
  await f.agent('implementer', {
    task: `Implement issue ${input.issue}`,
    cli: 'claude',
    model: 'claude-sonnet-4-6',
  });
  f.done('success');
});
```

`f.dispatch(name, input)` can call only a **direct** child whose relative
`.flow.ts` path appears in the current flow's static `use` header. The name is
the child's declared `flow(...)` name, not its path. Missing files, duplicate
or ambiguous names, cycles, and calls to undeclared or transitive-only children
are refused before the child body can widen the graph.

The child is part of the same durable run tree: it shares the root's budget and
worker-capacity pool, its step IDs are qualified, and the dispatch receipt joins
the child leaves back to the next parent operation. Resume replays those durable
identities instead of repeating completed effects. A non-success child rejects
the dispatch; success returns `{ name, completionReason: 'success',
completionDetail? }`.

Authority only narrows down the tree. A child cannot declare another budget,
call `f.human`, or require a helper/MCP capability its parent did not grant.
Static `use` cycles are refused and runtime child depth is capped at three.

## Put a local composed run on the Cloud dashboard

```sh
flows run --cloud-mirror release.flow.ts --input '{"issue":123}'

# Equivalent opt-in for every run in the current shell:
FLOWS_CLOUD_MIRROR=1 flows run release.flow.ts --input '{"issue":123}'
```

`--cloud-mirror` keeps execution and the authoritative journal local, while
projecting the root, qualified child steps, dependency edges, dispatch
receipts, transcripts, source, log, and final output into one connected Cloud
dashboard run. Internal completion receipts remain journal evidence but are
not rendered as work nodes. The normal observer link is separate and does not
put the run in Cloud history.

Mirroring is explicit because it uploads flow source, transcripts, and output;
a prior Cloud login never enables it automatically. A mirror outage can make
the dashboard projection incomplete, but cannot fail the underlying run.

## Running it: `flows check` / `run` / `resume`

### Real usage (`packages/sdk/src/cli.ts`):

```
flows check [--json] <flow.yaml|spec.json>
flows run [--json] [--no-spawn] [--no-observer-link] [--cloud-mirror] [--data-dir <dir>] [--local-agent] <flow.yaml|spec.json>
flows run [--json] [--no-spawn] [--no-observer-link] [--cloud-mirror] [--data-dir <dir>] [--local-agent] <flow.ts> --input <inline-json-or-file>
flows resume [--json] [--no-spawn] [--no-observer-link] [--cloud-mirror] [--data-dir <dir>] <run-id>
```

## Common mistakes

- **Forgetting `version` in a YAML/JSON `FlowSpec`.** It's required, not optional — `flows check` refuses a spec without it.
- **Adding `agents:` to a TypeScript `flow()` header.** `FlowHeader` has no such field; it throws `TypeError: flow header has unknown fields: agents` at authoring time. Named-agent maps + `agent:` selector are YAML/JSON-only; TypeScript composition uses static `use:` plus `f.dispatch(...)` instead.
- **Dispatching a file path or a transitive child.** `f.dispatch` takes the declared name of a direct child in `use`, not a path and not any descendant visible elsewhere in the graph.
- **Assuming the observer link also creates a dashboard run.** Add `--cloud-mirror` (or affirmatively set `FLOWS_CLOUD_MIRROR=1`) when the source, transcripts, output, and complete parent/child graph should be stored in Cloud.
- **Assuming `flows.json`'s `models` sets a default model.** It only validates models already declared elsewhere; it never selects one.
- **Not awaiting a step, or manually `.then()`-chaining one.** Both are refused (`unawaited_step` / `unsupported_verb`) rather than silently ignored — the executor closes every root operation's lifecycle explicitly.
- **Running a `.flow.ts` without `--input`.** Required even for flows that don't use their input argument.
- **Expecting a fifth `done()` reason.** The set is closed: `success | step_failed | canceled | budget_exceeded`. Don't invent `partial` or `skipped`.

## What this skill does NOT cover

- **Named-agent maps in TypeScript** (`agents: { reviewer: { cli, model } }` + reuse across steps by name) — YAML/JSON only today. TypeScript's `use:` imports complete child flows, not named-agent definitions.
- **`recoveryMode`, `permissions`, `surfaces`, `budget`, `memory`** on agent steps — real YAML/JSON fields with no TypeScript equivalent. Author that step in YAML and reach it from TypeScript with `f.dispatch` if you need them.
- **Cloud execution** (`flows run --cloud`), **triggers/webhooks**, **memory retrieval**, and the **`f.mcp`**/**`f.slack`** helper namespaces — each is its own surface with its own gotchas; see the [Relayflows product docs](https://agentrelay.com/docs/relayflows) for what's shipped versus designed-but-not-yet-implemented.
- The **older `@relayflows/core` `WorkflowBuilder`** engine — see `writing-agent-relay-workflows` and `migrating-persona-to-relayflow` in this repo.

## Quick reference

| Verb / field                             | Language       | Notes                                                          |
| ---------------------------------------- | -------------- | -------------------------------------------------------------- |
| `f.run(command)` / `type: deterministic` | both           | shell command, implicit `exit_code` gate                       |
| `f.llm(...)` / `type: llm`               | both           | bare model call, no workspace                                  |
| `f.agent(name, opts)` / `type: agent`    | both           | harnessed coding agent, returns `{summary, artifacts}`         |
| `f.human(question, {to})`                | TS only        | durable approval; YAML has no equivalent yet                   |
| `use: ['./child.flow.ts']`               | TS only        | static allowlist of direct child flows                         |
| `f.dispatch(flow, input)`                | TS only        | run a declared direct child in the same durable tree           |
| `f.done(reason)` / —                     | TS / kernel    | one of `success \| step_failed \| canceled \| budget_exceeded` |
| `options.cli` / `step.cli`               | both           | per-call/step CLI override (TS: flows#310)                     |
| `options.model` / `step.model`           | both           | per-call/step model; no flow/project default                   |
| `agent: <name>` + `agents: {...}`        | YAML/JSON only | named cli/model pair, reused by selector                       |
| `flows check <file>`                     | CLI            | pure validate + preflight, no daemon                           |
| `flows run <file> [--input ...]`         | CLI            | actually executes; `.flow.ts` needs `--input`                  |
| `flows run --cloud-mirror ...`           | CLI            | opt in to one connected local-run graph on the Cloud dashboard |
| `flows resume <run-id>`                  | CLI            | resume a parked/crashed run                                    |

## Verified against

### `AgentWorkforce/flows@86a2ec2` (origin/main). Built `packages/surface` and `packages/sdk` from source in a clean worktree (published npm `@relayflows/surface@2.0.8` is stale — it predates flows#310 and lacks `cli`/`model` on `AgentOptions`; local build was symlinked in instead), then ran the real CLI:

```
$ flows check hello.flow.yaml         # this skill's YAML example, cli/model added, flows.json models allowlist set
CHECK PASSED hello.flow.yaml            # exit 0

$ flows check hello.flow.ts            # this skill's TypeScript example
CHECK PASSED hello.flow.ts              # exit 0

$ flows check extract.flow.yaml        # this skill's output_contains example
CHECK PASSED extract.flow.yaml          # exit 0

$ flows check hello.flow.yaml           # same YAML, no flows.json anywhere
REFUSED [cli_unresolved] Step "greeter" has no CLI at step, flow, or project level. ...   # exit 2

$ flows check hello.flow.yaml           # step model not in flows.json's models[]
REFUSED [model_unknown] Step "greeter" declares model "claude-sonnet-4-6" ... not listed in project model registry ...   # exit 2
```
