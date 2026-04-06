# Trajectory: Fix binaryArgs docs description for structured TypeScript type

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** April 2, 2026 at 01:31 PM
> **Completed:** April 2, 2026 at 01:32 PM

---

## Summary

Added language-specific spawn option descriptions so binaryArgs shows structured TypeScript usage and keeps the Python list example; updated markdown and docs table tests.

**Approach:** Standard approach

---

## Key Decisions

### Use language-specific spawn option descriptions for shared docs rows
- **Chose:** Use language-specific spawn option descriptions for shared docs rows
- **Reasoning:** The table already switches option names by docs language. Adding per-language descriptions fixes the TypeScript binaryArgs example without regressing Python docs that still accept list[str].

---

## Chapters

### 1. Work
*Agent: default*

- Use language-specific spawn option descriptions for shared docs rows: Use language-specific spawn option descriptions for shared docs rows
