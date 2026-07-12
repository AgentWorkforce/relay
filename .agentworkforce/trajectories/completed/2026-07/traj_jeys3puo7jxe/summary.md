# Trajectory: Fix harness-driver/PTY attach (drive/view) correctness bugs from audit

> **Status:** ✅ Completed
> **Confidence:** 80%
> **Started:** July 12, 2026 at 08:20 PM
> **Completed:** July 12, 2026 at 09:02 PM

---

## Summary

Added per-worker byte offsets to worker_stream + snapshot response (relay-pty consumed_offset atomic, pty_worker flush-before-snapshot); reworked drive/view/passthrough to subscribe-first buffering + offset reconcile via shared StreamSyncBuffer; moved drive resize after WS subscribe; fixed pending inflation via sinceSeq cutoff (new currentSeq in /api/events/replay). Rust + TS tests green.

**Approach:** Standard approach

---

## Key Decisions

### Filed issue #1247 with consolidated audit; fixing in 5 sequential workstreams on one branch
- **Chose:** Filed issue #1247 with consolidated audit; fixing in 5 sequential workstreams on one branch
- **Reasoning:** Workstreams share files (attach-drive.ts, pty_worker.rs); sequential agents avoid conflicts. Opus for the 4 hard workstreams (stream cursor sync, async loop, session robustness, snapshot modes), Sonnet for mechanical transport/misc fixes

### Report snapshot offset as grid consumed-offset (atomic under term lock); flush coalescing buffer before snapshot; clients subscribe-first + reconcile by offset
- **Chose:** Report snapshot offset as grid consumed-offset (atomic under term lock); flush coalescing buffer before snapshot; clients subscribe-first + reconcile by offset
- **Reasoning:** Grid is causally ahead of the stream; offset must reflect what the grid painted, and flushing aligns the emission boundary to minimize straddle duplication

---

## Chapters

### 1. Work
*Agent: default*

- Filed issue #1247 with consolidated audit; fixing in 5 sequential workstreams on one branch: Filed issue #1247 with consolidated audit; fixing in 5 sequential workstreams on one branch
- Report snapshot offset as grid consumed-offset (atomic under term lock); flush coalescing buffer before snapshot; clients subscribe-first + reconcile by offset: Report snapshot offset as grid consumed-offset (atomic under term lock); flush coalescing buffer before snapshot; clients subscribe-first + reconcile by offset

---

## Artifacts

**Commits:** 6a4db09, 62f740d
**Files changed:** 18
