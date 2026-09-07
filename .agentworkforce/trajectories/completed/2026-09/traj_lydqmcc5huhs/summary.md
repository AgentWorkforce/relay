# Trajectory: Harden RelayFlow timing proof after review

> **Status:** ✅ Completed
> **Task:** relay#1673
> **Confidence:** 96%
> **Started:** September 6, 2026 at 04:55 AM
> **Completed:** September 6, 2026 at 04:56 AM

---

## Summary

Hardened the sealed RelayFlow proof by measuring terminal return after its controlled 503 and single-sourcing all mock diagnostic markers.

**Approach:** Standard approach

---

## Key Decisions

### Measure terminal return after the mock response
- **Chose:** Measure terminal return after the mock response
- **Reasoning:** Process startup time is unrelated to Retry-After behavior. The proof now starts the bounded terminal-delay measurement when its own loopback server writes the 503, and shares all mock diagnostic values with assertions.

---

## Chapters

### 1. Work
*Agent: default*

- Measure terminal return after the mock response: Measure terminal return after the mock response

---

## Artifacts

**Commits:** c4d268e73
**Files changed:** 1
