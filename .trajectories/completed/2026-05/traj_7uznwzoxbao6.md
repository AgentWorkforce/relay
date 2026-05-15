# Trajectory: Fix standalone detached headless startup

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 15, 2026 at 12:18 PM
> **Completed:** May 15, 2026 at 12:25 PM

---

## Summary

Fixed standalone detached headless startup by avoiding an extra script argv for compiled binaries, added a regression test, and reran typecheck, core CLI tests, lint, and diff checks.

**Approach:** Standard approach

---

## Key Decisions

### Use invocation-shape aware detached re-exec

- **Chose:** Use invocation-shape aware detached re-exec
- **Reasoning:** Standalone Bun binaries do not have a separate Node script path; spawning execPath with cliScript as an extra argv item prevents the foreground child from running the intended up command.

---

## Chapters

### 1. Work

_Agent: default_

- Use invocation-shape aware detached re-exec: Use invocation-shape aware detached re-exec
- Strict pass found and fixed the standalone binary regression surfaced by CI: detached start now builds child argv based on whether the current invocation is a Node script or a compiled executable.
