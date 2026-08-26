# Trajectory: Fix PR #1619 accepted placement logging exception

> **Status:** ✅ Completed
> **Task:** relay#1619
> **Confidence:** 99%
> **Started:** August 26, 2026 at 08:10 PM
> **Completed:** August 26, 2026 at 08:12 PM

---

## Summary

Isolated placementLog failures after an accepted automatic dispatch and added a regression proving roster-refresh plus logger failures cannot reject committed work. Source-revert ablation failed 1/28 for the expected observability exception; restored source passed 28/28. The SDK-only CI command `npm run -w @agent-relay/sdk check` (`tsc -p tsconfig.json --noEmit`) passed; this does not claim the broader root typecheck, SDK build, or `test:types` scopes.

**Approach:** Standard approach

---

## Key Decisions

### Isolate placementLog at accepted-placement roster refresh
- **Chose:** Isolate placementLog at accepted-placement roster refresh
- **Reasoning:** commands.invoke has already committed the remote spawn; observability exceptions must not convert success into a retryable rejection. Regression ablation failed 1/28 specifically with observability sink down; restored source passed 28/28.

---

## Chapters

### 1. Work
*Agent: default*

- Isolate placementLog at accepted-placement roster refresh: Isolate placementLog at accepted-placement roster refresh
