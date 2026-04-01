# Trajectory: Add SDK log follow stream helper

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** February 23, 2026 at 11:21 AM
> **Completed:** February 23, 2026 at 11:24 AM

---

## Summary

Added SDK followLogs helper with typed subscribe/history/log/error events, AgentRelay wrapper, and passing unit tests for missing/history/incremental follow behavior.

**Approach:** Standard approach

---

## Key Decisions

### Added SDK followLogs helper (history + incremental polling)
- **Chose:** Added SDK followLogs helper (history + incremental polling)
- **Reasoning:** Dashboard and other consumers need a shared local log-stream primitive; polling works cross-platform and matches existing standalone behavior until broker-side stream APIs are introduced.

---

## Chapters

### 1. Work
*Agent: default*

- Added SDK followLogs helper (history + incremental polling): Added SDK followLogs helper (history + incremental polling)
