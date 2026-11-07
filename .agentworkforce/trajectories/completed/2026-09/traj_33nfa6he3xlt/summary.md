# Trajectory: Complete trusted proof runtime capability detection

> **Status:** ✅ Completed
> **Confidence:** 97%
> **Started:** September 2, 2026 at 04:50 AM
> **Completed:** September 2, 2026 at 04:51 AM

---

## Summary

Completed trusted runtime detection with non-root UID/GID validation and a bounded passwordless-sudo probe before selecting privileged private-devpts regressions.

**Approach:** Standard approach

---

## Key Decisions

### Require a usable privilege bootstrap, not executable presence alone
- **Chose:** Require a usable privilege bootstrap, not executable presence alone
- **Reasoning:** The private-devpts regressions can only execute for a safe non-root caller with positive UID/GID and working passwordless sudo. A bounded no-op sudo probe prevents root-based and non-sudo Linux containers from selecting tests that the launcher must reject.

---

## Chapters

### 1. Work
*Agent: default*

- Require a usable privilege bootstrap, not executable presence alone: Require a usable privilege bootstrap, not executable presence alone
- The tightened capability predicate now matches runLandlockedProcess preconditions. Focused tests and typecheck pass; the sequential full suite passes 2280 tests with 21 skips. An earlier concurrent full/typecheck attempt was invalid because typecheck cleans package build outputs during Vitest.

---

## Artifacts

**Commits:** e4e0ad1cb
**Files changed:** 1
