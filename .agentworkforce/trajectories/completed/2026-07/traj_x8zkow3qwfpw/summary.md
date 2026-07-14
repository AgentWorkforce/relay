# Trajectory: Rebase PR #1098 (broker DLQ + redeliver + persisted dedup) onto current main; resolve conflicts

> **Status:** ✅ Completed
> **Task:** PR-1098
> **Confidence:** 85%
> **Started:** July 14, 2026 at 03:25 PM
> **Completed:** July 14, 2026 at 03:25 PM

---

## Summary

Rebased PR #1098 onto main: resolved 9 conflicts, adapted local->node CLI rename, threaded dead_letters through release_worker_locally. All broker + TS tests pass.

**Approach:** Standard approach

---

## Chapters

### 1. Work
*Agent: default*

- Kept current-main 'node' CLI group; added node deadletters/redeliver (PR predated local->node rename): Kept current-main 'node' CLI group; added node deadletters/redeliver (PR predated local->node rename)
- Dropped PR edits to relaycast_events firehose handler (delivery is now node-only); threaded dead_letters into release_worker_locally to match new emit_dropped_delivery_failures signature: Dropped PR edits to relaycast_events firehose handler (delivery is now node-only); threaded dead_letters into release_worker_locally to match new emit_dropped_delivery_failures signature

---

## Artifacts

**Commits:** defd3305
**Files changed:** 23
