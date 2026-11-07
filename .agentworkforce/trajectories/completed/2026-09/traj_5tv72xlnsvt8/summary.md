# Trajectory: Make scheduled workflow code snapshot uploads R2-only

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** September 18, 2026 at 11:13 PM
> **Completed:** September 18, 2026 at 11:16 PM

---

## Summary

Made scheduled workflow snapshots R2-only via Cloud workflow storage, preserving cloud run's legacy fallback.

**Approach:** Standard approach

---

## Key Decisions

### Scheduled snapshots require Cloud workflow storage
- **Chose:** Scheduled snapshots require Cloud workflow storage
- **Reasoning:** Schedules must upload through the R2-backed Cloud API and reject S3 prepare responses before any archive upload or S3 client creation.

---

## Chapters

### 1. Work
*Agent: default*

- Scheduled snapshots require Cloud workflow storage: Scheduled snapshots require Cloud workflow storage
