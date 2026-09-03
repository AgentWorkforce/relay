# Trajectory: Make Cloud node status retry backoff honor its deadline

> **Status:** ✅ Completed
> **Confidence:** 96%
> **Started:** September 3, 2026 at 02:53 PM
> **Completed:** September 3, 2026 at 02:53 PM

---

## Summary

Made Cloud lookup retry waits abort-aware and added a deterministic deadline regression test

**Approach:** Standard approach

---

## Key Decisions

### Use the lookup AbortSignal for retry waits

- **Chose:** Use the lookup AbortSignal for retry waits
- **Reasoning:** One shared signal enforces the total two-second diagnostic budget across fetches and backoff sleeps.

---

## Chapters

### 1. Work

_Agent: default_

- Use the lookup AbortSignal for retry waits: Use the lookup AbortSignal for retry waits
