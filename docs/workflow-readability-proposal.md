# Workflow Readability Proposal

## Summary

Relay workflows are powerful, but they are still harder to read and review than they should be across YAML, TypeScript, and Python authoring styles.

The main issue is not functionality. The issue is that workflows currently tend to mix together:

1. orchestration logic
2. large prompt/task payloads
3. runtime execution details
4. dynamic generation logic
5. verification and output contracts

That makes reviews slower, raises the risk of subtle mistakes, and creates an unnecessary gap between "what this workflow is trying to do" and "how this workflow happens to be implemented."

This proposal introduces a workflow readability model that preserves current functionality while making workflows significantly easier to author, review, debug, and evolve.

## Goals

- Make workflows easy to skim and understand in PR review
- Keep YAML, TypeScript, and Python aligned to one mental model
- Reduce inline prompt/script noise without losing power
- Make step intent, dependencies, and success conditions obvious
- Encourage structured outputs and reusable patterns
- Preserve dynamic authoring for TypeScript and Python
- Improve tooling for review, linting, and normalization

## Non-goals

- Replacing the current runtime model
- Removing support for TypeScript or Python workflows
- Forcing all workflows into a single source format
- Fully redesigning workflow execution semantics in one pass

## Current pain points

### 1. Workflows try to do too much in one file

A single workflow source often contains:

- orchestration structure
- long prompts
- agent-specific execution details
- verification rules
- large interpolation payloads
- runtime-specific escape hatches

This makes diffs noisy and obscures intent.

### 2. Authoring styles feel more different than they should

YAML, TypeScript, and Python can all express the same kinds of workflows, but they do not always read like the same system. Reviewers end up re-learning the flow based on the source language instead of recognizing a shared workflow model.

### 3. Prompt text dominates the review surface

Large inline prompt blocks often bury the actual orchestration plan. Reviewers have to mentally separate:

- what the step is
- what context it needs
- what success looks like
- what exact text was handed to the agent

Those are related, but they should not all live at the same visual layer.

### 4. Runtime details leak into business logic

Workflows become harder to review when the important logic is mixed with low-level details such as:

- PTY / spawn concerns
- environment plumbing
- retry defaults
- transport quirks
- execution-mode knobs

Those details matter, but most should live in defaults, profiles, or adapters rather than dominating step definitions.

### 5. Outputs are often too unstructured

When downstream steps consume large text blobs rather than named fields, it becomes harder to understand the contract between steps and easier to break workflows accidentally.

## Design principles

### 1. One workflow model, multiple syntaxes

Relay should treat YAML, TypeScript, and Python as different authoring surfaces for the same core workflow model.

That shared model should center on:

- inputs
- defaults
- agents
- steps
- outputs
- verification

The more these formats converge semantically, the easier review and tooling become.

### 2. Separate declaration from payload

The workflow file should primarily describe:

- flow
- dependencies
- contracts
- success conditions

Large payloads should be referenced, not embedded, when possible.

Examples of payloads to externalize:

- long prompts
- reusable instructions
- examples
- large templates
- long inline scripts

### 3. Optimize for reviewability first

A good workflow should be understandable in a quick skim. A reviewer should be able to answer:

- what is this workflow for?
- what are the main steps?
- who does each step?
- what depends on what?
- what verifies success?

without reading every prompt body in full.

### 4. Keep power, but move complexity to the right layer

Relay should still support dynamic generation, conditional logic, and advanced runtime features. But those concerns should live in:

- typed builders
- reusable abstractions
- agent profiles
- normalization/compile steps
- render/lint tooling

rather than making every workflow definition look like custom glue code.

## Proposed workflow readability model

## A. Establish a canonical workflow shape

All authoring formats should map cleanly to a normalized internal shape roughly like:

```yaml
name: fix_pr_ci
inputs:
  pr_number:
    type: number
  repo:
    type: string

defaults:
  agent_profile: codex_worker

agents:
  analyst:
    profile: analyst_profile
  implementer:
    profile: codex_worker
  reviewer:
    profile: reviewer_profile

steps:
  - id: analyze_failure
    description: Identify the root cause of the failing CI job
    agent: analyst
    prompt: prompts/analyze-failure.md
    with:
      pr_number: "{{inputs.pr_number}}"
      repo: "{{inputs.repo}}"
    outputs:
      summary: string
      likely_fix: string
    verify:
      - output_contains: ROOT_CAUSE_IDENTIFIED

  - id: implement_fix
    description: Implement the most likely fix in the codebase
    agent: implementer
    needs: [analyze_failure]
    prompt: prompts/implement-fix.md
    with:
      summary: "{{steps.analyze_failure.outputs.summary}}"
      likely_fix: "{{steps.analyze_failure.outputs.likely_fix}}"
    verify:
      - tests_pass: packages/sdk

  - id: review_patch
    description: Review the patch and approve or request changes
    agent: reviewer
    needs: [implement_fix]
    prompt: prompts/review-patch.md
    with:
      diff_summary: "{{steps.implement_fix.outputs.summary}}"
    verify:
      - output_contains: APPROVED
```

This is not meant as exact schema syntax. It is the target reading experience.

