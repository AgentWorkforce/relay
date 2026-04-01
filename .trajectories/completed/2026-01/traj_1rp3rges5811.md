# Trajectory: Improve trajectory viewer design

> **Status:** ✅ Completed
> **Confidence:** 78%
> **Started:** January 3, 2026 at 03:09 PM
> **Completed:** January 3, 2026 at 03:10 PM

---

## Summary

Trimmed TrajectoryViewer detail UX: hide View Details button when no handler, only render detail panel when content exists; rebuilt dashboard and reran targeted vitest.

**Approach:** Standard approach

---

## Key Decisions

### Hide TrajectoryViewer action when no onStepClick provided
- **Chose:** Hide TrajectoryViewer action when no onStepClick provided
- **Reasoning:** Prevents empty expanded panes and removes dead View Details button when parent has no detail handler

---

## Chapters

### 1. Work
*Agent: default*

- Hide TrajectoryViewer action when no onStepClick provided: Hide TrajectoryViewer action when no onStepClick provided
