# Trajectory: Keep local attach responsive during slow cloud registration

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** September 8, 2026 at 12:04 PM
> **Completed:** September 8, 2026 at 12:21 PM

---

## Summary

Isolated HTTP-spawn cloud registration from local attach; bounded registration and overload retries; accurate health/attach diagnostics. 1065 broker tests passed (4 ignored), 43 attach tests passed, CLI typecheck passed. Same real-pipe regression fails on baseline 11.10.4 and passes with fix. Production broker untouched; rollout pending.

**Approach:** Standard approach

---

## Key Decisions

### Move HTTP-spawn cloud preparation out of the broker actor and bound it
- **Chose:** Move HTTP-spawn cloud preparation out of the broker actor and bound it
- **Reasoning:** Wrangler traced a 35.7s duplicate registration blocking local attach. Preserve node tokens, merge only completed identity/cursor state, reserve local names, reject pending releases, and skip launch when the caller is gone. Retry only explicit pre-allocation D1 overload for fleet attach.

---

## Chapters

### 1. Work
*Agent: default*

- Move HTTP-spawn cloud preparation out of the broker actor and bound it: Move HTTP-spawn cloud preparation out of the broker actor and bound it
