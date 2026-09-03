# Trajectory: Bound node status Cloud diagnostic latency

> **Status:** ✅ Completed
> **Confidence:** 91%
> **Started:** September 3, 2026 at 02:37 PM
> **Completed:** September 3, 2026 at 02:37 PM

---

## Summary

Reduced Cloud registration diagnostic timeout to two seconds and pinned the budget in a unit test; live status completes in 2.31s.

**Approach:** Standard approach

---

## Key Decisions

### Cap the optional Cloud name lookup at two seconds

- **Chose:** Cap the optional Cloud name lookup at two seconds
- **Reasoning:** The macOS E2E showed the 10-second lookup budget could exceed node status's established 10-second command deadline after local broker readiness; two seconds keeps the diagnostic useful while preserving local status responsiveness.

---

## Chapters

### 1. Work

_Agent: default_

- Cap the optional Cloud name lookup at two seconds: Cap the optional Cloud name lookup at two seconds
