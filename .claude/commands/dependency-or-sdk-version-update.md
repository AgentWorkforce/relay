---
name: dependency-or-sdk-version-update
description: Workflow command scaffold for dependency-or-sdk-version-update in relay.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /dependency-or-sdk-version-update

Use this workflow when working on **dependency-or-sdk-version-update** in `relay`.

## Goal

Updates dependency versions (e.g., SDK), adjusting package.json and package-lock.json files.

## Common Files

- `package-lock.json`
- `packages/cli/package.json`
- `packages/sdk/package.json`
- `.agentworkforce/trajectories/completed/*/summary.md`
- `.agentworkforce/trajectories/completed/*/trajectory.json`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Update package.json and package-lock.json with new version
- Commit the updated files
- Optionally update agentworkforce trajectory metadata

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.