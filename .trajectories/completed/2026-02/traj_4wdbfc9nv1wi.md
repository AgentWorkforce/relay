# Trajectory: Deduplicate pre-registration rate-limit errors

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** February 23, 2026 at 03:20 PM
> **Completed:** February 23, 2026 at 03:20 PM

---

## Summary

Centralized worker pre-registration error formatting and removed duplicate retry-after suffix; added regression tests; rebuilt broker binary

**Approach:** Standard approach

---

## Key Decisions

### Keep strict pre-registration failure behavior; only clean up duplicated retry wording
- **Chose:** Keep strict pre-registration failure behavior; only clean up duplicated retry wording
- **Reasoning:** Rate limit is a real Relaycast API constraint and should remain explicit; duplicated wording was noisy and misleading

---

## Chapters

### 1. Work
*Agent: default*

- Keep strict pre-registration failure behavior; only clean up duplicated retry wording: Keep strict pre-registration failure behavior; only clean up duplicated retry wording
