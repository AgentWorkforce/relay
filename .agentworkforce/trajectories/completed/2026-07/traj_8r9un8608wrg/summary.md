# Trajectory: Fix #1247 B2

> **Status:** ✅ Completed
> **Task:** 1247
> **Confidence:** 85%
> **Started:** July 12, 2026 at 09:18 PM
> **Completed:** July 12, 2026 at 10:24 PM

---

## Summary

Fixed all issue #1247 harness/PTY attach defects in 5 workstreams: stream-offset snapshot sync + subscribe-first attach, non-blocking PTY writes + ack-after-write + interactive hold, drive session robustness (signals/UTF-8/teardown/status line), snapshot terminal modes, transport reconnect guards + misc

**Approach:** Standard approach

---

## Artifacts

**Commits:** f9da582, 1c08f61, e2792f3, 4ff6854, 2b0ae52
**Files changed:** 26
