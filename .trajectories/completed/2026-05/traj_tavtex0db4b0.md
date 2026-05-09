# Trajectory: Make workflow failures repairable by agents

> **Status:** ✅ Completed
> **Confidence:** 82%
> **Started:** May 8, 2026 at 04:34 PM
> **Completed:** May 8, 2026 at 04:44 PM

---

## Summary

Moved implementation into worktree codex/repairable-workflow-failures. Added bounded deterministic gate repair in the workflow runner so failed deterministic checks can be fixed by a workflow agent before retrying.

**Approach:** Standard approach

---

## Key Decisions

### Use a separate git worktree for the workflow repair runtime change
- **Chose:** Use a separate git worktree for the workflow repair runtime change
- **Reasoning:** The user explicitly requested worktree isolation after the branch was created; keeping the dirty base checkout untouched avoids mixing this implementation with existing local edits.

---

## Chapters

### 1. Work
*Agent: default*

- Use a separate git worktree for the workflow repair runtime change: Use a separate git worktree for the workflow repair runtime change
