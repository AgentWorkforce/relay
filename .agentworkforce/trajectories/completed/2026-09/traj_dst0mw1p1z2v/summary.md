# Trajectory: Close PR 1673 proof response timestamp review gap

> **Status:** ✅ Completed
> **Task:** relay#1673
> **Confidence:** 90%
> **Started:** September 6, 2026 at 05:16 AM
> **Completed:** September 6, 2026 at 05:16 AM

---

## Summary

Moved the RelayFlow 1673 terminal timing origin to the completed HTTP response callback; syntax and formatting pass; exact-head Cloud proof will rerun after push.

**Approach:** Standard approach

---

## Key Decisions

### Record lastResponseAtMs in response.end completion callback
- **Chose:** Record lastResponseAtMs in response.end completion callback
- **Reasoning:** The timing assertion must measure broker return only after the controlled 503 has fully flushed, exactly matching review feedback.

---

## Chapters

### 1. Work
*Agent: default*

- Record lastResponseAtMs in response.end completion callback: Record lastResponseAtMs in response.end completion callback
