# Trajectory: Fix PR 1666 Node 24 truncation fixture flake

> **Status:** ✅ Completed
> **Task:** relay#1666
> **Confidence:** 97%
> **Started:** September 9, 2026 at 06:53 AM
> **Completed:** September 9, 2026 at 06:54 AM

---

## Summary

Removed scheduler sensitivity from the Node 24 Fleet evidence-bound fixture while preserving exact byte-count and truncation assertions.

**Approach:** Standard approach

---

## Key Decisions

### Make the large UTF-8 bound fixture a single-write payload
- **Chose:** Make the large UTF-8 bound fixture a single-write payload
- **Reasoning:** The adjacent test already verifies one-byte decoder splitting; repeating 36,000 setImmediate callbacks made the independent truncation assertion depend on CI scheduler pressure under Node 24.

---

## Chapters

### 1. Work
*Agent: default*

- Make the large UTF-8 bound fixture a single-write payload: Make the large UTF-8 bound fixture a single-write payload
