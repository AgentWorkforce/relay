# Trajectory: Further split broker runtime module for issue 875

> **Status:** ✅ Completed
> **Task:** #875
> **Confidence:** 90%
> **Started:** May 18, 2026 at 09:28 PM
> **Completed:** May 18, 2026 at 09:38 PM

---

## Summary

Split broker runtime into focused modules for session setup, init loop, pending delivery, headless workers, connection discovery, paths, frame I/O, message/thread helpers, system helpers, spawn spec parsing, and tests.

**Approach:** Standard approach

---

## Key Decisions

### Split broker runtime by responsibility

- **Chose:** Split broker runtime by responsibility
- **Reasoning:** Kept the CLI-facing runtime API stable while moving cohesive concerns into runtime submodules: init loop, session setup, pending delivery, headless worker, connection discovery, paths, terminal/system helpers, message/thread helpers, frame IO, and spawn spec parsing.

---

## Chapters

### 1. Work

_Agent: default_

- Split broker runtime by responsibility: Split broker runtime by responsibility

---

## Artifacts

**Commits:** 7182810c
**Files changed:** 14
