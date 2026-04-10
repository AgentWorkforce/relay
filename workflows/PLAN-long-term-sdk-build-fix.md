# PLAN — long-term sdk build resolution fix

## Goal
Eliminate the fragile workspace/tooling behavior around `packages/sdk` builds so clean checkouts and workflows do not depend on ambient TypeScript resolution.

## Problems observed
- `packages/sdk` build currently depends on brittle TypeScript/tool resolution behavior.
- clean workflow runs exposed missing `tsc` resolution repeatedly.
- the immediate unblock uses an explicit package-backed TypeScript invocation inside the workflow.

## Long-term fix directions to evaluate
1. make `packages/sdk` build fully self-contained and reproducible from its own package context
2. normalize workspace build tooling across packages so compiler resolution is consistent
3. consider project references / root toolchain conventions instead of package-local ambiguity
4. ensure clean-checkout CI/workflows can run package builds without hidden preconditions

## Deliverable
A future workflow should diagnose the best repo-level fix and implement it with validation, rather than relying on workflow-only workarounds.
