# Trajectory: Repair Linux timeout termination assertion on PR #1642

> **Status:** ✅ Completed
> **Task:** PR-1642-CI2
> **Confidence:** 98%
> **Started:** September 2, 2026 at 09:56 PM
> **Completed:** September 2, 2026 at 09:57 PM

---

## Summary

Made the process-tree timeout regression portable by treating only absent or zombie filter processes as terminated; a running or sleeping descendant still fails the test.

**Approach:** Standard approach

---

## Key Decisions

### Treat an absent or zombie checkout filter as terminated
- **Chose:** Treat an absent or zombie checkout filter as terminated
- **Reasoning:** POSIX process-group SIGKILL stops the descendant, but container PID 1 may leave the dead process as a zombie long enough for kill(pid, 0) to succeed. Process state distinguishes a stopped zombie from a running descendant.

---

## Chapters

### 1. Work
*Agent: default*

- Treat an absent or zombie checkout filter as terminated: Treat an absent or zombie checkout filter as terminated

---

## Artifacts

**Commits:** 719a35b42
**Files changed:** 1
**Trace:** `../traj_ks4l2sj2y9lf.trace.json`
