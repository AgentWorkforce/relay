# Claude-Inspired Relay Workflow Campaigns

These workflow examples turn the best parts of Claude Code's orchestration model
into explicit Relay implementation campaigns.

## Included workflows

1. `workflow-claude-task-runtime.ts`
   Builds a first-class task runtime with task handles, pending messages,
   result payloads, and manager-owned completion.

2. `workflow-claude-capability-isolation.ts`
   Adds per-worker capability scopes, inherited spawn policy, and ergonomic
   worktree isolation.

3. `workflow-claude-structured-control.ts`
   Adds typed control messages, plan checkpoints, and phase-aware channel
   management.

## Why these exist

Relay already beats Claude Code on explicit DAGs, verification gates,
heterogeneous CLIs, and repeatability. These workflows focus on the areas where
Claude Code is stronger:

- task-centric worker lifecycle
- per-worker capability scoping
- structured continuation / approval semantics

The intent is not to copy Claude's implicit orchestration style. The intent is
to absorb the useful worker ergonomics while keeping Relay's explicit and
observable workflow model.

## Run

```bash
npx tsx packages/sdk/src/examples/workflow-claude-task-runtime.ts
npx tsx packages/sdk/src/examples/workflow-claude-capability-isolation.ts
npx tsx packages/sdk/src/examples/workflow-claude-structured-control.ts
```
