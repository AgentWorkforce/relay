# Trajectory: Add workflow reliability contract coverage

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 8, 2026 at 05:27 PM
> **Completed:** May 8, 2026 at 05:28 PM

---

## Summary

Added workflow-reliability-contract tests covering repair-agent retry, repair-agent throw resilience, budget exhaustion, soft deterministic validation flowing into fixer agents, and fail-fast opt-out.

**Approach:** Standard approach

---

## Key Decisions

### Add a dedicated SDK workflow reliability contract suite
- **Chose:** Add a dedicated SDK workflow reliability contract suite
- **Reasoning:** Workflow repair semantics should be enforced as product behavior with fast fake executors, not only incidental coverage in the broad runner test file.

---

## Chapters

### 1. Work
*Agent: default*

- Add a dedicated SDK workflow reliability contract suite: Add a dedicated SDK workflow reliability contract suite
