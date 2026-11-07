# Trajectory: Gate private devpts regressions on trusted proof runtime prerequisites

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** September 2, 2026 at 04:46 AM
> **Completed:** September 2, 2026 at 04:47 AM

---

## Summary

Added a named trusted Landlock runtime capability predicate so private-devpts tests skip Linux install containers without Python/sudo while remaining executable in Daytona and fully provisioned Linux proof runners.

**Approach:** Standard approach

---

## Key Decisions

### Gate the five private-devpts regressions on the complete trusted runtime capability
- **Chose:** Gate the five private-devpts regressions on the complete trusted runtime capability
- **Reasoning:** Node install-compatibility containers are Linux but intentionally lack /usr/bin/sudo, so platform-only selection executed infrastructure-specific tests where the trusted launcher cannot exist. Requiring Linux plus executable-path presence keeps standard trusted runners eligible while treating exact Daytona 5/5 evidence as the behavioral gate.

---

## Chapters

### 1. Work
*Agent: default*

- Gate the five private-devpts regressions on the complete trusted runtime capability: Gate the five private-devpts regressions on the complete trusted runtime capability
- The selection-only patch leaves production code unchanged. Focused tests pass 68 with 5 skips locally; the full suite passed 2280 with 21 skips after one unrelated lsof-dependent test passed on isolated rerun.

---

## Artifacts

**Commits:** 371add22a
**Files changed:** 1
