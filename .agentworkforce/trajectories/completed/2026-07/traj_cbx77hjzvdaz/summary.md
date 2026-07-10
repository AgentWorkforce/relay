# Trajectory: Fix manual-flush Relaycast ACK durability

> **Status:** ✅ Completed
> **Task:** #1241
> **Confidence:** 93%
> **Started:** July 10, 2026 at 10:15 AM
> **Completed:** July 10, 2026 at 10:15 AM

---

## Summary

Fixed #1241 by separating received and ACKed delivery cursors, retaining Relaycast receipts through manual flush, rejecting full queues without eviction, and ACKing only successfully injected FIFO prefixes. Verified focused cursor, replay, overflow, success, and failure regressions; cargo fmt check passed; full broker library suite passed 672 tests with 4 ignored.

**Approach:** Standard approach

---

## Key Decisions

### Split delivery progress into received and ACKed cursors
- **Chose:** Split delivery progress into received and ACKed cursors
- **Reasoning:** Manual-flush must accept multiple contiguous Relaycast sequences without cumulatively acknowledging volatile queue entries; duplicates and gaps therefore report only the ACKed cursor, while successful enqueue advances received state.

### Reject the newest delivery when the manual queue is full
- **Chose:** Reject the newest delivery when the manual queue is full
- **Reasoning:** Evicting an already-held delivery could discard the only actionable copy after a later cumulative ACK. Atomic rejection leaves the FIFO unchanged, does not advance received or ACKed state, and preserves Relaycast ownership for replay.

---

## Chapters

### 1. Work
*Agent: default*

- Split delivery progress into received and ACKed cursors: Split delivery progress into received and ACKed cursors
- Reject the newest delivery when the manual queue is full: Reject the newest delivery when the manual queue is full
