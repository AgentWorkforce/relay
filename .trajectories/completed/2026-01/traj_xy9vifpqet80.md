# Trajectory: Extract BaseWrapper from PtyWrapper and TmuxWrapper

> **Status:** ✅ Completed
> **Task:** agent-relay-wrap1
> **Confidence:** 90%
> **Started:** January 6, 2026 at 01:27 PM
> **Completed:** January 6, 2026 at 01:58 PM

---

## Summary

Extracted BaseWrapper abstract class from PtyWrapper and TmuxWrapper using TDD approach. Created 29 new tests, removed ~900 lines of duplicate code, both wrappers now inherit shared functionality.

**Approach:** Standard approach

---

## Key Decisions

### Using abstract class with protected methods for shared implementation
- **Chose:** Using abstract class with protected methods for shared implementation
- **Reasoning:** Allows subclasses to override while providing default behavior

### Created BaseWrapper abstract class with comprehensive tests
- **Chose:** Created BaseWrapper abstract class with comprehensive tests
- **Reasoning:** Extracted shared functionality from PtyWrapper/TmuxWrapper into base class. Tests cover message queue, spawn/release, continuity, and relay command handling.

---

## Chapters

### 1. Work
*Agent: default*

- Using abstract class with protected methods for shared implementation: Using abstract class with protected methods for shared implementation
- Created BaseWrapper abstract class with comprehensive tests: Created BaseWrapper abstract class with comprehensive tests
