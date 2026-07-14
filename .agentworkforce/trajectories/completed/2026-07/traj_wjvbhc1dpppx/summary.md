# Trajectory: Address #1252 review: pruner narrow-deserialize + Lagged reconciliation, queue bounds validation + O(1) drop-oldest, headless newline fidelity

> **Status:** ✅ Completed
> **Task:** PR-1252
> **Confidence:** 88%
> **Started:** July 13, 2026 at 12:59 AM
> **Completed:** July 13, 2026 at 01:05 AM

---

## Summary

Addressed all 5 #1252 review comments: pruner narrow PrunerEvent deserialize + Lagged reconciliation via List; TS maxQueueSize normalization + O(1) head-index drop-oldest; headless read_until preserving CRLF and unterminated final segments. All broker lib tests, clippy, tsc, and vitest green.

**Approach:** Standard approach

---

## Key Decisions

### Reconcile input_serializers against broker live-worker List on broadcast Lagged

- **Chose:** Reconcile input_serializers against broker live-worker List on broadcast Lagged
- **Reasoning:** agent_released/agent_exited fire once; a lag burst drops them and leaks the serializer. List query gives the authoritative live set; retain-live-only is non-racy since a dropped live entry is recreated lazily.

### Headless stdout/stderr use read_until(b'\n') instead of Lines

- **Chose:** Headless stdout/stderr use read_until(b'\n') instead of Lines
- **Reasoning:** Lines strips terminators, normalizing CRLF->LF and fabricating a trailing newline for unterminated final segments. read_until preserves exact bytes; lossy UTF-8 keeps prior behavior.

### O(1) head-index drop-oldest for subscribeWorkerStream queue + normalize maxQueueSize

- **Chose:** O(1) head-index drop-oldest for subscribeWorkerStream queue + normalize maxQueueSize
- **Reasoning:** shift() is O(n) under sustained overload; head-index with amortized compaction is O(1). NaN/Infinity/0/negative maxQueueSize defeated the bound, so normalize to finite positive int falling back to default.

---

## Chapters

### 1. Work

_Agent: default_

- Reconcile input_serializers against broker live-worker List on broadcast Lagged: Reconcile input_serializers against broker live-worker List on broadcast Lagged
- Headless stdout/stderr use read_until(b'\n') instead of Lines: Headless stdout/stderr use read_until(b'\n') instead of Lines
- O(1) head-index drop-oldest for subscribeWorkerStream queue + normalize maxQueueSize: O(1) head-index drop-oldest for subscribeWorkerStream queue + normalize maxQueueSize
