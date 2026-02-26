# Workflow Durability Patterns

Test workflows that encode the key rules for writing workflows that don't time out or fail silently.

## Workflows

| File                                | Tests                                                               |
| ----------------------------------- | ------------------------------------------------------------------- |
| `test-deterministic-pipeline.yaml`  | Pure shell steps, `captureOutput`, `{{steps.X.output}}` chaining    |
| `test-non-interactive-bounded.yaml` | Non-interactive agents with content injected by deterministic steps |
| `test-lead-worker-pattern.yaml`     | Interactive lead + non-interactive workers, relay coordination      |
| `test-step-sizing.yaml`             | One step = one deliverable; chaining vs discovery                   |

## Core Rules

### 1. Non-interactive agents must never discover information via tools

**Wrong:** Ask a `worker` agent to "read `src/foo.ts` and summarize it"  
**Right:** Deterministic step runs `cat src/foo.ts`, captures output, injects via `{{steps.read.output}}`

Non-interactive (`claude -p`) agents can use tools but it's slow, unreliable, and often times out on large files. Deterministic steps are instant.

### 2. One step = one deliverable

**Wrong:** "Read the codebase, design a spec, write it to disk, and validate the build"  
**Right:** Four separate steps, each with a single clear output and `output_contains` verification

### 3. Interactive (lead) for complexity, non-interactive (worker) for execution

- **Lead** (`preset: lead`): reasoning, coordination, relay messaging, spawning workers
- **Worker** (`preset: worker`): takes a small well-defined task, produces structured stdout

### 4. Always set `verification.output_contains`

Without verification, a step that produces empty output looks like success. Every agent step needs a sentinel value.

### 5. Timeout budgets

- Deterministic steps: seconds
- Non-interactive agents with injected content: 2–5 min
- Interactive lead agents: 10–20 min (they read channels, wait for workers)
- Full workflow: sum of critical path + 20% buffer

### 6. Never create a lead↔worker DAG deadlock

**Wrong:** `work-a` and `work-b` depend on `coordinate` (lead), but `coordinate` waits for DONE signals from `work-a` and `work-b`. Neither can proceed.

**Right:** Workers and lead all depend on `context` (start in parallel). A `merge` step depends on all three. Lead watches the channel for worker signals — it doesn't block the workers from starting.

```
context → work-a ─┐
context → work-b ─┼→ merge
context → lead  ──┘
```

### 7. Never ask an agent to read large files via tools

`packages/sdk/src/workflows/runner.ts` is ~3200 lines. Asking `claude -p` to read it via the Read tool + reason about it = 20+ min timeout. Extract only the relevant lines in a deterministic step first.
