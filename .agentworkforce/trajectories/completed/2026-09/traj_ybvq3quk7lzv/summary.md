# Trajectory: Cancel duplicate PR 1632 broker producers

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1632
> **Confidence:** 99%
> **Started:** September 1, 2026 at 09:18 PM
> **Completed:** September 1, 2026 at 09:18 PM

---

## Summary

Enabled cancellation for superseded same-SHA broker producers and added source-contract coverage for the SHA-keyed concurrency group and cancellation policy.

**Approach:** Standard approach

---

## Key Decisions

### Cancel superseded same-SHA broker builds
- **Chose:** Cancel superseded same-SHA broker builds
- **Reasoning:** Edited and ready-for-review events may retrigger the same exact source SHA. Because the producer is deterministic and keyed by source SHA, keeping an older run consumes resources and can extend artifact availability beyond one producer bound without adding evidence. Cancel the previous same-SHA run when its replacement starts.

---

## Chapters

### 1. Work
*Agent: default*

- Cancel superseded same-SHA broker builds: Cancel superseded same-SHA broker builds
