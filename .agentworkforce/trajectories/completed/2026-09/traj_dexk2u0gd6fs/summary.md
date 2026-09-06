# Trajectory: Fix Claude folder-trust auto-accept for both menu orderings

> **Status:** ✅ Completed
> **Task:** 1654
> **Confidence:** 90%
> **Started:** September 6, 2026 at 06:26 AM
> **Completed:** September 6, 2026 at 06:38 AM

---

## Summary

Made Claude folder-trust handling selection-aware for both menu orderings and added parser plus real-PTY regression coverage.

**Approach:** Standard approach

---

## Key Decisions

### Parse the rendered Claude trust menu into explicit Confirm/MoveUp/MoveDown actions
- **Chose:** Parse the rendered Claude trust menu into explicit Confirm/MoveUp/MoveDown actions
- **Reasoning:** The option order changed across Claude versions; requiring both labels and exactly one rendered selection marker preserves fail-closed behavior and avoids blind Enter.

---

## Chapters

### 1. Work
*Agent: default*

- Parse the rendered Claude trust menu into explicit Confirm/MoveUp/MoveDown actions: Parse the rendered Claude trust menu into explicit Confirm/MoveUp/MoveDown actions
