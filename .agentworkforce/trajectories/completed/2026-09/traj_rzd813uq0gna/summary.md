# Trajectory: Fix replacement terminal allocation timeout and error propagation

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** September 19, 2026 at 07:44 PM
> **Completed:** September 19, 2026 at 07:44 PM

---

## Summary

Corrected replacement allocation timeout budgeting and structured error propagation, with focused regressions.

**Approach:** Standard approach

---

## Key Decisions

### Use the control-plane timeout and preserve structured replacement failures
- **Chose:** Use the control-plane timeout and preserve structured replacement failures
- **Reasoning:** Replacement allocation is an HTTP control-plane request, not a WebSocket upgrade; its failure code must remain visible to readiness-gated loopback callers.

---

## Chapters

### 1. Work
*Agent: default*

- Use the control-plane timeout and preserve structured replacement failures: Use the control-plane timeout and preserve structured replacement failures
