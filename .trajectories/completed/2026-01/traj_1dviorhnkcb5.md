# Trajectory: Use uuid() instead of Math.random() for message IDs

> **Status:** ✅ Completed
> **Task:** agent-relay-417
> **Confidence:** 95%
> **Started:** January 3, 2026 at 04:25 PM
> **Completed:** January 3, 2026 at 04:25 PM

---

## Summary

Replaced Math.random().toString(36).slice(2) with uuid() in daemon/server.ts:284 for cross-machine message IDs. Added uuid import. Build verified.

**Approach:** Standard approach

---

## Key Decisions

### TrajectoryViewer already wired up but needs UX improvements
- **Chose:** TrajectoryViewer already wired up but needs UX improvements
- **Reasoning:** Component was connected in recent commits, but user reported: too small, not browsable, no back navigation

### Used existing uuid library pattern from codebase
- **Chose:** Used existing uuid library pattern from codebase
- **Reasoning:** Already imported as 'v4 as uuid' in router.ts, connection.ts, agent-registry.ts - maintaining consistency

---

## Chapters

### 1. Work
*Agent: default*

- TrajectoryViewer already wired up but needs UX improvements: TrajectoryViewer already wired up but needs UX improvements
- Used existing uuid library pattern from codebase: Used existing uuid library pattern from codebase
