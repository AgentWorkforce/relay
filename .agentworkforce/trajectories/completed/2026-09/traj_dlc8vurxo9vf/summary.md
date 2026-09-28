# Trajectory: Resolve final stale lock review for PR #1864

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1864
> **Confidence:** 96%
> **Started:** September 28, 2026 at 09:40 AM
> **Completed:** September 28, 2026 at 09:40 AM

---

## Summary

Fixed stale on-relay lock recovery and added a regression test for abandoned owners.

**Approach:** Standard approach

---

## Key Decisions

### Keep stale detection inside the five-second acquisition budget
- **Chose:** Keep stale detection inside the five-second acquisition budget
- **Reasoning:** A four-second stale grace protects normal lock creation while allowing the same bounded acquisition attempt to reclaim a dead owner.

---

## Chapters

### 1. Work
*Agent: default*

- Keep stale detection inside the five-second acquisition budget: Keep stale detection inside the five-second acquisition budget
