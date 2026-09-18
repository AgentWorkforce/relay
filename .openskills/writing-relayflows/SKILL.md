---
name: writing-relayflows
description: Use when authoring a Relayflows flow (@relayflows/surface / @relayflows/sdk, the journal-based v2 engine — the CLI is `flows`, package versions 2.0.x) in TypeScript or YAML/JSON. Covers the three-rung ladder (run/llm/agent), the resident verbs (human/dispatch/done), verification gates, TypeScript vs YAML authoring, per-step cli/model selection and its resolution order, flows.json, and `flows check`/`run`/`resume` with their real refusal shapes and exit codes. Not for the older, unrelated `@relayflows/core` WorkflowBuilder engine (`.pattern('dag')`/.agent()/.step() chains) that `writing-agent-relay-workflows` and `migrating-persona-to-relayflow` cover — that's a different product despite the similar name.
---

# Writing Relayflows

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

**YAML/JSON** is data: `flows check` or CI can validate it without running anything. **TypeScript** calls the same primitives imperatively as ordinary async code. Both compile to the same journal.

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

**Version note:** the published `@relayflows/surface@2.0.8` on npm predates `AgentOptions.cli`/`.model` (flows#310) — it does not define them, and using them against that installed version throws at authoring time. These examples require `AgentWorkforce/flows@86a2ec2` or a later/compatible published release; if your installed `@relayflows/surface` still reads `2.0.8` and doesn't export these fields, omit `cli`/`model` from `f.agent`/`f.llm` calls until it's updated. Both examples above were run for real against a source build of that commit (`flows check`, exit 0 both) — see **Verified against**.

## The real `Ctx` contract (TypeScript)

`packages/surface/src/context.ts`, current as of `origin/main@86a2ec2`:

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

Do not add fields to `AgentOptions`/`Ctx` that aren't in this list — they don't exist in the shipped SDK. In particular: **no flow-level `cli`, no named-agent map, no `recoveryMode`/`permissions`/`surfaces`/`budget`** on the TypeScript side. Those are YAML/JSON-only today (see **What this skill does NOT cover**). `FlowHeader` (`packages/surface/src/flow.ts:4-9`) only allows `identity`, `memory`, `budget`, `tools`, `workspace` — no `agents` key. Passing an unknown header field or an unknown `AgentOptions` field throws a `TypeError` at authoring time, before anything is journaled.

`Step<T>` (`packages/surface/src/step.ts`) is a `PromiseLike<T>` with one extra method: `.gate(predicate, because?)`, which fails the step `verification_failed` when the predicate returns false. Every awaited step must actually be awaited — an unawaited or manually-`.then()`-chained step is refused (`unawaited_step` / `unsupported_verb`), not silently dropped.

`done(reason)` takes exactly one of the closed run-completion set (`packages/surface/src/completion.ts`): `'success' | 'step_failed' | 'canceled' | 'budget_exceeded'`. There's no fifth option — don't invent one (e.g. `'partial'`, `'skipped'`).

## The real step shapes (YAML/JSON, `packages/sdk/src/spec.ts`)

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

`version` is required on every `FlowSpec` — omitting it is a real, common mistake; `flows check` refuses it.

## Verification gates

Verification is control flow, not decoration — a gate decides whether a step actually completed, not just whether the process exited cleanly (`packages/sdk/src/spec.ts`, `VerificationGateType`):

- `exit_code` — implicit default for `deterministic` steps. `exit_code == 0`. Not configurable in v0.
- `output_contains` — step output (stdout tail or LLM value, stringified) contains `value`.
- `json_schema` — step output validates against a JSON Schema (`boolean | Record<string, unknown>`). Used for structured LLM/agent output.

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

Verified for real: `flows check` on exactly this step passed (`CHECK PASSED`, exit 0) — see **Verified against**.

An agent step rarely fails by crashing; it fails by returning something plausible and wrong, which a plain retry-on-error never catches. Always give an `agent`/`llm` step a real `verification`, not just the default.

## `cli` / `model`: what a step actually runs on

Both YAML and TypeScript agent/llm steps can set `cli` and `model` directly (TypeScript since flows#310, `AgentOptions.cli?`/`.model?`). Resolution order for `cli` — checked once per step by `preflight.ts`'s `resolveCli` (`packages/sdk/src/preflight.ts:265-282`), identical regardless of authoring language because both compile to the same `StepSpec`:

1. **step** — `step.cli` (or TS's `options.cli`)
2. **named** — the flow's `agents[step.agent]` entry, if the step selects one via `agent: <name>` (YAML/JSON only — TypeScript has no named-agent map yet, see below)
3. **flow** — `FlowSpec.cli`
4. **project** — nearest `flows.json`'s `cli`, found by walking up from the flow file's directory

No resolution found at any level → `REFUSED [cli_unresolved]`, before anything is journaled. Verified for real:

```
$ flows check hello.flow.yaml   # agent step, no cli anywhere
REFUSED [cli_unresolved] Step "greeter" has no CLI at step, flow, or project level. No flows.json was found from "..." to the filesystem root.
```
(exit 2 — see **Verified against**)

`model` has **no** flow or project default — only step or named-agent. Omitting it just runs whatever model the resolved CLI defaults to.

### `flows.json`

Nearest-wins project config, walking from the flow file's directory to the filesystem root (`packages/sdk/src/cli/check.ts`). Exact schema — unknown keys fail closed as `config_invalid`:

```json
{ "cli": "claude", "executors": ["cron"], "models": ["claude-sonnet-4-6"] }
```

- `cli` (optional, non-empty string) — the project-wide CLI default (resolution rung 4 above).
- `executors` (optional, string array) — trigger executors this project has registered. A trigger whose `executor` isn't in this list is `no_executor`.
- `models` (optional, string array) — **an allowlist, not a default.** Any model declared on any step or named agent anywhere in the flow must appear here, or `flows check` refuses `model_unknown`. Setting `models` does not select a model for anything; there's still no flow/project model default.

```
$ flows check hello.flow.yaml   # model set on the step, but not in flows.json's models[]
REFUSED [model_unknown] Step "greeter" declares model "claude-sonnet-4-6" for CLI "claude", but it is not listed in project model registry "..."; add the exact model only after verifying that project is allowed to use it.
```
(Verified for real — see **Verified against**.)

## Human approval and dispatch (TypeScript resident verbs)

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

`f.human` is a durable, journaled approval gate — the run parks until the human answers, and resumes exactly where it left off. `f.dispatch` hands input to a named child flow and returns its typed result; the parent doesn't inline the child's steps. (Source: `docs/SURFACE.md` §2 rule 6 region, lines ~40-53 as of `origin/main@86a2ec2` — this snippet is cited, not independently re-run, since it needs a live daemon.)

`f.slack` is a separate helper namespace, and its real calling convention doesn't fit a plain `flow(name, async (f) => ...)` body: in the real source, `f.slack.reply(event, ...)` only appears inside a trigger handler registered via `.on(slack.mention('#exec'), async (f, event) => { ... })`, where `event` is the trigger's second callback argument — not something a step-based flow like the one above ever has in scope. Triggers and `f.slack` are out of this skill's scope (see **What this skill does NOT cover**); don't copy a bare `f.slack.reply(event, ...)` call into a `flow()` body like the one above, it will throw `event is not defined`.

## Running it: `flows check` / `run` / `resume`

Real usage (`packages/sdk/src/cli.ts`):

```
flows check [--json] <flow.yaml|spec.json>
flows run [--json] [--no-spawn] [--no-observer-link] [--data-dir <dir>] [--local-agent] <flow.yaml|spec.json>
flows run [--json] [--no-spawn] [--no-observer-link] [--data-dir <dir>] [--local-agent] <flow.ts> --input <inline-json-or-file>
flows resume [--json] [--no-spawn] [--no-observer-link] [--data-dir <dir>] <run-id>
```

`check` is a pure compile-and-preflight — no daemon, no socket, no data dir. It's the fast, safe way to validate a flow before ever running it. `--json` works on `check`/`run`/`resume`; it does **not** exist on `tick start`, `hn-monitor start`, or `observer`. The printed usage above only lists `<flow.yaml|spec.json>` for `check`, but it accepts `.flow.ts` too — verified in this skill's own **Verified against** section (`flows check hello.flow.ts` passes); the tool's own `--help` text is just incomplete on this point.

A `.flow.ts` run via `flows run` requires `--input <inline-json-or-file>` even when the flow body ignores its input argument — `flows run hello.flow.ts` alone refuses `REFUSED [input_missing]`.

### Exit codes and refusal shapes

Every refusal before a journal write is exit **2**, printed as `REFUSED [<kind>] <message>`. The `<kind>` differs by *how* the flow was checked, not just *what* was wrong — don't assume one canonical string for "no CLI":

- `flows check` on a YAML/JSON spec, or the declarative-compiler path in general → `preflight.ts`'s own kind directly: `cli_unresolved`, `model_unknown`, `cli_missing`, `cli_unauthenticated`, `no_executor`, etc. (`packages/sdk/src/failure-kinds.ts`, `PREFLIGHT_FAILURE_KINDS`).
- `flows run` on a **TypeScript** `.flow.ts` whose authored `f.agent`/`f.llm` call can't resolve a CLI at runtime → the executor's internal `agent_cli_unresolved` gets wrapped and printed as `REFUSED [invalid_spec] <message>` (`packages/sdk/src/cli/direct-run.ts:97-119`). The internal `agent_cli_unresolved` string is never itself the printed kind a user sees.

Both are real, both are exit 2 — just from different code paths, so don't be surprised if the same underlying problem prints a different `[kind]` depending on whether you hit it via `flows check` on YAML or `flows run` on TypeScript.

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

`AgentWorkforce/flows@86a2ec2` (origin/main). Built `packages/surface` and `packages/sdk` from source in a clean worktree (published npm `@relayflows/surface@2.0.8` is stale — it predates flows#310 and lacks `cli`/`model` on `AgentOptions`; local build was symlinked in instead), then ran the real CLI:

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

The `f.human`/`f.dispatch`/`f.slack` snippet and the TypeScript `REFUSED [invalid_spec]` wrapping claim are source-cited (exact file:line above), not independently re-run — both need a live `relayflowd` daemon (and Slack mount, for the former), which this pass didn't build.
