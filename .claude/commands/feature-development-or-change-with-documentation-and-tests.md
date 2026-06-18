---
name: feature-development-or-change-with-documentation-and-tests
description: Workflow command scaffold for feature-development-or-change-with-documentation-and-tests in relay.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /feature-development-or-change-with-documentation-and-tests

Use this workflow when working on **feature-development-or-change-with-documentation-and-tests** in `relay`.

## Goal

Implements or modifies a feature, updating implementation code, tests, and documentation, often across both CLI and SDK packages.

## Common Files

- `packages/cli/src/cli/commands/*.ts`
- `packages/cli/src/cli/commands/*.test.ts`
- `packages/sdk/src/**/*.ts`
- `packages/sdk/src/__tests__/*.test.ts`
- `web/content/docs/*.mdx`
- `CHANGELOG.md`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Update implementation files in packages/cli and/or packages/sdk
- Update or add corresponding test files in __tests__ directories
- Update documentation files (e.g., web/content/docs/*.mdx)
- Update package.json and package-lock.json if dependencies or versions change
- Update CHANGELOG.md to reflect the change

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.