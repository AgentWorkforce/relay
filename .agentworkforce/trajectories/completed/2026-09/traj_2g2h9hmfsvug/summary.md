# Trajectory: Retry safe replacement terminal allocation failures

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** September 19, 2026 at 07:49 PM
> **Completed:** September 19, 2026 at 07:49 PM

---

## Summary

Replacement allocation now uses bounded retries only for definite non-allocation failures and includes the full budget in readiness timing.

**Approach:** Standard approach

---

## Key Decisions

### Retry only definite non-allocation responses during replacement
- **Chose:** Retry only definite non-allocation responses during replacement
- **Reasoning:** Structured node_unreachable and terminal_session_unavailable responses prove no terminal was allocated, so bounded retries preserve the single replacement-session invariant while handling stale liveness.

---

## Chapters

### 1. Work
*Agent: default*

- Retry only definite non-allocation responses during replacement: Retry only definite non-allocation responses during replacement
