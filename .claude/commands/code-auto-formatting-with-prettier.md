---
name: code-auto-formatting-with-prettier
description: Workflow command scaffold for code-auto-formatting-with-prettier in relay.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /code-auto-formatting-with-prettier

Use this workflow when working on **code-auto-formatting-with-prettier** in `relay`.

## Goal

Applies automatic code formatting to source files using Prettier, sometimes across multiple files.

## Common Files

- `packages/sdk/src/**/*.ts`
- `packages/cli/src/cli/commands/*.ts`
- `.agentworkforce/trajectories/completed/*/summary.md`
- `.agentworkforce/trajectories/completed/*/trajectory.json`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Run Prettier on relevant source files
- Commit the auto-formatted files

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.