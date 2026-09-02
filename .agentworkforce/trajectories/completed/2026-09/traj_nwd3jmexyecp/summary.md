# Trajectory: Align Landlock capability probe with detached production launcher

> **Status:** ✅ Completed
> **Confidence:** 98%
> **Started:** September 2, 2026 at 05:42 AM
> **Completed:** September 2, 2026 at 05:48 AM

---

## Summary

Detached the synchronous Landlock probe to match production and added a real controlling-TTY regression; local gates and exact six-test Daytona proof pass.

**Approach:** Standard approach

---

## Key Decisions

### Detach the synchronous Landlock capability probe on POSIX
- **Chose:** Detach the synchronous Landlock capability probe on POSIX
- **Reasoning:** The production launcher already creates a new session through runBoundedProcess. Matching that spawn boundary prevents an interactive caller's controlling TTY from causing the trusted bootstrap /dev/tty guard to reject an otherwise eligible host; a pty.fork regression exercises the real condition.

---

## Chapters

### 1. Work
*Agent: default*

- Detach the synchronous Landlock capability probe on POSIX: Detach the synchronous Landlock capability probe on POSIX
- The production/probe session mismatch is fixed and exercised end-to-end. Local focused/typecheck/full gates are green, and exact Daytona raw output shows the six selected Linux security regressions passed with the real shell marker.
