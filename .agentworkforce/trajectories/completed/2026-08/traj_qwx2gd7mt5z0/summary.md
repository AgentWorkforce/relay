# Trajectory: Require exact target revisions in PR 1609 proof

> **Status:** ✅ Completed
> **Task:** PR-1609
> **Confidence:** 95%
> **Started:** August 26, 2026 at 02:33 AM
> **Completed:** August 26, 2026 at 02:34 AM

---

## Summary

Added an exact target revision guard to the mounted-sandbox timeout proof runner.

**Approach:** Started the trajectory at the original PR head, committed the runner guard separately, and finalized the record from the resulting Git range.

---

## Key Decisions

### Bind each RelayFlow arm to the workflow-declared target revision
- **Chose:** Bind each RelayFlow arm to the workflow-declared target revision
- **Reasoning:** A deterministic red-green result must reject a stale or mutated target checkout before observing production behavior.

---

## Chapters

### 1. Initial work
*Agent: relay-pr1609-trail-repair*

- Bind each RelayFlow arm to the workflow-declared target revision: Bind each RelayFlow arm to the workflow-declared target revision

---

## Artifacts

**Commits:** 7d14b0373
**Files changed:** 1
