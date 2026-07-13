# Relay Evals

Relay uses the shared `@agent-assistant/telemetry/evals` helpers for eval case
loading, filtering, deterministic checks, and run artifacts. Relay owns the
domain-specific suites, rubrics, and in-memory SDK executor in this repository.

## Layout

```text
evals/
  PLAN.md
  README.md
  suites/
    <suite>/
      cases.md
      cases.jsonl
      rubric.md
scripts/evals/
  compile-cases.mjs
  run-relay-evals.mjs
  relay-executor.mjs
  relay-checks.mjs
  ci-summary.mjs
```

## Case Shape

Author cases in `cases.md`; `cases.jsonl` is generated and should not be edited
by hand. A typical case looks like:

```json
{
  "id": "messaging.example",
  "suite": "messaging",
  "executor": "relay",
  "kind": "capability",
  "input": {
    "message": "Post a channel message",
    "operation": [{ "op": "post_message", "as": "Lead", "channel": "general", "text": "hello" }]
  },
  "expected": { "ok": true, "messageExists": [{ "channel": "general", "text": "hello", "from": "Lead" }] },
  "tags": ["messaging"]
}
```

## Commands

```bash
npm run evals:compile
npm run evals:list
npm run evals:offline
npm run evals:offline -- --suite messaging
npm run evals:offline -- --tag pending-executor
```

Run artifacts are written under `.relay/evals/runs/` and are ignored by git.
Each run writes `result.json`, `summary.md`, and `human-review.md`.

## Executor

`scripts/evals/relay-executor.mjs` runs the SDK against an in-memory Relay
model. It does not connect to a live broker. The executor records:

- `observed.content` for `contentIncludes` checks.
- `observed.events[]` for `eventEmitted` checks.
- `observed.error.code` for `errorCode` checks.
- `observed.toolCalls[]` for tool-call checks.

The operation vocabulary and argument contract live in `evals/PLAN.md`.

## Practice

Keep capability and regression cases separate with tags. Prefer deterministic
checks first. Mark cases `Human Review: true` only when the executor substrate
is intentionally pending or the rubric requires manual judgment.
