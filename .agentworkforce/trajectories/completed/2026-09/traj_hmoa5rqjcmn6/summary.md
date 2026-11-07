# Trajectory: Align Landlock capability probe with detached production launcher

> **Status:** ✅ Completed
> **Confidence:** 98%
> **Started:** September 2, 2026 at 06:02 AM
> **Completed:** September 2, 2026 at 06:02 AM

---

## Summary

Detached the synchronous Landlock probe to match production and added a real controlling-TTY regression; local gates and exact six-test Daytona proof pass.

**Approach:** Standard approach

---

## Key Decisions

### Detach the synchronous Landlock capability probe on POSIX
- **Chose:** Detach the synchronous Landlock capability probe on POSIX
- **Reasoning:** The production launcher creates a new POSIX session through runBoundedProcess. Matching that process boundary prevents an interactive caller's controlling TTY from causing the trusted bootstrap /dev/tty guard to reject an otherwise eligible host; a pty.fork regression exercises the real condition.

---

## Chapters

### 1. Work
*Agent: default*

- Detach the synchronous Landlock capability probe on POSIX: Detach the synchronous Landlock capability probe on POSIX
- The production/probe session mismatch is fixed and exercised end-to-end. Local focused/typecheck/full gates are green, and exact Daytona raw output shows all six selected Linux security regressions passed with the real shell marker.

---

## Artifacts

**Commits:** beee1968b, 5a5f2bdbd
**Files changed:** 4
