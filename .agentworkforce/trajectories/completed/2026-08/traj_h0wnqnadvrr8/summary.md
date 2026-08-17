# Trajectory: Harden relay#1548 release teardown after review

> **Status:** ✅ Completed
> **Task:** relay#1548-review
> **Confidence:** 97%
> **Started:** August 17, 2026 at 12:21 PM
> **Completed:** August 17, 2026 at 12:21 PM

---

## Summary

Addressed PR review by preserving terminal close frames through writer backpressure, clearing resize leases in the shared release lifecycle, and closing stale sessions on idempotent HTTP release.

**Approach:** Verified each review finding against the transport and repo rules, added a dedicated final-frame queue with deterministic mutation-backed coverage, kept the required patch changelog heading, and reran the full broker and attach suites.

---

## Key Decisions

### Give terminal.closed a dedicated bounded writer lane
- **Chose:** Give terminal.closed a dedicated bounded writer lane
- **Rejected:** Increase the shared writer queue, Block all output writes, Ignore the saturated-writer case
- **Reasoning:** The outer queue reserved close capacity, but the inner WebSocket writer still shed every Send frame when bulk output filled its queue. A final-frame lane prioritized ahead of output preserves teardown without making output unbounded.

---

## Chapters

### 1. Work
*Agent: default*

- Give terminal.closed a dedicated bounded writer lane: Give terminal.closed a dedicated bounded writer lane
