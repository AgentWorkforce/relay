# Trajectory: Close final Cubic findings on relay #1642

> **Status:** ✅ Completed
> **Task:** relay#1642
> **Confidence:** 92%
> **Started:** September 3, 2026 at 05:01 AM
> **Completed:** September 3, 2026 at 05:12 AM

---

## Summary

Closed final Cubic gaps with artifact-root containment, complete aggregate dependencies, executable exact-base delivery evidence, and failOnError mutation coverage.

**Approach:** Standard approach

---

## Key Decisions

### Exercise exact-base delivery commands and capture enforcement metadata
- **Chose:** Exercise exact-base delivery commands and capture enforcement metadata
- **Reasoning:** The regression contract must observe the original zero-exit/no-receipt behavior and must fail if a delivery gate loses failOnError or runs before every audited receipt exists.

### Reject the artifact root itself before touching children
- **Chose:** Reject the artifact root itself before touching children
- **Reasoning:** Checking only root/runs happens after mkdirSync has already followed an ARTIFACTS_ROOT symlink and permits writes and pruning outside the configured namespace.

---

## Chapters

### 1. Work
*Agent: default*

- Exercise exact-base delivery commands and capture enforcement metadata: Exercise exact-base delivery commands and capture enforcement metadata
- Reject the artifact root itself before touching children: Reject the artifact root itself before touching children
- Five settled Cubic threads include four valid runtime/proof gaps and one broad P3 about intentional source-level invariant checks. Runtime paths now have executable coverage and three mutations turn the suite red; retain the narrow source assertions as complementary structural contracts.