## B. Externalize prompt/task bodies

### Recommendation

Support first-class references such as:

- `prompt: prompts/foo.md`
- `instructions: prompts/shared/reviewer-rubric.md`
- `template: prompts/bar.mustache`

### Why

This keeps the workflow file focused on orchestration while still making prompt content explicit and versioned.

### Benefits

- smaller diffs
- easier step scanning
- prompt bodies can be reviewed independently
- reusable prompt fragments become practical

### Suggested conventions

- `prompts/` for step-specific prompt bodies
- `prompts/shared/` for reusable fragments/rubrics
- short inline text allowed for tiny prompts only

### Suggested lint rule

Warn when inline prompt text exceeds a threshold, for example 15-20 lines.

## C. Introduce step descriptions as first-class fields

Every workflow and every non-trivial step should be able to carry:

- `description`
- optional `why`
- optional `notes`

Example:

```yaml
- id: split_prs
  description: Split completed workflow packs into reviewable PRs
  why: Smaller PRs reduce review latency and conflict surface
```

This gives reviewers the intended meaning without forcing them to infer it from prompt text.

## D. Standardize step structure and key ordering

One simple readability gain is a stable field order.

Suggested order for step keys:

```yaml
- id:
  description:
  agent:
  needs:
  prompt:
  with:
  outputs:
  verify:
  on_fail:
```

A consistent order reduces cognitive load during review and makes workflows feel visually predictable.

## E. Move runtime details into agent profiles/defaults

### Problem

Step readability degrades when each step repeats low-level execution settings.

### Recommendation

Use agent profiles or execution profiles for things like:

- interactive vs non-interactive execution
- PTY defaults
- retry defaults
- timeout defaults
- environment defaults
- review/owner patterns

Example:

```yaml
agents:
  implementer:
    profile: codex_worker
```

where `codex_worker` resolves runtime specifics elsewhere.

### Result

Workflow definitions stay focused on behavior rather than transport/execution mechanics.

## F. Prefer structured outputs over freeform downstream parsing

### Recommendation

Encourage steps to expose named outputs and typed contracts instead of forcing downstream steps to parse arbitrary prose.

Example:

```yaml
outputs:
  summary: string
  changed_files: string[]
  risk_level: enum(low, medium, high)
```

### Why

This improves:

- readability
- validation
- safer refactors
- downstream composability
- TS/Python typing support

### Tooling implication

The workflow system should make structured step outputs easy to define and reference in all three authoring styles.

## G. Introduce reusable high-level step templates

A lot of noise comes from repeatedly spelling out the same workflow patterns.

Examples of common patterns:

- analyze
- implement
- verify
- review
- summarize
- handoff
- code change with tests

### Recommendation

Allow higher-level templates/macros, for example:

```yaml
- use: code_change
  id: implement_fix
  with:
    agent: codex
    prompt: prompts/implement-fix.md
    tests: npm test -- packages/sdk
```

Equivalent TS/Python helpers should exist too.

### Why

This reduces boilerplate and makes intent more obvious.

## H. Add a rendered review view

This is likely the single biggest practical improvement.

### Recommendation

Add a command or artifact that renders workflows into a concise human review format.

For example:

```text
Workflow: fix_pr_ci

Inputs:
- pr_number
- repo

Steps:
1. analyze_failure (agent: analyst)
   description: Identify the root cause of the failing CI job
   verifies: output_contains(ROOT_CAUSE_IDENTIFIED)

2. implement_fix (agent: implementer)
   needs: analyze_failure
   description: Implement the likely fix
   verifies: tests_pass(packages/sdk)

3. review_patch (agent: reviewer)
   needs: implement_fix
   description: Review and approve the patch
   verifies: output_contains(APPROVED)
```

### Also useful

- dependency graph rendering
- prompt file references
- output contract summary
- risk markers for especially complex steps

### Why

Humans review plans better than raw source.

## I. Keep TypeScript and Python as authoring layers, not freeform workflow scripts

### TypeScript

TypeScript should be excellent for:

- generated workflows
- reusable abstractions
- typed helpers
- conditional composition

But it should preferably build workflows using a structured builder API rather than arbitrary imperative orchestration logic.

Better:

```ts
workflow.add(
  analyzeStep({ ... }),
  codeChangeStep({ ... }),
  reviewStep({ ... })
)
```

Worse:

```ts
if (x) {
  for (...) {
    // custom mutation-heavy logic that obscures the actual workflow plan
  }
}
```

### Python

Python should follow the same rule.

Good Python workflow authoring should look like a typed workflow spec expressed in Python, not an ad hoc script.

That suggests using:

- dataclasses / pydantic models
- builder helpers
- explicit schema export
- constrained orchestration helpers

## J. Normalize all workflows to a canonical internal JSON representation

### Recommendation

Whether authored in YAML, TS, or Python, every workflow should normalize to one internal representation before execution and optionally before review.

### Benefits

- consistent execution semantics
- easier validation/linting
- easier diff/render tooling
- easier parity across languages
- easier debugging of generated workflows

### Review benefit

A PR could include both:

