# Trajectory: Fix Claude folder-trust auto-accept for both menu orderings

> **Status:** ✅ Completed
> **Task:** 1654
> **Confidence:** 82%
> **Started:** September 6, 2026 at 08:04 AM
> **Completed:** September 6, 2026 at 08:13 AM

---

## Summary

Made Claude folder-trust auto-accept selection-aware for both menu orderings, added fail-closed detector coverage and a live PTY regression.

**Approach:** Standard approach

---

## Key Decisions

### Parse Claude trust selection by cursor-marked row and preserve the existing detector API
- **Chose:** Parse Claude trust selection by cursor-marked row and preserve the existing detector API
- **Reasoning:** Both menu orderings share labels; only rendered selection state safely determines whether Enter or Down+Enter selects trust, while retaining the tuple detector avoids a public API break.

---

## Chapters

### 1. Work
*Agent: default*

- Parse Claude trust selection by cursor-marked row and preserve the existing detector API: Parse Claude trust selection by cursor-marked row and preserve the existing detector API
