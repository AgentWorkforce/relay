# Trajectory: Finalize relay#1548 teardown review

> **Status:** ✅ Completed
> **Task:** relay#1548-review-2
> **Confidence:** 98%
> **Started:** August 17, 2026 at 12:40 PM
> **Completed:** August 17, 2026 at 12:41 PM

---

## Summary

Resolved the final teardown review findings: release closes remain nonblocking at the reserved outer queue, and shutdown now reliably sends its queued WebSocket close even when the final-frame lane is empty. Added a loopback WebSocket regression test and proved its mutation fails.

**Approach:** Audited both queue layers and the biased writer select, restored nonblocking outer enqueueing, retained the inner final-frame lane, removed the premature sender drop, and validated with the full broker suite plus targeted mutation.

---

## Key Decisions

### Keep worker-release finalization nonblocking at the outer queue and preserve the final-frame sender through WebSocket shutdown
- **Chose:** Keep worker-release finalization nonblocking at the outer queue and preserve the final-frame sender through WebSocket shutdown
- **Rejected:** Await outer queue admission and risk stalling broker events, Drop final_tx before awaiting the writer and risk suppressing the WebSocket close
- **Reasoning:** The broker event loop must not await a congested transport queue; its 1,024-slot queue reserves 32 slots for the maximum 32 live terminal sessions, while the dedicated inner final lane protects close frames from bulk output backpressure. Keeping final_tx alive prevents an empty closed final lane from winning the biased writer select before the queued priority WebSocket Close.

---

## Chapters

### 1. Work
*Agent: default*

- Keep worker-release finalization nonblocking at the outer queue and preserve the final-frame sender through WebSocket shutdown: Keep worker-release finalization nonblocking at the outer queue and preserve the final-frame sender through WebSocket shutdown