1. source workflow changes
2. normalized rendered plan

That would significantly improve review confidence.

## Language-specific recommendations

## YAML workflows

### Best use case

- static or mostly static workflows
- declarative DAGs
- workflows where human review clarity is the top priority

### Recommendations

- externalize large prompts
- keep step objects shallow
- prefer references over inline payloads
- add descriptions consistently
- standardize key ordering
- use templates/macros for repeated patterns

## TypeScript workflows

### Best use case

- dynamic workflow generation
- reusable typed abstractions
- compile-time contract checking
- library-like workflow construction

### Recommendations

- introduce first-class builders and step factories
- discourage raw imperative orchestration in workflow source files
- strongly type inputs, outputs, and verification
- provide easy export to normalized workflow spec

## Python workflows

### Best use case

- dynamic generation
- data-driven workflow assembly
- Python-native integrations or experimentation

### Recommendations

- use typed models/builders rather than loose dict assembly
- make export to canonical spec explicit
- keep orchestration declarative where possible
- align naming and concepts with YAML and TS

## Suggested phased rollout

## Phase 1: immediate readability wins

These changes are high leverage and low risk.

1. Add first-class support for prompt file references
2. Add `description` for workflows and steps
3. Standardize key ordering in examples/docs/formatters
4. Add lint rules for oversized inline prompts and ambiguous step ids
5. Add a CLI render command for concise workflow summaries

### Expected impact

Immediate improvement in PR readability with minimal runtime disruption.

## Phase 2: reduce repetition and implicit behavior

1. Add agent profiles/defaults
2. Add structured output contracts
3. Add reusable verification helpers
4. Add reusable step templates/macros for common patterns

### Expected impact

Cleaner workflow definitions and fewer repeated low-level fields.

## Phase 3: unify multi-language authoring

1. Add a TypeScript builder API
2. Add a Python builder API
3. Normalize all formats to one canonical schema
4. Generate review artifacts from normalized workflows

### Expected impact

Much stronger parity between YAML, TS, and Python and easier tooling.

## Potential CLI/tooling additions

### `agent-relay workflow render`

Render a concise human-readable summary of a workflow.

Possible outputs:

- plain text summary
- markdown review view
- JSON normalized spec
- graphviz/mermaid dependency graph

### `agent-relay workflow lint`

Lint for readability and maintainability issues, such as:

- inline prompt too large
- missing descriptions on non-trivial steps
- ambiguous step ids
- repeated agent runtime config in too many steps
- over-nested generated workflows
- outputs consumed as raw prose where structured contracts are expected

### `agent-relay workflow normalize`

Emit the canonical normalized representation from YAML, TS, or Python.

This would be useful both for debugging and for review artifacts.

## Example of improved authoring style

## Before

```yaml
steps:
  - id: step1
    agent: codex
    task: |
      Read the repo carefully. Investigate the failing tests. Understand
      the workflow runner behavior. Examine related code and determine
      whether the failure comes from task injection behavior, verification
      semantics, test assumptions, or output parsing. Then make the needed
      changes, run tests, explain your reasoning, and produce the special
      marker FIXED_AND_VERIFIED when complete.
    verify:
      - output_contains: FIXED_AND_VERIFIED
```

## After

```yaml
steps:
  - id: investigate_runner_failure
    description: Identify the root cause of the workflow runner failure
    agent: implementer
    prompt: prompts/investigate-runner-failure.md
    outputs:
      summary: string
      root_cause: string
    verify:
      - output_contains: ROOT_CAUSE_IDENTIFIED
```

The second version is much easier to review even though it can preserve the same runtime behavior.

## Risks and tradeoffs

### 1. More files

Externalizing prompts increases file count.

### Why this is acceptable

That trade is usually worth it because it reduces noise and improves diffs.

### 2. More abstraction can hide behavior if overdone

Templates, profiles, and builders can become opaque if they are too magical.

### Mitigation

- keep abstractions named and explicit
- provide normalized render output
- make expansions inspectable in tooling

### 3. Canonical normalization adds implementation work

Yes, but it pays back across execution, validation, linting, and review.

## Recommendation

Adopt the following direction:

1. Treat YAML, TypeScript, and Python as three authoring surfaces for one workflow model
2. Externalize large prompt/task payloads
3. Make step intent explicit with descriptions and structured outputs
4. Move execution details into agent profiles/defaults
5. Add high-level reusable step templates
6. Add normalized render/lint tooling for review
7. Converge all formats on a canonical internal representation

## Proposed next steps

1. Add prompt file references and step descriptions
2. Define a normalized workflow shape for docs and internal tooling
3. Add a workflow render command for human review
4. Add a readability lint pass
5. Design TS/Python builder APIs around the canonical model rather than separate mental models

## Why this matters

Relay workflows are increasingly central to how multi-agent work is expressed. If they remain difficult to read, review quality will lag behind runtime capability.

A workflow system that is easy to review will be:

- safer
- easier to evolve
- easier to onboard contributors into
- easier to debug
- much more scalable as the workflow surface grows

This proposal aims to improve readability without sacrificing the flexibility that makes Relay workflows powerful in the first place.
