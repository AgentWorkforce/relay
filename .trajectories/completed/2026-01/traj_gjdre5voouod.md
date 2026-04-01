# Trajectory: Fix LogViewer ANSI stripping and Show more removal

> **Status:** ✅ Completed
> **Task:** logviewer-cleanup
> **Confidence:** 80%
> **Started:** January 3, 2026 at 03:11 PM
> **Completed:** January 3, 2026 at 03:16 PM

---

## Summary

Sanitized LogViewer output (strips ANSI/SGR including bracket-only codes) and removed Show more collapse so logs display fully; verified via build + targeted vitest.

**Approach:** Standard approach

---

## Key Decisions

### Always render full sanitized LogViewer lines
- **Chose:** Always render full sanitized LogViewer lines
- **Reasoning:** Removed collapse button and strip all ANSI/SGR sequences (including bracket-only codes) so logs display clean text without hidden sections.

---

## Chapters

### 1. Work
*Agent: default*

- Always render full sanitized LogViewer lines: Always render full sanitized LogViewer lines
