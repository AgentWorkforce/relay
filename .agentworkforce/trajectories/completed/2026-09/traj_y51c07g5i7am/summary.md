# Trajectory: Align PR 1632 resolver and producer timeouts

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1632
> **Confidence:** 98%
> **Started:** September 1, 2026 at 09:05 PM
> **Completed:** September 1, 2026 at 09:06 PM

---

## Summary

Aligned broker artifact polling with the 30-minute producer timeout and added deterministic coverage proving the default wait exceeds that bound without wall-clock delay.

**Approach:** Standard approach

---

## Key Decisions

### Derive resolver wait from producer timeout
- **Chose:** Derive resolver wait from producer timeout
- **Reasoning:** The broker workflow permits 30 minutes, so a fixed 20-minute resolver budget can fail before a valid cold build completes. Derive 182 attempts from the 30-minute producer bound and 10-second interval, giving 30m10s of wait while two worst-case sequential resolutions still fit within the 70-minute dispatcher timeout.

---

## Chapters

### 1. Work
*Agent: default*

- Derive resolver wait from producer timeout: Derive resolver wait from producer timeout
