# Trajectory: Address PR #1248 review: post-reconcile watermark, atomic pending seed, changelog trim

> **Status:** ✅ Completed
> **Task:** 1248
> **Confidence:** 85%
> **Started:** July 12, 2026 at 11:56 PM
> **Completed:** July 13, 2026 at 12:04 AM

---

## Summary

Addressed PR #1248 review: (1) post-reconcile offset watermark in StreamSyncBuffer suppresses in-flight stragglers <= snapshotOffset; (2) reversed cutoff/seed order + event_id dedup for exact pending count; (3) trimmed 3 changelog bullets. tsc + 264 vitest tests green; no Rust changes.

**Approach:** Standard approach

---

## Key Decisions

### Comment 2: implemented option (b) dedup-by-event_id, not (a)

- **Chose:** Comment 2: implemented option (b) dedup-by-event_id, not (a)
- **Reasoning:** Replay seq is assigned asynchronously downstream of the runtime turn (in broadcast_if_relevant), so /pending cannot capture currentSeq coherently with the queue snapshot; (a) would still race (double-count). Option (b) is provably correct and purely client-side: capture cutoff first then seed, and dedupe replayed delivery_queued frames by event_id (present on both pending messages and WS frames).

---

## Chapters

### 1. Work

_Agent: default_

- Comment 2: implemented option (b) dedup-by-event_id, not (a): Comment 2: implemented option (b) dedup-by-event_id, not (a)
