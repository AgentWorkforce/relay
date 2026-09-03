# Trajectory: Close final shared-worktree and retention findings on PR #1642

> **Status:** ✅ Completed
> **Task:** PR-1642
> **Confidence:** 94%
> **Started:** September 2, 2026 at 09:16 PM
> **Completed:** September 2, 2026 at 09:29 PM

---

## Summary

Isolated each verifier invocation in a detached git worktree, added concurrency-safe bounded artifact retention, and expanded unit and exact-head proof coverage for both controls.

**Approach:** Standard approach

---

## Key Decisions

### Isolate each verification invocation in a detached git worktree
- **Chose:** Isolate each verification invocation in a detached git worktree
- **Reasoning:** Run-scoped evidence prevents artifact collisions but does not isolate autofix branch switches, commits, integrity checks, or PR creation. A unique worktree gives the whole DAG an independent git index and HEAD without reintroducing a stale-lock protocol.

### Retain only marker-complete verifier histories
- **Chose:** Retain only marker-complete verifier histories
- **Reasoning:** Completion markers distinguish immutable evidence from active overlapping invocations; atomic rename claims make concurrent pruning idempotent, and the canonical run is always protected.

---

## Chapters

### 1. Work
*Agent: default*

- Isolate each verification invocation in a detached git worktree: Isolate each verification invocation in a detached git worktree
- Retain only marker-complete verifier histories: Retain only marker-complete verifier histories
- Both final findings have executable controls: simultaneous detached worktrees preserve independent git state, and racing retention processes converge without deleting the active run.

---

## Artifacts

**Commits:** ce7325d65
**Files changed:** 8
**Trace:** `../traj_jtwpjqd8h655.trace.json`
