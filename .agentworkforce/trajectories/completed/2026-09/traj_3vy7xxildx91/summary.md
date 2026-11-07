# Trajectory: Eliminate PR #1642 invocation-lock races and close exact-head review

> **Status:** ✅ Completed
> **Task:** PR-1642
> **Confidence:** 94%
> **Started:** September 2, 2026 at 07:57 PM
> **Completed:** September 2, 2026 at 08:02 PM

---

## Summary

Replaced the racy shared-artifact lock with UUID-scoped run directories and atomic canonical symlinks, added process-level concurrency and exact-head proof coverage, and repaired the prior review trajectory's commit/file evidence.

**Approach:** Standard approach

---

## Key Decisions

### Replace shared-artifact locking with run-scoped artifacts and an atomic canonical pointer
- **Chose:** Replace shared-artifact locking with run-scoped artifacts and an atomic canonical pointer
- **Reasoning:** Portable filesystem primitives cannot safely reclaim a stale shared lock with compare-and-delete semantics. Unique run directories eliminate write collisions; atomically swapped relative symlinks preserve the established top-level artifact paths and make the newest invocation fail visibly if incomplete.

### Proved concurrency with eight independent Node processes and the exact-head RelayFlow case
- **Chose:** Proved concurrency with eight independent Node processes and the exact-head RelayFlow case
- **Reasoning:** Source assertions would not catch filesystem publication races. The process-level stress test verifies every run directory remains intact, while the proof verifies the canonical path exposes the newest incomplete run instead of a stale verdict.

---

## Chapters

### 1. Work
*Agent: default*

- Replace shared-artifact locking with run-scoped artifacts and an atomic canonical pointer: Replace shared-artifact locking with run-scoped artifacts and an atomic canonical pointer
- Proved concurrency with eight independent Node processes and the exact-head RelayFlow case: Proved concurrency with eight independent Node processes and the exact-head RelayFlow case

---

## Artifacts

**Commits:** 4e83a0465
**Files changed:** 8
