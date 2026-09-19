# Writing Relayflows

Use when authoring a Relayflows flow (@relayflows/surface / @relayflows/sdk, the journal-based v2 engine — the CLI is `flows`, package versions 2.0.x) in TypeScript or YAML/JSON. Covers the three-rung ladder (run/llm/agent), the resident verbs (human/dispatch/done), verification gates, TypeScript vs YAML authoring, per-step cli/model selection and its resolution order, flows.json, and `flows check`/`run`/`resume` with their real refusal shapes and exit codes. Not for the older, unrelated `@relayflows/core` WorkflowBuilder engine (`.pattern('dag')`/.agent()/.step() chains) that `writing-agent-relay-workflows` and `migrating-persona-to-relayflow` cover — that's a different product despite the similar name.

## Overview

Relayflows turns a coding-agent task into steps a journal can inspect, verify, and resume. A flow is data (YAML/JSON) or code (TypeScript) that compiles to the same journal-backed kernel spec. Every effect is journaled before it's treated as real — a journal write that fails fails the step, with no silent fallback.

**Name collision warning.** This repo also has skills for an older, unrelated engine that is *also* casually called "Relayflow" (singular) — `@relayflows/core`'s `WorkflowBuilder`, a chained builder (`workflow('name').pattern('dag').agent(...).step(...).run()`). That's `writing-agent-relay-workflows` and `migrating-persona-to-relayflow`'s territory. This skill is the **v2** engine: `@relayflows/surface`'s `flow()` function and the YAML/JSON dialect compiled by `@relayflows/sdk`. If you see `.pattern(`, `.agent(` as a chained builder call, or `ctx.workflow.run()`, you're in the other engine — stop and use one of those skills instead.

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

export interface Ctx {
  run(command: string): Step<string>;
  llm(strings: TemplateStringsArray, ...values: unknown[]): Step<string>;
  llm(prompt: string, options: { output: Record<string, unknown>; cli?: string; model?: string }): Step<unknown>;
  agent(name: string, options: AgentOptions): Step<AgentResult>;
  human(question: string, options: { to: string }): Promise<boolean>;
  dispatch<T>(flow: string, input: unknown): Promise<T>;
  done(reason: RunCompletionReason): void;
  cloud: CloudHelper;
  slack: SlackHelper;
}
```


## The real step shapes (YAML/JSON, `packages/sdk/src/spec.ts`)

### ```ts

```ts
interface DeterministicStepSpec {
  type: 'deterministic';
  id: string;
  command: string;
  dependsOn?: string[];
  timeoutMs?: number;
  verification?: VerificationSpec;   // omit for implicit exit_code
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
  agent?: string;      // selects a named FlowSpec.agents entry
  cli?: string;
  model?: string;
  surfaces?: { workspace?: { surface: string }[]; streams?: { stream: string }[]; external?: string[] };
  recoveryMode?: 'reset' | 'inspect' | 'manual';   // default 'reset'
  permissions?: { fileGlobs?: string[]; networkAllowlist?: string[]; accessPreset?: 'readonly' | 'readwrite' };
}

interface FlowSpec {
  version: string;      // required, e.g. '0.1.0' — not optional
  name?: string;
  cli?: string;                          // flow-level CLI default
  agents?: Record<string, { cli: string; model: string }>;  // both fields required
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


## Human approval and dispatch (TypeScript resident verbs)

### ```ts

```ts
import { flow } from '@relayflows/surface';

export default flow('ship-feature', async (f) => {
  const plan = await f.agent('planner', {
    task: 'Research and plan: add OAuth2 support',
    workspace: 'acme/api: readonly',   // compiles to relayauth path scopes
  });

  const ok = await f.human(`Ship this?\n${plan.summary}`, { to: 'khaliq' });
  if (!ok) return f.done('canceled');

  const pr = await f.dispatch('garden/implement', plan);   // hands off to a child flow
  f.done('success');
});
```


## Running it: `flows check` / `run` / `resume`

### Real usage (`packages/sdk/src/cli.ts`):

```
flows check [--json] <flow.yaml|spec.json>
flows run [--json] [--no-spawn] [--no-observer-link] [--data-dir <dir>] [--local-agent] <flow.yaml|spec.json>
flows run [--json] [--no-spawn] [--no-observer-link] [--data-dir <dir>] [--local-agent] <flow.ts> --input <inline-json-or-file>
flows resume [--json] [--no-spawn] [--no-observer-link] [--data-dir <dir>] <run-id>
```


## Common mistakes

- **Forgetting `version` in a YAML/JSON `FlowSpec`.** It's required, not optional — `flows check` refuses a spec without it.
- **Adding `agents:` to a TypeScript `flow()` header.** `FlowHeader` has no such field; it throws `TypeError: flow header has unknown fields: agents` at authoring time. Named-agent maps + `agent:` selector are YAML/JSON-only (flows#300 tracks TypeScript composition via `use:`, not yet shipped).
- **Assuming `flows.json`'s `models` sets a default model.** It only validates models already declared elsewhere; it never selects one.
- **Not awaiting a step, or manually `.then()`-chaining one.** Both are refused (`unawaited_step` / `unsupported_verb`) rather than silently ignored — the executor closes every root operation's lifecycle explicitly.
- **Running a `.flow.ts` without `--input`.** Required even for flows that don't use their input argument.
- **Expecting a fifth `done()` reason.** The set is closed: `success | step_failed | canceled | budget_exceeded`. Don't invent `partial` or `skipped`.

## What this skill does NOT cover

- **Named-agent maps in TypeScript** (`agents: { reviewer: { cli, model } }` + reuse across steps by name) — YAML/JSON only today. Tracked for TS composition via `use:` at [flows#300](https://github.com/AgentWorkforce/flows/issues/300).
- **`recoveryMode`, `permissions`, `surfaces`, `budget`, `memory`** on agent steps — real YAML/JSON fields with no TypeScript equivalent. Author that step in YAML and reach it from TypeScript with `f.dispatch` if you need them.
- **Cloud execution** (`flows run --cloud`), **triggers/webhooks**, **memory retrieval**, and the **`f.mcp`**/**`f.slack`** helper namespaces — each is its own surface with its own gotchas; see the [Relayflows product docs](https://agentrelay.com/docs/relayflows) for what's shipped versus designed-but-not-yet-implemented.
- The **older `@relayflows/core` `WorkflowBuilder`** engine — see `writing-agent-relay-workflows` and `migrating-persona-to-relayflow` in this repo.

## Quick reference

| Verb / field | Language | Notes |
|---|---|---|
| `f.run(command)` / `type: deterministic` | both | shell command, implicit `exit_code` gate |
| `f.llm(...)` / `type: llm` | both | bare model call, no workspace |
| `f.agent(name, opts)` / `type: agent` | both | harnessed coding agent, returns `{summary, artifacts}` |
| `f.human(question, {to})` | TS only | durable approval; YAML has no equivalent yet |
| `f.dispatch(flow, input)` | TS only | hand off to a named child flow |
| `f.done(reason)` / — | TS / kernel | one of `success \| step_failed \| canceled \| budget_exceeded` |
| `options.cli` / `step.cli` | both | per-call/step CLI override (TS: flows#310) |
| `options.model` / `step.model` | both | per-call/step model; no flow/project default |
| `agent: <name>` + `agents: {...}` | YAML/JSON only | named cli/model pair, reused by selector |
| `flows check <file>` | CLI | pure validate + preflight, no daemon |
| `flows run <file> [--input ...]` | CLI | actually executes; `.flow.ts` needs `--input` |
| `flows resume <run-id>` | CLI | resume a parked/crashed run |

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