# Trajectory: Fix duplicate up startup failure and broker lock diagnostics

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** February 23, 2026 at 08:54 AM
> **Completed:** February 23, 2026 at 08:56 AM

---

## Summary

Improved up startup diagnostics and duplicate-run protection; broker lock failures now surface root cause; validated with tests and live repro

**Approach:** Standard approach

---

## Key Decisions

### Prevent duplicate up from clobbering broker.pid and hide lock cause
- **Chose:** Prevent duplicate up from clobbering broker.pid and hide lock cause
- **Reasoning:** A second up was overwriting or deleting pid state and surfacing only code=1; preflight checks plus stderr context make failure deterministic and actionable

---

## Chapters

### 1. Work
*Agent: default*

- Prevent duplicate up from clobbering broker.pid and hide lock cause: Prevent duplicate up from clobbering broker.pid and hide lock cause
