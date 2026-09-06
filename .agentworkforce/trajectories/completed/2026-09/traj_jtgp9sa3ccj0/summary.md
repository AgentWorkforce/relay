# Trajectory: Fix Claude folder-trust auto-accept for both menu orderings

> **Status:** ✅ Completed
> **Task:** 1654
> **Confidence:** 88%
> **Started:** September 6, 2026 at 07:27 AM
> **Completed:** September 6, 2026 at 07:42 AM

---

## Summary

Made Claude folder-trust acceptance selection-aware, added old/new menu regressions and a live-worker PTY integration test, and updated the changelog

**Approach:** Standard approach

---

## Key Decisions

### Derived Claude trust keystrokes from the rendered selected row
- **Chose:** Derived Claude trust keystrokes from the rendered selected row
- **Reasoning:** Claude ships both option orderings; requiring exactly one Yes row, one No row, and one selected marker preserves fail-closed behavior while allowing direction-aware navigation

---

## Chapters

### 1. Work
*Agent: default*

- Derived Claude trust keystrokes from the rendered selected row: Derived Claude trust keystrokes from the rendered selected row
