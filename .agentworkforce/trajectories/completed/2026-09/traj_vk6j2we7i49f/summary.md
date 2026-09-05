# Trajectory: Implement issue #1658 set-model applied receipt

> **Status:** ✅ Completed
> **Task:** 1658
> **Confidence:** 86%
> **Started:** September 5, 2026 at 07:39 PM
> **Completed:** September 5, 2026 at 07:54 PM

---

## Summary

Implemented correlated set-model receipts with explicit accepted_pending/applied/rejected/unsupported states, worker generation and revision fencing, GET polling, typed worker protocol responses, CLI/SDK surfaces, and deterministic tests.

**Approach:** Standard approach

---

## Key Decisions

### Use an opt-in typed set_model worker protocol and fail closed for all current runtimes
- **Chose:** Use an opt-in typed set_model worker protocol and fail closed for all current runtimes
- **Reasoning:** PTY output cannot prove provider consumption; headless/native adapters expose no setter. Correlated request IDs, worker generations, and exact effective-model matching prevent false applied receipts while preserving queue admission as accepted_pending.

---

## Chapters

### 1. Work
*Agent: default*

- Use an opt-in typed set_model worker protocol and fail closed for all current runtimes: Use an opt-in typed set_model worker protocol and fail closed for all current runtimes
- Implemented broker-owned model receipts, polling, typed worker responses, client surfaces, CLI messaging, and deterministic positive/negative tests; full broker library suite passes.
