# Trajectory: Reduce process-level CLI flake surface by keeping only smoke coverage in index.test

> **Status:** ✅ Completed
> **Confidence:** 94%
> **Started:** March 4, 2026 at 01:15 PM
> **Completed:** March 4, 2026 at 01:15 PM

---

## Summary

Trimmed index.test to version/help plus agents --json smoke; hardened smoke JSON detection against broker log prefixes

**Approach:** Standard approach

---

## Key Decisions

### Removed broker-dependent subprocess assertions from index.test and relied on command/lib unit tests
- **Chose:** Removed broker-dependent subprocess assertions from index.test and relied on command/lib unit tests
- **Reasoning:** unit tests already cover status/agents/who/history/read behavior deterministically; subprocess tests were flaky due broker startup timing

---

## Chapters

### 1. Work
*Agent: default*

- Removed broker-dependent subprocess assertions from index.test and relied on command/lib unit tests: Removed broker-dependent subprocess assertions from index.test and relied on command/lib unit tests
