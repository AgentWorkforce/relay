# Trajectory: Debug dashboard send injection to spawned worker

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 23, 2026 at 12:36 PM
> **Completed:** February 23, 2026 at 01:39 PM

---

## Summary

Reduced system-reminder spam by omitting reminder wrapper on delivery retries while keeping it on first injection.

**Approach:** Standard approach

---

## Key Decisions

### Omit <system-reminder> on delivery retries
- **Chose:** Omit <system-reminder> on delivery retries
- **Reasoning:** Echo verification retries were re-injecting full reminder blocks, causing repeated reminder spam; keep reminders on first delivery only.

---

## Chapters

### 1. Work
*Agent: default*

- Omit <system-reminder> on delivery retries: Omit <system-reminder> on delivery retries
